/**
 * Read-only GreenLake / Aruba Central client.
 *
 * The page posts to /proxy on whatever origin served it. functions/proxy.js
 * forwards that to HPE and does not store it. Redirects are not followed.
 */

export const TOKEN_URL = "https://sso.common.cloud.hpe.com/as/token.oauth2";

/** Relative, so the call stays on the host that served the page. */
export const PROXY_PATH = "/proxy";

export const MISSING_PROXY =
  "The live check posts to /proxy on this same address. python3 -m http.server refuses that POST. In the terminal already serving this site, stop it and run python3 server.py with the same port, from the repo root. Then reload. Or load a snapshot.";

const READ_ONLY_PATHS = new Set([
  "/network-config/v1alpha1/roles",
  "/network-config/v1alpha1/policies",
  "/network-config/v1alpha1/role-acls",
  "/network-config/v1alpha1/net-services",
  "/network-monitoring/v1/clients",
]);

const HOST_RE = /^[a-z0-9-]+\.api\.central\.arubanetworks\.com(\.cn)?$/i;

/** Clusters published on the Roles & Policy OpenAPI servers list. */
export const CLUSTERS = [
  { id: "us1", label: "US-1", baseUrl: "https://us1.api.central.arubanetworks.com" },
  { id: "us2", label: "US-2", baseUrl: "https://us2.api.central.arubanetworks.com" },
  { id: "us4", label: "US-4", baseUrl: "https://us4.api.central.arubanetworks.com" },
  { id: "us5", label: "US-5", baseUrl: "https://us5.api.central.arubanetworks.com" },
  { id: "us6", label: "US-6", baseUrl: "https://us6.api.central.arubanetworks.com" },
  { id: "ca1", label: "CA-1", baseUrl: "https://ca1.api.central.arubanetworks.com" },
  { id: "de1", label: "EU (DE-1)", baseUrl: "https://de1.api.central.arubanetworks.com" },
  { id: "de2", label: "EU (DE-2)", baseUrl: "https://de2.api.central.arubanetworks.com" },
  { id: "de3", label: "EU (DE-3)", baseUrl: "https://de3.api.central.arubanetworks.com" },
  { id: "gb1", label: "UK (GB-1)", baseUrl: "https://gb1.api.central.arubanetworks.com" },
  { id: "in1", label: "IN-1", baseUrl: "https://in1.api.central.arubanetworks.com" },
  { id: "jp1", label: "JP-1", baseUrl: "https://jp1.api.central.arubanetworks.com" },
  { id: "au1", label: "AU-1", baseUrl: "https://au1.api.central.arubanetworks.com" },
  { id: "ae1", label: "AE-1", baseUrl: "https://ae1.api.central.arubanetworks.com" },
  { id: "cn1", label: "CN-1", baseUrl: "https://cn1.api.central.arubanetworks.com.cn" },
  { id: "internal", label: "Internal", baseUrl: "https://internal.api.central.arubanetworks.com" },
];

/**
 * Remove a client secret if an error body happens to echo it.
 * @param {string} message
 * @param {string} secret
 */
export function scrub(message, secret) {
  const text = String(message || "");
  if (!secret) return text;
  return text.split(String(secret)).join("[secret]");
}

/**
 * Cluster origin only. The token must not be sent to a host the user typed
 * that is not an Aruba Central API cluster.
 * @param {string} baseUrl
 * @returns {string}
 */
export function assertCentralBase(baseUrl) {
  let url;
  try {
    url = new URL(String(baseUrl || "").trim());
  } catch {
    throw new Error("Cluster URL is not a URL.");
  }
  if (url.protocol !== "https:") throw new Error("Cluster URL must be https.");
  if (url.username || url.password) throw new Error("Cluster URL must not include a username or password.");
  if (url.search || url.hash) throw new Error("Cluster URL must be the host only, with no query or hash.");
  if (url.pathname && url.pathname !== "/") {
    throw new Error("Cluster URL must be the host only. Leave off /network-config and anything after it.");
  }
  if (!HOST_RE.test(url.hostname)) {
    throw new Error("That host is not an Aruba Central API cluster (*.api.central.arubanetworks.com).");
  }
  return url.origin;
}

/**
 * GET collections this tool is allowed to read. Anything else is refused
 * before a request is built, including single-object writes and other APIs.
 * @param {string} path
 */
