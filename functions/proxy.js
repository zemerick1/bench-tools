/**
 * POST /proxy  { url, method, headers, body }
 *
 * Same shape as Aruba-Onboarder functions/proxy.js. The browser talks to
 * this origin only. Whatever host served the page — a 192.168 address, a
 * public name — is the host that receives /proxy. The allowlist is the HPE
 * API, not this site.
 *
 * Read-only on purpose: GET, plus the one GreenLake client-credentials POST.
 * Nothing is stored. Redirects are not followed.
 */

const TOKEN_URL = "https://sso.common.cloud.hpe.com/as/token.oauth2";

const ALLOWED = [
  "sso.common.cloud.hpe.com",
  "global.api.greenlake.hpe.com",
  ".api.central.arubanetworks.com",
  "cn1.api.central.arubanetworks.com.cn",
];

export async function onRequestPost(context) {
  try {
    const { url, method = "GET", headers = {}, body } = await context.request.json();
    const target = allowedTarget(url, method);
    if (target.error) return json({ error: target.error }, target.status);

    const upstream = await fetch(target.href, {
      method: target.method,
      headers: forwardHeaders(headers),
      body: target.method === "GET" ? undefined : body,
      redirect: "manual",
    });

    if (upstream.status >= 300 && upstream.status < 400) {
      return json({ error: "Upstream redirect refused" }, 502);
    }

    const responseHeaders = corsHeaders(upstream.headers.get("content-type") || "application/json");
    for (const name of ["retry-after", "x-request-id", "www-authenticate"]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders[name] = value;
    }
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return json({ error: "Proxy request failed" }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

/** Workers static-assets deploys do not run Pages functions unless a script owns the route. */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/proxy") {
      if (request.method === "OPTIONS") return onRequestOptions();
      if (request.method === "POST") return onRequestPost({ request });
      return json({ error: "POST only" }, 405);
    }
    if (env && env.ASSETS && typeof env.ASSETS.fetch === "function") return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  },
};

export function allowedTarget(url, method) {
  if (!url || typeof url !== "string") return { error: "Missing url parameter", status: 400 };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { error: "Domain not allowed", status: 403 };
  }
  const hostOk = ALLOWED.some((domain) => parsed.hostname === domain || parsed.hostname.endsWith(domain));
  if (!hostOk || parsed.protocol !== "https:" || parsed.username || parsed.password) {
    return { error: "Domain not allowed", status: 403 };
  }
  const verb = String(method || "GET").toUpperCase();
  const tokenPost = verb === "POST" && parsed.origin + parsed.pathname === TOKEN_URL && !parsed.search && !parsed.hash;
  if (verb !== "GET" && !tokenPost) return { error: "Read-only", status: 403 };
  return { href: parsed.href, method: verb };
}

function forwardHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== "object") return out;
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (name === "host" || name === "cookie" || name === "content-length") continue;
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders("application/json") });
}

function corsHeaders(contentType) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
  };
  if (contentType) headers["Content-Type"] = contentType;
  return headers;
}
