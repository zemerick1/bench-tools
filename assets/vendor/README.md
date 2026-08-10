jsrsasign 11.1.0 — https://github.com/kjur/jsrsasign (BSD-2-Clause).
node-forge 1.3.1 — https://github.com/digitalbazaar/forge (BSD-3-Clause OR GPL-2.0).
Vendored browser builds; no Node/npm required at runtime.

After replacing a vendor (or tool) `.js` file, refresh `integrity="sha384-…"` on
the corresponding `<script>` tags in tool HTML:

```bash
openssl dgst -sha384 -binary path/to/file.js | openssl base64 -A
```

Then set `integrity="sha384-<output>"`. Do not add `crossorigin` for same-origin
scripts (it forces a CORS fetch and can break loading on static hosts).
