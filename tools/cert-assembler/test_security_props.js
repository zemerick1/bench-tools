/**
 * Structural security properties for Cert Assembler — reads shipped sources.
 * Run: node tools/cert-assembler/test_security_props.js
 *
 * Locks positive controls and documents known weak crypto choices as present.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

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

const asmJs = readRel("tools/cert-assembler/assembler.js");
const asmHtml = readRel("tools/cert-assembler/index.html");
const vendorReadme = readRel("assets/vendor/README.md");
const headers = readRel("_headers");

console.log("Cert Assembler — security property checks\n");

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
  ok(!re.test(asmJs), `assembler.js has no ${re}`);
}

// --- Key match fail-closed ---
ok(/function keyMatchesCert/.test(asmJs), "keyMatchesCert defined");
ok(
  /match === false/.test(asmJs) && /does NOT match/.test(asmJs),
  "RSA mismatch blocks packaging (match === false path)"
);
ok(
  /match === null/.test(asmJs) && /unsupported key type/i.test(asmJs),
  "Unsupported key type (EC) fails closed — does not claim match"
);

// --- Crypto choices ---
ok(
  /algorithm:\s*"aes256"/.test(asmJs),
  "PEM private key encryption uses aes256"
);
ok(
  /toPkcs12Asn1/.test(asmJs) && /algorithm:\s*"(3des|aes256|aes128)"/.test(asmJs),
  "PKCS#12 build sets an explicit algorithm (currently 3des for compat — see review F15)"
);
ok(
  /allowEmptyPfx|allow-empty-pfx/.test(asmJs) &&
    /Allow empty/.test(asmHtml),
  "Empty PFX password requires explicit allow checkbox"
);
ok(
  /PFX\/P12 needs an output passphrase/.test(asmJs),
  "PFX without passphrase throws unless empty explicitly allowed"
);

// --- XSS hygiene ---
ok(/function escapeHtml/.test(asmJs), "escapeHtml helper defined");
ok(
  /metaRow\.innerHTML[\s\S]*escapeHtml\(/.test(asmJs),
  "metaRow innerHTML escapes dynamic cert fields"
);
ok(
  /escapeHtml\(f\.name\)/.test(asmJs) && /escapeHtml\(f\.note\)/.test(asmJs),
  "download card name/note escaped"
);
ok(
  /li\.textContent\s*=\s*c\.label/.test(asmJs),
  "Verification list uses textContent"
);

// --- Script loading posture ---
ok(
  /src="\.\.\/\.\.\/assets\/vendor\/forge\.min\.js"/.test(asmHtml),
  "HTML loads same-origin vendored forge (not CDN)"
);
ok(/src="\.\/assembler\.js"/.test(asmHtml), "HTML loads local assembler.js");
ok(
  !/<script[^>]+src=["']https?:\/\//i.test(asmHtml),
  "No third-party https script src on assembler page"
);

// --- SRI matches files ---
const forgeIntegrity = sha384Integrity("assets/vendor/forge.min.js");
const asmIntegrity = sha384Integrity("tools/cert-assembler/assembler.js");
ok(
  asmHtml.includes(`integrity="${forgeIntegrity}"`),
  "forge script integrity matches file SHA-384"
);
ok(
  asmHtml.includes(`integrity="${asmIntegrity}"`),
  "assembler.js integrity matches file SHA-384"
);

// --- Vendor pin ---
ok(
  /node-forge\s+1\.3\.1/.test(vendorReadme),
  "Vendor README pins node-forge 1.3.1"
);

// --- Headers / CSP ---
ok(/Content-Security-Policy/.test(headers), "_headers defines Content-Security-Policy");
ok(
  /frame-ancestors 'none'/.test(headers) || /X-Frame-Options:\s*DENY/.test(headers),
  "_headers blocks framing"
);

// --- No Google Fonts ---
ok(
  !/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(asmHtml),
  "Assembler HTML has no Google Fonts origins"
);

// --- Clear path nulls lastBuild ---
ok(
  /lastBuild\s*=\s*null/.test(asmJs) && /clearBtn/.test(asmJs),
  "Clear control nulls lastBuild"
);

// --- Blob URL hygiene ---
ok(
  /createObjectURL/.test(asmJs) && /revokeObjectURL/.test(asmJs),
  "Downloads create and later revoke object URLs"
);

// --- IIFE ---
ok(
  asmJs.includes('(function () {\n  "use strict";') ||
    /^\s*\(function\s*\(\s*\)\s*\{/.test(asmJs.trim()),
  "assembler.js wraps in IIFE with use strict"
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
