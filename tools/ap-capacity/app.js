/**
 * AP Capacity — live estimator UI.
 */

import {
  APP_PRESETS,
  DEVICE_PRESETS,
  MAX_MCS,
  NEIGHBOR_MODES,
  STANDARD_LABEL,
  STANDARD_RANK,
  WIDTHS_MHZ,
  allowedWidths,
  appById,
  clampBand,
  clampMcs,
  clampRadio,
  clampStandardToBand,
  clampWidthMHz,
  defaultRadios,
  deviceById,
  estimateCapacity,
  formatCount,
  formatMbps,
  validBandsFor,
} from "./model.js?v=7";

/** IDs may contain dots (2.4 GHz). querySelector('#x.y') is invalid. */
function $(sel, root = document) {
  if (typeof sel === "string" && sel.charAt(0) === "#" && !/[\s>+~[]/.test(sel)) {
    const id = sel.slice(1);
    if (root === document || (root && root.nodeType === 9)) {
      return document.getElementById(id);
    }
  }
  return root.querySelector(sel);
}

function escapeHtml(value) {
  return String(value)
    .split("&")
    .join("&amp;")
    .split("<")
    .join("&lt;")
    .split(">")
    .join("&gt;")
    .split('"')
    .join("&quot;");
}

const state = {
  radioCount: 2,
  generation: "ax",
  nss: 2,
  radios: defaultRadios(2, "ax").map((r) => ({ ...r, nss: 2 })),
  deviceId: "wifi6-laptop",
  customStandard: "ax",
  customNss: 2,
  customBands: ["2.4", "5"],
  customMaxWidth: 80,
  quality: "typical",
  neighbor: "typical",
  ssidCount: 3,
  activeClients: 30,
  appId: "classroom",
  customMbps: 2,
  splitMode: "steered",
  mcsOverride: "",
  scenario: "",
};

function currentClient() {
  if (state.deviceId === "custom") {
    const standard = state.customStandard;
    const bands = state.customBands.length ? state.customBands.slice() : ["5"];
    return {
      standard,
      nss: Number(state.customNss) || 2,
      bands: bands.filter((b) => validBandsFor(standard).includes(b) || b === "2.4" || b === "5"),
      maxWidthMHz: clampWidthMHz(standard, bands.includes("6") ? "6" : "5", state.customMaxWidth),
    };
  }
  const d = deviceById(state.deviceId);
  return {
    standard: d.standard,
    nss: d.nss,
    bands: d.bands.slice(),
    maxWidthMHz: d.maxWidthMHz,
  };
}

function currentTarget() {
  if (state.appId === "custom") return Math.max(0.1, Number(state.customMbps) || 2);
  return appById(state.appId).mbps;
}

function applyConstraints() {
  for (const r of state.radios) {
    clampRadio(r, state.generation, state.nss);
  }
  const maxMcs = MAX_MCS[state.generation] ?? 11;
  if (state.mcsOverride !== "" && state.mcsOverride != null) {
    const clamped = clampMcs(state.generation, state.mcsOverride);
    state.mcsOverride = clamped == null ? "" : clamped;
  }
  if (state.deviceId === "custom") {
    state.customMaxWidth = clampWidthMHz(
      state.customStandard,
      state.customBands.includes("6") ? "6" : state.customBands.includes("5") ? "5" : "2.4",
      state.customMaxWidth,
    );
    const bands = validBandsFor(state.customStandard);
    state.customBands = state.customBands.filter((b) => bands.includes(b) || b === "2.4" || b === "5");
    if (state.customStandard === "n" || state.customStandard === "ac") {
      state.customBands = state.customBands.filter((b) => b !== "6");
    }
    if (!state.customBands.length) state.customBands = ["5"];
  }
}

function rebuildRadios() {
  const next = defaultRadios(state.radioCount, state.generation);
  const prevByBand = new Map(state.radios.map((r) => [r.band, r]));
  const prevById = new Map(state.radios.map((r) => [r.id, r]));
  state.radios = next.map((r) => {
    const old = prevById.get(r.id) || prevByBand.get(r.band);
    const merged = {
      ...r,
      enabled: old ? old.enabled : r.enabled,
      widthMHz: old ? old.widthMHz : r.widthMHz,
      band: old && validBandsFor(state.generation).includes(old.band) ? old.band : r.band,
      nss: state.nss,
    };
    return clampRadio(merged, state.generation, state.nss);
  });
}

function applyScenario(id) {
  state.scenario = id;
  if (id === "ipad1") {
    state.radioCount = 1;
    state.generation = "n";
    state.nss = 3;
    state.deviceId = "ipad-1";
    state.quality = "excellent";
    state.neighbor = "isolated";
    state.ssidCount = 1;
    state.activeClients = 30;
    state.appId = "classroom";
    state.splitMode = "best";
    rebuildRadios();
  } else if (id === "air2") {
    state.radioCount = 1;
    state.generation = "ac";
    state.nss = 3;
    state.deviceId = "ipad-air-2";
    state.quality = "excellent";
    state.neighbor = "isolated";
    state.ssidCount = 1;
    state.activeClients = 30;
    state.appId = "classroom";
    state.splitMode = "best";
    rebuildRadios();
  } else if (id === "office") {
    state.radioCount = 2;
    state.generation = "ax";
    state.nss = 2;
    state.deviceId = "wifi6-laptop";
    state.quality = "typical";
    state.neighbor = "typical";
    state.ssidCount = 3;
    state.activeClients = 30;
    state.appId = "office";
    state.splitMode = "steered";
    rebuildRadios();
  } else if (id === "triband") {
    state.radioCount = 3;
    state.generation = "be";
    state.nss = 2;
    state.deviceId = "iphone-16-pro";
    state.quality = "typical";
    state.neighbor = "typical";
    state.ssidCount = 2;
    state.activeClients = 40;
    state.appId = "office";
    state.splitMode = "steered";
    rebuildRadios();
  }
  applyConstraints();
}

function readNumber(id, fallback, min, max) {
  const el = $(id);
  if (!el) return fallback;
  const raw = el.value;
  if (raw === "" || raw == null) return fallback;
  let n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) n = min;
  if (n > max) n = max;
  return n;
}

