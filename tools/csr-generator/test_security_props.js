/**
 * Structural security properties for CSR Generator — reads shipped sources.
 * Run: node tools/csr-generator/test_security_props.js
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");

let passed = 0;
let failed = 0;

/** @param {boolean} cond @param {string} msg */
function ok(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ok  — ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL — ${msg}`);
  }
}

function readRel(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function sha384Integrity(rel) {
  const buf = fs.readFileSync(path.join(root, rel));
  return "sha384-" + crypto.createHash("sha384").update(buf).digest("base64");
}

const csrJs = readRel("tools/csr-generator/csr.js");
const csrHtml = readRel("tools/csr-generator/index.html");
const vendorReadme = readRel("assets/vendor/README.md");
const headers = readRel("_headers");
const styles = readRel("assets/css/styles.css");

console.log("CSR Generator — security property checks\n");

// --- Egress: no network / storage APIs in shipped app JS ---
const egressPatterns = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bsendBeacon\s*\(/,
  /\bWebSocket\b/,
  /\bEventSource\b/,
  /\blocalStorage\b/,
  /\bsessionStorage\b/,
  /\bindexedDB\b/,
  /\bdocument\.cookie\b/,
];
for (const re of egressPatterns) {
  ok(!re.test(csrJs), `csr.js has no ${re}`);
}

// --- Crypto floors ---
ok(
  /value:\s*"2048"/.test(csrJs) && !/value:\s*"1024"/.test(csrJs),
  "RSA options include 2048 and exclude 1024"
);
ok(/SHA256withRSA/.test(csrJs), "CSR uses SHA256withRSA");
ok(/SHA256withECDSA/.test(csrJs) && /SHA384withECDSA/.test(csrJs), "EC sig algs SHA-256/384");
ok(/AES-256-CBC/.test(csrJs), "Encrypted PKCS#8 uses AES-256-CBC");
ok(
  /MIN_PASSPHRASE_LEN\s*=\s*12/.test(csrJs),
  "Passphrase minimum length is 12 when encrypting"
);
ok(
  /allowUnencrypted|allow-unencrypted/.test(csrJs) &&
    /allow-unencrypted/.test(csrHtml),
  "Blank (unencrypted) key requires explicit allow checkbox"
);
ok(
  /function forgetSecrets/.test(csrJs) && /lastResult\s*=\s*null/.test(csrJs),
  "forgetSecrets clears lastResult key material"
);
ok(
  /beforeunload/.test(csrJs),
  "beforeunload warns when key material is still in the tab"
);
ok(
  /clear-secrets-btn|clearSecretsBtn/.test(csrJs) &&
    /clear-secrets-btn/.test(csrHtml),
  "UI exposes Clear key from this tab control"
);

// --- Verify path exists ---
ok(
  /CSRUtil\.verifySignature/.test(csrJs) && /publicKeysMatch/.test(csrJs),
  "Post-gen verification calls CSRUtil.verifySignature and publicKeysMatch"
);
ok(
  /function verifyOutput/.test(csrJs) && /checks\.every/.test(csrJs),
  "verifyOutput aggregates checks with every()"
);

// --- XSS hygiene ---
ok(/function escapeHtml/.test(csrJs), "escapeHtml helper defined");
ok(
  /&#39;|replaceAll\("'"/.test(csrJs),
  "escapeHtml encodes single quotes"
);
ok(
  csrJs.includes("els.sanTip.innerHTML") && csrJs.includes("escapeHtml("),
  "sanTip innerHTML paths use escapeHtml for dynamic values"
);
ok(
  /pemView\.textContent|els\.pemView\.textContent/.test(csrJs),
  "PEM view uses textContent (not innerHTML)"
);
ok(
  /li\.textContent\s*=\s*check\.label/.test(csrJs),
  "Verification list items use textContent"
);

// --- Script loading + SRI ---
ok(
  /src="\.\.\/\.\.\/assets\/vendor\/jsrsasign-all-min\.js"/.test(csrHtml),
  "HTML loads same-origin vendored jsrsasign (not a third-party CDN script)"
);
ok(/src="\.\/csr\.js"/.test(csrHtml), "HTML loads local csr.js");
ok(
  !/<script[^>]+src=["']https?:\/\//i.test(csrHtml),
  "No third-party https script src on CSR page"
);

const jsrsasignIntegrity = sha384Integrity("assets/vendor/jsrsasign-all-min.js");
const csrJsIntegrity = sha384Integrity("tools/csr-generator/csr.js");
ok(
  csrHtml.includes(`integrity="${jsrsasignIntegrity}"`),
  "jsrsasign script integrity matches file SHA-384"
);
ok(
  csrHtml.includes(`integrity="${csrJsIntegrity}"`),
  "csr.js script integrity matches file SHA-384"
);

// --- Vendor pin ---
ok(
  /jsrsasign\s+11\.1\.0/.test(vendorReadme),
  "Vendor README pins jsrsasign 11.1.0"
);

// --- Headers / CSP ---
ok(
  /Content-Security-Policy/.test(headers),
  "_headers defines Content-Security-Policy"
);
ok(
  /frame-ancestors 'none'/.test(headers) || /X-Frame-Options:\s*DENY/.test(headers),
  "_headers blocks framing"
);
ok(/X-Content-Type-Options:\s*nosniff/.test(headers), "_headers sets nosniff");
ok(/Referrer-Policy:/.test(headers), "_headers sets Referrer-Policy");

// --- Self-hosted fonts ---
ok(
  !/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(csrHtml),
  "CSR HTML has no Google Fonts origins"
);
ok(
  /@font-face/.test(styles) && /ibm-plex-sans-latin-400-normal\.woff2/.test(styles),
  "styles.css self-hosts IBM Plex via @font-face"
);
ok(
  fs.existsSync(path.join(root, "assets/fonts/ibm-plex-sans-latin-400-normal.woff2")),
  "Self-hosted sans 400 woff2 file exists"
);

// --- Filename sanitization ---
ok(
  csrJs.includes(".replace(/[^a-z0-9._-]+/g"),
  "fileBaseName sanitizes download names to safe charset"
);

// --- IIFE isolation ---
ok(
  csrJs.includes('(function () {\n  "use strict";'),
  "csr.js wraps in IIFE with use strict"
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
