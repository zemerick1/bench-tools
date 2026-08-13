#!/usr/bin/env python3
"""Fixture tests for the dependency-aware OpenAPI splitter."""

from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from oasutil import dump_spec, normalize_servers, pointer_escape, redact_example_secrets
from spec_splitter import build_slice, slice_output_path, split_spec
from spec_validate import validate_spec


def _base(**overrides) -> dict:
    spec = {
        "openapi": "3.1.0",
        "info": {"title": "Fixture API", "version": "1.0.0"},
        "servers": [{"url": "https://example.test"}],
        "security": [{"BearerAuth": []}],
        "tags": [{"name": "Pets"}, {"name": "Stores"}],
        "paths": {},
        "components": {
            "securitySchemes": {
                "BearerAuth": {"type": "http", "scheme": "bearer"},
                "UnusedAuth": {"type": "apiKey", "in": "header", "name": "X-Key"},
            },
            "schemas": {},
        },
    }
    spec.update(overrides)
    return spec


class OasUtilTests(unittest.TestCase):
    def test_pointer_roundtrip(self) -> None:
        name = "Foo/Bar~Baz"
        escaped = pointer_escape(name)
        self.assertEqual(escaped, "Foo~1Bar~0Baz")
        from oasutil import pointer_unescape

        self.assertEqual(pointer_unescape(escaped), name)

    def test_example_secrets_redacted(self) -> None:
        payload = {
            "twilio_sid": "AC" + "0" * 32,
            "oauth_cc_client_secret": {
                "examples": ["example-oauth-client-secret-value"]
            },
            "name": "keep-me",
        }
        redacted = redact_example_secrets(payload)
        self.assertEqual(redacted["twilio_sid"], "REDACTED")
        self.assertEqual(redacted["oauth_cc_client_secret"]["examples"], ["REDACTED"])
        self.assertEqual(redacted["name"], "keep-me")

    def test_switch_ip_server_normalized(self) -> None:
        servers = normalize_servers([{"url": "switch-ip/rest/v10.16"}])
        self.assertEqual(servers[0]["url"], "https://{switchIp}/rest/v10.16")
        self.assertEqual(servers[0]["variables"]["switchIp"]["default"], "192.0.2.1")


