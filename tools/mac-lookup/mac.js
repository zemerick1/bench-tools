/**
 * MAC / OUI lookup — offline, flexible input formats.
 * Randomized / locally administered: second hex char of first octet is 2, 6, A, or E.
 */

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const els = {
    form: $("mac-form"),
    input: $("mac-input"),
    submit: $("lookup-btn"),
    clear: $("clear-btn"),
    status: $("status"),
    results: $("results"),
    list: $("results-list"),
    expandAll: $("expand-all"),
    collapseAll: $("collapse-all"),
  };

  /** @type {null | { mal: Record<string,string>, mam: Record<string,string>, mas: Record<string,string>, updated?: string }} */
  let ouiDb = null;
  let ouiLoadPromise = null;

  function setStatus(msg, tone) {
    els.status.textContent = msg || "";
    if (tone) els.status.dataset.tone = tone;
    else delete els.status.dataset.tone;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  /**
   * Accept full MACs or partial OUI / block prefixes.
   * @returns {{ hex: string, kind: 'full'|'oui'|'mam'|'mas' } | null}
   *
   * Full (12 hex):
   *   aa:bb:cc:dd:ee:ff | aa-bb-cc-dd-ee-ff | aabb.ccdd.eeff |
   *   aabbccddeeff | aabbcc-ddeeff
   * OUI / MA-L (6 hex) — what people usually mean by “the OUI”:
   *   aabbcc | aa:bb:cc | aa-bb-cc
   * Also: 7 hex (MA-M), 9 hex (MA-S) if someone pastes a longer IEEE prefix.
   */
  function parseMac(raw) {
    let s = String(raw || "").trim();
    if (!s) return null;

    // Cisco triple-dot full MAC: aabb.ccdd.eeff
    if (/^[0-9a-f]{4}(\.[0-9a-f]{4}){2}$/i.test(s)) {
      s = s.replace(/\./g, "");
    }

    // One dash in the middle (full only): 6 hex + dash + 6 hex
    if (/^[0-9a-f]{6}-[0-9a-f]{6}$/i.test(s)) {
      s = s.replace("-", "");
    }

    // Strip every non-hex character (covers : - . space etc.)
    const hex = s.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
    if (!/^[0-9A-F]+$/.test(hex)) return null;

    if (hex.length === 12) return { hex, kind: "full" };
    if (hex.length === 6) return { hex, kind: "oui" }; // classic OUI / MA-L
    if (hex.length === 7) return { hex, kind: "mam" };
    if (hex.length === 9) return { hex, kind: "mas" };
    return null;
  }

  function formatHex(hex, style) {
    const h = hex.toUpperCase();
    const p = h.match(/.{1,2}/g) || [];
    if (h.length === 12) {
      switch (style) {
        case "dash":
          return p.join("-");
        case "cisco":
          return `${h.slice(0, 4)}.${h.slice(4, 8)}.${h.slice(8, 12)}`.toLowerCase();
        case "bare":
          return h;
        case "middle-dash":
          return `${h.slice(0, 6)}-${h.slice(6, 12)}`;
        case "colon":
        default:
          return p.join(":").toLowerCase();
      }
    }
    // Partial prefix (OUI / MA-M / MA-S)
    switch (style) {
      case "dash":
        return p.join("-");
      case "bare":
        return h;
      case "colon":
      default:
        return p.join(":").toLowerCase();
    }
  }

  function kindLabel(kind) {
    switch (kind) {
      case "full":
        return "Full MAC (48-bit)";
      case "oui":
        return "OUI / MA-L prefix (24-bit, 6 hex)";
      case "mam":
        return "MA-M prefix (28-bit, 7 hex)";
      case "mas":
        return "MA-S prefix (36-bit, 9 hex)";
      default:
        return kind;
    }
  }

  /**
   * Locally administered unicast ⇔ second hex character of the full MAC is 2, 6, A, or E.
   * (U/L bit set, I/G bit clear on the first octet.)
   */
  /** Bit analysis only needs the first octet (works for OUI-only too). */
  function analyzeBits(hex) {
    const firstOctet = parseInt(hex.slice(0, 2), 16);
    const secondChar = hex.charAt(1).toUpperCase();
    const ig = (firstOctet & 0x01) !== 0; // multicast
    const ul = (firstOctet & 0x02) !== 0; // local
    const localUnicastChars = new Set(["2", "6", "A", "E"]);
    const likelyRandomized = !ig && localUnicastChars.has(secondChar);

    return {
      firstOctet,
      firstOctetHex: hex.slice(0, 2),
      secondChar,
      isMulticast: ig,
      isBroadcast: hex.length === 12 && hex === "FFFFFFFFFFFF",
      isLocal: ul,
      isUniversal: !ul,
      isUnicast: !ig,
      likelyRandomized,
    };
  }

  /**
   * @param {string} hex
   * @param {'full'|'oui'|'mam'|'mas'} kind
   */
  function lookupOui(hex, kind) {
    if (!ouiDb) return null;
    const bare = hex.toUpperCase();

    // Exact registry hit when user pasted a known-length prefix
    if (kind === "oui" && ouiDb.mal && ouiDb.mal[bare]) {
      return {
        prefix: bare,
        org: ouiDb.mal[bare],
        registry: "MA-L",
        prefixBits: 24,
        exact: true,
      };
    }
    if (kind === "mam" && ouiDb.mam && ouiDb.mam[bare]) {
      return {
        prefix: bare,
        org: ouiDb.mam[bare],
        registry: "MA-M",
        prefixBits: 28,
        exact: true,
      };
    }
    if (kind === "mas" && ouiDb.mas && ouiDb.mas[bare]) {
      return {
        prefix: bare,
        org: ouiDb.mas[bare],
        registry: "MA-S",
        prefixBits: 36,
        exact: true,
      };
    }

    // Full MAC (or fallback): longest prefix first
    if (bare.length >= 9 && ouiDb.mas && ouiDb.mas[bare.slice(0, 9)]) {
      return {
        prefix: bare.slice(0, 9),
        org: ouiDb.mas[bare.slice(0, 9)],
        registry: "MA-S",
        prefixBits: 36,
        exact: kind === "mas",
      };
    }
    if (bare.length >= 7 && ouiDb.mam && ouiDb.mam[bare.slice(0, 7)]) {
      return {
        prefix: bare.slice(0, 7),
        org: ouiDb.mam[bare.slice(0, 7)],
        registry: "MA-M",
        prefixBits: 28,
        exact: kind === "mam",
      };
    }
    if (bare.length >= 6 && ouiDb.mal && ouiDb.mal[bare.slice(0, 6)]) {
      return {
        prefix: bare.slice(0, 6),
        org: ouiDb.mal[bare.slice(0, 6)],
        registry: "MA-L",
        prefixBits: 24,
        exact: kind === "oui" || kind === "full",
      };
    }
    return null;
  }

  function specialNotes(hex, bits, kind) {
    const notes = [];
    const h = hex.toUpperCase();

    if (kind === "oui") {
      notes.push(
        "Partial OUI (6 hex). Vendor match uses the IEEE MA-L block; device-unique bits were not provided."
      );
    } else if (kind === "mam") {
      notes.push("Partial MA-M prefix (7 hex / 28-bit assignment).");
    } else if (kind === "mas") {
      notes.push("Partial MA-S prefix (9 hex / 36-bit assignment).");
    }

    if (bits.isBroadcast) {
      notes.push("Ethernet broadcast address (ff:ff:ff:ff:ff:ff).");
    }
    if (h.startsWith("01005E")) {
      notes.push("IPv4 multicast mapping (01:00:5e:… / RFC 1112).");
    }
    if (h.startsWith("3333")) {
      notes.push("IPv6 multicast mapping (33:33:…).");
    }
    if (kind === "full" && h.startsWith("00005E0001")) {
      notes.push("Likely VRRP virtual router MAC (00:00:5e:00:01:xx).");
    }
    if (
      kind === "full" &&
      (h.startsWith("00000C07AC") || h.startsWith("00000C9FF"))
    ) {
      notes.push("Common HSRP / HSRPv2-style virtual MAC pattern (Cisco lore).");
    }
    if (kind === "full" && h.startsWith("0180C20000")) {
      notes.push("IEEE 802.1 bridge group address block (01:80:c2:00:00:xx).");
    }
    if (kind === "full" && h.startsWith("01000CCCCCCC")) {
      notes.push("Cisco CDP/VTP group address (01:00:0c:cc:cc:cc).");
    }

    const vmHints = [
      ["005056", "VMware"],
      ["000C29", "VMware"],
      ["000569", "VMware"],
      ["00155D", "Microsoft Hyper-V"],
      ["00163E", "Xen"],
      ["525400", "QEMU/KVM (often)"],
    ];
    for (const [p, name] of vmHints) {
      if (h.startsWith(p)) {
        notes.push(`Common ${name} virtual NIC OUI (hint, not a guarantee).`);
        break;
      }
    }

    return notes;
  }

  function randomizedLabel(bits, oui) {
    if (bits.isBroadcast) {
      return {
        tone: "neutral",
        title: "Broadcast",
        detail: "Not a host NIC address.",
      };
    }
    if (bits.isMulticast) {
      return {
        tone: "neutral",
        title: "Multicast",
        detail:
          "Group address (I/G bit set). Not a typical device burned-in unicast MAC.",
      };
    }
    if (bits.likelyRandomized) {
      return {
        tone: "warn",
        title: "Likely randomized / locally administered",
        detail:
          `Second character is “${bits.secondChar}” (one of 2, 6, A, E) → ` +
          "U/L bit set, unicast. Common for Wi‑Fi privacy MACs, VMs, and admin-set addresses.",
      };
    }
    if (bits.isLocal) {
      // local but multicast already handled; local multicast is 3,7,B,F
      return {
        tone: "warn",
        title: "Locally administered",
        detail: "U/L bit is set (not a globally unique burned-in assignment).",
      };
    }
    if (oui) {
      return {
        tone: "ok",
        title: "Universally administered",
        detail:
          "Second character is not 2/6/A/E for local unicast — looks like a global (factory-style) address with an IEEE block match.",
      };
    }
    return {
      tone: "neutral",
      title: "Universally administered (no OUI hit)",
      detail:
        "Bits say universal unicast, but no MA-L/M/S match in the local registry dump. Could be unregistered, very new, or a spoof.",
    };
  }

  function loadOuiDb() {
    if (ouiDb) return Promise.resolve(ouiDb);
    if (ouiLoadPromise) return ouiLoadPromise;
    setStatus("Loading OUI registry…", "");
    ouiLoadPromise = fetch("./oui-data.json")
      .then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then((data) => {
        ouiDb = data;
        setStatus(
          data.updated
            ? `Registry ready (IEEE dump ${data.updated}).`
            : "Registry ready.",
          "ok"
        );
        return data;
      })
      .catch((err) => {
        console.error(err);
        ouiLoadPromise = null;
        setStatus(
          "Could not load oui-data.json — vendor lookup disabled; bit analysis still works.",
          "error"
        );
        ouiDb = { mal: {}, mam: {}, mas: {} };
        return ouiDb;
      });
    return ouiLoadPromise;
  }

  function splitInput(text) {
    return String(text || "")
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /**
   * @param {string} raw
   * @param {{ hex: string, kind: 'full'|'oui'|'mam'|'mas' }} parsed
   */
  function renderCard(raw, parsed) {
    const { hex, kind } = parsed;
    const bits = analyzeBits(hex);
    const oui = lookupOui(hex, kind);
    const rand = randomizedLabel(bits, oui);
    const notes = specialNotes(hex, bits, kind);

    const toneClass =
      rand.tone === "warn"
        ? "mac-flag mac-flag--warn"
        : rand.tone === "ok"
          ? "mac-flag mac-flag--ok"
          : "mac-flag";

    /** @type {[string, string][]} */
    let formats;
    if (kind === "full") {
      formats = [
        ["Colon", formatHex(hex, "colon")],
        ["Dash", formatHex(hex, "dash")],
        ["Cisco", formatHex(hex, "cisco")],
        ["Middle dash", formatHex(hex, "middle-dash")],
        ["Bare", formatHex(hex, "bare")],
      ];
    } else {
      formats = [
        ["Colon", formatHex(hex, "colon")],
        ["Dash", formatHex(hex, "dash")],
        ["Bare OUI/prefix", formatHex(hex, "bare")],
      ];
    }

    const fmtHtml = formats
      .map(
        ([label, val]) =>
          `<button type="button" class="mac-fmt mac-fmt--copy" data-copy="${escapeHtml(
            val
          )}" title="Click to copy ${escapeHtml(val)}" aria-label="Copy ${escapeHtml(
            label
          )} form ${escapeHtml(val)}">
            <span class="mac-fmt__label">${escapeHtml(label)}</span>
            <code class="copyable">${escapeHtml(val)}</code>
            <span class="mac-fmt__hint" aria-hidden="true">click to copy</span>
          </button>`
      )
      .join("");

    const ouiHtml = oui
      ? `<div class="meta-chip"><span>Vendor / org</span><strong>${escapeHtml(
          oui.org
        )}</strong></div>
         <div class="meta-chip"><span>Registry</span><strong>${escapeHtml(
           oui.registry
         )} · ${oui.prefixBits}-bit</strong></div>
         <div class="meta-chip"><span>Matched prefix</span><strong class="mono">${escapeHtml(
           oui.prefix
         )}</strong></div>`
      : `<div class="meta-chip"><span>Vendor / org</span><strong>No match in local IEEE dump</strong></div>`;

    const notesHtml = notes.length
      ? `<ul class="mac-notes">${notes
          .map((n) => `<li>${escapeHtml(n)}</li>`)
          .join("")}</ul>`
      : "";

    const secondHi = `<span class="mac-second-char">${escapeHtml(
      bits.secondChar
    )}</span>`;

    const displayAddr = formatHex(hex, "colon");
    const vendorShort = oui
      ? oui.org
      : bits.likelyRandomized
        ? "Likely randomized (no vendor)"
        : "Unknown vendor";
    const vendorTitle = vendorShort.length > 72
      ? vendorShort.slice(0, 69) + "…"
      : vendorShort;

    const flagPill =
      bits.likelyRandomized
        ? '<span class="mac-pill mac-pill--warn">randomized</span>'
        : bits.isMulticast
          ? '<span class="mac-pill">multicast</span>'
          : oui
            ? '<span class="mac-pill mac-pill--ok">OUI hit</span>'
            : '<span class="mac-pill">no OUI</span>';

    return `
      <details class="mac-card">
        <summary class="mac-card__summary">
          <span class="mac-card__summary-main">
            <span class="mono mac-card__addr">${escapeHtml(displayAddr)}</span>
            <span class="mac-card__vendor" title="${escapeHtml(
              vendorShort
            )}">${escapeHtml(vendorTitle)}</span>
          </span>
          <span class="mac-card__summary-meta">
            ${flagPill}
            <span class="mac-chevron" aria-hidden="true"></span>
          </span>
        </summary>
        <div class="mac-card__body">
          <p class="mac-card__raw">
            from <code>${escapeHtml(raw)}</code>
            · ${escapeHtml(kindLabel(kind))}
          </p>
          <div class="${toneClass}">
            <strong>${escapeHtml(rand.title)}</strong>
            <p>${escapeHtml(rand.detail)}</p>
            <p class="mac-bitline">
              First octet <code>${escapeHtml(
                bits.firstOctetHex
              )}</code> · second character ${secondHi}
              · ${bits.isUnicast ? "unicast" : "multicast"}
              · ${
                bits.isLocal
                  ? "locally administered"
                  : "universally administered"
              }
            </p>
          </div>
          <div class="results-meta" style="margin-top:1rem">${ouiHtml}
            <div class="meta-chip"><span>Input type</span><strong>${escapeHtml(
              kindLabel(kind)
            )}</strong></div>
            <div class="meta-chip"><span>I/G bit</span><strong>${
              bits.isMulticast ? "1 · multicast" : "0 · unicast"
            }</strong></div>
            <div class="meta-chip"><span>U/L bit</span><strong>${
              bits.isLocal ? "1 · local" : "0 · universal"
            }</strong></div>
          </div>
          <h4 class="subhead">Normalized forms</h4>
          <p class="mac-fmt-note">Click any form to copy it to the clipboard.</p>
          <div class="mac-fmt-grid">${fmtHtml}</div>
          ${notesHtml}
        </div>
      </details>
    `;
  }

  function renderError(raw, reason) {
    return `
      <details class="mac-card mac-card--error">
        <summary class="mac-card__summary">
          <span class="mac-card__summary-main">
            <span class="mono mac-card__addr">${escapeHtml(raw)}</span>
            <span class="mac-card__vendor">Couldn’t parse</span>
          </span>
          <span class="mac-card__summary-meta">
            <span class="mac-pill mac-pill--err">invalid</span>
            <span class="mac-chevron" aria-hidden="true"></span>
          </span>
        </summary>
        <div class="mac-card__body">
          <p class="panel__intro" style="margin:0">${escapeHtml(reason)}</p>
        </div>
      </details>
    `;
  }

  async function runLookup() {
    await loadOuiDb();
    const lines = splitInput(els.input.value);
    if (!lines.length) {
      setStatus("Paste at least one MAC address.", "error");
      els.input.focus();
      return;
    }

    const html = [];
    let ok = 0;
    let bad = 0;
    let randomish = 0;
    let partial = 0;

    for (const line of lines) {
      const parsed = parseMac(line);
      if (!parsed) {
        bad++;
        html.push(
          renderError(
            line,
            "need 12 hex (full MAC), 6 hex (OUI), or 7/9 hex (MA-M / MA-S). Colons, dashes, dots, bare, or 6+6 middle-dash are fine."
          )
        );
        continue;
      }
      ok++;
      if (parsed.kind !== "full") partial++;
      const bits = analyzeBits(parsed.hex);
      if (bits.likelyRandomized) randomish++;
      html.push(renderCard(line, parsed));
    }

    els.list.innerHTML = html.join("");
    els.results.classList.remove("hidden");

    // All results start collapsed (no open attribute on <details>)
    // Click-to-copy for normalized forms (don't toggle the row)
    els.list.querySelectorAll("[data-copy]").forEach((el) => {
      el.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const v = el.getAttribute("data-copy") || "";
        if (!v) return;
        try {
          await navigator.clipboard.writeText(v);
          setStatus(`Copied ${v}`, "ok");
          el.classList.add("is-copied");
          const hint = el.querySelector(".mac-fmt__hint");
          const prev = hint ? hint.textContent : "";
          if (hint) hint.textContent = "copied!";
          window.setTimeout(() => {
            el.classList.remove("is-copied");
            if (hint) hint.textContent = prev || "click to copy";
          }, 1200);
        } catch {
          // Fallback for non-secure contexts / denied clipboard
          try {
            const ta = document.createElement("textarea");
            ta.value = v;
            ta.setAttribute("readonly", "");
            ta.style.position = "fixed";
            ta.style.left = "-9999px";
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand("copy");
            document.body.removeChild(ta);
            if (ok) {
              setStatus(`Copied ${v}`, "ok");
              el.classList.add("is-copied");
              window.setTimeout(() => el.classList.remove("is-copied"), 1200);
            } else {
              setStatus("Clipboard blocked — select and copy manually.", "error");
            }
          } catch {
            setStatus("Clipboard blocked — select and copy manually.", "error");
          }
        }
      });
    });

    setStatus(
      `Parsed ${ok} entr${ok === 1 ? "y" : "ies"}` +
        (partial ? ` (${partial} OUI/prefix)` : "") +
        (bad ? `, ${bad} invalid` : "") +
        (randomish
          ? `, ${randomish} likely randomized (2/6/A/E rule)`
          : "") +
        " — results collapsed; expand a row for details.",
      ok ? "ok" : "error"
    );
    els.results.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function setAllOpen(open) {
    els.list.querySelectorAll("details.mac-card").forEach((d) => {
      d.open = open;
    });
  }

  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    runLookup();
  });

  els.clear.addEventListener("click", () => {
    els.input.value = "";
    els.list.innerHTML = "";
    els.results.classList.add("hidden");
    setStatus("");
  });

  if (els.expandAll) {
    els.expandAll.addEventListener("click", () => setAllOpen(true));
  }
  if (els.collapseAll) {
    els.collapseAll.addEventListener("click", () => setAllOpen(false));
  }

  // Warm the DB in the background
  loadOuiDb();
})();
