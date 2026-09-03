/**
 * AP capacity estimator — practical throughput, not datasheet PHY.
 *
 * PHY rates follow IEEE 802.11-2020 / 802.11be (same construction as
 * typical MCS tables). Usable throughput applies:
 *   - MAC/protocol efficiency from client count
 *   - RF fraction that is actually yours (CCI/ACI / neighbors)
 *   - beacon + probe tax from SSID count
 *
 * Never quote PHY rate as user speed.
 */

/** @typedef {"n" | "ac" | "ax" | "be"} Standard */
/** @typedef {"2.4" | "5" | "6"} Band */
/** @typedef {"edge" | "typical" | "excellent"} LinkQuality */
/** @typedef {"isolated" | "typical" | "crowded"} NeighborMode */

export const STANDARD_LABEL = {
  n: "Wi-Fi 4 (802.11n)",
  ac: "Wi-Fi 5 (802.11ac)",
  ax: "Wi-Fi 6 / 6E (802.11ax)",
  be: "Wi-Fi 7 (802.11be)",
};

export const STANDARD_RANK = { n: 4, ac: 5, ax: 6, be: 7 };

export const MCS_ROWS = [
  { mcs: 0, mod: "BPSK", qam: 2, bpscs: 1, coding: 1 / 2, codingLabel: "1/2" },
  { mcs: 1, mod: "QPSK", qam: 4, bpscs: 2, coding: 1 / 2, codingLabel: "1/2" },
  { mcs: 2, mod: "QPSK", qam: 4, bpscs: 2, coding: 3 / 4, codingLabel: "3/4" },
  { mcs: 3, mod: "16-QAM", qam: 16, bpscs: 4, coding: 1 / 2, codingLabel: "1/2" },
  { mcs: 4, mod: "16-QAM", qam: 16, bpscs: 4, coding: 3 / 4, codingLabel: "3/4" },
  { mcs: 5, mod: "64-QAM", qam: 64, bpscs: 6, coding: 2 / 3, codingLabel: "2/3" },
  { mcs: 6, mod: "64-QAM", qam: 64, bpscs: 6, coding: 3 / 4, codingLabel: "3/4" },
  { mcs: 7, mod: "64-QAM", qam: 64, bpscs: 6, coding: 5 / 6, codingLabel: "5/6" },
  { mcs: 8, mod: "256-QAM", qam: 256, bpscs: 8, coding: 3 / 4, codingLabel: "3/4" },
  { mcs: 9, mod: "256-QAM", qam: 256, bpscs: 8, coding: 5 / 6, codingLabel: "5/6" },
  { mcs: 10, mod: "1024-QAM", qam: 1024, bpscs: 10, coding: 3 / 4, codingLabel: "3/4" },
  { mcs: 11, mod: "1024-QAM", qam: 1024, bpscs: 10, coding: 5 / 6, codingLabel: "5/6" },
  { mcs: 12, mod: "4096-QAM", qam: 4096, bpscs: 12, coding: 3 / 4, codingLabel: "3/4" },
  { mcs: 13, mod: "4096-QAM", qam: 4096, bpscs: 12, coding: 5 / 6, codingLabel: "5/6" },
];

export const MAX_MCS = { n: 7, ac: 9, ax: 11, be: 13 };

/** Approximate min RSSI (dBm) to hold the MCS. Vendor tables vary. */
export const MIN_RSSI_DBM = {
  0: -90,
  1: -89,
  2: -87,
  3: -84,
  4: -81,
  5: -78,
  6: -76,
  7: -73,
  8: -68,
  9: -65,
  10: -58,
  11: -51,
  12: -48,
  13: -45,
};

/** Data subcarriers (N_SD). OFDM 312.5 kHz vs OFDMA 78.125 kHz. */
export const NSD = {
  ofdm: { 20: 52, 40: 108, 80: 234, 160: 468 },
  ofdma: { 20: 234, 40: 468, 80: 980, 160: 1960, 320: 3920 },
};

export const WIDTHS_MHZ = [20, 40, 80, 160, 320];

/**
 * Neighbor RF: fraction of the channel that is actually this BSS's to use.
 * Isolated = no CCI/ACI (single AP / clean cell). Typical = 60% yours.
 */
