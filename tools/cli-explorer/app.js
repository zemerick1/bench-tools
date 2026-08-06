/**
 * CLI Explorer — multi-bank tree + filter + detail pane (static JSON).
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = "cli-explorer-bank";

  /** @type {{ banks: Array<Bank>} | null} */
  let catalog = null;
  /**
   * @typedef {{
   *   id: string,
   *   label: string,
   *   family: string,
   *   versionHint: string,
   *   platform: string|null,
   *   default?: boolean,
   *   dataPath?: string,
   *   layers?: {common:string, platform:string}
   * }} Bank
   */
  /** @type {Bank[]} */
  let banks = [];
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
  /** Prevent re-entrant select change handlers while syncing dropdowns */
  let syncingSelects = false;

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
    return banks.find((b) => b.id === id) || null;
  }

  /**
   * Normalize catalog rows so the UI always has family / version / platform.
   * Accepts both hand-written catalog entries and bare folder ids.
   * @param {any} raw
   * @returns {Bank}
   */
  function normalizeBank(raw) {
    const id = String(raw.id || "");
    let family = (raw.family || "").trim();
    let versionHint = (raw.versionHint || "").trim();
    let platform =
      raw.platform === undefined || raw.platform === ""
        ? null
        : raw.platform === null
          ? null
          : String(raw.platform);

    if (!family) {
      if (id === "aos-10" || id.startsWith("aos-10")) family = "AOS 10";
      else if (id.startsWith("aos-cx")) family = "AOS-CX";
      else family = "Other";
    }

    // aos-cx-10.18-6100  |  aos-cx-10.17  |  aos-cx-10.17.1000-6200
    const cx = id.match(/^aos-cx-(\d+(?:\.\d+)*)(?:-(.+))?$/i);
    if (cx) {
      if (!versionHint) versionHint = cx[1];
      if (platform === null && cx[2]) platform = cx[2];
      // legacy single-bank 10.17 build was from the 6200 PDF
      if (platform === null && versionHint === "10.17") platform = "6200";
    }
    if (id === "aos-10" || family === "AOS 10") {
      family = "AOS 10";
      if (!versionHint) versionHint = "10.x";
      platform = null;
    }

    let label = (raw.label || "").trim();
    if (!label || /^aos-cx-/i.test(label) || label === id) {
      if (family === "AOS 10") label = "AOS 10.x";
      else if (platform) label = `AOS-CX ${versionHint} · ${platform}`;
      else label = `AOS-CX ${versionHint}`;
    }

    return {
      id,
      label,
      family,
      versionHint,
      platform,
      default: !!raw.default,
      dataPath: raw.dataPath || `data/${id}`,
      layers: raw.layers || undefined,
    };
  }

  function defaultBankId() {
    if (!banks.length) return null;
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && banks.some((b) => b.id === stored)) return stored;
    const def = banks.find((b) => b.default);
    return (def || banks[0]).id;
  }

  function compareVersions(a, b) {
    const pa = String(a).split(".").map((x) => parseInt(x, 10) || 0);
    const pb = String(b).split(".").map((x) => parseInt(x, 10) || 0);
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  }

  function families() {
    const order = ["AOS-CX", "AOS 10"];
    const set = new Set(banks.map((b) => b.family));
    return [...order.filter((f) => set.has(f)), ...[...set].filter((f) => !order.includes(f))];
  }

  function versionsFor(family) {
    const set = new Set(
      banks.filter((b) => b.family === family).map((b) => b.versionHint)
    );
    return [...set].sort((a, b) => compareVersions(b, a)); // newest first
  }

  function modelsFor(family, version) {
    return banks
      .filter((b) => b.family === family && b.versionHint === version)
      .slice()
      .sort((a, b) => String(a.platform || "").localeCompare(String(b.platform || ""), undefined, { numeric: true }));
  }

  function resolveBank(family, version, platform) {
    if (family === "AOS 10") {
      return banks.find((b) => b.family === "AOS 10") || null;
    }
    const matches = banks.filter(
      (b) => b.family === family && b.versionHint === version
    );
    if (!matches.length) return null;
    if (platform != null && platform !== "") {
      const hit = matches.find((b) => b.platform === platform);
      if (hit) return hit;
    }
    return matches[0];
  }

  function setFieldVisible(wrapId, visible) {
    const el = $(wrapId);
    if (!el) return;
    el.classList.toggle("is-hidden", !visible);
  }

  function fillSelect(sel, options, selected) {
    if (!sel) return;
    sel.innerHTML = options
      .map(
        (o) =>
          `<option value="${escapeHtml(o.value)}"${
            o.value === selected ? " selected" : ""
          }>${escapeHtml(o.label)}</option>`
      )
      .join("");
  }

  /** Rebuild Product / Version / Model dropdowns from catalog + active bank. */
  function renderSelectors(preferredBankId) {
    const bank = bankById(preferredBankId) || bankById(defaultBankId());
    if (!bank) return;

    const famList = families();
    const family = famList.includes(bank.family) ? bank.family : famList[0];
    const isCx = family === "AOS-CX";

    fillSelect(
      $("cx-family"),
      famList.map((f) => ({ value: f, label: f })),
      family
    );

    if (isCx) {
      setFieldVisible("cx-version-wrap", true);
      setFieldVisible("cx-model-wrap", true);
      const vers = versionsFor(family);
      const version = vers.includes(bank.versionHint) ? bank.versionHint : vers[0];
      fillSelect(
        $("cx-version"),
        vers.map((v) => ({ value: v, label: v })),
        version
      );
      const models = modelsFor(family, version);
      const platform =
        models.find((m) => m.platform === bank.platform)?.platform ||
        (models[0] && models[0].platform) ||
        "";
      fillSelect(
        $("cx-model"),
        models.map((m) => ({
          value: m.platform || m.id,
          label: m.platform || m.label || m.id,
        })),
        platform
      );
      $("cx-version").disabled = vers.length <= 1;
      $("cx-model").disabled = models.length <= 1;
    } else {
      // AOS 10 — no version/model drill-down
      setFieldVisible("cx-version-wrap", false);
      setFieldVisible("cx-model-wrap", false);
      fillSelect($("cx-version"), [{ value: "", label: "—" }], "");
      fillSelect($("cx-model"), [{ value: "", label: "—" }], "");
    }
  }

  function selectionFromUi() {
    const family = $("cx-family")?.value || "";
    const version = $("cx-version")?.value || "";
    const model = $("cx-model")?.value || "";
    return resolveBank(family, version, model || null);
  }

  async function applySelectionFromUi() {
    if (syncingSelects) return;
    const bank = selectionFromUi();
    if (!bank) return;
    if (bank.id === activeBankId) {
      renderSelectors(bank.id);
      return;
    }
    try {
      await loadBank(bank.id);
    } catch (err) {
      console.error(err);
      const metaEl = $("meta-line");
      metaEl.className = "callout callout--warn";
      metaEl.innerHTML = `<strong>Failed to load bank.</strong>
        <span class="hint">${escapeHtml(err.message || String(err))}</span>`;
    }
  }

  function dataBase(bank) {
    // dataPath is like "data/aos-cx-10.17" relative to tool root
    const p = (bank && bank.dataPath) || `data/${bank.id}`;
    return p.startsWith("./") ? p : `./${p}`;
  }

  function layerPath(p) {
    if (!p) return null;
    return p.startsWith("./") ? p : `./${p}`;
  }

  /**
   * Merge two tree arrays by node title at each level.
   * Platform (b) wins on same title for leaf metadata; children are unioned.
   */
  function mergeTrees(aNodes, bNodes) {
    const a = Array.isArray(aNodes) ? aNodes : [];
    const b = Array.isArray(bNodes) ? bNodes : [];
    if (!a.length) return cloneTree(b);
    if (!b.length) return cloneTree(a);

    const byTitle = new Map();
    const order = [];

    function touch(title) {
      if (!byTitle.has(title)) {
        byTitle.set(title, null);
        order.push(title);
      }
    }

    for (const n of a) touch(n.title);
    for (const n of b) touch(n.title);

    const aMap = new Map(a.map((n) => [n.title, n]));
    const bMap = new Map(b.map((n) => [n.title, n]));

    return order.map((title) => {
      const na = aMap.get(title);
      const nb = bMap.get(title);
      if (na && nb) {
        const kidsA = na.children || [];
        const kidsB = nb.children || [];
        const mergedKids =
          kidsA.length || kidsB.length ? mergeTrees(kidsA, kidsB) : undefined;
        const base = { ...(nb.leaf === false || kidsA.length || kidsB.length ? na : nb) };
        // Prefer platform leaf payload when both are leaves; keep structure from union
        if (mergedKids && mergedKids.length) {
          return {
            ...base,
            id: nb.id || na.id,
            title,
            page: nb.page || na.page,
            pageEnd: nb.pageEnd || na.pageEnd,
            chapter: nb.chapter || na.chapter,
            leaf: false,
            children: mergedKids,
          };
        }
        // Both leaves (or no kids): platform wins
        return {
          ...na,
          ...nb,
          title,
          leaf: true,
        };
      }
      return cloneTree([na || nb])[0];
    });
  }

  function cloneTree(nodes) {
    return (nodes || []).map((n) => {
      const c = { ...n };
      if (n.children) c.children = cloneTree(n.children);
      return c;
    });
  }

  async function loadPack(base) {
    const root = layerPath(base);
    const [m, t, e] = await Promise.all([
      loadJson(`${root}/meta.json`),
      loadJson(`${root}/tree.json`),
      loadJson(`${root}/entries.json`),
    ]);
    return { meta: m, tree: t, entries: e };
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
    const metaEl = $("meta-line");
    metaEl.className = "callout callout--soft";
    metaEl.textContent = `Loading ${bank.label || bankId}…`;
    $("cx-tree").innerHTML = "";
    $("cx-count").textContent = "";
    clearDetail();

    let m;
    let t;
    let e;

    if (bank.layers && bank.layers.common && bank.layers.platform) {
      // Layered bank: common + platform delta (join is hidden from the user)
      const [common, platform] = await Promise.all([
        loadPack(bank.layers.common),
        loadPack(bank.layers.platform),
      ]);
      e = Object.assign({}, common.entries, platform.entries);
      t = {
        tree: mergeTrees(common.tree.tree || common.tree, platform.tree.tree || platform.tree),
      };
      m = Object.assign({}, common.meta, platform.meta, {
        label: bank.label || platform.meta.label || common.meta.label,
        layered: true,
        layerCommon: bank.layers.common,
        layerPlatform: bank.layers.platform,
        tocCount:
          (common.meta.entryCount || 0) + (platform.meta.entryCount || 0),
        leafCount:
          (common.meta.commonLeaves || common.meta.leafCount || 0) +
          (platform.meta.uniqueLeaves || 0) +
          (platform.meta.overrideLeaves || 0) +
          (platform.meta.partialLeaves || 0),
      });
    } else {
      const base = dataBase(bank);
      const pack = await loadPack(base);
      m = pack.meta;
      t = pack.tree;
      e = pack.entries;
    }

    meta = m;
    treeData = t;
    entries = e;
    activeBankId = bankId;
    localStorage.setItem(STORAGE_KEY, bankId);
    syncingSelects = true;
    try {
      renderSelectors(bankId);
    } finally {
      syncingSelects = false;
    }
    // Prefer catalog label in chrome
    if (bank.label) meta = Object.assign({}, meta, { label: bank.label });
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
      banks = catalog.banks.map(normalizeBank);
      const id = defaultBankId();
      await loadBank(id);
    } catch (err) {
      console.error(err);
      metaEl.className = "callout callout--warn";
      metaEl.innerHTML = `<strong>CLI data not ready.</strong>
        Place PDFs under <span class="inline-code">source/</span> and run
        <span class="inline-code">.venv/bin/python build_from_pdf.py</span>
        for each bank.
        <br><span class="hint">${escapeHtml(err.message || String(err))}</span>`;
    }

    const onFamilyChange = async () => {
      if (syncingSelects) return;
      const family = $("cx-family").value;
      if (family === "AOS 10") {
        const b = resolveBank("AOS 10", "10.x", null);
        if (b) await loadBank(b.id);
        return;
      }
      // AOS-CX: pick newest version + first model
      const vers = versionsFor(family);
      const version = vers[0];
      const models = modelsFor(family, version);
      const b = models[0] || resolveBank(family, version, null);
      if (b) await loadBank(b.id);
    };

    const onVersionChange = async () => {
      if (syncingSelects) return;
      const family = $("cx-family").value;
      const version = $("cx-version").value;
      const models = modelsFor(family, version);
      const prevModel = $("cx-model").value;
      const keep = models.find((m) => m.platform === prevModel);
      const b = keep || models[0];
      if (b) await loadBank(b.id);
    };

    $("cx-family")?.addEventListener("change", onFamilyChange);
    $("cx-version")?.addEventListener("change", onVersionChange);
    $("cx-model")?.addEventListener("change", () => applySelectionFromUi());

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
