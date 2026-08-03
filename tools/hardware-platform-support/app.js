/**
 * Hardware Platform Support — correlated multi-track matrix (platforms.json)
 */

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const els = {
    search: $("hps-search"),
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
  let typeFilt = "all";
  let firmwareFilt = "all";
  let statusFilt = "all";
  let query = "";

  const KIND_LABELS = {
    "aos-10": "AOS-10",
    "aos-8-iap": "Instant (IAP 8.x)",
    "aos-cx": "AOS-CX",
    "aos-s": "AOS-S",
  };

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

  function fwPillClass(kind) {
    if (kind === "aos-8-iap") return "hps-fw hps-fw--iap";
    if (kind === "aos-10") return "hps-fw hps-fw--aos10";
    if (kind === "aos-cx" || kind === "aos-s") return "hps-fw hps-fw--switch";
    return "hps-fw";
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
    // Prefer AOS-10 for collapsed summary, else first track
    const t =
      tracks.find((x) => x.kind === "aos-10") ||
      tracks.find((x) => x.kind === "aos-8-iap") ||
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

  function renderTrackRow(track) {
    const label = track.label || kindLabel(track.kind);
    const minLbl = releaseLabel(track.minRelease);
    const lastLbl = releaseLabel(track.lastRelease);
    const parked = track.status === "parked";
    const statusPill = parked
      ? '<span class="mac-pill mac-pill--warn">parked</span>'
      : '<span class="mac-pill mac-pill--ok">current</span>';
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

  function renderRow(d) {
    const tracks = tracksOf(d);
    const status = overallStatus(tracks);
    const statusPill =
      status === "parked"
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

    const install = d.installMode
      ? `<div class="meta-chip"><span>Install mode</span><strong>${escapeHtml(
          d.installMode
        )}</strong></div>`
      : "";

    const deviceNotes = d.notes
      ? `<p class="hps-notes">${escapeHtml(d.notes)}</p>`
      : "";

    return `
      <details class="mac-card hps-card" data-type="${escapeHtml(
        d.type
      )}" data-status="${escapeHtml(status)}" data-model="${escapeHtml(
      d.model
    )}" data-family="${escapeHtml(d.family || "")}" data-tracks="${escapeHtml(
      tracks.map((t) => t.kind).join(",")
    )}">
        <summary class="mac-card__summary">
          <span class="mac-card__summary-main">
            <span class="mac-card__addr mono">${escapeHtml(d.model)}</span>
            <span class="mac-card__vendor">
              ${escapeHtml(d.typeLabel || d.type)}
              ${d.family ? " · " + escapeHtml(d.family) : ""}
              ${
                tracks.length === 1
                  ? ` · first <span class="mono">${escapeHtml(
                      sum.first
                    )}</span> · last <span class="mono">${escapeHtml(
                      sum.last
                    )}</span>`
                  : ` · <span class="mono">${tracks.length}</span> firmware tracks`
              }
            </span>
          </span>
          <span class="mac-card__summary-meta">
            <span class="hps-fw-row">${trackPills}</span>
            ${statusPill}
            <span class="mac-chevron" aria-hidden="true"></span>
          </span>
        </summary>
        <div class="mac-card__body">
          <div class="results-meta">
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
            ${tracks.map(renderTrackRow).join("")}
          </div>
        </div>
      </details>
    `;
  }

  function visibleDevices() {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.devices.filter((d) => {
      const tracks = tracksOf(d);
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
        d.typeLabel,
        d.notes,
        d.installMode,
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

  function render() {
    const list = visibleDevices();
    els.list.innerHTML = list.map(renderRow).join("");
    els.empty.classList.toggle("hidden", list.length > 0);

    const c = data ? data.counts : {};
    const latest = latestAos10();
    setStatus(
      `Showing ${list.length} of ${c.total || 0} platforms` +
        (data && data.updated ? ` · snapshot ${data.updated}` : "") +
        (c["aos-8-iap"] != null
          ? ` · Instant tracks ${c["aos-8-iap"]}, AOS-10 ${c["aos-10"] || 0}`
          : "") +
        (latest && latest.version ? ` · latest AOS-10 ${latest.version}` : ""),
      "ok"
    );
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
        "Could not load data/platforms.json. Run update_data.py or check the path.",
        "error"
      );
    }
  }

  els.search.addEventListener("input", () => {
    query = els.search.value;
    render();
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
    els.list.querySelectorAll("details.hps-card").forEach((d) => {
      d.open = true;
    });
  });
  els.collapseAll.addEventListener("click", () => {
    els.list.querySelectorAll("details.hps-card").forEach((d) => {
      d.open = false;
    });
  });

  init();
})();
