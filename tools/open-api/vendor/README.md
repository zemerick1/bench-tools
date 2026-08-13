# Scalar API Reference (pinned)

`@scalar/api-reference@1.64.1` standalone browser build, served from this
origin so the site-wide CSP (`script-src 'self'`) can load it.

Cloudflare applies both `/*` and `/tools/open-api/` Content-Security-Policy
headers. Browsers AND those policies, so a path-specific allow-list for
cdn.jsdelivr.net never takes effect.

Refresh:

```bash
curl -fsSL "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.64.1/dist/browser/standalone.js" \
  -o scalar-api-reference-1.64.1.js
```