export const NEIGHBOR_MODES = {
  isolated: {
    id: "isolated",
    rfUsable: 1,
    label: "Isolated cell",
    hint: "No neighboring APs on this channel. Classroom / single-AP math.",
  },
  typical: {
    id: "typical",
    rfUsable: 0.6,
    label: "Typical neighbors",
    hint: "About 60% of the channel is yours. Some CCI/ACI from nearby APs.",
  },
  crowded: {
    id: "crowded",
    rfUsable: 0.4,
    label: "Crowded RF",
    hint: "Heavy co-channel / adjacent-channel contention. 2.4 GHz often lives here.",
  },
};

export const APP_PRESETS = [
  { id: "web", label: "Web, email, chat", mbps: 1, blurb: "Light browsing, mail, messaging." },
  { id: "classroom", label: "Classroom video", mbps: 2, blurb: "Unicast video to each student." },
  { id: "office", label: "Office / video call", mbps: 3, blurb: "Cloud apps plus a 1080p call." },
  { id: "hd", label: "HD streaming", mbps: 5, blurb: "One HD stream per person, give or take." },
  { id: "power", label: "Power user / 4K", mbps: 15, blurb: "Fat downlink. Rare as a whole-room target." },
];

/**
 * Common client presets (phones, laptops, IoT). Bands and max width are
 * honest device limits, not AP ads.
 */
export const DEVICE_PRESETS = [
  {
    id: "iphone-16-pro",
    label: "iPhone 16 Pro",
    detail: "Wi-Fi 7 · 2SS",
    standard: "be",
    nss: 2,
    bands: ["2.4", "5", "6"],
    maxWidthMHz: 160,
  },
  {
    id: "iphone-16",
    label: "iPhone 16",
    detail: "Wi-Fi 7 · 2SS",
    standard: "be",
    nss: 2,
    bands: ["2.4", "5", "6"],
    maxWidthMHz: 160,
  },
  {
    id: "macbook-pro-m4",
    label: "MacBook Pro M4",
    detail: "Wi-Fi 7 · 2SS",
    standard: "be",
    nss: 2,
    bands: ["2.4", "5", "6"],
    maxWidthMHz: 160,
  },
  {
    id: "ipad-pro-m4",
    label: "iPad Pro M4",
    detail: "Wi-Fi 7 · 2SS",
    standard: "be",
    nss: 2,
    bands: ["2.4", "5", "6"],
    maxWidthMHz: 160,
  },
  {
    id: "s25-ultra",
    label: "Samsung Galaxy S25 Ultra",
    detail: "Wi-Fi 7 · 2SS",
    standard: "be",
    nss: 2,
    bands: ["2.4", "5", "6"],
    maxWidthMHz: 160,
  },
  {
    id: "s24",
    label: "Samsung Galaxy S24",
    detail: "Wi-Fi 7 · 2SS",
    standard: "be",
    nss: 2,
    bands: ["2.4", "5", "6"],
    maxWidthMHz: 160,
  },
  {
    id: "pixel-9-pro",
    label: "Google Pixel 9 Pro",
    detail: "Wi-Fi 7 · 2SS",
    standard: "be",
    nss: 2,
    bands: ["2.4", "5", "6"],
    maxWidthMHz: 160,
  },
  {
    id: "iphone-15-pro",
    label: "iPhone 15 Pro",
    detail: "Wi-Fi 6E · 2SS",
    standard: "ax",
    nss: 2,
    bands: ["2.4", "5", "6"],
    maxWidthMHz: 160,
  },
  {
    id: "macbook-air-m3",
    label: "MacBook Air M3",
    detail: "Wi-Fi 6E · 2SS",
    standard: "ax",
    nss: 2,
    bands: ["2.4", "5", "6"],
    maxWidthMHz: 160,
  },
  {
    id: "s23-ultra",
    label: "Samsung Galaxy S23 Ultra",
    detail: "Wi-Fi 6E · 2SS",
    standard: "ax",
    nss: 2,
    bands: ["2.4", "5", "6"],
    maxWidthMHz: 160,
  },
  {
    id: "iphone-14",
    label: "iPhone 14",
    detail: "Wi-Fi 6 · 2SS",
    standard: "ax",
    nss: 2,
    bands: ["2.4", "5"],
    maxWidthMHz: 80,
  },
  {
    id: "wifi6-laptop",
    label: "Typical Wi-Fi 6 laptop",
    detail: "802.11ax · 2SS",
    standard: "ax",
    nss: 2,
    bands: ["2.4", "5"],
    maxWidthMHz: 80,
  },
  {
    id: "wifi5-laptop",
    label: "Typical Wi-Fi 5 laptop",
    detail: "802.11ac · 2SS",
    standard: "ac",
    nss: 2,
    bands: ["2.4", "5"],
    maxWidthMHz: 80,
  },
  {
    id: "ipad-air-2",
    label: "iPad Air 2",
    detail: "802.11ac · 2SS",
    standard: "ac",
    nss: 2,
    bands: ["2.4", "5"],
    maxWidthMHz: 40,
  },
  {
    id: "ipad-1",
    label: "iPad 1",
    detail: "802.11n · 1SS",
    standard: "n",
    nss: 1,
    bands: ["2.4", "5"],
    maxWidthMHz: 20,
  },
  {
    id: "older-laptop",
    label: "Older laptop",
    detail: "802.11n · 2SS",
    standard: "n",
    nss: 2,
    bands: ["2.4", "5"],
    maxWidthMHz: 40,
  },
  {
    id: "iot",
    label: "IoT / smart home",
    detail: "802.11n · 1SS",
    standard: "n",
    nss: 1,
    bands: ["2.4"],
    maxWidthMHz: 20,
  },
  {
    id: "custom",
    label: "Custom",
    detail: "set standard & streams below",
    standard: "ax",
    nss: 2,
    bands: ["2.4", "5", "6"],
    maxWidthMHz: 160,
  },
];

