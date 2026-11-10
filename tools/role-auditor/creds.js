/**
 * GreenLake credentials for the role auditor.
 *
 * Stored in this browser's localStorage. The access token stays in memory
 * for the check that asked for it. A live check posts the secret to /proxy
 * on this origin. The proxy sees it in flight and does not store it.
 * There is no database.
 */

export const CREDS_KEY = "bt-role-auditor-creds";
export const RULES_KEY = "bt-role-auditor-rules";
export const EXTRA_RULES_KEY = "bt-role-auditor-extra";

const CRED_FIELDS = ["baseUrl", "clientId", "clientSecret"];

function storage() {
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}

/**
 * @param {object} creds
 * @returns {{ baseUrl: string, clientId: string, clientSecret: string }}
 */
export function saveCreds(creds) {
  const store = storage();
  const clean = {};
  for (const key of CRED_FIELDS) clean[key] = String((creds && creds[key]) || "");
  if (!store) return clean;
  store.setItem(CREDS_KEY, JSON.stringify(clean));
  return clean;
}

/** @returns {{ baseUrl: string, clientId: string, clientSecret: string } | null} */
export function loadCreds() {
  const store = storage();
  if (!store) return null;
  const raw = store.getItem(CREDS_KEY);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return null;
    const clean = {};
    for (const key of CRED_FIELDS) clean[key] = String(data[key] || "");
    return clean;
  } catch {
    return null;
  }
}

export function clearCreds() {
  const store = storage();
  if (!store) return;
  store.removeItem(CREDS_KEY);
}

/** @returns {Record<string, boolean>} */
export function loadRuleToggles() {
  const store = storage();
  if (!store) return {};
  try {
    const data = JSON.parse(store.getItem(RULES_KEY) || "{}");
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const out = {};
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === "boolean") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** @param {Record<string, boolean>} toggles */
export function saveRuleToggles(toggles) {
  const store = storage();
  if (!store) return;
  const clean = {};
  for (const [key, value] of Object.entries(toggles || {})) {
    if (typeof value === "boolean") clean[String(key).slice(0, 80)] = value;
  }
  store.setItem(RULES_KEY, JSON.stringify(clean));
}

export function loadExtraRulesText() {
  const store = storage();
  if (!store) return "";
  return store.getItem(EXTRA_RULES_KEY) || "";
}

/** @param {string} text */
export function saveExtraRulesText(text) {
  const store = storage();
  if (!store) return;
  store.setItem(EXTRA_RULES_KEY, String(text || ""));
}
