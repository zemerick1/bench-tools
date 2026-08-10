/**
 * CSR Generator — pure browser, no server, no Node.
 * Crypto via vendored jsrsasign (assets/vendor/jsrsasign-all-min.js).
 */

(function () {
  "use strict";

  /** @type {{ privateKeyPem: string, csrPem: string, label: string, encrypted: boolean } | null} */
  let lastResult = null;

  /** SAN hostnames we last auto-inserted from the CN (lowercase). */
  let autoSansFromCn = [];

  /** Minimum passphrase length when encrypting the private key PEM. */
  const MIN_PASSPHRASE_LEN = 12;

  const $ = (id) => document.getElementById(id);

  const els = {
    form: $("csr-form"),
    cn: $("cn"),
    sans: $("sans"),
    sanTip: $("san-tip"),
    keyType: $("key-type"),
    keySize: $("key-size"),
    keySizeLabel: $("key-size-label"),
    passphrase: $("passphrase"),
    passphrase2: $("passphrase2"),
    allowUnencrypted: $("allow-unencrypted"),
    unencryptedWarn: $("unencrypted-warn"),
    passTip: $("pass-tip"),
    org: $("org"),
    ou: $("ou"),
    locality: $("locality"),
    state: $("state"),
    country: $("country"),
    email: $("email"),
    generateBtn: $("generate-btn"),
    clearSecretsBtn: $("clear-secrets-btn"),
    clearResultsBtn: $("clear-results-btn"),
    status: $("status"),
    openssl: $("openssl-cmd"),
    copyOpenssl: $("copy-openssl"),
    results: $("results"),
    metaCn: $("meta-cn"),
    metaKey: $("meta-key"),
    metaSans: $("meta-sans"),
    pemView: $("pem-view"),
    tabCsr: $("tab-csr"),
    tabKey: $("tab-key"),
    downloadCsr: $("download-csr"),
    downloadKey: $("download-key"),
    downloadBoth: $("download-both"),
    copyPem: $("copy-pem"),
    verifyBanner: $("verify-banner"),
    verifyMark: $("verify-mark"),
    verifyTitle: $("verify-title"),
    verifySummary: $("verify-summary"),
    verifyList: $("verify-list"),
  };

  const RSA_SIZES = [
    { value: "2048", label: "2048 (recommended)" },
    { value: "3072", label: "3072" },
    { value: "4096", label: "4096" },
  ];

  const EC_CURVES = [
    { value: "P-256", label: "P-256 (recommended)" },
    { value: "P-384", label: "P-384" },
  ];

  function setStatus(message, tone) {
    els.status.textContent = message || "";
    if (tone) els.status.dataset.tone = tone;
    else delete els.status.dataset.tone;
  }

  function parseSans(cn, sansText) {
    const raw = String(sansText || "")
      .split(/[\n,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    const list = [];
    const seen = new Set();

    function add(name) {
      const n = name.trim().toLowerCase();
      if (!n || seen.has(n)) return;
      seen.add(n);
      list.push(n);
    }

    if (cn) add(cn);
    raw.forEach(add);
    return list;
  }

  function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
  }

  function subjectFromForm() {
    const parts = [];
    const cn = els.cn.value.trim();
    if (cn) parts.push(["CN", cn]);
    if (els.org.value.trim()) parts.push(["O", els.org.value.trim()]);
    if (els.ou.value.trim()) parts.push(["OU", els.ou.value.trim()]);
    if (els.locality.value.trim()) parts.push(["L", els.locality.value.trim()]);
    if (els.state.value.trim()) parts.push(["ST", els.state.value.trim()]);
    if (els.country.value.trim()) {
      parts.push(["C", els.country.value.trim().toUpperCase()]);
    }
    if (els.email.value.trim()) {
      parts.push(["emailAddress", els.email.value.trim()]);
    }
    return parts;
  }

  function subjectOpenSslString(parts) {
    return (
      "/" +
      parts
        .map(([k, v]) => `${k}=${v.replace(/[\/\\]/g, "")}`)
        .join("/")
    );
  }

  function subjectJsrsasignString(parts) {
    return subjectOpenSslString(parts);
  }

  function updateKeySizeOptions() {
    const type = els.keyType.value;
    const options = type === "ECDSA" ? EC_CURVES : RSA_SIZES;
    const prev = els.keySize.value;

    els.keySizeLabel.textContent = type === "ECDSA" ? "Curve" : "Key size";
    els.keySize.innerHTML = options
      .map((o) => `<option value="${o.value}">${o.label}</option>`)
      .join("");

    const stillValid = options.some((o) => o.value === prev);
    els.keySize.value = stillValid ? prev : options[0].value;
  }

  function buildOpensslCommand() {
    const type = els.keyType.value;
    const size = els.keySize.value;
    const parts = subjectFromForm();
    const cn = els.cn.value.trim() || "example.com";
    if (!parts.find(([k]) => k === "CN")) parts.unshift(["CN", cn]);

    const sans = parseSans(cn, els.sans.value);
    const subj = subjectOpenSslString(parts);
    const sanExt = sans.map((d) => `DNS:${d}`).join(",");
    const pass = els.passphrase ? els.passphrase.value : "";
    const encryptKey = Boolean(pass);

    const header =
      "# OpenSSL 1.1.1+ (or LibreSSL with -addext). Run locally — your key never leaves your machine.";

    if (type === "ECDSA") {
      const curve = size === "P-384" ? "secp384r1" : "prime256v1";
      if (encryptKey) {
        return [
          header,
          `# Private key encrypted with your passphrase (you'll be prompted, or use -passout).`,
          `openssl ecparam -name ${curve} -genkey -noout | \\`,
          `  openssl ec -aes256 -passout pass:YOUR_PASSPHRASE -out private.key`,
          `openssl req -new -key private.key -passin pass:YOUR_PASSPHRASE -out request.csr \\`,
          `  -subj ${shellQuote(subj)} \\`,
          `  -addext ${shellQuote("subjectAltName=" + sanExt)}`,
        ].join("\n");
      }
      return [
        header,
        `openssl ecparam -name ${curve} -genkey -noout -out private.key`,
        `openssl req -new -key private.key -out request.csr \\`,
        `  -subj ${shellQuote(subj)} \\`,
        `  -addext ${shellQuote("subjectAltName=" + sanExt)}`,
      ].join("\n");
    }

    if (encryptKey) {
      return [
        header,
        `# -nodes omitted so the key is encrypted; replace YOUR_PASSPHRASE or use prompts.`,
        `openssl req -new -newkey rsa:${size} \\`,
        `  -keyout private.key -out request.csr \\`,
        `  -passout pass:YOUR_PASSPHRASE \\`,
        `  -subj ${shellQuote(subj)} \\`,
        `  -addext ${shellQuote("subjectAltName=" + sanExt)}`,
      ].join("\n");
    }

    return [
      header,
      `openssl req -new -newkey rsa:${size} -nodes \\`,
      `  -keyout private.key -out request.csr \\`,
      `  -subj ${shellQuote(subj)} \\`,
      `  -addext ${shellQuote("subjectAltName=" + sanExt)}`,
    ].join("\n");
  }

  function refreshOpenssl() {
    els.openssl.textContent = buildOpensslCommand();
  }

  function looksLikeHostname(value) {
    const h = String(value || "")
      .trim()
      .toLowerCase();
    if (!h || h.length > 253) return false;
    if (h.includes(" ") || h.includes("/") || h.includes(":")) return false;
    // hostname with at least one dot (skip bare words like "localhost" for www-suggest)
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(h)) {
      return false;
    }
    return true;
  }

  /**
   * Guess companion names for the CN:
   * - example.com  → www.example.com
   * - www.example.com → example.com
   * Skip multi-label hosts like api.example.com (www.api… is almost never wanted).
   */
  function companionSansForCn(cnRaw) {
    const cn = String(cnRaw || "")
      .trim()
      .toLowerCase();
    if (!looksLikeHostname(cn)) return [];

    if (cn.startsWith("www.")) {
      const apex = cn.slice(4);
      if (looksLikeHostname(apex) && apex.split(".").length === 2) {
        return [apex];
      }
      return [];
    }

    // Apex-style: name.tld only (one dot)
    if (cn.split(".").length === 2) {
      return [`www.${cn}`];
    }
    return [];
  }

  function sanFieldEntries() {
    return String(els.sans.value || "")
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /**
   * Keep SANs in sync with a sensible www/apex pair when the CN changes.
   * Only mutates entries we previously auto-inserted (or are newly suggested).
   */
  function syncAutoSansFromCn() {
    const nextAuto = companionSansForCn(els.cn.value);
    const nextAutoSet = new Set(nextAuto.map((s) => s.toLowerCase()));
    const prevAutoSet = new Set(autoSansFromCn);

    let entries = sanFieldEntries();

    // Drop previous auto entries still present (user can re-type if they want them)
    entries = entries.filter((e) => !prevAutoSet.has(e.toLowerCase()));

    // Append new auto entries if not already present under another spelling
    for (const host of nextAuto) {
      if (!entries.some((e) => e.toLowerCase() === host.toLowerCase())) {
        entries.push(host);
      }
    }

    autoSansFromCn = nextAuto.map((s) => s.toLowerCase());
    els.sans.value = entries.join("\n");
  }

  /**
   * Nudge users to fill SANs — modern TLS cares about SAN more than CN.
   * Tip softens once they add an extra name (or at least type something).
   */
  function refreshSanTip() {
    if (!els.sanTip) return;

    const cn = els.cn.value.trim().toLowerCase();
    const typed = String(els.sans.value || "")
      .split(/[\n,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const uniqueExtra = typed.filter((s) => s && s !== cn);
    const auto = companionSansForCn(cn);

    if (!cn && typed.length === 0) {
      els.sanTip.classList.remove("hidden");
      els.sanTip.dataset.tone = "";
      els.sanTip.innerHTML =
        `<strong>SAN tip:</strong> Type an apex domain in CN (e.g. ` +
        `<span class="inline-code">example.com</span>) and we’ll add ` +
        `<span class="inline-code">www.example.com</span> here automatically. ` +
        `The CN is also folded into the CSR SAN list when you generate.`;
      return;
    }

    if (auto.length && uniqueExtra.some((s) => auto.includes(s))) {
      els.sanTip.classList.remove("hidden");
      els.sanTip.dataset.tone = "ok";
      els.sanTip.innerHTML =
        `<strong>Auto-filled.</strong> Added ` +
        `<span class="inline-code">${escapeHtml(auto.join(", "))}</span> ` +
        `from your CN so apex + www are both covered. Edit SANs anytime — ` +
        `CSR will include CN + whatever’s listed here.`;
      return;
    }

    if (uniqueExtra.length === 0) {
      els.sanTip.classList.remove("hidden");
      els.sanTip.dataset.tone = "";
      const name = cn || "your hostname";
      els.sanTip.innerHTML =
        `<strong>Single-name check:</strong> Right now the cert will only ` +
        `cover <span class="inline-code">${escapeHtml(name)}</span> ` +
        `(via CN → SAN). Add more hosts here if needed.`;
      return;
    }

    els.sanTip.classList.remove("hidden");
    els.sanTip.dataset.tone = "ok";
    els.sanTip.innerHTML =
      `<strong>Nice.</strong> You’ll have ` +
      `<span class="inline-code">${escapeHtml(
        parseSans(cn, els.sans.value).join(", ")
      )}</span> on the request.`;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  /**
   * Show/hide the loud unencrypted-key warning; keep tip honest about the mode.
   */
  function refreshPassphraseUi() {
    const pass = (els.passphrase && els.passphrase.value) || "";
    const pass2 = (els.passphrase2 && els.passphrase2.value) || "";
    const allow =
      els.allowUnencrypted && els.allowUnencrypted.checked;
    const blank = !pass && !pass2;

    if (els.unencryptedWarn) {
      const showWarn = allow && blank;
      els.unencryptedWarn.classList.toggle("hidden", !showWarn);
    }

    if (els.passTip) {
      if (allow && blank) {
        els.passTip.dataset.tone = "danger";
        els.passTip.innerHTML =
          `<strong>Unencrypted export enabled.</strong> ` +
          `Both passphrase fields are blank and you opted in. The ` +
          `<span class="inline-code">.key</span> will be readable by anyone ` +
          `who gets the file. Only do this when a device requires it.`;
      } else if (pass || pass2) {
        els.passTip.dataset.tone = "";
        els.passTip.innerHTML =
          `<strong>Protect the key.</strong> ` +
          `Use at least ${MIN_PASSPHRASE_LEN} characters; both fields must match. ` +
          `You’ll need this passphrase later in Cert Assembler or on the server.`;
      } else {
        els.passTip.dataset.tone = "";
        els.passTip.innerHTML =
          `<strong>Protect the key.</strong> ` +
          `A passphrase (${MIN_PASSPHRASE_LEN}+ characters) encrypts the private key PEM at rest. ` +
          `Prefer that whenever the target allows it. To force a blank (unencrypted) key, ` +
          `check the box below and read the warning.`;
      }
    }
  }

  /**
   * Drop private key / CSR material from memory and the DOM.
   * Does not delete files already downloaded to disk.
   */
  function forgetSecrets(opts) {
    const silent = opts && opts.silent;
    lastResult = null;
    if (els.pemView) els.pemView.textContent = "";
    if (els.results) els.results.classList.add("hidden");
    if (els.verifyList) els.verifyList.innerHTML = "";
    if (els.metaCn) els.metaCn.textContent = "—";
    if (els.metaKey) els.metaKey.textContent = "—";
    if (els.metaSans) els.metaSans.textContent = "—";
    if (els.passphrase) els.passphrase.value = "";
    if (els.passphrase2) els.passphrase2.value = "";
    if (els.allowUnencrypted) els.allowUnencrypted.checked = false;
    refreshPassphraseUi();
    if (!silent) {
      setStatus(
        "Key material cleared from this tab (downloads on disk are unchanged).",
        "ok"
      );
    }
  }

  function fileBaseName() {
    const cn = (els.cn.value.trim() || "certificate")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const stamp = new Date().toISOString().slice(0, 10);
    return `${cn || "certificate"}-${stamp}`;
  }

  function downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: mime || "application/x-pem-file" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function showPem(which) {
    if (!lastResult) return;
    const isKey = which === "key";
    els.pemView.textContent = isKey
      ? lastResult.privateKeyPem
      : lastResult.csrPem;
    els.tabCsr.setAttribute("aria-selected", isKey ? "false" : "true");
    els.tabKey.setAttribute("aria-selected", isKey ? "true" : "false");
  }

  function normalizePem(pem) {
    return String(pem || "")
      .replace(/\r/g, "")
      .replace(/-----[^-]+-----/g, "")
      .replace(/\s+/g, "");
  }

  function subjectMapFromParam(param) {
    /** @type {Record<string, string>} */
    const map = {};
    const rows = (param && param.subject && param.subject.array) || [];
    for (const row of rows) {
      const attrs = Array.isArray(row) ? row : [row];
      for (const attr of attrs) {
        if (!attr || !attr.type) continue;
        const key =
          attr.type === "E" || attr.type === "EMAIL"
            ? "emailAddress"
            : attr.type;
        map[key] = String(attr.value || "");
      }
    }
    return map;
  }

  function sansFromParam(param) {
    const extreq = (param && param.extreq) || [];
    const sanExt = extreq.find(
      (e) => e && (e.extname === "subjectAltName" || e.extname === "san")
    );
    if (!sanExt || !Array.isArray(sanExt.array)) return [];
    return sanExt.array
      .map((entry) => {
        if (entry.dns) return String(entry.dns).toLowerCase();
        if (entry.ip) return String(entry.ip).toLowerCase();
        if (entry.rfc822) return String(entry.rfc822).toLowerCase();
        if (entry.email) return String(entry.email).toLowerCase();
        return "";
      })
      .filter(Boolean)
      .sort();
  }

  function sameStringSet(a, b) {
    if (a.length !== b.length) return false;
    const sa = [...a].map((x) => x.toLowerCase()).sort();
    const sb = [...b].map((x) => x.toLowerCase()).sort();
    return sa.every((v, i) => v === sb[i]);
  }

  function publicKeysMatch(privateKeyPem, csrPublicKeyPem, passphrase) {
    const prv = passphrase
      ? KEYUTIL.getKey(privateKeyPem, passphrase)
      : KEYUTIL.getKey(privateKeyPem);
    const pub = KEYUTIL.getKey(csrPublicKeyPem);

    // RSA: modulus + exponent
    if (prv.n && pub.n) {
      const nOk = prv.n.equals(pub.n);
      const eOk =
        prv.e === pub.e ||
        (prv.e && pub.e && prv.e.equals && prv.e.equals(pub.e));
      return Boolean(nOk && eOk);
    }

    // ECDSA: uncompressed public point hex
    if (prv.pubKeyHex && pub.pubKeyHex) {
      return (
        String(prv.pubKeyHex).toLowerCase() ===
        String(pub.pubKeyHex).toLowerCase()
      );
    }

    // Fallback: compare SPKI if we can re-export from keypair-like objects
    try {
      if (prv.pubKeyHex == null && pub.pubKeyHex == null && prv.n == null) {
        return normalizePem(KEYUTIL.getPEM(prv)) === normalizePem(csrPublicKeyPem);
      }
    } catch {
      /* ignore */
    }

    return false;
  }

  /**
   * Re-parse CSR + private key PEMs and compare to the form intent.
   * @returns {{ ok: boolean, checks: { ok: boolean, label: string }[] }}
   */
  function verifyOutput({
    csrPem,
    privateKeyPem,
    expectedCn,
    expectedSans,
    expectedSubjectParts,
    expectedType,
    expectedSize,
    passphrase,
    expectEncrypted,
  }) {
    /** @type {{ ok: boolean, label: string }[]} */
    const checks = [];

    let param = null;
    try {
      param = KJUR.asn1.csr.CSRUtil.getParam(csrPem);
      checks.push({
        ok: true,
        label: "CSR PEM parses cleanly (we can read the request back)",
      });
    } catch (err) {
      checks.push({
        ok: false,
        label: "CSR PEM did not parse — generation may have failed",
      });
      return { ok: false, checks };
    }

    let sigOk = false;
    try {
      sigOk = Boolean(KJUR.asn1.csr.CSRUtil.verifySignature(csrPem));
    } catch {
      sigOk = false;
    }
    checks.push({
      ok: sigOk,
      label: sigOk
        ? "CSR signature is valid for the embedded public key"
        : "CSR signature check failed",
    });

    let keyMatch = false;
    try {
      keyMatch = publicKeysMatch(
        privateKeyPem,
        param.sbjpubkey,
        passphrase || undefined
      );
    } catch (err) {
      keyMatch = false;
    }
    checks.push({
      ok: keyMatch,
      label: keyMatch
        ? "Private key matches the public key inside the CSR"
        : "Private key does not match the CSR public key",
    });

    if (expectEncrypted) {
      const looksEnc =
        /BEGIN ENCRYPTED PRIVATE KEY/i.test(privateKeyPem) ||
        /Proc-Type:\s*4,ENCRYPTED/i.test(privateKeyPem);
      checks.push({
        ok: looksEnc,
        label: looksEnc
          ? "Private key PEM is encrypted with your passphrase"
          : "Expected an encrypted private key PEM, but it looks unencrypted",
      });
    } else {
      checks.push({
        ok: true,
        label: "Private key PEM is unencrypted (no passphrase set)",
      });
    }

    const subject = subjectMapFromParam(param);
    const cnOk =
      String(subject.CN || "").toLowerCase() ===
      String(expectedCn || "").toLowerCase();
    checks.push({
      ok: cnOk,
      label: cnOk
        ? `Common Name matches (${expectedCn})`
        : `Common Name mismatch (wanted ${expectedCn}, got ${
            subject.CN || "—"
          })`,
    });

    const gotSans = sansFromParam(param);
    const wantSans = expectedSans.map((s) => s.toLowerCase()).sort();
    const sanOk = sameStringSet(gotSans, wantSans);
    checks.push({
      ok: sanOk,
      label: sanOk
        ? `SANs match (${wantSans.join(", ") || "—"})`
        : `SANs mismatch (wanted ${wantSans.join(", ") || "—"}, got ${
            gotSans.join(", ") || "—"
          })`,
    });

    // Optional subject attributes that were filled in
    const optionalKeys = ["O", "OU", "L", "ST", "C", "emailAddress"];
    /** @type {Record<string, string>} */
    const expectedMap = {};
    for (const [k, v] of expectedSubjectParts) {
      expectedMap[k] = v;
    }

    let optionalOk = true;
    const optionalNotes = [];
    for (const key of optionalKeys) {
      const want = expectedMap[key];
      if (!want) continue;
      const got = subject[key] || "";
      const match =
        key === "emailAddress"
          ? got.toLowerCase() === want.toLowerCase()
          : key === "C"
            ? got.toUpperCase() === want.toUpperCase()
            : got === want;
      if (!match) {
        optionalOk = false;
        optionalNotes.push(`${key}`);
      }
    }
    if (Object.keys(expectedMap).some((k) => optionalKeys.includes(k))) {
      checks.push({
        ok: optionalOk,
        label: optionalOk
          ? "Optional subject fields match your form"
          : `Optional subject mismatch (${optionalNotes.join(", ")})`,
      });
    }

    // Key algorithm / size (best-effort from parsed public key)
    let algOk = false;
    let algLabel = "Key algorithm / size";
    try {
      const pub = KEYUTIL.getKey(param.sbjpubkey);
      if (expectedType === "RSA") {
        const bits = pub.n ? pub.n.bitLength() : 0;
        algOk = Boolean(pub.n) && bits === parseInt(expectedSize, 10);
        algLabel = algOk
          ? `Key is RSA ${bits}`
          : `Expected RSA ${expectedSize}, saw ${
              pub.n ? `RSA ${bits}` : "non-RSA"
            }`;
      } else {
        // Uncompressed EC point: 0x04 || X || Y
        // P-256 → 65 bytes → 130 hex chars; P-384 → 97 bytes → 194 hex chars
        const hexLen = pub.pubKeyHex ? String(pub.pubKeyHex).length : 0;
        const expectHex = expectedSize === "P-384" ? 194 : 130;
        const name = String(pub.curveName || "");
        const nameOk =
          !name ||
          (expectedSize === "P-256" &&
            /256|secp256|prime256|P-256/i.test(name)) ||
          (expectedSize === "P-384" && /384|secp384|P-384/i.test(name));
        algOk = hexLen === expectHex && nameOk;
        algLabel = algOk
          ? `Key is ECDSA ${expectedSize}`
          : `Expected ECDSA ${expectedSize}, saw point length ${hexLen || "?"} (want ${expectHex})`;
      }
    } catch {
      algOk = false;
      algLabel = "Could not inspect key algorithm from CSR";
    }
    checks.push({ ok: algOk, label: algLabel });

    const ok = checks.every((c) => c.ok);
    return { ok, checks };
  }

  function renderVerification(result) {
    const banner = els.verifyBanner;
    const list = els.verifyList;
    if (!banner || !list) return;

    banner.dataset.state = result.ok ? "ok" : "fail";
    els.verifyMark.textContent = result.ok ? "✓" : "!";
    els.verifyTitle.textContent = result.ok
      ? "Verified in this browser"
      : "Verification found a problem";
    els.verifySummary.textContent = result.ok
      ? "We re-parsed the CSR, checked its signature, matched the private key, and compared names to your form. Safe to download."
      : "Something didn’t line up. Don’t trust these files — try generating again.";

    list.innerHTML = "";
    for (const check of result.checks) {
      const li = document.createElement("li");
      if (!check.ok) li.className = "is-fail";
      li.textContent = check.label;
      list.appendChild(li);
    }
  }

  function generate() {
    if (typeof KEYUTIL === "undefined" || typeof KJUR === "undefined") {
      setStatus(
        "Crypto library failed to load. Check that assets/vendor/jsrsasign-all-min.js is present.",
        "error"
      );
      return;
    }

    const cn = els.cn.value.trim();
    if (!cn) {
      setStatus("Give me a Common Name (usually your main domain).", "error");
      els.cn.focus();
      return;
    }

    const country = els.country.value.trim();
    if (country && country.length !== 2) {
      setStatus(
        "Country should be a 2-letter code (US, GB, DE…), or leave it blank.",
        "error"
      );
      els.country.focus();
      return;
    }

    const pass = (els.passphrase && els.passphrase.value) || "";
    const pass2 = (els.passphrase2 && els.passphrase2.value) || "";
    const allowUnencrypted =
      els.allowUnencrypted && els.allowUnencrypted.checked;

    if (pass || pass2) {
      if (pass !== pass2) {
        setStatus("Passphrases don’t match — fix that and try again.", "error");
        els.passphrase2.focus();
        return;
      }
      if (pass.length < MIN_PASSPHRASE_LEN) {
        setStatus(
          `Use at least ${MIN_PASSPHRASE_LEN} characters for the passphrase (or clear both fields and allow unencrypted if a device requires it).`,
          "error"
        );
        els.passphrase.focus();
        return;
      }
    } else if (!allowUnencrypted) {
      setStatus(
        `Set a passphrase (${MIN_PASSPHRASE_LEN}+ characters), or check “Allow unencrypted private key” if a device requires a blank passphrase.`,
        "error"
      );
      if (els.allowUnencrypted) els.allowUnencrypted.focus();
      else if (els.passphrase) els.passphrase.focus();
      return;
    }

    const type = els.keyType.value;
    const size = els.keySize.value;
    const parts = subjectFromForm();
    const sans = parseSans(cn, els.sans.value);
    const subj = subjectJsrsasignString(parts);

    els.generateBtn.disabled = true;
    setStatus(
      type === "RSA" && size === "4096"
        ? "Minting a chunky 4096-bit key… hang tight a sec."
        : "Cooking up a keypair in your browser…",
      ""
    );

    setTimeout(() => {
      try {
        let keypair;
        let sigalg;

        if (type === "ECDSA") {
          const curve =
            size === "P-384" || size === "secp384r1"
              ? "secp384r1"
              : size === "P-256" || size === "secp256r1"
                ? "secp256r1"
                : size;
          keypair = KEYUTIL.generateKeypair("EC", curve);
          sigalg =
            curve === "secp384r1" ? "SHA384withECDSA" : "SHA256withECDSA";
        } else {
          keypair = KEYUTIL.generateKeypair("RSA", parseInt(size, 10));
          sigalg = "SHA256withRSA";
        }

        const extreq = [
          {
            extname: "subjectAltName",
            array: sans.map((dns) => ({ dns })),
          },
        ];

        const csrPem = KJUR.asn1.csr.CSRUtil.newCSRPEM({
          subject: { str: subj },
          sbjpubkey: keypair.pubKeyObj,
          sigalg,
          sbjprvkey: keypair.prvKeyObj,
          extreq,
        });

        // Sign CSR with raw key first; encrypt PEM only for download/storage
        let privateKeyPem;
        const encrypted = Boolean(pass);
        if (encrypted) {
          privateKeyPem = KEYUTIL.getPEM(
            keypair.prvKeyObj,
            "PKCS8PRV",
            pass,
            "AES-256-CBC"
          );
        } else {
          privateKeyPem = KEYUTIL.getPEM(keypair.prvKeyObj, "PKCS8PRV");
        }

        const verification = verifyOutput({
          csrPem,
          privateKeyPem,
          expectedCn: cn,
          expectedSans: sans,
          expectedSubjectParts: parts,
          expectedType: type,
          expectedSize: size,
          passphrase: pass || undefined,
          expectEncrypted: encrypted,
        });

        lastResult = {
          privateKeyPem,
          csrPem,
          label: fileBaseName(),
          encrypted,
        };

        els.metaCn.textContent = cn;
        const keyBits =
          type === "ECDSA" ? `ECDSA ${size}` : `RSA ${size}`;
        els.metaKey.textContent = encrypted
          ? `${keyBits} · encrypted`
          : `${keyBits} · unencrypted`;
        els.metaSans.textContent = sans.join(", ");

        renderVerification(verification);

        els.results.classList.remove("hidden");
        showPem("csr");

        if (verification.ok) {
          setStatus(
            encrypted
              ? "Done and verified. Key is passphrase-protected — remember that password."
              : "Done and verified. ⚠ Key is UNENCRYPTED — protect the file; anyone with it can use it.",
            encrypted ? "ok" : "error"
          );
        } else {
          setStatus(
            "Generated, but verification failed — treat the output as untrusted.",
            "error"
          );
        }

        els.results.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (err) {
        console.error(err);
        setStatus(
          "Something went sideways generating the key/CSR. Try again or use the OpenSSL commands below.",
          "error"
        );
      } finally {
        els.generateBtn.disabled = false;
      }
    }, 30);
  }

  async function copyText(text, okMessage) {
    try {
      await navigator.clipboard.writeText(text);
      setStatus(okMessage, "ok");
    } catch {
      setStatus(
        "Clipboard blocked — select the text and copy manually.",
        "error"
      );
    }
  }

  // Wire up
  els.keyType.addEventListener("change", () => {
    updateKeySizeOptions();
    refreshOpenssl();
  });

  [
    els.cn,
    els.sans,
    els.keySize,
    els.passphrase,
    els.passphrase2,
    els.org,
    els.ou,
    els.locality,
    els.state,
    els.country,
    els.email,
  ]
    .filter(Boolean)
    .forEach((el) => {
      el.addEventListener("input", () => {
        if (el === els.cn) {
          syncAutoSansFromCn();
        }
        refreshOpenssl();
        if (el === els.cn || el === els.sans) refreshSanTip();
        if (el === els.passphrase || el === els.passphrase2) {
          refreshPassphraseUi();
        }
      });
      el.addEventListener("change", () => {
        if (el === els.cn) {
          syncAutoSansFromCn();
        }
        refreshOpenssl();
        if (el === els.cn || el === els.sans) refreshSanTip();
        if (el === els.passphrase || el === els.passphrase2) {
          refreshPassphraseUi();
        }
      });
    });

  if (els.allowUnencrypted) {
    els.allowUnencrypted.addEventListener("change", () => {
      refreshPassphraseUi();
      refreshOpenssl();
    });
  }

  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    generate();
  });

  function onClearSecretsClick() {
    forgetSecrets();
  }

  if (els.clearSecretsBtn) {
    els.clearSecretsBtn.addEventListener("click", onClearSecretsClick);
  }
  if (els.clearResultsBtn) {
    els.clearResultsBtn.addEventListener("click", onClearSecretsClick);
  }

  window.addEventListener("beforeunload", (e) => {
    if (!lastResult) return;
    // Browsers show a generic leave-site dialog; we only need to trigger it.
    e.preventDefault();
    e.returnValue = "";
  });

  els.copyOpenssl.addEventListener("click", () => {
    copyText(els.openssl.textContent, "OpenSSL commands copied.");
  });

  els.tabCsr.addEventListener("click", () => showPem("csr"));
  els.tabKey.addEventListener("click", () => showPem("key"));

  els.downloadCsr.addEventListener("click", () => {
    if (!lastResult) return;
    downloadText(
      `${lastResult.label}.csr`,
      lastResult.csrPem,
      "application/pkcs10"
    );
  });

  els.downloadKey.addEventListener("click", () => {
    if (!lastResult) return;
    downloadText(
      `${lastResult.label}.key`,
      lastResult.privateKeyPem,
      "application/x-pem-file"
    );
  });

  els.downloadBoth.addEventListener("click", () => {
    if (!lastResult) return;
    downloadText(
      `${lastResult.label}.key`,
      lastResult.privateKeyPem,
      "application/x-pem-file"
    );
    setTimeout(() => {
      downloadText(
        `${lastResult.label}.csr`,
        lastResult.csrPem,
        "application/pkcs10"
      );
    }, 250);
  });

  els.copyPem.addEventListener("click", () => {
    copyText(els.pemView.textContent, "Copied what’s on screen.");
  });

  updateKeySizeOptions();
  refreshOpenssl();
  refreshSanTip();
  refreshPassphraseUi();
})();