class SplitterFixtureTests(unittest.TestCase):
    def test_nested_refs_copied_unused_schema_dropped(self) -> None:
        spec = _base()
        spec["components"]["schemas"] = {
            "Leaf": {"type": "object", "properties": {"id": {"type": "string"}}},
            "Parent": {
                "type": "object",
                "properties": {"leaf": {"$ref": "#/components/schemas/Leaf"}},
            },
            "Unused": {"type": "string"},
        }
        spec["paths"] = {
            "/pets": {
                "get": {
                    "tags": ["Pets"],
                    "responses": {
                        "200": {
                            "description": "ok",
                            "content": {
                                "application/json": {
                                    "schema": {"$ref": "#/components/schemas/Parent"}
                                }
                            },
                        }
                    },
                }
            }
        }
        results = split_spec(spec, api="fix", source_stem="core")
        self.assertEqual(len(results), 1)
        schemas = results[0].spec["components"]["schemas"]
        self.assertEqual(set(schemas), {"Parent", "Leaf"})
        self.assertEqual(schemas["Parent"]["properties"]["leaf"]["$ref"], "#/components/schemas/Leaf")
        self.assertNotIn("Unused", schemas)
        self.assertTrue(validate_spec(results[0].spec).ok)

    def test_circular_refs_preserved(self) -> None:
        spec = _base()
        spec["components"]["schemas"] = {
            "Node": {
                "type": "object",
                "properties": {
                    "child": {"$ref": "#/components/schemas/Node"},
                },
            }
        }
        spec["paths"] = {
            "/tree": {
                "get": {
                    "tags": ["Pets"],
                    "responses": {
                        "200": {
                            "description": "ok",
                            "content": {
                                "application/json": {
                                    "schema": {"$ref": "#/components/schemas/Node"}
                                }
                            },
                        }
                    },
                }
            }
        }
        results = split_spec(spec, api="fix", source_stem="core")
        node = results[0].spec["components"]["schemas"]["Node"]
        self.assertEqual(node["properties"]["child"]["$ref"], "#/components/schemas/Node")
        self.assertTrue(validate_spec(results[0].spec).ok)
        self.assertEqual(results[0].unresolved, [])

    def test_allof_oneof(self) -> None:
        spec = _base()
        spec["components"]["schemas"] = {
            "A": {"type": "string"},
            "B": {"type": "integer"},
            "C": {"type": "boolean"},
            "Combo": {
                "allOf": [{"$ref": "#/components/schemas/A"}],
                "oneOf": [{"$ref": "#/components/schemas/B"}, {"$ref": "#/components/schemas/C"}],
            },
        }
        spec["paths"] = {
            "/combo": {
                "post": {
                    "tags": ["Pets"],
                    "requestBody": {
                        "content": {
                            "application/json": {"schema": {"$ref": "#/components/schemas/Combo"}}
                        }
                    },
                    "responses": {"200": {"description": "ok"}},
                }
            }
        }
        schemas = split_spec(spec, api="fix", source_stem="core")[0].spec["components"]["schemas"]
        self.assertEqual(set(schemas), {"Combo", "A", "B", "C"})

    def test_path_level_parameter_ref(self) -> None:
        spec = _base()
        spec["components"]["parameters"] = {
            "PetId": {"name": "petId", "in": "path", "required": True, "schema": {"type": "string"}}
        }
        spec["paths"] = {
            "/pets/{petId}": {
                "parameters": [{"$ref": "#/components/parameters/PetId"}],
                "get": {
                    "tags": ["Pets"],
                    "responses": {"200": {"description": "ok"}},
                },
            }
        }
        slice_spec = split_spec(spec, api="fix", source_stem="core")[0].spec
        self.assertEqual(
            slice_spec["paths"]["/pets/{petId}"]["parameters"][0]["$ref"],
            "#/components/parameters/PetId",
        )
        self.assertIn("PetId", slice_spec["components"]["parameters"])

    def test_first_tag_wins_not_duplicated(self) -> None:
        spec = _base()
        spec["paths"] = {
            "/both": {
                "get": {
                    "tags": ["Pets", "Stores"],
                    "responses": {"200": {"description": "ok"}},
                }
            },
            "/store": {
                "get": {
                    "tags": ["Stores"],
                    "responses": {"200": {"description": "ok"}},
                }
            },
        }
        results = {item.group_id: item for item in split_spec(spec, api="fix", source_stem="core")}
        self.assertEqual(set(results), {"pets", "stores"})
        self.assertEqual(results["pets"].operation_count, 1)
        self.assertEqual(results["stores"].operation_count, 1)
        self.assertIn("/both", results["pets"].spec["paths"])
        self.assertNotIn("/both", results["stores"].spec["paths"])

    def test_untagged_goes_uncategorized(self) -> None:
        spec = _base()
        spec["paths"] = {
            "/mystery": {"get": {"responses": {"200": {"description": "ok"}}}}
        }
        results = split_spec(spec, api="fix", source_stem="core")
        self.assertEqual([item.group_id for item in results], ["uncategorized"])

    def test_json_pointer_escaping(self) -> None:
        spec = _base()
        name = "Foo/Bar"
        spec["components"]["schemas"] = {
            name: {"type": "object", "properties": {"ok": {"type": "boolean"}}},
        }
        spec["paths"] = {
            "/escaped": {
                "get": {
                    "tags": ["Pets"],
                    "responses": {
                        "200": {
                            "description": "ok",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "$ref": f"#/components/schemas/{pointer_escape(name)}"
                                    }
                                }
                            },
                        }
                    },
                }
            }
        }
        slice_spec = split_spec(spec, api="fix", source_stem="core")[0].spec
        self.assertIn(name, slice_spec["components"]["schemas"])
        self.assertTrue(validate_spec(slice_spec).ok)

    def test_security_scheme_copied_unused_dropped(self) -> None:
        spec = _base()
        spec["paths"] = {
            "/secure": {"get": {"tags": ["Pets"], "responses": {"200": {"description": "ok"}}}}
        }
        schemes = split_spec(spec, api="fix", source_stem="core")[0].spec["components"]["securitySchemes"]
        self.assertEqual(set(schemes), {"BearerAuth"})

    def test_external_ref_is_unresolved(self) -> None:
        spec = _base()
        spec["paths"] = {
            "/ext": {
                "get": {
                    "tags": ["Pets"],
                    "responses": {
                        "200": {
                            "description": "ok",
                            "content": {
                                "application/json": {
                                    "schema": {"$ref": "https://example.test/schema.json"}
                                }
                            },
                        }
                    },
                }
            }
        }
        result = split_spec(spec, api="fix", source_stem="core")[0]
        self.assertEqual(result.unresolved, ["https://example.test/schema.json"])
        self.assertFalse(validate_spec(result.spec).ok)

    def test_second_cut_by_ops_budget(self) -> None:
        spec = _base()
        spec["paths"] = {
            f"/network-monitoring/v1/clients/{i}": {
                "get": {"tags": ["Clients"], "responses": {"200": {"description": "ok"}}}
            }
            for i in range(5)
        } | {
            f"/network-monitoring/v1/devices/{i}": {
                "get": {"tags": ["Clients"], "responses": {"200": {"description": "ok"}}}
            }
            for i in range(5)
        }
        results = split_spec(spec, api="fix", source_stem="core", max_ops=4, max_bytes=10_000_000)
        self.assertGreater(len(results), 1)
        self.assertTrue(all(item.second_cut for item in results))
        self.assertTrue(all(item.operation_count <= 4 for item in results))
        self.assertEqual(sum(item.operation_count for item in results), 10)
        self.assertTrue(any("·" in item.group_title for item in results))

    def test_crud_on_one_path_stays_together(self) -> None:
        huge = {
            "type": "object",
            "description": "x" * 4000,
            "properties": {f"field{i}": {"type": "string"} for i in range(40)},
        }
        spec = _base()
        spec["components"]["schemas"] = {"Huge": huge}
        schema_ref = {"$ref": "#/components/schemas/Huge"}
        spec["paths"] = {
            "/network-config/v1alpha1/ethernet-interfaces": {
                "get": {
                    "tags": ["Interface Ethernet"],
                    "summary": "List Ethernet",
                    "responses": {
                        "200": {
                            "description": "ok",
                            "content": {"application/json": {"schema": schema_ref}},
                        }
                    },
                }
            },
            "/network-config/v1alpha1/ethernet-interfaces/{name}": {
                "get": {
                    "tags": ["Interface Ethernet"],
                    "summary": "Get Ethernet",
                    "responses": {
                        "200": {
                            "description": "ok",
                            "content": {"application/json": {"schema": schema_ref}},
                        }
                    },
                },
                "post": {
                    "tags": ["Interface Ethernet"],
                    "summary": "Create Ethernet",
                    "responses": {
                        "200": {
                            "description": "ok",
                            "content": {"application/json": {"schema": schema_ref}},
                        }
                    },
                },
                "put": {
                    "tags": ["Interface Ethernet"],
                    "summary": "Replace Ethernet",
                    "responses": {
                        "200": {
                            "description": "ok",
                            "content": {"application/json": {"schema": schema_ref}},
                        }
                    },
                },
                "patch": {
                    "tags": ["Interface Ethernet"],
                    "summary": "Update Ethernet",
                    "responses": {
                        "200": {
                            "description": "ok",
                            "content": {"application/json": {"schema": schema_ref}},
                        }
                    },
                },
            },
        }
        results = split_spec(spec, api="fix", source_stem="core", max_ops=200, max_bytes=800)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].group_title, "Interface Ethernet")
        self.assertEqual(results[0].operation_count, 5)
        methods = {
            record["method"] for record in results[0].operation_records
        }
        self.assertEqual(methods, {"get", "post", "put", "patch"})

    def test_deterministic_dump(self) -> None:
        spec = _base()
        spec["paths"] = {
            "/b": {"post": {"tags": ["Pets"], "responses": {"200": {"description": "ok"}}}},
            "/a": {"get": {"tags": ["Pets"], "responses": {"200": {"description": "ok"}}}},
        }
        first = split_spec(copy.deepcopy(spec), api="fix", source_stem="core")[0]
        second = split_spec(copy.deepcopy(spec), api="fix", source_stem="core")[0]
        self.assertEqual(dump_spec(first.spec), dump_spec(second.spec))
        dumped = dump_spec(first.spec)
        paths = json.loads(dumped)["paths"]
        self.assertEqual(list(paths), ["/a", "/b"])

    def test_output_path_includes_source_stem(self) -> None:
        spec = _base()
        spec["paths"] = {
            "/x": {"get": {"tags": ["Access Points"], "responses": {"200": {"description": "ok"}}}}
        }
        monitoring = split_spec(
            spec, api="aruba-central", variant="mrt", source_stem="monitoring-81"
        )[0]
        troubleshooting = split_spec(
            spec, api="aruba-central", variant="mrt", source_stem="troubleshooting-85"
        )[0]
        root = Path("/tmp/openapi-docs")
        self.assertNotEqual(
            slice_output_path(root, monitoring),
            slice_output_path(root, troubleshooting),
        )
        self.assertTrue(
            str(slice_output_path(root, monitoring)).endswith(
                "specs/aruba-central/mrt/monitoring-81/access-points.json"
            )
        )

    def test_swagger2_definitions_copied(self) -> None:
        spec = {
            "swagger": "2.0",
            "info": {"title": "Axis", "version": "1.0"},
            "host": "admin-api.axissecurity.com",
            "schemes": ["https"],
            "paths": {
                "/api/v1.0/Tags": {
                    "get": {
                        "tags": ["ApplicationGroups"],
                        "responses": {
                            "200": {"schema": {"$ref": "#/definitions/ApplicationGroupModelV1"}}
                        },
                    }
                }
            },
            "definitions": {
                "ApplicationGroupModelV1": {
                    "type": "object",
                    "properties": {"name": {"type": "string"}},
                },
                "Unused": {"type": "string"},
            },
            "securityDefinitions": {
                "OAuthBearerToken": {"type": "apiKey", "name": "Authorization", "in": "header"}
            },
            "security": [{"OAuthBearerToken": []}],
        }
        result = split_spec(spec, api="axis", source_stem="axis")[0]
        slice_spec = result.spec
        self.assertEqual(slice_spec["swagger"], "2.0")
        self.assertNotIn("openapi", slice_spec)
        self.assertIn("ApplicationGroupModelV1", slice_spec["definitions"])
        self.assertNotIn("Unused", slice_spec["definitions"])
        self.assertEqual(
            slice_spec["servers"][0]["url"], "https://admin-api.axissecurity.com"
        )
        self.assertIn("OAuthBearerToken", slice_spec["securityDefinitions"])
        self.assertEqual(result.unresolved, [])
        self.assertTrue(validate_spec(slice_spec).ok)

    def test_marketing_info_stripped(self) -> None:
        spec = _base()
        spec["info"] = {
            "title": "Mist API",
            "version": "2602.1.1",
            "contact": {"name": "Thomas Munzer", "email": "tmunzer@juniper.net"},
            "license": {"name": "MIT"},
            "description": (
                "> Version: **2602.1.1**\n"
                "<div class=\"notification\">NOTE</div>\n"
                "* [Mist Automation Guide](https://example.com)\n"
            ),
            "x-logo": {"url": "https://example.com/logo.png"},
        }
        spec["paths"] = {
            "/x": {"get": {"tags": ["Pets"], "responses": {"200": {"description": "ok"}}}}
        }
        info = split_spec(spec, api="mist", source_stem="mist")[0].spec["info"]
        self.assertEqual(info["title"], "Pets")
        self.assertEqual(info["version"], "2602.1.1")
        self.assertNotIn("description", info)
        self.assertNotIn("contact", info)
        self.assertNotIn("license", info)
        self.assertNotIn("x-logo", info)

    def test_servers_and_info_copied(self) -> None:
        spec = _base()
        spec["paths"] = {
            "/x": {"get": {"tags": ["Pets"], "responses": {"200": {"description": "ok"}}}}
        }
        slice_spec = split_spec(spec, api="fix", source_stem="core")[0].spec
        self.assertEqual(slice_spec["servers"], spec["servers"])
        self.assertEqual(slice_spec["info"]["title"], "Pets")

    def test_build_slice_keeps_refs(self) -> None:
        spec = _base()
        spec["components"]["schemas"] = {"A": {"type": "string"}}
        spec["paths"] = {
            "/x": {
                "get": {
                    "tags": ["Pets"],
                    "responses": {
                        "200": {
                            "description": "ok",
                            "content": {
                                "application/json": {"schema": {"$ref": "#/components/schemas/A"}}
                            },
                        }
                    },
                }
            }
        }
        from spec_splitter import Operation, assign_group

        grouping = {"maps": []}
        path, method, operation, path_item = next(
            ((p, m, o, i) for p, m, o, i in __import__("oasutil").iter_operations(spec))
        )
        group_id, title, category, tags = assign_group(path, method, operation, grouping)
        op = Operation(path, method, operation, path_item, tags, group_id, title, category)
        document, unresolved = build_slice(spec, [op], title_suffix=title)
        self.assertEqual(unresolved, [])
        self.assertEqual(
            document["paths"]["/x"]["get"]["responses"]["200"]["content"]["application/json"]["schema"]["$ref"],
            "#/components/schemas/A",
        )


class ValidatorTests(unittest.TestCase):
    def test_empty_paths_fail(self) -> None:
        result = validate_spec({"openapi": "3.1.0", "info": {"title": "x", "version": "1"}, "paths": {}})
        self.assertFalse(result.ok)

    def test_missing_ref_fails(self) -> None:
        spec = {
            "openapi": "3.1.0",
            "info": {"title": "x", "version": "1"},
            "paths": {
                "/x": {
                    "get": {
                        "responses": {
                            "200": {
                                "description": "ok",
                                "content": {
                                    "application/json": {
                                        "schema": {"$ref": "#/components/schemas/Missing"}
                                    }
                                },
                            }
                        }
                    }
                }
            },
        }
        result = validate_spec(spec)
        self.assertFalse(result.ok)
        self.assertTrue(any("unresolved" in error for error in result.errors))


if __name__ == "__main__":
    unittest.main()