function readForm() {
  const gen = $("input[name=apc-gen]:checked")?.value;
  const count = Number($("input[name=apc-radios]:checked")?.value);
  const nss = Number($("#apc-nss")?.value);
  const countChanged = count && count !== state.radioCount;

  if (gen) state.generation = gen;
  if (nss) state.nss = nss;

  if (countChanged) {
    state.radioCount = count;
    rebuildRadios();
  } else {
    for (const r of state.radios) {
      const en = $(`#apc-en-${r.id}`);
      const band = $(`#apc-band-${r.id}`);
      const width = $(`#apc-width-${r.id}`);
      if (en && !en.disabled) r.enabled = en.checked;
      if (band && !band.options[band.selectedIndex]?.disabled) r.band = band.value;
      else if (band) r.band = clampBand(state.generation, band.value);
      if (width && !width.disabled) r.widthMHz = Number(width.value);
      r.nss = state.nss;
    }
  }

  applyConstraints();

  state.deviceId = $("#apc-device")?.value || state.deviceId;
  state.customStandard = $("#apc-custom-std")?.value || state.customStandard;
  state.customNss = Number($("#apc-custom-nss")?.value) || state.customNss;
  state.customMaxWidth = Number($("#apc-custom-width")?.value) || state.customMaxWidth;
  const bands = [];
  const bandIds = { "2.4": "apc-cband-24", 5: "apc-cband-5", 6: "apc-cband-6" };
  for (const b of ["2.4", "5", "6"]) {
    if (document.getElementById(bandIds[b])?.checked) bands.push(b);
  }
  if (state.deviceId === "custom") state.customBands = bands.length ? bands : ["5"];

  state.quality = $("input[name=apc-quality]:checked")?.value || state.quality;
  state.neighbor = $("input[name=apc-neighbor]:checked")?.value || state.neighbor;
  state.splitMode = $("input[name=apc-split]:checked")?.value || state.splitMode;
  state.ssidCount = Math.round(readNumber("#apc-ssids", state.ssidCount, 1, 16));
  state.activeClients = Math.floor(readNumber("#apc-clients", 0, 0, 500));
  state.appId = $("#apc-app")?.value || state.appId;
  state.customMbps = readNumber("#apc-custom-mbps", state.customMbps, 0.1, 200);
  const mcsRaw = $("#apc-mcs")?.value;
  state.mcsOverride = mcsRaw === "" || mcsRaw == null ? "" : Number(mcsRaw);

  applyConstraints();
}

