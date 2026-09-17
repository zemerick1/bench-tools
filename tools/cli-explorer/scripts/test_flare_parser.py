#!/usr/bin/env python3
"""Unit tests for CLI-Bank Flare topic + letter-chunk parsing (no network)."""

from __future__ import annotations

import unittest
from pathlib import Path

from flare_topic import group_title, parse_flare_topic, parse_toc_chunk

HERE = Path(__file__).resolve().parent
FIXTURES = HERE / "fixtures"


class TocChunkTests(unittest.TestCase):
    def test_letter_chunk(self) -> None:
        js = (FIXTURES / "aos10_a_chunk.js").read_text(encoding="utf-8")
        entries = parse_toc_chunk(js)
        self.assertEqual(len(entries), 3)
        self.assertEqual(entries[0]["path"], "/Content/aos10/a10-sh-aaa-auth-via-glbl-cnfg.htm")
        self.assertEqual(entries[0]["title"], "show aaa authentication via global-config")
        self.assertEqual(entries[1]["title"], "show ap active")
        self.assertEqual(entries[2]["title"], "AOS 10")

    def test_html_404_is_empty(self) -> None:
        self.assertEqual(parse_toc_chunk("<!DOCTYPE html><html>404</html>"), [])


class GroupTitleTests(unittest.TestCase):
    def test_show_second_word(self) -> None:
        self.assertEqual(group_title("show aaa authentication via global-config"), "show aaa")
        self.assertEqual(group_title("show ap active"), "show ap")
        self.assertEqual(group_title("show running-config"), "show running-config")

    def test_non_show(self) -> None:
        self.assertEqual(group_title("halt"), "halt")


class FlareTopicTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        html = (FIXTURES / "aos10_via_global_config.htm").read_text(encoding="utf-8")
        cls.parsed = parse_flare_topic(html)

    def test_title(self) -> None:
        self.assertEqual(self.parsed["title"], "show aaa authentication via global-config")

    def test_syntax(self) -> None:
        self.assertEqual(
            self.parsed["syntax"], "show aaa authentication via global-config"
        )

    def test_description(self) -> None:
        self.assertIn("VIA global configuration", self.parsed["description"])
        self.assertNotIn("Example", self.parsed["description"])

    def test_examples_keep_cli_columns(self) -> None:
        ex = self.parsed["examples"]
        self.assertIn("show aaa authentication via global-config", ex)
        self.assertIn("VIA Global Configuration", ex)
        self.assertIn("Allow VIA SSL Fallback", ex)

    def test_history_table(self) -> None:
        hist = self.parsed["historyRows"]
        self.assertGreaterEqual(len(hist), 2)
        header = " ".join(hist[0]).lower()
        self.assertIn("release", header)
        joined = " ".join(" ".join(r) for r in hist)
        self.assertIn("10.5", joined)

    def test_preview(self) -> None:
        self.assertIn("show aaa authentication via global-config", self.parsed["preview"])


class ClearPassFlareTests(unittest.TestCase):
    """ClearPass repeats Description for the example screen and puts params in the first."""

    @classmethod
    def setUpClass(cls) -> None:
        html = (FIXTURES / "cppm_ad_auth.htm").read_text(encoding="utf-8")
        cls.parsed = parse_flare_topic(html)

    def test_title_and_syntax(self) -> None:
        self.assertEqual(self.parsed["title"], "ad auth")
        self.assertIn("ad auth -u", self.parsed["syntax"])

    def test_description_is_prose_not_example(self) -> None:
        self.assertIn("Active Directory", self.parsed["description"])
        self.assertNotIn("[appadmin]", self.parsed["description"])

    def test_second_description_is_examples(self) -> None:
        self.assertIn("ad auth -u jbrown", self.parsed["examples"])
        self.assertIn("Authentication successful", self.parsed["examples"])

    def test_param_table_inside_description(self) -> None:
        rows = self.parsed["paramRows"]
        self.assertGreaterEqual(len(rows), 2)
        self.assertIn("parameter", rows[0][0].lower())


if __name__ == "__main__":
    unittest.main()
