/**
 * Hardware Platform Support — correlated multi-track matrix (platforms.json)
 * Aruba firmware tracks + HPE Juniper Pathfinder (EX / QFX / Mist APs).
 */

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const els = {
    search: $("hps-search"),
    vendorFilters: $("vendor-filters"),
    typeFilters: $("type-filters"),
    firmwareFilters: $("firmware-filters"),
    statusFilters: $("status-filters"),
    list: $("hps-list"),
    empty: $("hps-empty"),
    status: $("hps-status"),
    expandAll: $("expand-all"),
    collapseAll: $("collapse-all"),
  };

  /** @type {null | object} */
  let data = null;
  let vendorFilt = "all";
  let typeFilt = "all";
  let firmwareFilt = "all";
  let statusFilt = "all";
  let query = "";

  const KIND_LABELS = {
    "aos-10": "AOS-10",
    "aos-8-iap": "Instant (IAP 8.x)",
    "aos-cx": "AOS-CX",
    "aos-s": "AOS-S",
    junos: "Junos",
    mist: "Mist AP",
  };

  const TYPE_ORDER = [
    "ap",
    "gateway",
    "bridge",
    "aos-cx",
    "aos-s",
    "ex",
    "qfx",
  ];

  function escapeHtml(v) {
    return String(v ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function setStatus(msg, tone) {
    els.status.textContent = msg || "";
    if (tone) els.status.dataset.tone = tone;
    else delete els.status.dataset.tone;
  }

  function releaseLabel(rel) {
    if (!rel) return "—";
    return rel.raw || rel.version || "N/A";
  }

  function tagsHtml(rel) {
    const tags = (rel && rel.tags) || [];
    return tags
      .map((t) => `<span class="hps-tag">${escapeHtml(t)}</span>`)
      .join("");
  }

  function kindLabel(kind) {
    return KIND_LABELS[kind] || kind;
  }

  function vendorOf(d) {
    return d.vendor || "aruba";
  }

  function vendorLabelOf(d) {
    if (d.vendorLabel) return d.vendorLabel;
    return vendorOf(d) === "juniper" ? "HPE Juniper" : "HPE Aruba";
  }

  function isJuniper(d) {
    return vendorOf(d) === "juniper";
  }

  function fwPillClass(kind) {
    if (kind === "aos-8-iap") return "hps-fw hps-fw--iap";
    if (kind === "aos-10") return "hps-fw hps-fw--aos10";
    if (kind === "junos") return "hps-fw hps-fw--junos";
    if (kind === "mist") return "hps-fw hps-fw--mist";
    if (kind === "aos-cx" || kind === "aos-s") return "hps-fw hps-fw--switch";
    return "hps-fw";
  }

  function vendorPillClass(v) {
    return v === "juniper" ? "hps-vendor hps-vendor--juniper" : "hps-vendor hps-vendor--aruba";
  }

  /** Normalize legacy single-track rows into tracks[] */
  function tracksOf(d) {
    if (d.tracks && d.tracks.length) return d.tracks;
    const kind = d.firmwareKind || "aos-10";
    return [
      {
        kind,
        label: d.firmwareLabel || kindLabel(kind),
        minRelease: d.minRelease,
        lastRelease: d.lastRelease,
        status: d.status || "current",
        notes: d.notes || "",
        minRnUrl: d.minRnUrl,
        lastRnUrl: d.lastRnUrl,
        pathfinderUrl: d.pathfinderUrl,
      },
    ];
  }

  function latestAos10() {
    return (data && data.latestRelease) || null;
  }

  function trackRn(track) {
    if (!track || track.kind !== "aos-10") return null;
    if (track.status === "parked" && track.lastRnUrl) {
      return {
        url: track.lastRnUrl,
        label: "RN (last supported train)",
      };
    }
    const latest = latestAos10();
    if (track.lastRnUrl && latest && track.lastRnUrl === latest.url) {
      return {
        url: track.lastRnUrl,
        label: latest.version
          ? `Latest AOS-10 RN (${latest.version})`
          : "Latest AOS-10 RN",
      };
    }
    if (track.lastRnUrl) {
      return { url: track.lastRnUrl, label: "AOS-10 release notes" };
    }
    if (latest && latest.url) {
      return {
        url: latest.url,
        label: latest.version
          ? `Latest AOS-10 RN (${latest.version})`
          : "Latest AOS-10 RN",
      };
    }
    const fallback = data && data.allReleasesUrl;
    return fallback
      ? { url: fallback, label: "AOS-10 all releases" }
      : null;
  }

  function summaryFirstLast(tracks) {
    const t =
      tracks.find((x) => x.kind === "aos-10") ||
      tracks.find((x) => x.kind === "aos-8-iap") ||
      tracks.find((x) => x.kind === "junos") ||
      tracks.find((x) => x.kind === "mist") ||
      tracks[0];
    if (!t) return { first: "—", last: "—" };
    return {
      first: releaseLabel(t.minRelease),
      last: releaseLabel(t.lastRelease),
      track: t,
    };
  }

  function overallStatus(tracks) {
    if (tracks.some((t) => t.status === "current")) return "current";
    if (tracks.some((t) => t.status === "parked")) return "parked";
    return "current";
  }

  function groupKey(d) {
    const v = vendorOf(d);
    if (v === "juniper") {
      return `juniper::${d.series || d.family || d.typeLabel || d.type}`;
    }
    const fam = (d.family || "").trim();
    if (fam && d.type !== "ap") {
      return `aruba::${d.type}::${fam}`;
    }
    return `aruba::${d.type}::${d.typeLabel || d.type}`;
  }

  function groupTitle(d) {
    if (isJuniper(d)) {
      return d.series || d.family || d.typeLabel || "Juniper";
    }
    const fam = (d.family || "").trim();
    if (fam && d.type !== "ap") return fam;
    return d.typeLabel || d.type || "Platforms";
  }

  function renderTrackRow(track, device) {
    const label = track.label || kindLabel(track.kind);
    const minLbl = releaseLabel(track.minRelease);
    const lastLbl = releaseLabel(track.lastRelease);
    const parked = track.status === "parked";
    const statusPill = parked
      ? '<span class="mac-pill mac-pill--warn">parked</span>'
      : '<span class="mac-pill mac-pill--ok">current</span>';

    // Juniper / Pathfinder tracks — no fake firmware mins (button is on the card body)
    if (track.kind === "junos" || track.kind === "mist" || (device && isJuniper(device))) {
      return `
        <div class="hps-track" data-track="${escapeHtml(track.kind)}">
          <div class="hps-track__head">
            <span class="${fwPillClass(track.kind)}">${escapeHtml(label)}</span>
            ${
              device && device.isEol
                ? '<span class="mac-pill mac-pill--warn">EOL</span>'
                : statusPill
            }
          </div>
        </div>
      `;
    }

    const rn = trackRn(track);
    let rnHtml = "";
    if (rn) {
      rnHtml = `<a class="btn btn--secondary" href="${escapeHtml(
        rn.url
      )}" target="_blank" rel="noopener noreferrer">${escapeHtml(rn.label)}</a>`;
    } else if (track.kind === "aos-8-iap") {
      rnHtml = `<span class="hint">Confirm Instant release notes on HPE support</span>`;
    }
    const note = track.notes
      ? `<div class="hps-track__note">${escapeHtml(track.notes)}</div>`
      : "";

    return `
      <div class="hps-track" data-track="${escapeHtml(track.kind)}">
        <div class="hps-track__head">
          <span class="${fwPillClass(track.kind)}">${escapeHtml(label)}</span>
          ${statusPill}
        </div>
        <div class="hps-track__grid">
          <div class="meta-chip"><span>First supported</span><strong class="mono">${escapeHtml(
            minLbl
          )}</strong> ${tagsHtml(track.minRelease)}</div>
          <div class="meta-chip"><span>Parked / last</span><strong class="mono">${escapeHtml(
            lastLbl
          )}</strong> ${tagsHtml(track.lastRelease)}</div>
        </div>
        ${note}
        <div class="hps-track__actions">${rnHtml}</div>
      </div>
    `;
  }

  function renderArubaSummary(d, tracks, sum) {
    if (tracks.length === 1) {
      return ` · first <span class="mono">${escapeHtml(
        sum.first
      )}</span> · last <span class="mono">${escapeHtml(sum.last)}</span>`;
    }
    return ` · <span class="mono">${tracks.length}</span> firmware tracks`;
  }

  function renderJuniperSummary(d) {
    const series = d.series || d.family || "";
    const code = d.productCodeName || "";
    const bits = [];
    if (series) bits.push(escapeHtml(series));
    if (code) bits.push(`<span class="mono">${escapeHtml(code)}</span>`);
    return bits.length ? ` · ${bits.join(" · ")}` : "";
  }

  function renderRow(d) {
    const tracks = tracksOf(d);
    const status = overallStatus(tracks);
    const juniper = isJuniper(d);
    const statusPill = juniper
      ? d.isEol
        ? '<span class="mac-pill mac-pill--warn">EOL</span>'
        : '<span class="mac-pill mac-pill--ok">current</span>'
      : status === "parked"
        ? '<span class="mac-pill mac-pill--warn">parked</span>'
        : '<span class="mac-pill mac-pill--ok">current</span>';
    const sum = summaryFirstLast(tracks);
    const trackPills = tracks
      .map(
        (t) =>
          `<span class="${fwPillClass(t.kind)}">${escapeHtml(
            t.label || kindLabel(t.kind)
          )}</span>`
      )
      .join("");
    const vLabel = vendorLabelOf(d);
    const vPill = `<span class="${vendorPillClass(
      vendorOf(d)
    )}">${escapeHtml(vLabel)}</span>`;

    const install = d.installMode
      ? `<div class="meta-chip"><span>Install mode</span><strong>${escapeHtml(
          d.installMode
        )}</strong></div>`
      : "";

    const deviceNotes = d.notes
      ? `<p class="hps-notes">${escapeHtml(d.notes)}</p>`
      : "";

    const summaryExtra = juniper
      ? renderJuniperSummary(d)
      : renderArubaSummary(d, tracks, sum);

    let bodyExtra = "";
    if (juniper) {
      const pf = d.pathfinderUrl
        ? `<a class="btn btn--secondary" href="${escapeHtml(
            d.pathfinderUrl
          )}" target="_blank" rel="noopener noreferrer">Open in Pathfinder</a>`
        : "";
      const trackPillsExpanded = tracks
        .map(
          (t) =>
            `<span class="${fwPillClass(t.kind)}">${escapeHtml(
              t.label || kindLabel(t.kind)
            )}</span>`
        )
        .join(" ");
      bodyExtra = `
          <div class="results-meta">
            <div class="meta-chip"><span>Vendor</span><strong>${escapeHtml(
              vLabel
            )}</strong></div>
            <div class="meta-chip"><span>Type</span><strong>${escapeHtml(
              d.typeLabel || d.type
            )}</strong></div>
            <div class="meta-chip"><span>Series</span><strong>${escapeHtml(
              d.series || d.family || "—"
            )}</strong></div>
            <div class="meta-chip"><span>Pathfinder code</span><strong class="mono">${escapeHtml(
              d.productCodeName || "—"
            )}</strong></div>
            <div class="meta-chip"><span>Lifecycle</span><strong>${
              d.isEol ? "EOL" : "Current"
            }</strong></div>
            <div class="meta-chip"><span>Line</span><strong>${trackPillsExpanded}</strong></div>
          </div>
          ${deviceNotes}
          <div class="hps-actions">${pf}</div>
        `;
    } else {
      bodyExtra = `
          <div class="results-meta">
            <div class="meta-chip"><span>Vendor</span><strong>${escapeHtml(
              vLabel
            )}</strong></div>
            <div class="meta-chip"><span>Type</span><strong>${escapeHtml(
              d.typeLabel || d.type
            )}</strong></div>
            <div class="meta-chip"><span>Family</span><strong>${escapeHtml(
              d.family || "—"
            )}</strong></div>
            ${install}
          </div>
          ${deviceNotes}
          <h3 class="hps-tracks-heading">Firmware support</h3>
          <div class="hps-tracks">
            ${tracks.map((t) => renderTrackRow(t, d)).join("")}
          </div>
        `;
    }

    return `
      <details class="mac-card hps-card" data-vendor="${escapeHtml(
        vendorOf(d)
      )}" data-type="${escapeHtml(d.type)}" data-status="${escapeHtml(
      status
    )}" data-model="${escapeHtml(d.model)}" data-family="${escapeHtml(
      d.family || ""
    )}" data-series="${escapeHtml(
      d.series || d.family || ""
    )}" data-tracks="${escapeHtml(tracks.map((t) => t.kind).join(","))}">
        <summary class="mac-card__summary">
          <span class="mac-card__summary-main">
            <span class="mac-card__addr mono">${escapeHtml(d.model)}</span>
            <span class="mac-card__vendor">
              ${escapeHtml(d.typeLabel || d.type)}${summaryExtra}
            </span>
          </span>
          <span class="mac-card__summary-meta">
            ${vPill}
            <span class="hps-fw-row">${trackPills}</span>
            ${statusPill}
            <span class="mac-chevron" aria-hidden="true"></span>
          </span>
        </summary>
        <div class="mac-card__body">
          ${bodyExtra}
        </div>
      </details>
    `;
  }

  function visibleDevices() {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.devices.filter((d) => {
      const tracks = tracksOf(d);
      const v = vendorOf(d);
      if (vendorFilt !== "all" && v !== vendorFilt) return false;
      if (typeFilt !== "all" && d.type !== typeFilt) return false;
      if (firmwareFilt !== "all") {
        if (!tracks.some((t) => t.kind === firmwareFilt)) return false;
      }
      const status = overallStatus(tracks);
      if (statusFilt !== "all" && status !== statusFilt) return false;
      if (!q) return true;
      const hay = [
        d.model,
        d.family,
        d.series,
        d.category,
        d.typeLabel,
        d.notes,
        d.installMode,
        d.productCodeName,
        d.pathfinderUrl,
        d.vendor,
        d.vendorLabel,
        d.isEol ? "eol" : "",
        ...tracks.map((t) =>
          [
            t.kind,
            t.label,
            t.notes,
            releaseLabel(t.minRelease),
            releaseLabel(t.lastRelease),
          ].join(" ")
        ),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }

  function groupDevices(list) {
    const map = new Map();
    for (const d of list) {
      const key = groupKey(d);
      if (!map.has(key)) {
        map.set(key, {
          key,
          title: groupTitle(d),
          vendor: vendorOf(d),
          vendorLabel: vendorLabelOf(d),
          type: d.type,
          devices: [],
        });
      }
      map.get(key).devices.push(d);
    }
    const groups = Array.from(map.values());
    groups.sort((a, b) => {
      const va = a.vendor === "juniper" ? 1 : 0;
      const vb = b.vendor === "juniper" ? 1 : 0;
      if (va !== vb) return va - vb;
      const ta = TYPE_ORDER.indexOf(a.type);
      const tb = TYPE_ORDER.indexOf(b.type);
      if (ta !== tb) return (ta < 0 ? 99 : ta) - (tb < 0 ? 99 : tb);
      return a.title.localeCompare(b.title);
    });
    return groups;
  }

  function renderGroup(group, openByDefault) {
    const n = group.devices.length;
    const openAttr = openByDefault ? " open" : "";
    const vPill = `<span class="${vendorPillClass(
      group.vendor
    )}">${escapeHtml(group.vendorLabel)}</span>`;
    return `
      <details class="hps-group"${openAttr} data-group="${escapeHtml(
      group.key
    )}">
        <summary class="hps-group__summary">
          <span class="hps-group__title">${escapeHtml(group.title)}</span>
          <span class="hps-group__meta">
            ${vPill}
            <span class="hps-group__count mono">${n}</span>
            <span class="mac-chevron" aria-hidden="true"></span>
          </span>
        </summary>
        <div class="hps-group__body">
          ${group.devices.map(renderRow).join("")}
        </div>
      </details>
    `;
  }

  function render() {
    const list = visibleDevices();
    const groups = groupDevices(list);
    // Only auto-open series groups on search (not on vendor/type filter alone).
    // Product cards always start collapsed.
    const openGroups = Boolean(query.trim());

    els.list.innerHTML = groups.map((g) => renderGroup(g, openGroups)).join("");
    els.empty.classList.toggle("hidden", list.length > 0);

    const c = data ? data.counts : {};
    const latest = latestAos10();
    const parts = [
      `Showing ${list.length} of ${c.total || 0} platforms`,
      data && data.updated ? `Aruba snapshot ${data.updated}` : null,
      data && data.juniperUpdated ? `Juniper ${data.juniperUpdated}` : null,
      c.aruba != null ? `Aruba ${c.aruba}` : null,
      c.juniper != null ? `Juniper ${c.juniper}` : null,
      c["aos-8-iap"] != null
        ? `Instant ${c["aos-8-iap"]}, AOS-10 ${c["aos-10"] || 0}`
        : null,
      c.ex != null || c.qfx != null
        ? `EX ${c.ex || 0}, QFX ${c.qfx || 0}`
        : null,
      latest && latest.version ? `latest AOS-10 ${latest.version}` : null,
    ].filter(Boolean);
    setStatus(parts.join(" · "), "ok");
  }

  function wireFilters(root, attr, setter) {
    if (!root) return;
    root.querySelectorAll(".filter-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        root.querySelectorAll(".filter-btn").forEach((b) =>
          b.classList.remove("active")
        );
        btn.classList.add("active");
        setter(btn.getAttribute(attr) || "all");
        render();
      });
    });
  }

  async function init() {
    setStatus("Loading platform data…", "");
    try {
      const res = await fetch("./data/platforms.json");
      if (!res.ok) throw new Error("HTTP " + res.status);
      data = await res.json();
      render();
    } catch (err) {
      console.error(err);
      setStatus(
        "Could not load data/platforms.json. Run update_data.py / update_juniper.py or check the path.",
        "error"
      );
    }
  }

  els.search.addEventListener("input", () => {
    query = els.search.value;
    render();
  });

  wireFilters(els.vendorFilters, "data-vendor", (v) => {
    vendorFilt = v;
  });
  wireFilters(els.typeFilters, "data-type", (v) => {
    typeFilt = v;
  });
  wireFilters(els.firmwareFilters, "data-firmware", (v) => {
    firmwareFilt = v;
  });
  wireFilters(els.statusFilters, "data-status", (v) => {
    statusFilt = v;
  });

  els.expandAll.addEventListener("click", () => {
    els.list.querySelectorAll("details.hps-group").forEach((d) => {
      d.open = true;
    });
    els.list.querySelectorAll("details.hps-card").forEach((d) => {
      d.open = true;
    });
  });
  els.collapseAll.addEventListener("click", () => {
    els.list.querySelectorAll("details.hps-card").forEach((d) => {
      d.open = false;
    });
    els.list.querySelectorAll("details.hps-group").forEach((d) => {
      d.open = false;
    });
  });

  init();
})();
