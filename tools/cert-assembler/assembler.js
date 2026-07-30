/**
 * Cert Assembler — browser-only PEM / PKCS#12 packaging.
 * Crypto via vendored node-forge (assets/vendor/forge.min.js).
 */

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const els = {
    form: $("asm-form"),
    keyPem: $("key-pem"),
    certPem: $("cert-pem"),
    chainPem: $("chain-pem"),
    keyFile: $("key-file"),
    certFile: $("cert-file"),
    chainFile: $("chain-file"),
    passIn: $("pass-in"),
    passOut: $("pass-out"),
    allowEmptyPfx: $("allow-empty-pfx"),
    buildBtn: $("build-btn"),
    clearBtn: $("clear-btn"),
    status: $("status"),
    results: $("results"),
    verifyBanner: $("verify-banner"),
    verifyMark: $("verify-mark"),
    verifyTitle: $("verify-title"),
    verifySummary: $("verify-summary"),
    verifyList: $("verify-list"),
    metaRow: $("meta-row"),
    downloadGrid: $("download-grid"),
  };

  /** @type {null | { files: { name: string, blob: Blob, note: string }[], meta: object, checks: object[] }} */
  let lastBuild = null;

  function setStatus(message, tone) {
    els.status.textContent = message || "";
    if (tone) els.status.dataset.tone = tone;
    else delete els.status.dataset.tone;
  }

  function wireFile(input, textarea) {
    input.addEventListener("change", async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        textarea.value = await file.text();
        setStatus(`Loaded ${file.name}`, "ok");
      } catch {
        setStatus("Could not read that file.", "error");
      }
      input.value = "";
    });
  }

  wireFile(els.keyFile, els.keyPem);
  wireFile(els.certFile, els.certPem);
  wireFile(els.chainFile, els.chainPem);

  function selectedFormats() {
    return Array.from(
      document.querySelectorAll('input[name="fmt"]:checked')
    ).map((el) => el.value);
  }

  function splitPemBlocks(text) {
    const re =
      /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g;
    const blocks = [];
    let m;
    const src = String(text || "");
    while ((m = re.exec(src)) !== null) {
      blocks.push(m[0].trim());
    }
    return blocks;
  }

  function isEncryptedKeyPem(pem) {
    const u = pem.toUpperCase();
    return (
      u.includes("BEGIN ENCRYPTED PRIVATE KEY") ||
      u.includes("Proc-Type: 4,ENCRYPTED") ||
      u.includes("PROC-TYPE: 4,ENCRYPTED")
    );
  }

  /**
   * @returns {{ key: object, wasEncrypted: boolean }}
   */
  function loadPrivateKey(pem, passphrase) {
    const trimmed = String(pem || "").trim();
    if (!trimmed) throw new Error("Private key is empty.");

    if (isEncryptedKeyPem(trimmed)) {
      if (!passphrase) {
        throw new Error(
          "This private key is encrypted — enter the current passphrase."
        );
      }
      let key = null;
      try {
        key = forge.pki.decryptRsaPrivateKey(trimmed, passphrase);
      } catch {
        key = null;
      }
      if (!key) {
        try {
          const encryptedInfo = forge.pki.encryptedPrivateKeyFromPem(trimmed);
          const asn1 = forge.pki.decryptPrivateKeyInfo(
            encryptedInfo,
            passphrase
          );
          key = forge.pki.privateKeyFromAsn1(asn1);
        } catch {
          key = null;
        }
      }
      if (!key) {
        throw new Error(
          "Could not decrypt the private key. Check the current passphrase."
        );
      }
      return { key, wasEncrypted: true };
    }

    try {
      const key = forge.pki.privateKeyFromPem(trimmed);
      return { key, wasEncrypted: false };
    } catch {
      throw new Error(
        "Could not parse the private key PEM. Need a PKCS#8 or RSA PRIVATE KEY block."
      );
    }
  }

  function loadCertificate(pem, label) {
    const trimmed = String(pem || "").trim();
    if (!trimmed) throw new Error(`${label} is empty.`);
    try {
      return forge.pki.certificateFromPem(trimmed);
    } catch {
      throw new Error(`Could not parse ${label}. Expect a CERTIFICATE PEM block.`);
    }
  }

  function loadChain(pemText) {
    const blocks = splitPemBlocks(pemText);
    const certs = [];
    for (const block of blocks) {
      if (!/CERTIFICATE/.test(block) || /REQUEST/.test(block)) continue;
      try {
        certs.push(forge.pki.certificateFromPem(block));
      } catch {
        throw new Error(
          "One of the certificates in the bundle could not be parsed."
        );
      }
    }
    return certs;
  }

  function rsaPubFromPrivate(privateKey) {
    if (!privateKey.n || !privateKey.e) return null;
    return forge.pki.setRsaPublicKey(privateKey.n, privateKey.e);
  }

  /**
   * @returns {boolean | null} true/false match, or null if key type unsupported
   */
  function keyMatchesCert(privateKey, cert) {
    const fromPriv = rsaPubFromPrivate(privateKey);
    if (fromPriv && cert.publicKey && cert.publicKey.n) {
      return (
        fromPriv.n.compareTo(cert.publicKey.n) === 0 &&
        fromPriv.e.compareTo(cert.publicKey.e) === 0
      );
    }
    // EC / other: forge packaging support is limited; don't claim a match
    if (!privateKey.n) return null;
    return false;
  }

  function certSubjectCn(cert) {
    try {
      const attrs = cert.subject.attributes || [];
      const cn = attrs.find((a) => a.name === "commonName" || a.shortName === "CN");
      return cn ? cn.value : "(no CN)";
    } catch {
      return "(unknown)";
    }
  }

  function certNotAfter(cert) {
    try {
      return cert.validity.notAfter.toISOString().slice(0, 10);
    } catch {
      return "—";
    }
  }

  function privateKeyToPem(privateKey, passphrase) {
    if (passphrase) {
      // PKCS#8 encrypted PEM
      return forge.pki.encryptRsaPrivateKey(privateKey, passphrase, {
        algorithm: "aes256",
      });
    }
    return forge.pki.privateKeyToPem(privateKey);
  }

  function certToPem(cert) {
    return forge.pki.certificateToPem(cert);
  }

  function joinPems(pems) {
    return pems
      .map((p) => String(p).trim())
      .filter(Boolean)
      .join("\n")
      .replace(/\n+$/, "\n");
  }

  function buildPkcs12Der(privateKey, leaf, chain, password) {
    const bags = [leaf, ...chain];
    const p12Asn1 = forge.pkcs12.toPkcs12Asn1(privateKey, bags, password, {
      algorithm: "3des", // wide compatibility for Windows / appliances
      generateLocalKeyId: true,
      friendlyName: certSubjectCn(leaf),
    });
    return forge.asn1.toDer(p12Asn1).getBytes();
  }

  function derToBlob(derBytes) {
    const buf = new Uint8Array(derBytes.length);
    for (let i = 0; i < derBytes.length; i++) {
      buf[i] = derBytes.charCodeAt(i) & 0xff;
    }
    return new Blob([buf], { type: "application/x-pkcs12" });
  }

  function textBlob(text) {
    return new Blob([text], { type: "application/x-pem-file" });
  }

  function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function baseName() {
    const stamp = new Date().toISOString().slice(0, 10);
    return `tls-bundle-${stamp}`;
  }

  function renderVerification(ok, checks, summary) {
    els.verifyBanner.dataset.state = ok ? "ok" : "fail";
    els.verifyMark.textContent = ok ? "✓" : "!";
    els.verifyTitle.textContent = ok
      ? "Verified in this browser"
      : "Could not verify cleanly";
    els.verifySummary.textContent = summary;
    els.verifyList.innerHTML = "";
    for (const c of checks) {
      const li = document.createElement("li");
      if (!c.ok) li.className = "is-fail";
      li.textContent = c.label;
      els.verifyList.appendChild(li);
    }
  }

  function renderMeta(meta) {
    els.metaRow.innerHTML = `
      <div class="meta-chip"><span>Leaf CN</span><strong>${escapeHtml(
        meta.cn
      )}</strong></div>
      <div class="meta-chip"><span>Expires</span><strong>${escapeHtml(
        meta.expires
      )}</strong></div>
      <div class="meta-chip"><span>Chain certs</span><strong>${escapeHtml(
        String(meta.chainCount)
      )}</strong></div>
      <div class="meta-chip"><span>Key</span><strong>${escapeHtml(
        meta.keyLabel
      )}</strong></div>
    `;
  }

  function renderDownloads(files) {
    els.downloadGrid.innerHTML = "";
    for (const f of files) {
      const card = document.createElement("div");
      card.className = "download-card";
      card.innerHTML = `
        <div>
          <strong>${escapeHtml(f.name)}</strong>
          <p class="hint">${escapeHtml(f.note)}</p>
        </div>
        <button type="button" class="btn btn--primary">Download</button>
      `;
      card.querySelector("button").addEventListener("click", () => {
        downloadBlob(f.name, f.blob);
      });
      els.downloadGrid.appendChild(card);
    }

    if (files.length > 1) {
      const all = document.createElement("div");
      all.className = "download-card download-card--all";
      all.innerHTML = `
        <div>
          <strong>Download everything</strong>
          <p class="hint">Fires one download per file (your browser may ask to allow multiple).</p>
        </div>
        <button type="button" class="btn btn--secondary">Download all</button>
      `;
      all.querySelector("button").addEventListener("click", async () => {
        for (let i = 0; i < files.length; i++) {
          downloadBlob(files[i].name, files[i].blob);
          await new Promise((r) => setTimeout(r, 350));
        }
      });
      els.downloadGrid.prepend(all);
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function assemble() {
    if (typeof forge === "undefined") {
      setStatus("Crypto library failed to load (forge).", "error");
      return;
    }

    const formats = selectedFormats();
    if (!formats.length) {
      setStatus("Pick at least one output format.", "error");
      return;
    }

    const passIn = els.passIn.value;
    const passOut = els.passOut.value;
    const allowEmptyPfx = els.allowEmptyPfx.checked;

    /** @type {{ ok: boolean, label: string }[]} */
    const checks = [];
    const files = [];
    const name = baseName();

    try {
      const { key, wasEncrypted } = loadPrivateKey(els.keyPem.value, passIn);
      checks.push({
        ok: true,
        label: wasEncrypted
          ? "Encrypted private key decrypted with your current passphrase"
          : "Private key PEM parsed (was not encrypted)",
      });

      const leaf = loadCertificate(els.certPem.value, "Server certificate");
      checks.push({ ok: true, label: "Server (leaf) certificate parsed" });

      let chain = [];
      if (els.chainPem.value.trim()) {
        chain = loadChain(els.chainPem.value);
        checks.push({
          ok: chain.length > 0,
          label:
            chain.length > 0
              ? `CA bundle parsed (${chain.length} certificate${
                  chain.length === 1 ? "" : "s"
                })`
              : "CA bundle field had text but no CERTIFICATE blocks",
        });
        if (!chain.length) {
          throw new Error(
            "Bundle didn’t contain any certificates. Paste intermediate PEMs or leave it blank."
          );
        }
      } else {
        checks.push({
          ok: true,
          label: "No CA bundle provided (fullchain will be leaf only)",
        });
      }

      // Drop leaf if it accidentally appears in chain
      const leafPemNorm = certToPem(leaf).replace(/\s+/g, "");
      chain = chain.filter(
        (c) => certToPem(c).replace(/\s+/g, "") !== leafPemNorm
      );

      const match = keyMatchesCert(key, leaf);
      if (match === false) {
        checks.push({
          ok: false,
          label: "Private key does NOT match the leaf certificate",
        });
        renderVerification(
          false,
          checks,
          "Mismatched key and cert — fix the inputs before packaging."
        );
        els.results.classList.remove("hidden");
        setStatus("Key and certificate don’t match.", "error");
        els.results.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      if (match === null) {
        checks.push({
          ok: false,
          label:
            "Could not confirm key↔cert match (unsupported key type for compare)",
        });
        renderVerification(
          false,
          checks,
          "We couldn’t prove the key matches this cert. Only RSA is fully checked today."
        );
        els.results.classList.remove("hidden");
        setStatus("Unsupported key type for match check.", "error");
        return;
      }
      checks.push({
        ok: true,
        label: "Private key matches the leaf certificate",
      });

      if (passOut) {
        checks.push({
          ok: true,
          label: "Output passphrase will protect PEM key and/or PKCS#12",
        });
      } else {
        checks.push({
          ok: true,
          label: "No output passphrase — PEM key will be unencrypted",
        });
      }

      const keyLabel =
        key.n && key.n.bitLength
          ? `RSA ${key.n.bitLength()}`
          : "Private key";

      const meta = {
        cn: certSubjectCn(leaf),
        expires: certNotAfter(leaf),
        chainCount: chain.length,
        keyLabel,
      };

      // --- Apache / Nginx PEMs ---
      if (formats.includes("apache")) {
        const keyPemOut = privateKeyToPem(key, passOut || undefined);
        const certPemOut = certToPem(leaf);
        const chainPemOut = joinPems(chain.map(certToPem));
        const fullchainPemOut = joinPems([certPemOut, chainPemOut]);

        files.push({
          name: `${name}.key`,
          blob: textBlob(keyPemOut.endsWith("\n") ? keyPemOut : keyPemOut + "\n"),
          note: passOut
            ? "Encrypted private key (PEM) — output passphrase applied"
            : "Unencrypted private key (PEM) — lock down file permissions",
        });
        files.push({
          name: `${name}.crt`,
          blob: textBlob(certPemOut),
          note: "Leaf / server certificate only",
        });
        if (chain.length) {
          files.push({
            name: `${name}.chain.crt`,
            blob: textBlob(chainPemOut),
            note: "Intermediate CA bundle",
          });
        }
        files.push({
          name: `${name}.fullchain.crt`,
          blob: textBlob(fullchainPemOut),
          note: "Leaf + chain (use this for nginx ssl_certificate)",
        });
      }

      // --- PKCS#12 ---
      const wantPfx = formats.includes("pfx");
      const wantP12 = formats.includes("p12");
      if (wantPfx || wantP12) {
        let pfxPass = passOut;
        if (!pfxPass) {
          if (!allowEmptyPfx) {
            throw new Error(
              "PFX/P12 needs an output passphrase (or check “Allow empty password”)."
            );
          }
          pfxPass = "";
        }
        const der = buildPkcs12Der(key, leaf, chain, pfxPass);
        const blob = derToBlob(der);
        if (wantPfx) {
          files.push({
            name: `${name}.pfx`,
            blob,
            note: pfxPass
              ? "PKCS#12 with leaf + chain + key (password protected)"
              : "PKCS#12 with empty password",
          });
        }
        if (wantP12) {
          files.push({
            name: `${name}.p12`,
            blob,
            note: pfxPass
              ? "Same PKCS#12 as PFX, .p12 extension"
              : "PKCS#12 with empty password (.p12)",
          });
        }
        checks.push({
          ok: true,
          label: "PKCS#12 container built (key + leaf + chain)",
        });
      }

      lastBuild = { files, meta, checks };

      renderVerification(
        true,
        checks,
        "Key matches cert; PEMs/PKCS#12 built locally. Download and store safely."
      );
      renderMeta(meta);
      renderDownloads(files);

      els.results.classList.remove("hidden");
      setStatus("Assembled. Download what you need — key material never left this tab.", "ok");
      els.results.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      console.error(err);
      const msg = err && err.message ? err.message : "Assembly failed.";
      checks.push({ ok: false, label: msg });
      renderVerification(false, checks, msg);
      els.results.classList.remove("hidden");
      setStatus(msg, "error");
    }
  }

  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    assemble();
  });

  els.clearBtn.addEventListener("click", () => {
    els.form.reset();
    // re-check default formats after reset
    const apache = document.querySelector('input[name="fmt"][value="apache"]');
    const pfx = document.querySelector('input[name="fmt"][value="pfx"]');
    if (apache) apache.checked = true;
    if (pfx) pfx.checked = true;
    els.results.classList.add("hidden");
    lastBuild = null;
    setStatus("");
  });
})();
