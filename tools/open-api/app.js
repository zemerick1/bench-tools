/**
 * OpenAPI docs UI — platform picker, one slice at a time in Scalar.
 */
(() => {
  const META = document.getElementById("oas-meta");
  const NAV = document.getElementById("oas-nav");
  const FILTER = document.getElementById("oas-filter");
  const PLATFORM = document.getElementById("oas-platform");
  const SWITCH_WRAP = document.getElementById("oas-switch-wrap");
  const SWITCH_IP = document.getElementById("oas-switch-ip");
  const EMPTY = document.getElementById("oas-empty");
  const VIEWER = document.getElementById("oas-viewer");

  const API_ORDER = [
    "aruba-central",
    "clearpass",
    "aos-cx",
    "uxi",
    "mist",
    "sdc",
    "axis",
  ];
  const VARIANT_LABEL = { mrt: "MRT", config: "Config" };
  const SWITCH_IP_KEY = "bench-tools.oas.aos-cx.switchIp";
  const DEFAULT_SWITCH_IP = "192.0.2.1";

  /** @type {ReturnType<typeof Scalar.createApiReference> | null} */
  let scalarApp = null;
  /** @type {object | null} */
  let manifest = null;
  /** @type {string} */
  let activeKey = "";
  /** @type {string} */
  let activePlatform = "";
  let switchIpTimer = 0;

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function specKey(specPath) {
    return String(specPath || "")
      .replace(/^specs\//, "")
      .replace(/\.json$/, "");
  }

  function specUrl(specPath) {
    return new URL(specPath, window.location.href).href;
  }

  function currentParams() {
    const url = new URL(window.location.href);
    return {
      platform: url.searchParams.get("p") || "",
      spec: url.searchParams.get("s") || "",
    };
  }

  function setParams({ platform, spec }, replace) {
    const url = new URL(window.location.href);
    if (platform) url.searchParams.set("p", platform);
    else url.searchParams.delete("p");
    if (spec) url.searchParams.set("s", spec);
    else url.searchParams.delete("s");
    url.hash = "";
    const next = url.pathname + url.search;
    if (replace) history.replaceState(null, "", next);
    else history.pushState(null, "", next);
  }

  function prefersDark() {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function sourceFor(api, group) {
    return (api.sources || []).find((src) => src.path === group.sourceFile) || {};
  }

  function sectionLabel(api, group) {
    const source = sourceFor(api, group);
    const variant = VARIANT_LABEL[group.variant] || group.variant || "";
    const title = source.title || group.sourceFile || "Spec";
    return variant ? `${variant} · ${title}` : title;
  }

  function formatBytes(bytes) {
    if (!bytes) return "0 KB";
    if (bytes < 1024) return `${bytes} B`;
    return `${Math.round(bytes / 1024)} KB`;
  }

  function apisInOrder() {
    const byId = Object.fromEntries((manifest?.apis || []).map((api) => [api.id, api]));
    const extra = Object.keys(byId)
      .filter((id) => !API_ORDER.includes(id))
      .sort();
    return [...API_ORDER, ...extra].map((id) => byId[id]).filter(Boolean);
  }

  function platformFromKey(key) {
    const first = String(key || "").split("/")[0];
    return apisInOrder().some((api) => api.id === first) ? first : "";
  }

  function allGroups() {
    const rows = [];
    for (const api of manifest?.apis || []) {
      for (const group of api.groups || []) {
        rows.push({ api, group, key: specKey(group.spec) });
      }
    }
    const variantRank = (value) =>
      value === "mrt" ? 0 : value === "config" ? 1 : 2;
    const isUncategorized = (id) =>
      id === "uncategorized" || String(id).startsWith("uncategorized");
    rows.sort((a, b) => {
      const ua = isUncategorized(a.group.id);
      const ub = isUncategorized(b.group.id);
      if (ua !== ub) return ua ? 1 : -1;
      const vr = variantRank(a.group.variant) - variantRank(b.group.variant);
      if (vr) return vr;
      const src = String(a.group.sourceFile || "").localeCompare(
        String(b.group.sourceFile || ""),
      );
      if (src) return src;
      return String(a.group.title || "").localeCompare(String(b.group.title || ""));
    });
    return rows;
  }

  function groupsForPlatform(platform) {
    return allGroups().filter((row) => row.api.id === platform);
  }

  function groupMatches(row, query) {
    if (!query) return true;
    const hay = [
      row.api.title,
      row.api.id,
      row.group.title,
      row.group.id,
      row.group.sourceFile,
      sectionLabel(row.api, row.group),
    ]
      .join(" ")
      .toLowerCase();
    if (hay.includes(query)) return true;
    return (manifest.operations || []).some(
      (op) =>
        specKey(op.spec) === row.key &&
        [op.path, op.summary, op.operationId, op.tag, op.method]
          .join(" ")
          .toLowerCase()
          .includes(query),
    );
  }

  function readSwitchIp() {
    try {
      return localStorage.getItem(SWITCH_IP_KEY) || "";
    } catch {
      return "";
    }
  }

  function writeSwitchIp(value) {
    try {
      if (value) localStorage.setItem(SWITCH_IP_KEY, value);
      else localStorage.removeItem(SWITCH_IP_KEY);
    } catch {
      /* ignore quota / private mode */
    }
  }

  function normalizeHost(raw) {
    let value = String(raw || "").trim();
    value = value.replace(/^https?:\/\//i, "");
    value = value.split("/")[0];
    return value || DEFAULT_SWITCH_IP;
  }

  function aosCxRestPath(api) {
    const version = (api?.sources && api.sources[0] && api.sources[0].version) || "10.16";
    const numeric = String(version).replace(/^v/i, "");
    return `/rest/v${numeric}`;
  }

  function populatePlatforms() {
    if (!PLATFORM) return;
    PLATFORM.replaceChildren();
    for (const api of apisInOrder()) {
      const option = document.createElement("option");
      option.value = api.id;
      option.textContent = api.title;
      PLATFORM.appendChild(option);
    }
  }

  function renderNav() {
    if (!manifest || !NAV) return;
    const query = (FILTER?.value || "").trim().toLowerCase();
    const rows = groupsForPlatform(activePlatform).filter((row) =>
      groupMatches(row, query),
    );

    if (!rows.length) {
      NAV.innerHTML = `<p class="oas-nav__empty">No groups match.</p>`;
      return;
    }

    const parts = [];
    let lastSection = "";
    const singleSource = new Set(rows.map((row) => row.group.sourceFile)).size <= 1;
    const hideSection = singleSource && !rows.some((row) => row.group.variant);
    for (const row of rows) {
      const section = sectionLabel(row.api, row.group);
      if (!hideSection && section !== lastSection) {
        lastSection = section;
        parts.push(`<h3 class="oas-nav__section">${escapeHtml(section)}</h3>`);
      }
      const selected = row.key === activeKey ? " aria-current=\"page\"" : "";
      const over = row.group.bytes > 500 * 1024 ? " oas-nav__link--warn" : "";
      parts.push(
        `<a class="oas-nav__link${over}" href="?p=${encodeURIComponent(row.api.id)}&s=${encodeURIComponent(row.key)}" data-key="${escapeHtml(row.key)}"${selected}>` +
          `<span class="oas-nav__title">${escapeHtml(row.group.title)}</span>` +
          `<span class="oas-nav__meta">${row.group.operations} · ${formatBytes(row.group.bytes)}</span>` +
          `</a>`,
      );
    }
    NAV.innerHTML = parts.join("");
  }

  function scalarConfig(url, api) {
    const config = {
      url,
      telemetry: false,
      withDefaultFonts: false,
      showDeveloperTools: "never",
      documentDownloadType: "direct",
      persistAuth: false,
      hideDarkModeToggle: true,
      hideClientButton: true,
      defaultOpenFirstTag: true,
      forceDarkModeState: prefersDark() ? "dark" : "light",
      agent: { disabled: true },
      layout: "classic",
      defaultHttpClient: { targetKey: "python", clientKey: "requests" },
      hiddenClients: { python: ["python3"] },
      customCss: `
        .scalar-app { min-height: 0 !important; height: auto !important; }
        .scalar-container { min-height: 0 !important; }
      `,
    };
    if (api?.id === "aos-cx") {
      const host = normalizeHost(SWITCH_IP?.value || readSwitchIp());
      config.servers = [
        {
          url: `https://${host}${aosCxRestPath(api)}`,
          description: "This switch",
        },
      ];
    }
    return config;
  }

  function destroyScalar() {
    if (scalarApp && typeof scalarApp.destroy === "function") {
      scalarApp.destroy();
    }
    scalarApp = null;
  }

  function showEmpty() {
    if (EMPTY) EMPTY.hidden = false;
    if (VIEWER) VIEWER.hidden = true;
    destroyScalar();
  }

  function mountScalar(row) {
    if (typeof Scalar === "undefined" || typeof Scalar.createApiReference !== "function") {
      if (VIEWER) {
        VIEWER.innerHTML =
          "<p class=\"hint\">Scalar failed to load from the CDN. Check the network / CSP.</p>";
      }
      return;
    }
    destroyScalar();
    if (VIEWER) VIEWER.replaceChildren();
    scalarApp = Scalar.createApiReference(VIEWER, scalarConfig(specUrl(row.group.spec), row.api));
  }

  function loadSlice(key) {
    const row = allGroups().find((item) => item.key === key);
    if (!row) {
      showEmpty();
      if (META) {
        META.textContent = key
          ? `Unknown slice “${key}”. Pick a group from the list.`
          : "Pick a platform, then a group.";
      }
      return;
    }

    activeKey = key;
    activePlatform = row.api.id;
    if (PLATFORM) PLATFORM.value = activePlatform;
    if (SWITCH_WRAP) SWITCH_WRAP.hidden = activePlatform !== "aos-cx";
    if (EMPTY) EMPTY.hidden = true;
    if (VIEWER) VIEWER.hidden = false;
    renderNav();

    const kb = (row.group.bytes / 1024).toFixed(0);
    if (META) {
      META.textContent =
        `${row.api.title} · ${row.group.title} — ` +
        `${row.group.operations} endpoints, ${kb} KB`;
    }
    mountScalar(row);
  }

  function firstGroup(platform) {
    return (
      groupsForPlatform(platform).find(
        (row) =>
          row.group.id !== "uncategorized" &&
          !String(row.group.id).startsWith("uncategorized"),
      ) || groupsForPlatform(platform)[0]
    );
  }

  function applyFromUrl(replace) {
    const params = currentParams();
    const inferred = platformFromKey(params.spec);
    const platform =
      params.platform ||
      inferred ||
      apisInOrder()[0]?.id ||
      "";
    activePlatform = platform;
    if (PLATFORM && platform) PLATFORM.value = platform;
    if (SWITCH_WRAP) SWITCH_WRAP.hidden = platform !== "aos-cx";

    let key = params.spec;
    if (key && platformFromKey(key) !== platform) key = "";
    if (!key) {
      const first = firstGroup(platform);
      if (first) {
        setParams({ platform, spec: first.key }, true);
        loadSlice(first.key);
        return;
      }
    }
    if (replace) setParams({ platform, spec: key }, true);
    loadSlice(key);
  }

  async function init() {
    if (SWITCH_IP) SWITCH_IP.value = readSwitchIp();

    try {
      const response = await fetch("./data/manifest.json", { cache: "no-cache" });
      if (!response.ok) throw new Error(`manifest ${response.status}`);
      manifest = await response.json();
    } catch (err) {
      if (META) {
        META.textContent = `Could not load data/manifest.json (${err}). Run scripts/build.py.`;
      }
      return;
    }

    populatePlatforms();
    applyFromUrl(true);

    PLATFORM?.addEventListener("change", () => {
      const platform = PLATFORM.value;
      const first = firstGroup(platform);
      setParams({ platform, spec: first?.key || "" }, false);
      if (FILTER) FILTER.value = "";
      if (first) loadSlice(first.key);
      else showEmpty();
    });

    NAV?.addEventListener("click", (event) => {
      const link = event.target.closest("a[data-key]");
      if (!link) return;
      event.preventDefault();
      const key = link.getAttribute("data-key");
      if (!key || key === activeKey) return;
      setParams({ platform: activePlatform, spec: key }, false);
      loadSlice(key);
    });

    FILTER?.addEventListener("input", () => renderNav());

    SWITCH_IP?.addEventListener("input", () => {
      writeSwitchIp(SWITCH_IP.value.trim());
      window.clearTimeout(switchIpTimer);
      switchIpTimer = window.setTimeout(() => {
        const row = allGroups().find((item) => item.key === activeKey);
        if (row && row.api.id === "aos-cx") mountScalar(row);
      }, 400);
    });

    window.addEventListener("popstate", () => applyFromUrl(false));
  }

  init();
})();