export function assertReadOnlyPath(path) {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new Error("Refusing a path that is not a Central API path.");
  }
  if (path.includes("://") || path.startsWith("//") || path.includes("..") || path.includes("\\")) {
    throw new Error("Refusing path " + path);
  }
  const query = path.indexOf("?");
  const pathname = query === -1 ? path : path.slice(0, query);
  if (!READ_ONLY_PATHS.has(pathname)) {
    throw new Error(
      "Refusing " + pathname + ". This tool only reads roles, policies, role ACLs, and connected clients."
    );
  }
  return path;
}

/**
 * @param {string} clientId
 * @param {string} clientSecret
 * @param {typeof fetch} [fetchImpl]
 */
export async function fetchToken(clientId, clientSecret, fetchImpl = globalThis.fetch) {
  const id = String(clientId || "").trim();
  const secret = String(clientSecret || "");
  if (!id || !secret) throw new Error("Client ID and client secret are both required.");

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: id,
    client_secret: secret,
  }).toString();

  const res = await callProxy(
    TOKEN_URL,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    },
    fetchImpl
  );
  const data = await readProxyJson(res, secret, "GreenLake refused the token (HTTP " + res.status + "). ");
  if (!data || typeof data.access_token !== "string" || !data.access_token) {
    throw new Error("GreenLake token response had no access_token.");
  }
  return {
    accessToken: data.access_token,
    expiresIn: Number(data.expires_in) || 7200,
  };
}

/**
 * @param {string} baseUrl
 * @param {string} token
 * @param {string} path
 * @param {typeof fetch} [fetchImpl]
 */
export async function centralGet(baseUrl, token, path, fetchImpl = globalThis.fetch) {
  const origin = assertCentralBase(baseUrl);
  const safePath = assertReadOnlyPath(path);
  if (!token || typeof token !== "string") throw new Error("Missing access token.");

  const res = await callProxy(
    origin + safePath,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer " + token,
      },
    },
    fetchImpl
  );
  return readProxyJson(res, token, "Central returned HTTP " + res.status + " for " + safePath.split("?")[0] + ". ");
}

/**
 * @param {string} upstreamUrl
 * @param {{ method: string, headers: Record<string, string>, body?: string }} upstreamInit
 * @param {typeof fetch} fetchImpl
 */
async function callProxy(upstreamUrl, upstreamInit, fetchImpl) {
  const payload = {
    url: upstreamUrl,
    method: upstreamInit.method,
    headers: upstreamInit.headers,
  };
  if (typeof upstreamInit.body === "string") payload.body = upstreamInit.body;

  try {
    return await fetchImpl(PROXY_PATH, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
  } catch (err) {
    if (isBrowserBlock(err)) {
      throw new Error("The browser could not reach /proxy on this origin. Nothing was forwarded to HPE.");
    }
    throw err;
  }
}

/**
 * @param {{ ok: boolean, status: number, statusText?: string, headers?: { get(name: string): string | null }, text(): Promise<string> }} res
 * @param {string} secret
 * @param {string} prefix
 */
async function readProxyJson(res, secret, prefix) {
  const type = responseType(res);
  let text = "";
  try {
    text = await res.text();
  } catch (err) {
    if (isBrowserBlock(err)) {
      throw new Error("The browser could not read /proxy on this origin. Nothing further was forwarded to HPE.");
    }
    throw err;
  }
  if (missingProxy(res, type, text)) throw new Error(MISSING_PROXY);
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg = (data && (data.error_description || data.message || data.error)) || String(text || "").slice(0, 240) || res.statusText || "";
    throw new Error(prefix + scrub(msg, secret));
  }
  return data;
}

function responseType(res) {
  const value = headerValue(res, "content-type");
  if (value === undefined) return "application/json";
  return value;
}

function headerValue(res, name) {
  if (!res || !res.headers || typeof res.headers.get !== "function") return undefined;
  const value = res.headers.get(name);
  return value == null ? "" : value;
}

function missingProxy(res, type, text) {
  if (!res || !res.headers || typeof res.headers.get !== "function") return false;
  if (/text\/html/i.test(type || "")) return true;
  if (res.status === 404 || res.status === 501) return true;
  if (res.status === 405 && !/json/i.test(type || "")) return true;
  if (String(text || "").trim().startsWith("<")) return true;
  return false;
}

function isBrowserBlock(err) {
  if (!err) return false;
  if (err.name === "TypeError") return true;
  return /failed to fetch|networkerror|load failed/i.test(String(err.message || ""));
}