function estimate() {
  const mcsOverride = state.mcsOverride === "" ? null : state.mcsOverride;
  return estimateCapacity({
    radios: state.radios.map((r) => ({ ...r })),
    client: currentClient(),
    quality: state.quality,
    neighbor: state.neighbor,
    ssidCount: state.ssidCount,
    activeClients: state.activeClients,
    targetMbps: currentTarget(),
    splitMode: state.splitMode,
    mcsOverride,
  });
}

function pillGroup(name, options, selected) {
  return options
    .map((opt) => {
      const checked = opt.value === String(selected) ? "checked" : "";
      return `<label class="apc-pill">
        <input type="radio" name="${escapeHtml(name)}" value="${escapeHtml(opt.value)}" ${checked} />
        <span>${escapeHtml(opt.label)}</span>
      </label>`;
    })
    .join("");
}

function radioNote(r) {
  const std = clampStandardToBand(state.generation, r.band);
  if (std == null) {
    return `${STANDARD_LABEL[state.generation]} does not run on ${r.band} GHz.`;
  }
  if (r.band === "2.4" && r.widthMHz > 20) return "40 MHz on 2.4 GHz is how you become that neighbor.";
  if (r.widthMHz >= 80) return "Wide channels are fast on a clean slice of spectrum and rude on a busy floor.";
  return "";
}

function radioCardHtml(r, i) {
  const std = clampStandardToBand(state.generation, r.band);
  const bandBlocked = std == null;
  const note = radioNote(r);
  const widthOpts = WIDTHS_MHZ.map(
    (w) => `<option value="${w}" ${w === r.widthMHz ? "selected" : ""}>${w} MHz</option>`,
  ).join("");
  return `<div class="apc-radio-card ${r.enabled && !bandBlocked ? "" : "apc-radio-card--off"}" data-radio="${escapeHtml(r.id)}">
    <div class="apc-radio-card__head">
      <label class="apc-check">
        <input type="checkbox" id="apc-en-${escapeHtml(r.id)}" ${r.enabled && !bandBlocked ? "checked" : ""} ${bandBlocked ? "disabled" : ""} />
        <span>Radio ${i + 1}</span>
      </label>
      <span class="apc-radio-card__tag">${escapeHtml(r.band)} GHz</span>
    </div>
    <div class="form-grid">
      <div class="field">
        <label for="apc-band-${escapeHtml(r.id)}">Band</label>
        <select id="apc-band-${escapeHtml(r.id)}">
          <option value="2.4" ${r.band === "2.4" ? "selected" : ""}>2.4 GHz</option>
          <option value="5" ${r.band === "5" ? "selected" : ""}>5 GHz</option>
          <option value="6" ${r.band === "6" ? "selected" : ""}>6 GHz</option>
        </select>
      </div>
      <div class="field">
        <label for="apc-width-${escapeHtml(r.id)}">Channel width</label>
        <select id="apc-width-${escapeHtml(r.id)}" ${bandBlocked ? "disabled" : ""}>${widthOpts}</select>
      </div>
    </div>
    <p class="hint apc-radio-note">${note ? escapeHtml(note) : ""}</p>
  </div>`;
}

function renderRadios() {
  const root = $("#apc-radios-wrap");
  if (!root) return;
  const ids = state.radios.map((r) => r.id).join(",");
  if (root.dataset.ids !== ids) {
    root.innerHTML = state.radios.map((r, i) => radioCardHtml(r, i)).join("");
    root.dataset.ids = ids;
  }
  syncRadioCards();
}