export function mcsRow(mcs) {
  return MCS_ROWS.find((row) => row.mcs === mcs) || null;
}

export function lowerStandard(a, b) {
  return STANDARD_RANK[a] <= STANDARD_RANK[b] ? a : b;
}

/** 802.11ac is 5 GHz only. 6 GHz needs ax/be. */
export function clampStandardToBand(standard, band) {
  if (band === "2.4") {
    return standard === "ac" ? "n" : standard;
  }
  if (band === "6") {
    if (standard === "n" || standard === "ac") return null;
    return standard;
  }
  return standard;
}

export function maxWidthMHz(standard, band) {
  if (band === "2.4") return 40;
  if (standard === "n") return 40;
  if (standard === "be" && band === "6") return 320;
  return 160;
}

export function allowedWidths(standard, band) {
  const max = maxWidthMHz(standard, band);
  return WIDTHS_MHZ.filter((w) => w <= max);
}

/** 6 GHz needs ax/be. ac is 5 GHz (2.4 falls back to n). */
export function validBandsFor(standard) {
  if (standard === "n" || standard === "ac") return ["2.4", "5"];
  return ["2.4", "5", "6"];
}

export function clampBand(standard, band) {
  const valid = validBandsFor(standard);
  if (valid.includes(band)) return band;
  return valid.includes("5") ? "5" : valid[0];
}

/** Snap an illegal width down to the widest legal one. */
export function clampWidthMHz(standard, band, widthMHz) {
  const allowed = allowedWidths(standard, band);
  const w = Number(widthMHz);
  if (allowed.includes(w)) return w;
  const lower = allowed.filter((x) => x <= w);
  return lower.length ? lower[lower.length - 1] : allowed[0] || 20;
}

export function clampMcs(standard, mcs) {
  const max = MAX_MCS[standard] ?? 7;
  const n = Number(mcs);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(max, Math.floor(n)));
}

/**
 * Force a radio onto a legal band/width/PHY for this AP generation.
 * Mutates and returns the radio.
 */
export function clampRadio(radio, generation, nss) {
  const gen = generation || radio.standard;
  radio.band = clampBand(gen, radio.band);
  const std = clampStandardToBand(gen, radio.band);
  radio.standard = std || gen;
  radio.widthMHz = clampWidthMHz(radio.standard, radio.band, radio.widthMHz);
  if (nss) radio.nss = nss;
  if (std == null) radio.enabled = false;
  return radio;
}

export function defaultGiUs(standard) {
  return standard === "n" || standard === "ac" ? 0.4 : 0.8;
}