/**
 * @param {unknown} body
 * @param {string[]} keys
 */
export function listFrom(body, keys) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return [];
  for (const key of keys) {
    if (Array.isArray(body[key])) return body[key];
  }
  return [];
}

/**
 * Read a config collection.
 * view-type=LIBRARY returns the shared library in one response. The roles,
 * policies, and role-ACL APIs reject limit and offset on that view
 * ("Invalid query parameter"). Other paths page with limit/offset.
 * @param {(path: string) => Promise<unknown>} getJson
 * @param {string} path
 * @param {string[]} listKeys
 */
export async function getAllPages(getJson, path, listKeys) {
  if (/(?:^|[?&])view-type=LIBRARY(?:&|$)/.test(path)) {
    const body = await getJson(path);
    return { items: listFrom(body, listKeys), truncated: false };
  }
  const pageSize = 100;
  const all = [];
  let offset = 0;
  let truncated = false;
  let prevSig = "";
  for (let page = 0; page < 50; page++) {
    const joiner = path.includes("?") ? "&" : "?";
    const body = await getJson(path + joiner + "limit=" + pageSize + "&offset=" + offset);
    const chunk = listFrom(body, listKeys);
    const sig = chunk
      .slice(0, 5)
      .map((item) => (item && (item.name || item.position)) || "")
      .join("|");
    if (page > 0 && sig && sig === prevSig) break;
    prevSig = sig;
    all.push(...chunk);
    if (chunk.length < pageSize) {
      truncated = false;
      break;
    }
    offset += chunk.length;
    truncated = page === 49;
  }
  return { items: all, truncated };
}

/**
 * Connected clients, paged with the monitoring cursor. Capped so a huge
 * tenant cannot pin the tab. `truncated` means the count is a sample.
 * @param {(path: string) => Promise<unknown>} getJson
 */
export async function getConnectedClients(getJson) {
  const items = [];
  let next = "";
  let total = null;
  let truncated = false;
  const pageCap = 10;
  for (let page = 0; page < pageCap; page++) {
    const q = new URLSearchParams();
    q.set("limit", "1000");
    q.set("filter", "status eq 'Connected'");
    if (next) q.set("next", next);
    const body = await getJson("/network-monitoring/v1/clients?" + q.toString());
    const chunk = listFrom(body, ["items", "clients"]);
    items.push(...chunk);
    if (body && typeof body.total === "number") total = body.total;
    const cursor = body && body.next ? String(body.next) : "";
    if (!cursor || chunk.length === 0) {
      truncated = false;
      break;
    }
    next = cursor;
    truncated = page === pageCap - 1;
  }
  return { items, total, truncated, error: null };
}

/**
 * Pull the shared library (view-type=LIBRARY) plus connected-client counts.
 * Client-count failure does not throw — config is still auditable.
 * @param {string} baseUrl
 * @param {string} token
 * @param {{ fetchImpl?: typeof fetch, onProgress?: (msg: string) => void }} [opts]
 */
export async function loadAuditSnapshot(baseUrl, token, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const onProgress = opts.onProgress || (() => {});
  const getJson = (path) => centralGet(baseUrl, token, path, fetchImpl);

  onProgress("Reading roles");
  const roles = await getAllPages(getJson, "/network-config/v1alpha1/roles?view-type=LIBRARY", ["role", "roles"]);
  onProgress("Reading policies");
  const policies = await getAllPages(getJson, "/network-config/v1alpha1/policies?view-type=LIBRARY", ["policy", "policies"]);
  onProgress("Reading role ACLs");
  const roleAcls = await getAllPages(getJson, "/network-config/v1alpha1/role-acls?view-type=LIBRARY", ["acl", "role-acls"]);

  let netServices = { items: [], total: null, truncated: false, error: null };
  onProgress("Reading net services");
  try {
    netServices = await getAllPages(getJson, "/network-config/v1alpha1/net-services?view-type=LIBRARY", ["net-service", "net-services"]);
  } catch (err) {
    netServices = {
      items: [],
      truncated: false,
      error: err && err.message ? err.message : String(err),
    };
  }

  let clients = { items: [], total: null, truncated: false, error: null };
  onProgress("Counting connected clients");
  try {
    clients = await getConnectedClients(getJson);
  } catch (err) {
    clients = {
      items: [],
      total: null,
      truncated: false,
      error: err && err.message ? err.message : String(err),
    };
  }

  return { roles, policies, roleAcls, netServices, clients };
}