function setOptionEnabled(select, value, enabled) {
  if (!select) return;
  const opt = [...select.options].find((o) => o.value === String(value));
  if (!opt) return;
  opt.disabled = !enabled;
}

function syncRadioCards() {
  const bands = validBandsFor(state.generation);
  state.radios.forEach((r, i) => {
    const card = document.querySelector(`[data-radio="${r.id}"]`);
    const std = clampStandardToBand(state.generation, r.band);
    const bandBlocked = std == null;
    const allowed = allowedWidths(r.standard, r.band);
    if (card) {
      card.classList.toggle("apc-radio-card--off", !(r.enabled && !bandBlocked));
      const tag = card.querySelector(".apc-radio-card__tag");
      if (tag) tag.textContent = `${r.band} GHz`;
      const note = card.querySelector(".apc-radio-note");
      if (note) note.textContent = radioNote(r);
    }
    const en = $(`#apc-en-${r.id}`);
    if (en) {
      en.disabled = bandBlocked;
      en.checked = r.enabled && !bandBlocked;
    }
    const bandSel = $(`#apc-band-${r.id}`);
    if (bandSel) {
      setOptionEnabled(bandSel, "2.4", bands.includes("2.4"));
      setOptionEnabled(bandSel, "5", bands.includes("5"));
      setOptionEnabled(bandSel, "6", bands.includes("6"));
      if (bandSel.value !== r.band) bandSel.value = r.band;
    }
    const widthSel = $(`#apc-width-${r.id}`);
    if (widthSel) {
      for (const w of WIDTHS_MHZ) setOptionEnabled(widthSel, w, allowed.includes(w));
      widthSel.disabled = bandBlocked;
      if (widthSel.value !== String(r.widthMHz)) widthSel.value = String(r.widthMHz);
    }
    const label = card?.querySelector(".apc-check span");
    if (label) label.textContent = `Radio ${i + 1}`;
  });
}

function renderDeviceExtras() {
  const wrap = $("#apc-custom-device");
  if (!wrap) return;
  wrap.hidden = state.deviceId !== "custom";
  const std = state.customStandard;
  const widthSel = $("#apc-custom-width");
  if (widthSel) {
    const allowed = allowedWidths(std, state.customBands.includes("6") ? "6" : "5");
    for (const w of WIDTHS_MHZ) setOptionEnabled(widthSel, w, allowed.includes(w));
    if (!allowed.includes(Number(widthSel.value))) widthSel.value = String(state.customMaxWidth);
  }
  const six = document.getElementById("apc-cband-6");
  if (six) {
    const ok = validBandsFor(std).includes("6");
    six.disabled = !ok;
    if (!ok) six.checked = false;
  }
}

function renderAppExtras() {
  const wrap = $("#apc-custom-app");
  if (!wrap) return;
  wrap.hidden = state.appId !== "custom";
}

