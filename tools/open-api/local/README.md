# Hand-dropped OpenAPI sources

Specs that are **not** on the HPE developer hub (Mist, Security Director
Cloud, Axis, …). The build copies this tree into gitignored `source/`
before a hub fetch so GitHub Actions still publishes those platforms.

Drop a file at `local/<api-id>/<name>.json` (same layout as `source/`).
Hub-fetched specs (Central, ClearPass, AOS-CX, UXI) do not belong here.