export function symbolUs(standard, giUs) {
  if (standard === "n" || standard === "ac") {
    return 3.2 + giUs;
  }
  return 12.8 + giUs;
}

export function nsdFor(standard, widthMHz) {
  if (standard === "n" && widthMHz > 40) return null;
  if ((standard === "ac" || standard === "ax") && widthMHz > 160) return null;
  const table = standard === "n" || standard === "ac" ? NSD.ofdm : NSD.ofdma;
  return table[widthMHz] ?? null;
}

function nDbps(nsd, nss, bpscs, coding) {
  return nsd * nss * bpscs * coding;
}

function isIntegerBits(value) {
  return Number.isFinite(value) && Math.abs(value - Math.round(value)) < 1e-6;
}

/**
 * VHT MCS 9 at 20 MHz is invalid for most stream counts (N_DBPS not integer).
 * Same rule applied generally: coded bits per symbol must be an integer.
 */
export function mcsValid(standard, widthMHz, nss, mcs) {
  if (mcs < 0 || mcs > MAX_MCS[standard]) return false;
  const row = mcsRow(mcs);
  const nsd = nsdFor(standard, widthMHz);
  if (!row || nsd == null) return false;
  // VHT (and HT) BCC needs an integer N_DBPS — this is why MCS 9 @ 20 MHz
  // is invalid for most stream counts. HE/EHT use LDPC and allow the rest.
  if (standard === "n" || standard === "ac") {
    return isIntegerBits(nDbps(nsd, nss, row.bpscs, row.coding));
  }
  return true;
}

export function highestValidMcs(standard, widthMHz, nss, preferred) {
  const cap = Math.min(preferred, MAX_MCS[standard]);
  for (let mcs = cap; mcs >= 0; mcs--) {
    if (mcsValid(standard, widthMHz, nss, mcs)) return mcs;
  }
  return null;
}

/**
 * Typical coverage is 64-QAM / 256-QAM — not 1024-QAM or 4096-QAM.
 * Those need to be sitting next to the AP with a clean channel.
 */
export function mcsForQuality(standard, quality, widthMHz, nss, band) {
  let preferred;
  if (quality === "edge") preferred = 3;
  else if (quality === "typical") {
    // 2.4 GHz cells rarely hold 256-QAM across the room.
    if (band === "2.4") preferred = 7;
    else if (standard === "n") preferred = 7;
    else preferred = 9;
  } else {
    preferred = MAX_MCS[standard];
  }
  return highestValidMcs(standard, widthMHz, nss, preferred);
}

/**
 * PHY rate in Mbps. Returns null if the combination is invalid.
 * @param {{ standard: Standard, widthMHz: number, nss: number, mcs: number, giUs: number }} p
 */
export function phyRateMbps(p) {
  const { standard, widthMHz, nss, mcs, giUs } = p;
  if (!mcsValid(standard, widthMHz, nss, mcs)) return null;
  const row = mcsRow(mcs);
  const nsd = nsdFor(standard, widthMHz);
  const tSym = symbolUs(standard, giUs);
  const dbps = nDbps(nsd, nss, row.bpscs, row.coding);
  return (dbps / (tSym * 1e-6)) / 1e6;
}

/**
 * Protocol efficiency vs PHY:
 *   1 client → ~50% of MCS
 *   small / moderate → ~45%
 *   medium-large / heavy → ~40%
 */
export function macEfficiency(activeClients) {
  const n = Math.max(0, Number(activeClients) || 0);
  if (n <= 1) return 0.5;
  if (n <= 10) return 0.45;
  return 0.4;
}

/**
 * Beacon + probe airtime for this radio. 100 TU beacons, ~350-byte frame,
 * 1 Mbps on 2.4 GHz / 6 Mbps on 5 and 6, plus a 1.5× probe fudge.
 */
export function ssidAirtimeFraction(ssidCount, band) {
  const count = Math.max(0, Number(ssidCount) || 0);
  // One SSID is already inside the 40–50% protocol factor. Extra SSIDs
  // are additional beacon/probe tax.
  const extra = Math.max(0, count - 1);
  if (extra === 0) return 0;
  const beaconBytes = 350;
  const beaconsPerSec = 1000 / 102.4;
  const rateMbps = band === "2.4" ? 1 : 6;
  const probeFactor = 1.5;
  const one = ((beaconBytes * 8 * beaconsPerSec) / (rateMbps * 1e6)) * probeFactor;
  return Math.min(0.65, extra * one);
}