function renderAnswer(est) {
  const root = $("#apc-answer");
  if (!root) return;
  const n = state.activeClients;
  const per = formatMbps(est.perUserMbps);
  const fit = Math.floor(est.clientsThatFit);
  const target = formatMbps(est.targetMbps);
  const app = state.appId === "custom" ? `${target} each` : appById(state.appId).label.toLowerCase();
  const busyTotal = formatMbps(
    (est.radios || []).reduce((s, r) => s + (r.share > 0 ? r.planMbps || 0 : 0), 0),
  );

  let eyebrow = "What to expect";
  let headline;
  let sub;
  if (est.verdict === "none") {
    headline = "This setup cannot do that job";
    sub = `Nothing here can deliver ${target} per person. Check that the phones can use these radios.`;
  } else if (n <= 0) {
    headline = `About ${formatCount(fit)} ${fit === 1 ? "person" : "people"}`;
    sub = `That’s how many can do ${app} (${target} each) on this AP. Type how many people are actually using it to see speed per person.`;
  } else if (est.verdict === "short") {
    headline = `Each of ${n} people gets ${per}`;
    sub = `That’s below the ${target} you wanted for ${app}. This AP can handle about ${fit} people at ${target}. Add an AP, or ask less of each person.`;
  } else if (est.verdict === "plenty") {
    headline = `Each of ${n} people gets ${per}`;
    sub = `That clears ${target} for ${app}, with room. This AP can handle about ${fit} people at that speed.`;
  } else {
    headline = `Each of ${n} people gets ${per}`;
    sub = `That just about hits ${target} for ${app}. This AP can handle about ${fit} people at that speed.`;
  }

  const client = currentClient();
  const links = est.radios.filter((r) => r.phyMbps);
  const mathHtml = links
    .map((r) => {
      const macPct = Math.round(r.macEfficiency * 100);
      const rfPct = Math.round(r.rfUsable * 100);
      const extraSsid = r.ssidAirtime > 0 ? ` Extra SSIDs take ${Math.round(r.ssidAirtime * 100)}%.` : "";
      const rfBit =
        r.rfUsable >= 0.99
          ? "No neighboring APs on this channel."
          : `Neighbors leave you about ${rfPct}% of the air.`;
      return `<li><strong>${escapeHtml(r.band)} GHz:</strong> radio rate ${escapeHtml(formatMbps(r.phyMbps))} × ${macPct}% after Wi-Fi overhead = ${escapeHtml(formatMbps(r.protocolMbps))}. ${rfBit}${extraSsid} Real total: <strong>${escapeHtml(formatMbps(r.usableMbps))}</strong>.</li>`;
    })
    .join("");
  const limitNotes = [];
  if (state.nss > client.nss) {
    limitNotes.push(
      `These devices only have ${client.nss} stream${client.nss === 1 ? "" : "s"}. Buying a ${state.nss}×${state.nss} AP does not make them faster.`,
    );
  }
  if (STANDARD_LABEL[client.standard] && STANDARD_RANK[state.generation] > STANDARD_RANK[client.standard]) {
    limitNotes.push(
      `These devices stop at ${STANDARD_LABEL[client.standard]}. A newer AP does not speed them up.`,
    );
  }
  const widthCapped = links.some((r) => {
    const radio = state.radios.find((x) => x.id === r.id);
    return radio && radio.widthMHz > r.widthMHz;
  });
  if (widthCapped) {
    limitNotes.push(
      `These devices top out at ${client.maxWidthMHz} MHz. A wider channel on the AP will not help them.`,
    );
  }
  const limitHtml = limitNotes.length
    ? `<ul class="apc-limits">${limitNotes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>`
    : "";

  const caveats = est.caveats.map((c) => `<li>${escapeHtml(c)}</li>`).join("");
  const caveatRoot = $("#apc-caveats-body");

  const rows = est.radios
    .map((r, i) => {
      if (!r.enabled) {
        return `<tr><td>Radio ${i + 1}</td><td>${escapeHtml(r.band)} GHz</td><td colspan="6" class="apc-muted">Off</td></tr>`;
      }
      if (!r.phyMbps) {
        return `<tr><td>Radio ${i + 1}</td><td>${escapeHtml(r.band)} GHz</td><td colspan="6" class="apc-muted">${escapeHtml(r.skip || "Not usable")}</td></tr>`;
      }
      const qam = r.qam ? `${r.modulation} (${r.qam}-QAM ${r.codingLabel})` : "—";
      return `<tr>
        <td>Radio ${i + 1}</td>
        <td>${escapeHtml(r.band)} GHz · ${r.widthMHz} MHz · ${r.nss}SS</td>
        <td>MCS ${r.mcs} · ${escapeHtml(qam)}</td>
        <td>${escapeHtml(formatMbps(r.phyMbps))}</td>
        <td>${escapeHtml(formatMbps(r.usableMbps))}</td>
        <td>${Math.round(r.share * 100)}% · ${r.clients ? r.clients.toFixed(1) : "0"}</td>
        <td>${r.clients ? escapeHtml(formatMbps(r.perUserMbps)) : "—"}</td>
      </tr>`;
    })
    .join("");

  const notes = est.radios
    .flatMap((r) => (r.notes || []).map((note) => `${r.band} GHz: ${note}`))
    .map((note) => `<li>${escapeHtml(note)}</li>`)
    .join("");

  root.className = `apc-answer apc-answer--${est.verdict}`;
  root.innerHTML = `
    <p class="apc-answer__eyebrow">${escapeHtml(eyebrow)}</p>
    <p class="apc-answer__headline">${escapeHtml(headline)}</p>
    <p class="apc-answer__sub">${escapeHtml(sub)}</p>
    <div class="results-meta">
      <div class="meta-chip"><span>Each person gets</span><strong>${escapeHtml(n ? per : "—")}</strong></div>
      <div class="meta-chip"><span>People who fit at ${escapeHtml(target)}</span><strong>${escapeHtml(String(fit))}</strong></div>
      <div class="meta-chip"><span>This AP, busy room</span><strong>${escapeHtml(busyTotal)}</strong></div>
      <div class="meta-chip"><span>Air this AP actually gets</span><strong>${Math.round(est.rfUsable * 100)}%</strong></div>
    </div>
    ${limitHtml}
  `;

  if (caveatRoot) {
    caveatRoot.innerHTML = `
      <ul class="apc-caveats">${caveats}</ul>
      <details class="details-block apc-math">
        <summary>The radio-by-radio math</summary>
        <div class="apc-table-scroll">
          <table class="apc-table">
            <thead>
              <tr>
                <th>Radio</th>
                <th>Link</th>
                <th>MCS / QAM</th>
                <th>PHY</th>
                <th>Usable</th>
                <th>Clients</th>
                <th>Each</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${mathHtml ? `<ul class="apc-mathline">${mathHtml}</ul>` : ""}
        ${notes ? `<ul class="apc-notes">${notes}</ul>` : ""}
        <p class="hint">
          One person on a quiet radio keeps more of the radio’s speed (~50%).
          A busy room keeps ~40%. “People who fit” always uses the busy-room number
          so adding people does not magically grow the AP.
        </p>
      </details>
    `;
  }
}

