/**
 * CLI Explorer — multi-bank tree + filter + detail pane (static JSON).
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = "cli-explorer-bank";

  /** @type {{ banks: Array<{id:string,label:string,family?:string,versionHint?:string,default?:boolean,dataPath:string}> } | null} */
  let catalog = null;
  /** @type {{ tree: any[] } | null} */
  let treeData = null;
  /** @type {Record<string, any> | null} */
  let entries = null;
  /** @type {any} */
  let meta = null;
  /** @type {string | null} */
  let activeBankId = null;
  let filterQ = "";
  let selectedId = null;

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  async function loadJson(path) {
    const res = await fetch(path, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  }

  function bankById(id) {
    return (catalog && catalog.banks || []).find((b) => b.id === id) || null;
  }

  function defaultBankId() {
    const banks = (catalog && catalog.banks) || [];
    if (!banks.length) return null;
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && banks.some((b) => b.id === stored)) return stored;
    const def = banks.find((b) => b.default);
    return (def || banks[0]).id;
  }

  function dataBase(bank) {
    // dataPath is like "data/aos-cx-10.17" relative to tool root
    const p = (bank && bank.dataPath) || `data/${bank.id}`;
    return p.startsWith("./") ? p : `./${p}`;
  }

  function nodeMatches(node, q) {
    if (!q) return true;
    if (node.title.toLowerCase().includes(q)) return true;
    if (node.children) {
      return node.children.some((c) => nodeMatches(c, q));
    }
    return false;
  }

  function filterTree(nodes, q) {
    if (!q) return nodes;
    const out = [];
    for (const n of nodes) {
      if (n.children && n.children.length) {
        const kids = filterTree(n.children, q);
        if (kids.length || n.title.toLowerCase().includes(q)) {
          out.push({ ...n, children: kids, _forceOpen: true });
        }
      } else if (n.title.toLowerCase().includes(q)) {
        out.push(n);
      }
    }
    return out;
  }

  function countLeaves(nodes) {
    let n = 0;
    for (const node of nodes) {
      if (node.children && node.children.length) n += countLeaves(node.children);
      else n += 1;
    }
    return n;
  }

  function renderBankSelect() {
    const sel = $("cx-bank");
    if (!sel || !catalog) return;
    const banks = catalog.banks || [];
    sel.innerHTML = banks
      .map((b) => {
        const label = b.family
          ? `${escapeHtml(b.label)}`
          : escapeHtml(b.label || b.id);
        return `<option value="${escapeHtml(b.id)}">${label}</option>`;
      })
      .join("");
    if (activeBankId) sel.value = activeBankId;
    sel.disabled = banks.length <= 1;
  }

  function renderTree() {
    const root = $("cx-tree");
    if (!treeData || !treeData.tree) {
      root.innerHTML = `<p class="hint" style="padding:0.75rem">No tree loaded.</p>`;
      $("cx-count").textContent = "";
      return;
    }
    const q = filterQ.trim().toLowerCase();
    const nodes = filterTree(treeData.tree, q);
    root.innerHTML = "";
    if (!nodes.length) {
      root.innerHTML = `<p class="hint" style="padding:0.75rem">No matches for “${escapeHtml(
        filterQ
      )}”.</p>`;
      $("cx-count").textContent = "0 shown";
      return;
    }
    const ul = document.createElement("ul");
    ul.className = "cx-tree__list";
    for (const n of nodes) ul.appendChild(renderNode(n, q, 0));
    root.appendChild(ul);
    $("cx-count").textContent =
      `${countLeaves(nodes)} shown` + (q ? ` (filter: “${filterQ}”)` : "");
  }

  function renderNode(node, q, depth) {
    const li = document.createElement("li");
    li.className = "cx-tree__item";
    li.style.setProperty("--depth", String(depth));

    const hasKids = node.children && node.children.length > 0;
    const row = document.createElement("div");
    row.className =
      "cx-tree__row" + (selectedId === node.id ? " is-selected" : "");
    row.setAttribute("role", "treeitem");
    row.dataset.id = node.id;

    if (hasKids) {
      const open = node._forceOpen || (!!q && nodeMatches(node, q));
      const det = document.createElement("details");
      if (open) det.open = true;
      const sum = document.createElement("summary");
      sum.className =
        "cx-tree__summary" + (selectedId === node.id ? " is-selected" : "");
      sum.dataset.id = node.id;
      sum.innerHTML = `<span class="cx-tree__twisty" aria-hidden="true"></span>
        <span class="cx-tree__folder" aria-hidden="true"></span>
        <span class="cx-tree__title">${escapeHtml(node.title)}</span>
        <span class="cx-tree__meta">${node.children.length}</span>`;
      det.appendChild(sum);
      const childUl = document.createElement("ul");
      childUl.className = "cx-tree__list";
      for (const c of node.children) {
        childUl.appendChild(renderNode(c, q, depth + 1));
      }
      det.appendChild(childUl);
      sum.addEventListener("click", () => {
        selectEntry(node.id);
      });
      li.appendChild(det);
    } else {
      row.innerHTML = `<span class="cx-tree__leaf" aria-hidden="true"></span>
        <span class="cx-tree__title">${escapeHtml(node.title)}</span>`;
      row.tabIndex = 0;
      row.addEventListener("click", () => selectEntry(node.id));
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          selectEntry(node.id);
        }
      });
      li.appendChild(row);
    }
    return li;
  }

  function selectEntry(id) {
    selectedId = id;
    document
      .querySelectorAll(".cx-tree__row.is-selected, .cx-tree__summary.is-selected")
      .forEach((el) => el.classList.remove("is-selected"));
    document.querySelectorAll(`[data-id="${CSS.escape(id)}"]`).forEach((el) => {
      el.classList.add("is-selected");
    });
    renderDetail(id);
  }

  function renderDataTable(rows, className) {
    if (!rows || !rows.length) return "";
    const head = rows[0] || [];
    const body = rows.slice(1);
    const thead = `<thead><tr>${head
      .map((c) => `<th>${escapeHtml(c || "")}</th>`)
      .join("")}</tr></thead>`;
    const tbody = `<tbody>${body
      .map(
        (row) =>
          `<tr>${(row || [])
            .map((c) => `<td>${escapeHtml(c || "")}</td>`)
            .join("")}</tr>`
      )
      .join("")}</tbody>`;
    return `<div class="cx-table-wrap"><table class="cx-table ${className || ""}">${thead}${tbody}</table></div>`;
  }

  function renderDetail(id) {
    const el = $("cx-detail");
    const entry = entries && entries[id];
    if (!entry) {
      el.innerHTML = `<p class="hint">No entry data for <code>${escapeHtml(id)}</code>.</p>`;
      return;
    }

    const pageLabel =
      entry.pageEnd && entry.pageEnd !== entry.page
        ? `pp. ${entry.page}–${entry.pageEnd}`
        : `p. ${entry.page}`;

    const syntaxText = [entry.syntax, entry.syntaxNo].filter(Boolean).join("\n");
    const syntax = syntaxText
      ? `<div class="cx-block">
          <h3 class="cx-block__h">Syntax</h3>
          <pre class="cx-syntax">${escapeHtml(syntaxText)}</pre>
        </div>`
      : "";

    const desc = entry.description
      ? `<div class="cx-block">
          <h3 class="cx-block__h">Description</h3>
          <p class="cx-desc">${escapeHtml(entry.description)}</p>
        </div>`
      : "";

    // Prefer structured param table; fall back to layout-preserving mono block
    let params = "";
    if (entry.paramRows && entry.paramRows.length) {
      params = `<div class="cx-block">
          <h3 class="cx-block__h">Parameters</h3>
          ${renderDataTable(entry.paramRows, "cx-table--params")}
        </div>`;
    } else if (entry.parameters) {
      params = `<div class="cx-block">
          <h3 class="cx-block__h">Parameters</h3>
          <pre class="cx-mono-block">${escapeHtml(entry.parameters)}</pre>
        </div>`;
    }

    // Examples: monospace, no wrap — CLI output tables need column alignment
    const examples = entry.examples
      ? `<div class="cx-block">
          <h3 class="cx-block__h">Examples</h3>
          <pre class="cx-mono-block cx-mono-block--example">${escapeHtml(
            entry.examples
          )}</pre>
        </div>`
      : "";

    const usage = entry.usage
      ? `<div class="cx-block">
          <h3 class="cx-block__h">Usage</h3>
          <p class="cx-desc">${escapeHtml(entry.usage)}</p>
        </div>`
      : "";

    const infoBits = [
      entry.platforms
        ? `<div class="meta-chip"><span>Platforms</span><strong>${escapeHtml(entry.platforms)}</strong></div>`
        : "",
      entry.context
        ? `<div class="meta-chip"><span>Command context</span><strong>${escapeHtml(entry.context)}</strong></div>`
        : "",
      entry.authority
        ? `<div class="meta-chip"><span>Authority</span><strong>${escapeHtml(entry.authority)}</strong></div>`
        : "",
    ].filter(Boolean);
    const historyTable =
      entry.historyRows && entry.historyRows.length
        ? renderDataTable(entry.historyRows, "cx-table--history")
        : "";
    const info =
      infoBits.length || historyTable
        ? `<div class="cx-block">
          <h3 class="cx-block__h">Command information</h3>
          ${infoBits.length ? `<div class="results-meta">${infoBits.join("")}</div>` : ""}
          ${historyTable}
        </div>`
        : "";

    const preview = entry.preview
      ? `<details class="cx-more">
          <summary>Raw extracted block</summary>
          <pre class="cx-mono-block cx-mono-block--raw">${escapeHtml(
            entry.preview
          )}</pre>
        </details>`
      : "";

    el.innerHTML = `
      <p class="cx-crumb">${escapeHtml(entry.chapter || "CLI")}</p>
      <h2 id="cx-detail-title" class="cx-detail__title">${escapeHtml(entry.title)}</h2>
      <p class="cx-detail__meta">
        <span class="inline-code">${escapeHtml(pageLabel)}</span>
        ${entry.leaf === false ? " · chapter / section" : " · command"}
      </p>
      ${syntax}
      ${desc}
      ${params}
      ${examples}
      ${usage}
      ${info}
      ${preview}
    `;
  }

  function setAllOpen(open) {
    $("cx-tree").querySelectorAll("details").forEach((d) => {
      d.open = open;
    });
  }

  function updateMetaLine() {
    const metaEl = $("meta-line");
    if (!meta) {
      metaEl.textContent = "No bank loaded.";
      return;
    }
    const srcNote = meta.sourceNote
      ? escapeHtml(meta.sourceNote)
      : meta.versionHint
        ? `Indexed from ${escapeHtml(String(meta.versionHint))} CLI PDF`
        : "Indexed from local CLI PDF";
    const disc = meta.sourceDisclaimer
      ? `<span class="hint" style="display:block;margin-top:0.35rem">${escapeHtml(
          meta.sourceDisclaimer
        )}</span>`
      : "";
    metaEl.className = "callout callout--soft";
    metaEl.innerHTML = `<strong>${escapeHtml(meta.label || meta.source || "CLI")}</strong>
      · ${srcNote}
      · ${meta.tocCount || "?"} TOC entries
      · ${meta.leafCount || "?"} commands
      · ${meta.pageCount || "?"} source pages
      ${disc}`;
  }

  function clearDetail() {
    selectedId = null;
    $("cx-detail").innerHTML =
      '<p class="hint">Pick a command from the tree (or filter, then click a hit).</p>';
  }

  async function loadBank(bankId) {
    const bank = bankById(bankId);
    if (!bank) throw new Error(`Unknown bank: ${bankId}`);
    const base = dataBase(bank);
    const metaEl = $("meta-line");
    metaEl.className = "callout callout--soft";
    metaEl.textContent = `Loading ${bank.label || bankId}…`;
    $("cx-tree").innerHTML = "";
    $("cx-count").textContent = "";
    clearDetail();

    const [m, t, e] = await Promise.all([
      loadJson(`${base}/meta.json`),
      loadJson(`${base}/tree.json`),
      loadJson(`${base}/entries.json`),
    ]);
    meta = m;
    treeData = t;
    entries = e;
    activeBankId = bankId;
    localStorage.setItem(STORAGE_KEY, bankId);
    if ($("cx-bank")) $("cx-bank").value = bankId;
    filterQ = "";
    if ($("cx-filter")) $("cx-filter").value = "";
    updateMetaLine();
    renderTree();
  }

  async function init() {
    const metaEl = $("meta-line");
    try {
      catalog = await loadJson("./data/catalog.json");
      if (!catalog.banks || !catalog.banks.length) {
        throw new Error("catalog.json has no banks");
      }
      renderBankSelect();
      const id = defaultBankId();
      await loadBank(id);
    } catch (err) {
      console.error(err);
      metaEl.className = "callout callout--warn";
      metaEl.innerHTML = `<strong>CLI data not ready.</strong>
        Place PDFs under <span class="inline-code">source/</span> and run
        <span class="inline-code">.venv/bin/python build_from_pdf.py --bank aos-cx-10.17</span>
        (and optionally <span class="inline-code">--bank aos-10</span>).
        <br><span class="hint">${escapeHtml(err.message || String(err))}</span>`;
    }

    const bankSel = $("cx-bank");
    if (bankSel) {
      bankSel.addEventListener("change", async (e) => {
        const id = e.target.value;
        if (!id || id === activeBankId) return;
        try {
          await loadBank(id);
        } catch (err) {
          console.error(err);
          metaEl.className = "callout callout--warn";
          metaEl.innerHTML = `<strong>Failed to load bank.</strong>
            <span class="hint">${escapeHtml(err.message || String(err))}</span>`;
        }
      });
    }

    $("cx-filter").addEventListener("input", (e) => {
      filterQ = e.target.value || "";
      renderTree();
    });
    $("cx-expand").addEventListener("click", () => setAllOpen(true));
    $("cx-collapse").addEventListener("click", () => setAllOpen(false));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