export function formatMbps(mbps) {
  if (!Number.isFinite(mbps)) return "—";
  const x = Math.max(0, mbps);
  if (x >= 100) return `${Math.round(x)} Mbps`;
  if (x >= 10) return `${trimNum(x, 1)} Mbps`;
  if (x >= 1) return `${trimNum(x, 1)} Mbps`;
  if (x >= 0.05) return `${Math.round(x * 1000)} kbps`;
  return "<50 kbps";
}

function trimNum(x, digits) {
  return Number(x.toFixed(digits)).toString();
}

export function formatCount(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 100) return String(Math.round(n));
  if (Math.abs(n - Math.round(n)) < 0.05) return String(Math.round(n));
  return n.toFixed(1);
}

/**
 * How clients land on enabled radios this device can actually join.
 * Steered: a little leftover on 2.4, the rest on 5/6.
 * Best: everyone on the highest band they can use.
 */
export function clientSplit(radios, clientBands, mode) {
  const capable = radios.filter(
    (r) => r.enabled && clientBands.includes(r.band) && clampStandardToBand(r.standard, r.band),
  );
  /** @type {Record<string, number>} */
  const out = {};
  for (const r of radios) out[r.id] = 0;
  if (!capable.length) return out;

  if (mode === "best") {
    const rank = { 6: 3, 5: 2, "2.4": 1 };
    capable.sort((a, b) => (rank[b.band] || 0) - (rank[a.band] || 0));
    out[capable[0].id] = 1;
    return out;
  }

  const byBand = { "2.4": [], 5: [], 6: [] };
  for (const r of capable) byBand[r.band].push(r);

  /** @type {Record<Band, number>} */
  let weights = { "2.4": 0, 5: 0, 6: 0 };
  const has24 = byBand["2.4"].length > 0;
  const has5 = byBand["5"].length > 0;
  const has6 = byBand["6"].length > 0;

  if (has6 && has5 && has24) weights = { "2.4": 0.1, 5: 0.45, 6: 0.45 };
  else if (has6 && has5) weights = { "2.4": 0, 5: 0.5, 6: 0.5 };
  else if (has6 && has24) weights = { "2.4": 0.15, 5: 0, 6: 0.85 };
  else if (has5 && has24) weights = { "2.4": 0.15, 5: 0.85, 6: 0 };
  else if (has6) weights = { "2.4": 0, 5: 0, 6: 1 };
  else if (has5) weights = { "2.4": 0, 5: 1, 6: 0 };
  else weights = { "2.4": 1, 5: 0, 6: 0 };

  for (const band of ["2.4", "5", "6"]) {
    const list = byBand[band];
    if (!list.length || !weights[band]) continue;
    const each = weights[band] / list.length;
    for (const r of list) out[r.id] = each;
  }
  return out;
}

/**
 * Negotiate the link this client actually gets on one radio.
 * AP × client: min streams, min generation, min width, MCS from quality.
 */