function renderStaticControls() {
  const device = $("#apc-device");
  if (device && !device.options.length) {
    for (const d of DEVICE_PRESETS) {
      const opt = document.createElement("option");
      opt.value = d.id;
      opt.textContent = d.detail ? `${d.label} — ${d.detail}` : d.label;
      device.appendChild(opt);
    }
    device.value = state.deviceId;
  }
  const app = $("#apc-app");
  if (app && !app.options.length) {
    for (const a of APP_PRESETS) {
      const opt = document.createElement("option");
      opt.value = a.id;
      opt.textContent = `${a.label} (${a.mbps} Mbps)`;
      app.appendChild(opt);
    }
    const custom = document.createElement("option");
    custom.value = "custom";
    custom.textContent = "Custom Mbps";
    app.appendChild(custom);
    app.value = state.appId;
  }
}

function syncToolbar() {
  const gen = $(`input[name=apc-gen][value="${state.generation}"]`);
  if (gen) gen.checked = true;
  const count = $(`input[name=apc-radios][value="${state.radioCount}"]`);
  if (count) count.checked = true;
  if ($("#apc-nss")) $("#apc-nss").value = String(state.nss);
  if ($("#apc-device")) $("#apc-device").value = state.deviceId;
  if ($("#apc-app")) $("#apc-app").value = state.appId;
  if ($("#apc-ssids") && document.activeElement !== $("#apc-ssids")) {
    $("#apc-ssids").value = String(state.ssidCount);
  }
  if ($("#apc-clients") && document.activeElement !== $("#apc-clients")) {
    $("#apc-clients").value = String(state.activeClients);
  }
  if ($("#apc-custom-mbps") && document.activeElement !== $("#apc-custom-mbps")) {
    $("#apc-custom-mbps").value = String(state.customMbps);
  }
  const q = $(`input[name=apc-quality][value="${state.quality}"]`);
  if (q) q.checked = true;
  const neigh = $(`input[name=apc-neighbor][value="${state.neighbor}"]`);
  if (neigh) neigh.checked = true;
  const s = $(`input[name=apc-split][value="${state.splitMode}"]`);
  if (s) s.checked = true;
  const mcs = $("#apc-mcs");
  if (mcs) {
    mcs.max = String(MAX_MCS[state.generation] ?? 13);
    if (document.activeElement !== mcs && state.mcsOverride !== "") mcs.value = String(state.mcsOverride);
  }
  for (const btn of document.querySelectorAll("[data-scenario]")) {
    btn.setAttribute("aria-pressed", btn.dataset.scenario === state.scenario ? "true" : "false");
  }
}

