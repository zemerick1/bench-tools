#!/usr/bin/env python3
"""Header and status-line tests for the CLI-Bank fetch."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from build_from_cli_bank import HttpGetError, curl_argv, parse_curl_http  # noqa: E402
from fetch_cli_json import CHROME_UA, SEC_CH_UA  # noqa: E402


def _header(argv: list, name: str) -> str:
    prefix = name + ": "
    for i, arg in enumerate(argv):
        if arg == "-H" and i + 1 < len(argv) and argv[i + 1].startswith(prefix):
            return argv[i + 1][len(prefix):]
    raise AssertionError("missing header {0}".format(name))


class CliBankHttpTests(unittest.TestCase):
    def test_curl_uses_chrome_client_hints(self) -> None:
        argv = curl_argv(
            "https://arubanetworking.hpe.com/techdocs/CLI-Bank/Content/aos10/sh-version.htm",
            dest="document",
            mode="navigate",
            referer="https://arubanetworking.hpe.com/techdocs/CLI-Bank/Content/landing-pages/aos10-home.htm",
        )
        self.assertIn("--http2", argv)
        self.assertEqual(argv[argv.index("-A") + 1], CHROME_UA)
        self.assertNotIn("Edg/", CHROME_UA)
        self.assertIn("Chrome/", CHROME_UA)
        self.assertEqual(_header(argv, "sec-ch-ua"), SEC_CH_UA)
        self.assertIn("Google Chrome", SEC_CH_UA)
        self.assertEqual(_header(argv, "sec-ch-ua-mobile"), "?0")
        self.assertEqual(_header(argv, "sec-ch-ua-platform"), '"macOS"')
        self.assertEqual(_header(argv, "Sec-Fetch-Dest"), "document")
        self.assertEqual(_header(argv, "Sec-Fetch-Mode"), "navigate")
        self.assertEqual(_header(argv, "Sec-Fetch-Site"), "same-origin")

    def test_script_fetch_keeps_sec_fetch_dest(self) -> None:
        argv = curl_argv(
            "https://arubanetworking.hpe.com/techdocs/CLI-Bank/Data/Tocs/AOS10__Commands__A_Chunk0.js",
            dest="script",
            mode="no-cors",
            referer="https://arubanetworking.hpe.com/techdocs/CLI-Bank/Content/landing-pages/aos10-home.htm",
        )
        self.assertEqual(_header(argv, "Sec-Fetch-Dest"), "script")
        self.assertEqual(_header(argv, "Sec-Fetch-Mode"), "no-cors")
        self.assertEqual(_header(argv, "Sec-Fetch-Site"), "same-origin")

    def test_status_line_splits_from_body(self) -> None:
        status, body = parse_curl_http(b"<html>ok</html>\n200", b"", 0, "https://example.test/a")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"<html>ok</html>")

    def test_transport_error_has_no_status(self) -> None:
        with self.assertRaises(HttpGetError) as caught:
            parse_curl_http(b"", b"curl: (6) Could not resolve host\n", 6, "https://example.test/a")
        self.assertIsNone(caught.exception.status)
        self.assertIn("Could not resolve host", str(caught.exception))

    def test_http_error_status_is_kept(self) -> None:
        status, body = parse_curl_http(b"denied\n403", b"", 0, "https://example.test/a")
        self.assertEqual(status, 403)
        self.assertEqual(body, b"denied")


if __name__ == "__main__":
    unittest.main()