export function negotiateLink(radio, client, quality, mcsOverride, giOverride) {
  const notes = [];
  if (!radio.enabled) return { ok: false, reason: "Radio is off.", notes };
  if (!client.bands.includes(radio.band)) {
    return {
      ok: false,
      reason: `This device has no ${radio.band} GHz radio.`,
      notes,
    };
  }
  const apStd = clampStandardToBand(radio.standard, radio.band);
  if (!apStd) {
    return {
      ok: false,
      reason: `${STANDARD_LABEL[radio.standard]} does not run on ${radio.band} GHz.`,
      notes,
    };
  }
  const clientStd = clampStandardToBand(client.standard, radio.band) || client.standard;
  const standard = lowerStandard(apStd, clientStd);
  if (standard !== apStd) {
    notes.push(`Client caps this radio at ${STANDARD_LABEL[standard]}.`);
  }
  if (standard !== clientStd && STANDARD_RANK[apStd] < STANDARD_RANK[client.standard]) {
    notes.push(`AP caps this radio at ${STANDARD_LABEL[standard]}.`);
  }

  const nss = Math.max(1, Math.min(radio.nss, client.nss));
  if (nss < radio.nss) notes.push(`Client is ${nss} stream${nss === 1 ? "" : "s"} — the AP’s extra streams sit idle.`);
  if (nss < client.nss) notes.push(`AP is ${nss}×${nss}; extra client streams unused.`);

  const apMaxW = maxWidthMHz(standard, radio.band);
  const widthMHz = Math.min(radio.widthMHz, client.maxWidthMHz || apMaxW, apMaxW);
  if (widthMHz < radio.widthMHz) {
    notes.push(`Width limited to ${widthMHz} MHz (device or PHY).`);
  }
  if (radio.band === "2.4" && widthMHz > 20) {
    notes.push("40 MHz on 2.4 GHz is usually a bad neighbor. Expect more CCI than the slider admits.");
  }
  if ((radio.band === "5" || radio.band === "6") && widthMHz >= 80) {
    notes.push("Wide channels need empty spectrum. Primary-channel traffic still burns the whole block.");
  }

  const giUs = giOverride ?? radio.giUs ?? defaultGiUs(standard);
  let mcs;
  if (mcsOverride != null && mcsOverride !== "") {
    mcs = highestValidMcs(standard, widthMHz, nss, Number(mcsOverride));
    if (mcs !== Number(mcsOverride)) {
      notes.push(`MCS ${mcsOverride} is invalid here; using MCS ${mcs}.`);
    }
  } else {
    mcs = mcsForQuality(standard, quality, widthMHz, nss, radio.band);
  }
  if (mcs == null) {
    return { ok: false, reason: "No valid MCS for this width / stream mix.", notes };
  }

  const phy = phyRateMbps({ standard, widthMHz, nss, mcs, giUs });
  if (phy == null) return { ok: false, reason: "Could not compute a PHY rate.", notes };

  const row = mcsRow(mcs);
  return {
    ok: true,
    band: radio.band,
    standard,
    widthMHz,
    nss,
    mcs,
    modulation: row.mod,
    qam: row.qam,
    codingLabel: row.codingLabel,
    giUs,
    phyMbps: phy,
    minRssiDbm: MIN_RSSI_DBM[mcs],
    notes,
  };
}

/**
 * Harmonic blend of PHY rates when a mix of clients shares a radio
 * (equal throughput → airtime ∝ 1/rate). The slow ones eat the pie.
 */
export function blendedPhyMbps(parts) {
  let w = 0;
  let acc = 0;
  for (const p of parts) {
    if (!p.weight || !p.phyMbps) continue;
    w += p.weight;
    acc += p.weight / p.phyMbps;
  }
  if (w <= 0 || acc <= 0) return null;
  return w / acc;
}

/**
 * @typedef {{
 *   id: string,
 *   enabled: boolean,
 *   band: Band,
 *   standard: Standard,
 *   widthMHz: number,
 *   nss: number,
 *   giUs?: number,
 * }} RadioInput
 *
 * @typedef {{
 *   standard: Standard,
 *   nss: number,
 *   bands: Band[],
 *   maxWidthMHz: number,
 *   mix?: { weight: number, nss: number, standard: Standard }[],
 * }} ClientInput
 *
 * @typedef {{
 *   radios: RadioInput[],
 *   client: ClientInput,
 *   quality: LinkQuality,
 *   neighbor: NeighborMode,
 *   ssidCount: number,
 *   activeClients: number,
 *   targetMbps: number,
 *   splitMode: "steered" | "best",
 *   mcsOverride?: number | null,
 *   giOverride?: number | null,
 * }} EstimateInput
 */

/**
 * Practical AP estimate.
 * @param {EstimateInput} input
 */
