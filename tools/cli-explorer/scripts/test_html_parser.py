#!/usr/bin/env python3
"""Unit tests for HPESC DITA topic parsing (no network)."""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from html_topic import parse_topic_html

HERE = Path(__file__).resolve().parent
FIXTURES = HERE / "fixtures"


def load_html(name: str) -> str:
    data = json.loads((FIXTURES / name).read_text(encoding="utf-8"))
    return data["page_html"]


class AlarmTopicTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.parsed = parse_topic_html(load_html("alarm_topic.json"))

    def test_title(self) -> None:
        self.assertEqual(self.parsed["title"], "alarm")

    def test_syntax_tree(self) -> None:
        syn = self.parsed["syntax"]
        self.assertIn("alarm", syn)
        self.assertIn("power-supply|temperature", syn)
        self.assertIn("<LOG-AND-TRAP>", syn)
        self.assertIn("<RELAY>", syn)
        self.assertNotIn("Syntax", syn.splitlines()[0])

    def test_description(self) -> None:
        self.assertTrue(
            self.parsed["description"].startswith("Configures input alarm")
        )
        self.assertNotIn("Parameter", self.parsed["description"])

    def test_param_table(self) -> None:
        rows = self.parsed["paramRows"]
        self.assertGreaterEqual(len(rows), 3)
        self.assertIn("parameter", rows[0][0].lower())
        names = " ".join(r[0] for r in rows).lower()
        self.assertIn("temperature", names)
        self.assertIn("power-supply", names)

    def test_examples(self) -> None:
        ex = self.parsed["examples"]
        self.assertIn("no alarm temperature", ex)
        self.assertIn("alarm snooze 10", ex)
        self.assertNotIn("For more information on features", ex)

    def test_history_and_info(self) -> None:
        hist = self.parsed["historyRows"]
        self.assertGreaterEqual(len(hist), 2)
        self.assertIn("10.08", hist[1][0])
        self.assertEqual(self.parsed["platforms"], "4100i")
        self.assertEqual(self.parsed["context"], "config")
        self.assertIn("Administrators", self.parsed["authority"])


class AccessListIpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.parsed = parse_topic_html(load_html("access_list_ip_topic.json"))

    def test_title(self) -> None:
        self.assertEqual(self.parsed["title"], "access-list ip")

    def test_syntax_has_no_form(self) -> None:
        self.assertIn("access-list ip", self.parsed["syntax"])
        self.assertIn("<ACL-NAME>", self.parsed["syntax"])
        self.assertTrue(self.parsed["syntaxNo"].startswith("no access-list ip"))

    def test_description_present(self) -> None:
        self.assertGreater(len(self.parsed["description"]), 40)


if __name__ == "__main__":
    unittest.main()
