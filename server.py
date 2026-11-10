#!/usr/bin/env python3
"""Static files, plus POST /proxy. Same rules as functions/proxy.js.

    python3 server.py 8001

python3 -m http.server serves the pages and answers POST with 501.
This replaces that command when a live Central check has to run.
Nothing is stored. Redirects are not followed. Request bodies are not logged.
"""

from __future__ import annotations

import json
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import http.client
import ssl
from urllib.parse import urlsplit

TOKEN_URL = "https://sso.common.cloud.hpe.com/as/token.oauth2"
ALLOWED = (
    "sso.common.cloud.hpe.com",
    "global.api.greenlake.hpe.com",
    ".api.central.arubanetworks.com",
    "cn1.api.central.arubanetworks.com.cn",
)


def allowed_target(url, method):
    if not isinstance(url, str) or not url:
        return {"error": "Missing url parameter", "status": 400}
    parts = urlsplit(url)
    host = parts.hostname or ""
    host_ok = any(host == domain or host.endswith(domain) for domain in ALLOWED)
    if parts.scheme != "https" or not host_ok or parts.username or parts.password:
        return {"error": "Domain not allowed", "status": 403}
    verb = str(method or "GET").upper()
    origin = parts.scheme + "://" + host
    if parts.port and parts.port != 443:
        origin += ":" + str(parts.port)
    token_post = (
        verb == "POST"
        and origin + (parts.path or "") == TOKEN_URL
        and not parts.query
        and not parts.fragment
    )
    if verb != "GET" and not token_post:
        return {"error": "Read-only", "status": 403}
    return {"href": url, "method": verb}


def forward(href, method, headers, body):
    parts = urlsplit(href)
    path = parts.path or "/"
    if parts.query:
        path += "?" + parts.query
    conn = http.client.HTTPSConnection(parts.hostname, parts.port or 443, timeout=60, context=ssl.create_default_context())
    try:
        payload = None
        if method != "GET" and body is not None:
            payload = body.encode("utf-8") if isinstance(body, str) else body
        conn.request(method, path, body=payload, headers=headers)
        resp = conn.getresponse()
        status = resp.status
        raw = resp.read()
        picked = {}
        for name in ("content-type", "retry-after", "x-request-id", "www-authenticate"):
            value = resp.getheader(name)
            if value:
                picked[name] = value
        return status, raw, picked
    finally:
        conn.close()


class Handler(SimpleHTTPRequestHandler):
    def do_OPTIONS(self):
        if self.path.split("?", 1)[0] != "/proxy":
            self.send_error(501, "Unsupported method ('OPTIONS')")
            return
        self._send(204, b"", "text/plain", {})

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/proxy":
            self.send_error(501, "Unsupported method ('POST')")
            return
        self._proxy()

    def _proxy(self):
        try:
            length = int(self.headers.get("Content-Length") or "0")
            raw = self.rfile.read(length) if length else b""
            data = json.loads(raw.decode("utf-8"))
            target = allowed_target(data.get("url"), data.get("method") or "GET")
            if "error" in target:
                self._json({"error": target["error"]}, target["status"])
                return
            headers = {}
            incoming = data.get("headers") or {}
            if isinstance(incoming, dict):
                for key, value in incoming.items():
                    if isinstance(value, str) and key.lower() not in ("host", "cookie", "content-length"):
                        headers[key] = value
            status, payload, picked = forward(
                target["href"],
                target["method"],
                headers,
                None if target["method"] == "GET" else data.get("body"),
            )
            if 300 <= status < 400:
                self._json({"error": "Upstream redirect refused"}, 502)
                return
            extra = {key: value for key, value in picked.items() if key != "content-type"}
            self._send(status, payload, picked.get("content-type") or "application/json", extra)
        except Exception:
            self._json({"error": "Proxy request failed"}, 500)

    def _json(self, obj, status):
        self._send(status, json.dumps(obj).encode("utf-8"), "application/json", {})

    def _send(self, status, body, content_type, extra):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Cache-Control", "no-store")
        for key, value in extra.items():
            self.send_header(key, value)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    ThreadingHTTPServer.allow_reuse_address = True
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print("http://0.0.0.0:%s  static files, POST /proxy" % port, flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
