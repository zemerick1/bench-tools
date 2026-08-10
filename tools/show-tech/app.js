/**
 * Show-Tech Sticky Note — UI
 * Paste or drop a dump. Get facts + grouped findings with real context.
 */

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const els = {
    drop: $("st-drop"),
    file: $("st-file"),
    paste: $("st-paste"),
    parseBtn: $("st-parse"),
    clearBtn: $("st-clear"),
    sampleBtn: $("st-sample"),
    status: $("st-status"),
    results: $("st-results"),
    empty: $("st-empty"),
  };

  let currentText = "";
  let currentName = "";
  /** @type {object | null} */
  let lastResult = null;

  function escapeHtml(v) {
    return String(v ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function setStatus(msg, tone) {
    if (!els.status) return;
    els.status.textContent = msg || "";
    if (tone) els.status.dataset.tone = tone;
    else delete els.status.dataset.tone;
  }

  function severityPill(sev) {
    if (sev === "high")
      return '<span class="mac-pill mac-pill--warn">high</span>';
    if (sev === "med") return '<span class="mac-pill st-pill--med">med</span>';
    return '<span class="mac-pill st-pill--low">low</span>';
  }

  function formatBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / (1024 * 1024)).toFixed(1) + " MB";
  }

  function renderEvidenceBlock(ev) {
    const before = (ev.contextBefore || [])
      .map(
        (l) =>
          `<div class="st-ctx st-ctx--before">${escapeHtml(l || " ")}</div>`
      )
      .join("");
    const after = (ev.contextAfter || [])
      .map(
        (l) =>
          `<div class="st-ctx st-ctx--after">${escapeHtml(l || " ")}</div>`
      )
      .join("");
    return `
      <div class="st-evidence">
        <div class="st-evidence__meta mono">line ${ev.line}</div>
        <div class="st-evidence__block mono">
          ${before}
          <div class="st-ctx st-ctx--hit">${escapeHtml(ev.text)}</div>
          ${after}
        </div>
      </div>`;
  }

  function renderFindingGroup(g) {
    // Always start collapsed — user opens groups of interest.
    const samples = g.evidence
      .map((ev) => renderEvidenceBlock(ev))
      .join("");
    return `
      <details class="st-finding st-finding--${escapeHtml(g.severity)}">
        <summary class="st-finding__summary">
          ${severityPill(g.severity)}
          <span class="st-finding__title">${escapeHtml(g.title)}</span>
          <span class="st-finding__count mono">${g.count} hit${
            g.count === 1 ? "" : "s"
          }</span>
          <span class="mac-chevron" aria-hidden="true"></span>
        </summary>
        <div class="st-finding__body">
          <p class="st-finding__hint">${escapeHtml(g.hint)}</p>
          <div class="st-evidence-list">${samples}</div>
        </div>
      </details>`;
  }

  function renderFacts(facts) {
    if (!facts.length) {
      return `<p class="hint">No tidy facts fell out. Either this isn’t a show-tech, or the format is one of those special children we haven’t met yet.</p>`;
    }
    // Split Central/Mist rows into their own list for scanning
    const centralLabels = new Set([
      "Central connection",
      "Central status detail",
      "Central server",
      "Central last disconnect",
      "Central last connect fail",
      "Mist status",
    ]);
    const platform = facts.filter((x) => !centralLabels.has(x.label));
    const central = facts.filter((x) => centralLabels.has(x.label));
    const list = (rows) =>
      rows.length
        ? `<dl class="st-facts">
        ${rows
          .map(
            (x) => `
          <div class="st-fact">
            <dt>${escapeHtml(x.label)}</dt>
            <dd class="mono">${escapeHtml(x.value)}</dd>
          </div>`
          )
          .join("")}
      </dl>`
        : "";
    return (
      list(platform) +
      (central.length
        ? `<h3 class="st-subhead">Aruba Central <span class="st-subhead__note">(Mist: coming soon)</span></h3>${list(
            central
          )}`
        : "")
    );
  }

  function render(result) {
    if (!els.results) return;
    lastResult = result || null;
    if (!result) {
      els.results.innerHTML = "";
      els.results.classList.add("hidden");
      if (els.empty) els.empty.classList.remove("hidden");
      return;
    }

    if (els.empty) els.empty.classList.add("hidden");
    els.results.classList.remove("hidden");

    const f = result.family;
    const m = result.meta;
    const findings = result.findings || [];

    const findingsHtml = findings.length
      ? findings.map(renderFindingGroup).join("")
      : `<p class="hint">No scream-level keywords survived the noise filter. That is not a warranty. Quiet dumps still break in creative ways.</p>`;

    const sectionsHtml = result.sections.length
      ? `<ul class="st-sections">
          ${result.sections
            .slice(0, 24)
            .map(
              (s) =>
                `<li><span class="mono">L${s.line}</span> ${escapeHtml(
                  s.title
                )}</li>`
            )
            .join("")}
          ${
            result.sections.length > 24
              ? `<li class="hint">…and ${
                  result.sections.length - 24
                } more. We got bored counting.</li>`
              : ""
          }
        </ul>`
      : `<p class="hint">No obvious section headers. Partial paste? Modern art?</p>`;

    els.results.innerHTML = `
      <section class="panel st-sticky" aria-labelledby="st-sticky-heading">
        <h2 id="st-sticky-heading">Sticky note</h2>
        <p class="st-oneliner">${escapeHtml(result.oneLiner)}</p>
        <dl class="st-meta-bar">
          <div class="st-meta-item">
            <dt>Family</dt>
            <dd>${escapeHtml(f.label)}</dd>
          </div>
          <div class="st-meta-item">
            <dt>Lines</dt>
            <dd class="mono">${m.lines.toLocaleString()}</dd>
          </div>
          <div class="st-meta-item">
            <dt>Size</dt>
            <dd class="mono">${formatBytes(m.bytes)}</dd>
          </div>
          <div class="st-meta-item">
            <dt>Findings</dt>
            <dd class="mono">${m.findingGroups || findings.length} groups · ${
              m.highFlags
            }H / ${m.medFlags}M / ${m.lowFlags}L hits</dd>
          </div>
          ${
            m.filename
              ? `<div class="st-meta-item">
            <dt>File</dt>
            <dd class="mono">${escapeHtml(m.filename)}</dd>
          </div>`
              : ""
          }
        </dl>
        <p class="hint st-sticky__disclaimer">
          Findings are grouped keyword hits with neighbors — not a diagnosis,
          health score, or personality test for your switch.
        </p>
        <div class="form-actions" style="margin-top: 0.85rem">
          <button type="button" class="btn btn--secondary" id="st-export">
            Export report (.txt)
          </button>
        </div>
      </section>

      <section class="panel st-facts-panel" aria-labelledby="st-facts-heading">
        <h2 id="st-facts-heading">Clear facts</h2>
        ${renderFacts(result.facts)}
      </section>

      <section class="panel st-findings-panel" aria-labelledby="st-flags-heading">
        <h2 id="st-flags-heading">Looks wrong (or at least loud)</h2>
        <div class="st-findings">${findingsHtml}</div>
      </section>

      <section class="panel" aria-labelledby="st-sections-heading">
        <h2 id="st-sections-heading">Sections we noticed</h2>
        <p class="hint">On-page only — left out of export so TAC doesn’t get a table of contents instead of a story.</p>
        ${sectionsHtml}
      </section>

      <section class="panel" aria-labelledby="st-copy-heading">
        <h2 id="st-copy-heading">For the ticket</h2>
        <p class="panel__intro">Copy-paste bait. Edit before you impress anyone.</p>
        <pre class="st-ticket mono" id="st-ticket">${escapeHtml(
          buildTicket(result)
        )}</pre>
        <div class="form-actions" style="margin-top: 0.75rem">
          <button type="button" class="btn btn--secondary" id="st-copy-ticket">Copy ticket text</button>
          <button type="button" class="btn btn--ghost" id="st-export-2">Export report (.txt)</button>
        </div>
      </section>
    `;

    const wireExport = (btn) => {
      if (!btn) return;
      btn.addEventListener("click", () => exportReport(result));
    };
    wireExport($("st-export"));
    wireExport($("st-export-2"));

    const copyBtn = $("st-copy-ticket");
    if (copyBtn) {
      copyBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(buildTicket(result));
          setStatus(
            "Copied. Try not to paste it into the wrong Teams chat.",
            "ok"
          );
        } catch {
          setStatus(
            "Clipboard said no. Select the box and Ctrl+C like it’s 2004.",
            "error"
          );
        }
      });
    }
  }

  /** Full export: sticky + facts + findings + ticket. Skips “sections we noticed”. */
  function buildExport(result) {
    const lines = [];
    lines.push("=== Show-Tech Sticky Note export ===");
    lines.push("(unofficial · browser-local · not TAC)");
    lines.push("");
    lines.push("--- Sticky note ---");
    lines.push(result.oneLiner);
    lines.push(`Family: ${result.family.label}`);
    if (result.meta && result.meta.filename)
      lines.push(`File: ${result.meta.filename}`);
    if (result.meta)
      lines.push(
        `Size: ${result.meta.lines} lines / ${result.meta.bytes} bytes`
      );
    lines.push("");
    lines.push("--- Clear facts ---");
    for (const f of result.facts || []) {
      lines.push(`${f.label}: ${f.value}`);
    }
    lines.push("");
    lines.push("--- Looks wrong (grouped findings) ---");
    const findings = result.findings || [];
    if (!findings.length) {
      lines.push("(none matched after noise filter)");
    } else {
      for (const g of findings) {
        lines.push("");
        lines.push(
          `[${g.severity}] ${g.title} (${g.count} hit${g.count === 1 ? "" : "s"})`
        );
        if (g.hint) lines.push(`  ${g.hint}`);
        for (const ev of g.evidence) {
          lines.push(`  L${ev.line}: ${ev.text}`);
          for (const b of ev.contextBefore || []) lines.push(`      | ${b}`);
          for (const a of ev.contextAfter || []) lines.push(`      | ${a}`);
        }
      }
    }
    lines.push("");
    lines.push("--- For the ticket ---");
    lines.push(buildTicket(result));
    lines.push("");
    lines.push("=== end export ===");
    return lines.join("\n");
  }

  function exportReport(result) {
    if (!result) {
      setStatus("Nothing to export. Parse a dump first.", "error");
      return;
    }
    const body = buildExport(result);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const base =
      (result.meta && result.meta.filename
        ? result.meta.filename.replace(/\.[^.]+$/, "")
        : "show-tech") || "show-tech";
    const name = `${base}-sticky-${stamp}.txt`;
    try {
      const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus(`Exported ${name}. Sections-we-noticed stayed home.`, "ok");
    } catch (err) {
      console.error(err);
      setStatus("Export failed. Clipboard may still work on the ticket box.", "error");
    }
  }

  function buildTicket(result) {
    const lines = [];
    lines.push("Show-tech sticky note (unofficial, browser-local)");
    lines.push(result.oneLiner);
    lines.push("");
    lines.push(`Family guess: ${result.family.label}`);
    if (result.facts.length) {
      lines.push("Facts:");
      for (const f of result.facts) lines.push(`  - ${f.label}: ${f.value}`);
    }
    // Explicit Central block for ticket copy (same fields, always called out)
    const c = result.central;
    lines.push("");
    lines.push("Aruba Central:");
    if (c) {
      const conn =
        c.connected === true
          ? "Connected"
          : c.connected === false
            ? "Not connected"
            : c.statusRaw || "Unknown (not in dump)";
      lines.push(`  - Connected now: ${conn}`);
      lines.push(`  - Server: ${c.server || "Unknown (not in dump)"}`);
      let disc = c.lastDisconnectReason || "Unknown (not in dump)";
      if (c.lastDisconnectTime) disc += ` @ ${c.lastDisconnectTime}`;
      lines.push(`  - Last disconnect reason: ${disc}`);
      if (c.lastConnectFailReason) {
        let fail = c.lastConnectFailReason;
        if (c.lastConnectFailTime) fail += ` @ ${c.lastConnectFailTime}`;
        lines.push(`  - Last connect fail: ${fail}`);
      }
    } else {
      lines.push("  - Connected now: Unknown (not in dump)");
      lines.push("  - Server: Unknown (not in dump)");
      lines.push("  - Last disconnect reason: Unknown (not in dump)");
    }
    lines.push("  - Mist: coming soon (not parsed yet)");
    const findings = result.findings || [];
    if (findings.length) {
      lines.push("");
      lines.push("Findings (grouped):");
      for (const g of findings) {
        lines.push(
          `  [${g.severity}] ${g.title} (${g.count} hit${g.count === 1 ? "" : "s"})`
        );
        for (const ev of g.evidence.slice(0, 5)) {
          lines.push(`      L${ev.line}: ${ev.text}`);
        }
        if (g.evidence.length > 5) {
          lines.push(`      … ${g.evidence.length - 5} more hits`);
        }
      }
    } else {
      lines.push("");
      lines.push("Findings: none matched after noise filter.");
    }
    lines.push("");
    lines.push("Not TAC. Not a root cause. Just a shorter novel.");
    return lines.join("\n");
  }

  function runParse() {
    const fromPaste = (els.paste && els.paste.value) || "";
    const text = fromPaste.trim() ? fromPaste : currentText;
    if (!text || !text.trim()) {
      setStatus(
        "Need a dump first. Paste text or drop a .txt — we don’t do interpretive silence.",
        "error"
      );
      render(null);
      return;
    }
    if (!globalThis.ShowTechParser) {
      setStatus(
        "Parser failed to load. That’s on us. Refresh and pretend it never happened.",
        "error"
      );
      return;
    }
    const name = fromPaste.trim()
      ? currentName || "paste"
      : currentName || "paste";
    const result = globalThis.ShowTechParser.parseTechDump(text, {
      filename: name,
    });
    render(result);
    const groups = (result.findings || []).length;
    setStatus(
      `Parsed ${result.meta.lines.toLocaleString()} lines · ${
        result.family.label
      } · ${groups} finding group${groups === 1 ? "" : "s"}.`,
      "ok"
    );
  }

  function clearAll() {
    currentText = "";
    currentName = "";
    if (els.paste) els.paste.value = "";
    if (els.file) els.file.value = "";
    render(null);
    setStatus(
      "Cleared. The switch is still broken somewhere; just not in this tab.",
      ""
    );
  }

  async function readFile(file) {
    const text = await file.text();
    currentText = text;
    currentName = file.name || "upload";
    if (els.paste) {
      if (text.length < 1_500_000) els.paste.value = text;
      else {
        els.paste.value = "";
        setStatus(
          `Loaded ${file.name} (${formatBytes(
            text.length
          )}). Too chunky for the textarea — still parseable.`,
          "ok"
        );
      }
    }
  }

  function wireDrop() {
    const zone = els.drop;
    if (!zone) return;

    const stop = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };

    ["dragenter", "dragover"].forEach((ev) => {
      zone.addEventListener(ev, (e) => {
        stop(e);
        zone.classList.add("st-drop--hot");
      });
    });
    ["dragleave", "drop"].forEach((ev) => {
      zone.addEventListener(ev, (e) => {
        stop(e);
        zone.classList.remove("st-drop--hot");
      });
    });

    zone.addEventListener("drop", async (e) => {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) {
        setStatus("That drop had the emotional support of zero files.", "error");
        return;
      }
      try {
        await readFile(files[0]);
        setStatus(
          `Loaded ${files[0].name}. Hit parse when you’ve finished admiring it.`,
          "ok"
        );
      } catch (err) {
        console.error(err);
        setStatus(
          "Could not read that file. Try a plain text dump, not a surprise .zip.",
          "error"
        );
      }
    });

    zone.addEventListener("click", () => {
      if (els.file) els.file.click();
    });
    zone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (els.file) els.file.click();
      }
    });
  }

  const DEMO = `! demo AOS-CX-shaped paste — not a real customer, not legal advice
*********************************
Command : show system
*********************************
Hostname               : lab-6300-a
Product Name           : JL658A 6300M 48G CL4 PoE 4SFP56 Sw
Chassis Serial Nbr     : TW90KZZ000
AOS-CX Version         : FL.10.17.1020
Up Time                : 14 days, 3 hours, 12 minutes
CPU Util (%)           : 12

*********************************
Command : show version
*********************************
AOS-CX
Version      : FL.10.17.1020
Active Image : primary

*********************************
Command : show logging
*********************************
2026-04-01T03:14:15 lab-6300-a daemon.err intfd: ERROR interface 1/1/5 moved to err-disabled state
2026-04-01T03:15:01 lab-6300-a hpe-envd: CRITICAL temperature sensor 2 high threshold
2026-04-01T04:00:00 lab-6300-a: fan tray 1 fault detected during self-test
2026-04-01T05:00:00 lab-6300-a: Total number of core dumps : 2
`;

  function loadSample() {
    currentText = DEMO;
    currentName = "demo-aos-cx.txt";
    if (els.paste) els.paste.value = DEMO;
    setStatus(
      "Loaded a fake CX dump with just enough drama to flex the findings.",
      "ok"
    );
    runParse();
  }

  function init() {
    wireDrop();
    if (els.file) {
      els.file.addEventListener("change", async () => {
        const file = els.file.files && els.file.files[0];
        if (!file) return;
        try {
          await readFile(file);
          setStatus(`Loaded ${file.name}.`, "ok");
        } catch (err) {
          console.error(err);
          setStatus(
            "File read failed. Text only — we’re not your unzip guy.",
            "error"
          );
        }
      });
    }
    if (els.parseBtn) els.parseBtn.addEventListener("click", runParse);
    if (els.clearBtn) els.clearBtn.addEventListener("click", clearAll);
    if (els.sampleBtn) els.sampleBtn.addEventListener("click", loadSample);
    render(null);
    setStatus("Waiting for a dump. Silence is not a valid show-tech.", "");
  }

  init();
})();