function paint({ fromForm = true, rebuildCards = false } = {}) {
  try {
    if (fromForm) readForm();
    else applyConstraints();
  } catch (err) {
    const root = $("#apc-answer");
    if (root) root.textContent = `Could not read settings: ${err && err.message ? err.message : err}`;
    return;
  }
  // Answer first — radio-card DOM work must not block the estimate.
  try {
    renderAnswer(estimate());
  } catch (err) {
    const root = $("#apc-answer");
    if (root) root.textContent = `Could not estimate: ${err && err.message ? err.message : err}`;
  }
  try {
    renderDeviceExtras();
    renderAppExtras();
    if (rebuildCards) {
      const root = $("#apc-radios-wrap");
      if (root) root.dataset.ids = "";
    }
    renderRadios();
    syncToolbar();
  } catch (err) {
    console.error(err);
  }
}

function bind() {
  const form = $("#apc-form");
  form?.addEventListener("submit", (ev) => ev.preventDefault());
  const onEdit = (ev) => {
    const t = ev.target;
    if (!t || (form && !form.contains(t))) return;
    state.scenario = "";
    const name = t.name;
    const rebuildCards = name === "apc-radios";
    paint({ fromForm: true, rebuildCards });
  };
  // Capture so a descendant stopPropagation cannot swallow it.
  document.addEventListener("input", onEdit, true);
  document.addEventListener("change", onEdit, true);
  for (const id of ["apc-app", "apc-clients", "apc-custom-mbps"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener("input", onEdit);
    el.addEventListener("change", onEdit);
    el.addEventListener("keyup", onEdit);
  }
  for (const btn of document.querySelectorAll("[data-scenario]")) {
    btn.addEventListener("click", () => {
      applyScenario(btn.dataset.scenario);
      paint({ fromForm: false, rebuildCards: true });
    });
  }
}

function initPills() {
  $("#apc-gen-pills").innerHTML = pillGroup(
    "apc-gen",
    [
      { value: "n", label: "Wi-Fi 4 · n" },
      { value: "ac", label: "Wi-Fi 5 · ac" },
      { value: "ax", label: "Wi-Fi 6 · ax" },
      { value: "be", label: "Wi-Fi 7 · be" },
    ],
    state.generation,
  );
  $("#apc-radio-pills").innerHTML = pillGroup(
    "apc-radios",
    [
      { value: "1", label: "1 radio" },
      { value: "2", label: "2 radios" },
      { value: "3", label: "3 radios" },
    ],
    String(state.radioCount),
  );
  $("#apc-quality-pills").innerHTML = pillGroup(
    "apc-quality",
    [
      { value: "edge", label: "Cell edge" },
      { value: "typical", label: "Typical coverage" },
      { value: "excellent", label: "Next to the AP" },
    ],
    state.quality,
  );
  $("#apc-neighbor-pills").innerHTML = pillGroup(
    "apc-neighbor",
    Object.values(NEIGHBOR_MODES).map((m) => ({ value: m.id, label: m.label })),
    state.neighbor,
  );
  $("#apc-split-pills").innerHTML = pillGroup(
    "apc-split",
    [
      { value: "steered", label: "Band-steered" },
      { value: "best", label: "Everyone on the best radio" },
    ],
    state.splitMode,
  );
}

function init() {
  initPills();
  renderStaticControls();
  bind();
  paint({ fromForm: false, rebuildCards: true });
}

init();