export function estimateCapacity(input) {
  const quality = input.quality || "typical";
  const neighbor = NEIGHBOR_MODES[input.neighbor] || NEIGHBOR_MODES.typical;
  const activeClients = Math.max(0, Number(input.activeClients) || 0);
  const targetMbps = Math.max(0.05, Number(input.targetMbps) || 2);
  const ssidCount = Math.max(1, Math.min(16, Number(input.ssidCount) || 1));
  const radios = (input.radios || []).map((r) =>
    clampRadio({ ...r }, r.standard, r.nss),
  );
  const client = input.client;
  const splitMode = input.splitMode || "steered";

  const split = clientSplit(radios, client.bands, splitMode);
  const radioResults = [];

  for (const radio of radios) {
    const share = split[radio.id] || 0;
    const clientsHere = activeClients * share;

    if (!radio.enabled) {
      radioResults.push({
        id: radio.id,
        enabled: false,
        band: radio.band,
        skip: "off",
        share: 0,
        clients: 0,
      });
      continue;
    }

    const link = negotiateLink(radio, client, quality, input.mcsOverride, input.giOverride);
    if (!link.ok) {
      radioResults.push({
        id: radio.id,
        enabled: true,
        band: radio.band,
        skip: link.reason,
        share: 0,
        clients: 0,
        notes: link.notes,
      });
      continue;
    }

    let phyMbps = link.phyMbps;
    if (client.mix && client.mix.length) {
      const parts = [];
      for (const m of client.mix) {
        const mixClient = {
          ...client,
          nss: m.nss,
          standard: m.standard || client.standard,
          mix: undefined,
        };
        const mixLink = negotiateLink(radio, mixClient, quality, input.mcsOverride, input.giOverride);
        if (mixLink.ok) parts.push({ weight: m.weight, phyMbps: mixLink.phyMbps });
      }
      const blended = blendedPhyMbps(parts);
      if (blended) {
        phyMbps = blended;
        link.notes.push("Mixed clients: slow stations consume more airtime for the same bits.");
      }
    }

    const macNow = macEfficiency(activeClients);
    // Planning load uses the medium/large-room bucket — "how many users"
    // should not assume a single-client 50% efficiency.
    const macPlan = 0.4;
    const ssidTax = ssidAirtimeFraction(ssidCount, radio.band);
    const rf = neighbor.rfUsable;
    const protocolMbps = phyMbps * macNow;
    const protocolPlanMbps = phyMbps * macPlan;
    const air = rf * (1 - ssidTax);
    const usableMbps = protocolMbps * air;
    const planMbps = protocolPlanMbps * air;
    const perUserMbps = clientsHere > 0 ? usableMbps / clientsHere : 0;
    const fitHere = targetMbps > 0 ? planMbps / targetMbps : 0;

    radioResults.push({
      id: radio.id,
      enabled: true,
      band: link.band,
      standard: link.standard,
      standardLabel: STANDARD_LABEL[link.standard],
      widthMHz: link.widthMHz,
      nss: link.nss,
      mcs: link.mcs,
      modulation: link.modulation,
      qam: link.qam,
      codingLabel: link.codingLabel,
      giUs: link.giUs,
      phyMbps,
      minRssiDbm: link.minRssiDbm,
      share,
      clients: clientsHere,
      macEfficiency: macNow,
      ssidAirtime: ssidTax,
      rfUsable: rf,
      protocolMbps,
      protocolPlanMbps,
      usableMbps,
      planMbps,
      perUserMbps,
      fitHere,
      notes: link.notes,
    });
  }

  const serving = radioResults.filter((r) => r.planMbps > 0 && r.share > 0);
  const aggregateMbps = serving.reduce((s, r) => s + r.usableMbps, 0);
  const protocolAggregate = serving.reduce((s, r) => s + (r.protocolMbps || 0), 0);
  // Classroom-style question: the AP is a pool. PHY × protocol × RF × SSIDs,
  // then divide. Do not use a steered-ratio min() — that is how "30 kids
  // on one AP" turned into "10 fit" while average Mbps still looked fine.
  const planAggregate = serving.reduce((s, r) => s + (r.planMbps || 0), 0);
  const clientsThatFit = targetMbps > 0 ? planAggregate / targetMbps : 0;

  const perUserMbps = activeClients > 0 ? aggregateMbps / activeClients : aggregateMbps;

  let verdict = "none";
  if (aggregateMbps <= 0) verdict = "none";
  else if (activeClients <= 0) verdict = clientsThatFit >= 1 ? "fits" : "none";
  else if (perUserMbps >= targetMbps * 1.25) verdict = "plenty";
  else if (perUserMbps >= targetMbps) verdict = "fits";
  else verdict = "short";

  const caveats = buildCaveats({
    neighbor,
    ssidCount,
    quality,
    mac: macEfficiency(activeClients),
    activeClients,
    radios: radioResults,
    client,
  });

  return {
    ok: aggregateMbps > 0,
    targetMbps,
    activeClients,
    clientsThatFit,
    protocolAggregate,
    perUserMbps,
    aggregateMbps,
    macEfficiency: macEfficiency(activeClients),
    rfUsable: neighbor.rfUsable,
    neighbor,
    quality,
    ssidCount,
    splitMode,
    verdict,
    caveats,
    radios: radioResults,
  };
}

function buildCaveats({ neighbor, ssidCount, quality, mac, activeClients, radios, client }) {
  const caveats = [];
  const rfPct = Math.round(neighbor.rfUsable * 100);
  const macPct = Math.round(mac * 100);

  if (neighbor.id === "isolated") {
    caveats.push(
      `RF: this channel is treated as 100% yours — no CCI/ACI from neighboring APs. Real floors are rarely this kind.`,
    );
  } else if (neighbor.id === "typical") {
    caveats.push(
      `RF: about ${rfPct}% of the channel is treated as yours. The rest is contention from neighbors (CCI/ACI) and leftover noise. Not a site survey.`,
    );
  } else {
    caveats.push(
      `RF: only ${rfPct}% of the channel is treated as yours. Crowded spectrum. 2.4 GHz often looks like this even when 5/6 GHz does not.`,
    );
  }

  caveats.push(
    `Protocol: with ${activeClients || 0} active client${activeClients === 1 ? "" : "s"}, usable airtime is ~${macPct}% of PHY (IFS, ACKs, backoff, retransmits, small frames). Associated-but-idle devices are not this math.`,
  );

  if (ssidCount <= 1) {
    caveats.push("SSIDs: one SSID. Each extra SSID is more beacons and probes, especially on 2.4 GHz.");
  } else {
    caveats.push(
      `SSIDs: ${ssidCount} broadcast here. Beacon/probe tax is already subtracted. Four is a crowd; eight is a meeting that should have been an email.`,
    );
  }

  if (quality === "excellent") {
    caveats.push(
      "Link: “excellent” is sitting near the AP with a clean SNR so high MCS (1024-QAM / 4096-QAM) can stick. That is not a cell-edge design target.",
    );
  } else if (quality === "edge") {
    caveats.push(
      "Link: cell edge (16-QAM). If RSSI is this low, add an AP — do not widen the channel.",
    );
  } else {
    caveats.push(
      "Link: typical coverage (~256-QAM / MCS 7–9 on 5/6 GHz; 64-QAM on 2.4). Not datasheet MCS 11/13. High QAM needs to be next to the AP.",
    );
  }

  const slow = radios.find((r) => r.nss === 1 && r.usableMbps);
  if (slow || client.nss === 1) {
    caveats.push(
      "The weakest station sets the airtime price. A 1-stream client takes roughly twice as long as a 2-stream client to send the same frame.",
    );
  }

  caveats.push(
    "This is not coverage, roaming, or a promise from a datasheet. Half-duplex. No MU-MIMO miracle, no OFDMA 4× sticker. Application payload, not PHY.",
  );

  return caveats;
}

/** Default radios for a 1 / 2 / 3-radio AP. */
export function defaultRadios(count, generation) {
  const templates = [
    { id: "r24", band: "2.4", widthMHz: 20 },
    { id: "r5", band: "5", widthMHz: 20 },
    { id: "r6", band: "6", widthMHz: 40 },
  ];
  let picked;
  if (count <= 1) picked = [templates[1]];
  else if (count === 2) picked = [templates[0], templates[1]];
  else picked = templates.slice();

  return picked.map((t) => {
    const radio = {
      id: t.id,
      enabled: true,
      band: t.band,
      standard: generation,
      widthMHz: t.widthMHz,
      nss: 2,
    };
    clampRadio(radio, generation, 2);
    radio.enabled = clampStandardToBand(generation, radio.band) != null;
    return radio;
  });
}

export function deviceById(id) {
  return DEVICE_PRESETS.find((d) => d.id === id) || DEVICE_PRESETS.find((d) => d.id === "wifi6-laptop");
}

export function appById(id) {
  return APP_PRESETS.find((a) => a.id === id) || APP_PRESETS[1];
}
