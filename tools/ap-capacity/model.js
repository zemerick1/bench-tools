/**
 * AP capacity — an airtime scenario estimator, not a design.
 *
 * PHY rates follow IEEE 802.11-2020 / 802.11be (same construction as
 * typical MCS tables). Each radio then applies coarse assumptions:
 *   - MAC/protocol efficiency from client count (one factor for the AP)
 *   - RF fraction that is actually yours (CCI/ACI / neighbors)
 *   - beacon + probe tax from SSID count
 *
 * People on different radios do not share one speed. The modeled
 * headcount is the tight radio under the chosen split, then a safety
 * margin. Never quote PHY rate as user speed, and never quote the
 * modeled ceiling as a build number.
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

/** 6E is a 6 GHz name. 2.4 and 5 GHz 802.11ax is Wi-Fi 6. */
export function linkStandardLabel(standard, band) {
  if (standard === "ax") {
    return band === "6" ? "Wi-Fi 6E (802.11ax)" : "Wi-Fi 6 (802.11ax)";
  }
  return STANDARD_LABEL[standard] || standard;
}

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

/** Spare airtime left unused. The modeled ceiling is not a design. */
export const DESIGN_MARGINS = [
  { value: 0, label: "No spare airtime" },
  { value: 0.3, label: "Leave 30% unused" },
  { value: 0.5, label: "Leave half unused" },
];

export const DEFAULT_DESIGN_MARGIN = 0.3;

export const APP_PRESETS = [
  { id: "web", label: "Web, email, chat", mbps: 1, blurb: "Light browsing and mail. This checks megabits only." },
  { id: "classroom", label: "Classroom video", mbps: 2, blurb: "Unicast video to each student. This checks megabits only." },
  {
    id: "office",
    label: "Office / video call",
    mbps: 3,
    blurb: "Cloud apps plus a call. A call also needs the other direction, and it fails on delay long before it fails on megabits.",
  },
  {
    id: "hd",
    label: "HD streaming",
    mbps: 5,
    blurb: "One HD stream per person. A stream can still look fine after a call has already failed.",
  },
  { id: "power", label: "Power user / 4K", mbps: 15, blurb: "Fat downlink. Rare as a whole-room target. This checks megabits only." },
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
    detail: "Wi-Fi 6E · 2SS",
    standard: "ax",
    nss: 2,
    bands: ["2.4", "5", "6"],
    maxWidthMHz: 160,
  },
  {
    id: "ipad-pro-m4",
    label: "iPad Pro M4",
    detail: "Wi-Fi 6E · 2SS",
    standard: "ax",
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
    detail: "802.11ac · 2SS · 80 MHz",
    standard: "ac",
    nss: 2,
    bands: ["2.4", "5"],
    maxWidthMHz: 80,
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
export const MAX_NSS = 8;
export const NSS_CHOICES = [1, 2, 3, 4, 8];

const BAND_RADIO_IDS = { "2.4": "r24", 5: "r5", 6: "r6" };
const DEFAULT_WIDTH_MHZ = { "2.4": 20, 5: 20, 6: 40 };

export function clampNss(nss) {
  const n = Number(nss);
  if (!Number.isFinite(n)) return 2;
  return Math.max(1, Math.min(MAX_NSS, Math.floor(n)));
}

/**
 * Force a radio onto a legal band/width/PHY for this AP generation.
 * Mutates and returns the radio. Pass nss to stamp streams; omit to keep the radio's own.
 */
export function clampRadio(radio, generation, nss) {
  const gen = generation || radio.standard;
  radio.band = clampBand(gen, radio.band);
  const std = clampStandardToBand(gen, radio.band);
  radio.standard = std || gen;
  radio.widthMHz = clampWidthMHz(radio.standard, radio.band, radio.widthMHz);
  if (nss != null && nss !== "") radio.nss = nss;
  radio.nss = clampNss(radio.nss);
  if (std == null) radio.enabled = false;
  return radio;
}

/** Compact stream label: "2×2" or "2×2 / 4×4". */
export function apStreamLabel(ap) {
  const parts = (ap?.radios || []).map((r) => `${r.nss}×${r.nss}`);
  if (!parts.length) return "";
  if (parts.every((p) => p === parts[0])) return parts[0];
  return parts.join(" / ");
}

export function apOptionLabel(ap) {
  const streams = apStreamLabel(ap);
  const wifi = ap.wifi || STANDARD_LABEL[ap.generation] || "";
  return streams ? `${ap.model} — ${streams} · ${wifi}` : `${ap.model} · ${wifi}`;
}

/**
 * Radios for a curated AP. Keeps prior width/enable when the band already existed.
 * Does not copy channel width from the SKU — that stays a design choice.
 */
export function radiosFromAp(ap, prevRadios = []) {
  const prevByBand = new Map((prevRadios || []).map((r) => [r.band, r]));
  return (ap.radios || []).map((spec) => {
    const old = prevByBand.get(spec.band);
    const radio = {
      id: BAND_RADIO_IDS[spec.band] || `r${spec.band}`,
      enabled: old ? old.enabled : true,
      band: spec.band,
      standard: ap.generation,
      widthMHz: old ? old.widthMHz : DEFAULT_WIDTH_MHZ[spec.band] || 20,
      nss: spec.nss,
    };
    return clampRadio(radio, ap.generation);
  });
}

/** True when generation, radio count, bands, and streams still match the SKU. */
export function apMatchesRadios(ap, radios, generation) {
  if (!ap || !ap.radios || generation !== ap.generation) return false;
  if (!radios || radios.length !== ap.radios.length) return false;
  return ap.radios.every((spec, i) => {
    const r = radios[i];
    return r && r.band === spec.band && Number(r.nss) === Number(spec.nss);
  });
}

export function sharedNss(radios) {
  if (!radios || !radios.length) return 2;
  const first = clampNss(radios[0].nss);
  return radios.every((r) => clampNss(r.nss) === first) ? first : "mixed";
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
 * PHY terms behind phyRateMbps. Null when the MCS / width / stream mix is invalid.
 * @param {{ standard: Standard, widthMHz: number, nss: number, mcs: number, giUs: number }} p
 */
export function phyBreakdown(p) {
  const { standard, widthMHz, nss, mcs, giUs } = p;
  if (!mcsValid(standard, widthMHz, nss, mcs)) return null;
  const row = mcsRow(mcs);
  const nsd = nsdFor(standard, widthMHz);
  const ofdm = standard === "n" || standard === "ac";
  const tDataUs = ofdm ? 3.2 : 12.8;
  const tSymUs = symbolUs(standard, giUs);
  const dbps = nDbps(nsd, nss, row.bpscs, row.coding);
  return {
    standard,
    ofdm,
    nsd,
    nss,
    bpscs: row.bpscs,
    modulation: row.mod,
    qam: row.qam,
    coding: row.coding,
    codingLabel: row.codingLabel,
    nDbps: dbps,
    tDataUs,
    giUs,
    tSymUs,
    phyMbps: (dbps / (tSymUs * 1e-6)) / 1e6,
  };
}

/**
 * PHY rate in Mbps. Returns null if the combination is invalid.
 * @param {{ standard: Standard, widthMHz: number, nss: number, mcs: number, giUs: number }} p
 */
export function phyRateMbps(p) {
  const breakdown = phyBreakdown(p);
  return breakdown ? breakdown.phyMbps : null;
}

/**
 * Protocol efficiency vs PHY:
 *   1 client → ~50% of MCS
 *   small / moderate → ~45%
 *   medium-large / heavy → ~40%
 */
/** Busy-room MAC factor. Seat count always uses this, even for one client. */
export const PLAN_MAC_EFFICIENCY = 0.4;

export function macEfficiency(activeClients) {
  const n = Math.max(0, Number(activeClients) || 0);
  if (n <= 1) return 0.5;
  if (n <= 10) return 0.45;
  return PLAN_MAC_EFFICIENCY;
}

/**
 * Beacon + probe airtime for this radio. 100 TU beacons (102.4 ms), ~350-byte
 * frame, 1 Mbps on 2.4 GHz / 6 Mbps on 5 and 6, plus a 1.5× probe fudge.
 * One SSID is already inside the 40–50% protocol factor. Extra SSIDs are the tax.
 */
export function ssidAirtimeBreakdown(ssidCount, band) {
  const count = Math.max(0, Number(ssidCount) || 0);
  const extra = Math.max(0, count - 1);
  const beaconBytes = 350;
  const beaconIntervalMs = 102.4;
  const beaconsPerSec = 1000 / beaconIntervalMs;
  const rateMbps = band === "2.4" ? 1 : 6;
  const probeFactor = 1.5;
  const perExtra = ((beaconBytes * 8 * beaconsPerSec) / (rateMbps * 1e6)) * probeFactor;
  const raw = extra * perExtra;
  const cap = 0.65;
  return {
    ssidCount: count,
    extra,
    beaconBytes,
    beaconIntervalMs,
    beaconsPerSec,
    rateMbps,
    probeFactor,
    perExtra,
    raw,
    fraction: Math.min(cap, raw),
    capped: raw > cap,
  };
}

export function ssidAirtimeFraction(ssidCount, band) {
  return ssidAirtimeBreakdown(ssidCount, band).fraction;
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
 * Default share left on 2.4 GHz when a higher band is also in the story.
 * Tri-band keeps today's 10%. One higher band keeps 15%.
 */
export function defaultLeftover24(has5, has6) {
  return has5 && has6 ? 0.1 : 0.15;
}

/**
 * How clients land on enabled radios this device can actually join.
 * Steered: leftover24 of the crowd stays on 2.4 (an assumption). The rest
 * splits evenly across the higher bands they can use.
 * Best: everyone on the highest band they can use.
 * @param {number | null | undefined} leftover24 fraction on 2.4, or omit for the default
 */
export function clientSplit(radios, clientBands, mode, leftover24) {
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
  const weights = { "2.4": 0, 5: 0, 6: 0 };
  const has24 = byBand["2.4"].length > 0;
  const has5 = byBand["5"].length > 0;
  const has6 = byBand["6"].length > 0;
  const higher = [];
  if (has5) higher.push("5");
  if (has6) higher.push("6");

  if (has24 && higher.length) {
    const fallback = defaultLeftover24(has5, has6);
    const hasOverride = leftover24 != null && leftover24 !== "" && Number.isFinite(Number(leftover24));
    const raw = hasOverride ? Number(leftover24) : fallback;
    const stay = Math.min(1, Math.max(0, raw));
    weights["2.4"] = stay;
    const rest = (1 - stay) / higher.length;
    for (const band of higher) weights[band] = rest;
  } else if (higher.length) {
    const each = 1 / higher.length;
    for (const band of higher) weights[band] = each;
  } else {
    weights["2.4"] = 1;
  }

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
      reason: `The client has no ${radio.band} GHz radio. This AP radio stays out of the pool.`,
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
    notes.push(
      `Client caps this radio at ${linkStandardLabel(standard, radio.band)}. The AP radio is ${linkStandardLabel(apStd, radio.band)}.`,
    );
  }
  if (standard !== clientStd && STANDARD_RANK[apStd] < STANDARD_RANK[client.standard]) {
    notes.push(`AP caps this radio at ${linkStandardLabel(standard, radio.band)}.`);
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
 *   leftover24?: number | null,
 *   margin?: number,
 *   neighborByBand?: Partial<Record<Band, NeighborMode>>,
 *   mcsOverride?: number | null,
 *   giOverride?: number | null,
 * }} EstimateInput
 */

function clampMargin(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_DESIGN_MARGIN;
  return Math.min(0.9, Math.max(0, n));
}

function neighborForBand(input, band, fallback) {
  const id = input.neighborByBand && input.neighborByBand[band];
  return (id && NEIGHBOR_MODES[id]) || fallback;
}

/**
 * What one person on this radio gets.
 * A single device, or a band with less than one person assigned, gets the
 * whole radio. A crowd shares it. Never divide by a fraction of a person.
 */
function groupMbps(usableMbps, clientsHere, activeClients) {
  if (!(usableMbps > 0) || !(activeClients > 0)) return 0;
  if (activeClients <= 1 || !(clientsHere >= 1)) return usableMbps;
  return usableMbps / clientsHere;
}

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
  const margin = clampMargin(input.margin);
  const leftover24 = splitMode === "steered" ? input.leftover24 : null;

  const split = clientSplit(radios, client.bands, splitMode, leftover24);
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
    let phyBlended = false;
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
        phyBlended = true;
        link.notes.push("Mixed clients: slow stations consume more airtime for the same bits.");
      }
    }

    const macNow = macEfficiency(activeClients);
    // Planning load uses the medium/large-room bucket — "how many users"
    // should not assume a single-client 50% efficiency.
    const macPlan = PLAN_MAC_EFFICIENCY;
    const bandNeighbor = neighborForBand(input, radio.band, neighbor);
    const ssidMath = ssidAirtimeBreakdown(ssidCount, radio.band);
    const ssidTax = ssidMath.fraction;
    const phyMath = phyBlended
      ? null
      : phyBreakdown({
          standard: link.standard,
          widthMHz: link.widthMHz,
          nss: link.nss,
          mcs: link.mcs,
          giUs: link.giUs,
        });
    const rf = bandNeighbor.rfUsable;
    const protocolMbps = phyMbps * macNow;
    const protocolPlanMbps = phyMbps * macPlan;
    const air = rf * (1 - ssidTax);
    const usableMbps = protocolMbps * air;
    const planMbps = protocolPlanMbps * air;
    const perUserMbps = groupMbps(usableMbps, clientsHere, activeClients);
    // Headcount this radio allows if the split stays put. Not "clients if
    // everyone moved here."
    const fitHere = share > 0 && targetMbps > 0 ? planMbps / (share * targetMbps) : 0;

    radioResults.push({
      id: radio.id,
      enabled: true,
      band: link.band,
      standard: link.standard,
      standardLabel: linkStandardLabel(link.standard, link.band),
      apStandard: radio.standard,
      apStandardLabel: linkStandardLabel(radio.standard, radio.band),
      widthMHz: link.widthMHz,
      nss: link.nss,
      mcs: link.mcs,
      modulation: link.modulation,
      qam: link.qam,
      codingLabel: link.codingLabel,
      giUs: link.giUs,
      phyMbps,
      phyMath,
      phyBlended,
      minRssiDbm: link.minRssiDbm,
      share,
      clients: clientsHere,
      macEfficiency: macNow,
      ssidAirtime: ssidTax,
      ssidMath,
      rfUsable: rf,
      neighborId: bandNeighbor.id,
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

  // The split is fixed. The room seats as many people as the tight radio
  // allows. Summing the radios and dividing pretends one person can use
  // every band at once, and pretends the fast band donates speed to the slow one.
  let binding = null;
  for (const radio of serving) {
    if (!binding || radio.fitHere < binding.fitHere) binding = radio;
  }
  const clientsThatFit = binding ? binding.fitHere : 0;
  const modeledClients = Math.floor(Number.isFinite(clientsThatFit) ? Math.max(0, clientsThatFit) : 0);
  const recommendedClients = Math.floor(modeledClients * (1 - margin));

  const fractional = serving.some((r) => r.clients < 1);
  let speedStory = "none";
  let perUserMbps = 0;
  if (!serving.length) {
    speedStory = "none";
  } else if (!(activeClients > 0)) {
    speedStory = "empty";
  } else if (serving.length === 1) {
    speedStory = "single";
    perUserMbps = serving[0].perUserMbps;
  } else if (activeClients <= 1 || fractional) {
    // One device uses one radio. Report the faster radio, not the sum.
    speedStory = "station";
    perUserMbps = serving.reduce((best, r) => Math.max(best, r.usableMbps || 0), 0);
  } else {
    speedStory = "crowd";
    perUserMbps = binding.perUserMbps;
  }

  let verdict = "none";
  if (!serving.length) {
    verdict = "none";
  } else if (!(activeClients > 0)) {
    verdict = clientsThatFit >= 1 ? "fits" : "none";
  } else if (speedStory === "station") {
    const rates = serving.map((r) => r.usableMbps || 0);
    const best = Math.max(...rates);
    const worst = Math.min(...rates);
    if (best < targetMbps) verdict = "short";
    else if (worst < targetMbps || activeClients > recommendedClients) verdict = "fits";
    else verdict = "plenty";
  } else if (perUserMbps < targetMbps) {
    verdict = "short";
  } else if (activeClients > recommendedClients) {
    verdict = "fits";
  } else {
    verdict = "plenty";
  }

  const sameRf = serving.every((r) => r.rfUsable === serving[0].rfUsable);
  const caveats = buildCaveats({
    neighbor,
    ssidCount,
    quality,
    mac: macEfficiency(activeClients),
    activeClients,
    radios: radioResults,
    client,
    splitMode,
    sameRf,
    margin,
  });

  return {
    ok: serving.length > 0,
    targetMbps,
    activeClients,
    clientsThatFit,
    modeledClients,
    recommendedClients,
    margin,
    bindingBand: binding ? binding.band : null,
    bindingId: binding ? binding.id : null,
    speedStory,
    protocolAggregate,
    perUserMbps,
    aggregateMbps,
    macEfficiency: macEfficiency(activeClients),
    macPlan: PLAN_MAC_EFFICIENCY,
    rfUsable: neighbor.rfUsable,
    sameRf,
    neighbor,
    quality,
    ssidCount,
    splitMode,
    verdict,
    caveats,
    radios: radioResults,
  };
}

function buildCaveats({ neighbor, ssidCount, quality, mac, activeClients, radios, client, splitMode, sameRf, margin }) {
  const caveats = [];
  const rfPct = Math.round(neighbor.rfUsable * 100);
  const macPct = Math.round(mac * 100);
  const marginPct = Math.round((margin ?? DEFAULT_DESIGN_MARGIN) * 100);

  if (sameRf === false) {
    const bits = [];
    for (const radio of radios) {
      if (!radio.phyMbps || !(radio.rfUsable > 0)) continue;
      bits.push(`${radio.band} GHz ${Math.round(radio.rfUsable * 100)}%`);
    }
    caveats.push(
      `RF: this story uses a different assumption on each band (${bits.join(", ")}). Those percents are knobs, not a survey. 2.4, 5, and 6 GHz usually do not share contention or how far the signal goes.`,
    );
  } else if (neighbor.id === "isolated") {
    caveats.push(
      `RF: every band is treated as 100% yours — no CCI/ACI from neighboring APs. Real floors are rarely this kind. Same coarse assumption on every band.`,
    );
  } else if (neighbor.id === "typical") {
    caveats.push(
      `RF: about ${rfPct}% of each channel is treated as yours. The rest is contention from neighbors (CCI/ACI) and leftover noise. Same coarse assumption on every band — 2.4 GHz is often worse than this. Not a site survey.`,
    );
  } else {
    caveats.push(
      `RF: only ${rfPct}% of each channel is treated as yours. Crowded spectrum, applied to every band in this story. 2.4 GHz often looks like this even when 5 and 6 GHz do not.`,
    );
  }

  caveats.push(
    `Protocol: with ${activeClients || 0} active client${activeClients === 1 ? "" : "s"}, this story keeps ~${macPct}% of PHY for payload (IFS, ACKs, backoff, retransmits, small frames). The 50/45/40% steps are one coarse assumption for the whole AP, not a capture. Associated-but-idle devices are not this math.`,
  );

  if (ssidCount <= 1) {
    caveats.push("SSIDs: one SSID. Each extra SSID is more beacons and probes, especially on 2.4 GHz.");
  } else {
    caveats.push(
      `SSIDs: ${ssidCount} broadcast here. Beacon/probe tax is already subtracted. Four is a crowd; eight is a meeting that should have been an email.`,
    );
  }

  const rateShift =
    " One MCS stands for every client on that radio, and the same rate up and down. Real cells rate-shift, and uplink is often worse.";
  if (quality === "excellent") {
    caveats.push(
      "Link: “excellent” is sitting near the AP with a clean SNR so high MCS (1024-QAM / 4096-QAM) can stick. That is not a cell-edge story." +
        rateShift,
    );
  } else if (quality === "edge") {
    caveats.push(
      "Link: cell edge (16-QAM). If RSSI is this low, add an AP — do not widen the channel." + rateShift,
    );
  } else {
    caveats.push(
      "Link: typical coverage (~256-QAM / MCS 7–9 on 5/6 GHz; 64-QAM on 2.4). Not datasheet MCS 11/13. High QAM needs to be next to the AP." +
        rateShift,
    );
  }

  if (splitMode === "best") {
    caveats.push(
      "Split: everyone is placed on the highest band they can use. That is a choice for this story, not a count of who associated.",
    );
  } else {
    caveats.push(
      "Split: the share on each band is an assumption. A real crowd does not have to land that way, and one device uses only one radio.",
    );
  }

  if (marginPct <= 0) {
    caveats.push(
      "Margin: none. The modeled maximum fills this story and leaves no spare airtime. Wi-Fi does not run well full.",
    );
  } else {
    caveats.push(
      `Margin: ${marginPct}% of the modeled maximum is left unused. The smaller count is the recommendation. The larger count is the model’s ceiling, not a design.`,
    );
  }

  const slow = radios.find((r) => r.nss === 1 && r.usableMbps);
  if (slow || client.nss === 1) {
    caveats.push(
      "The weakest station sets the airtime price. A 1-stream client takes roughly twice as long as a 2-stream client to send the same frame.",
    );
  }

  caveats.push(
    "This story is one kind of device. A real room mixes generations, streams, widths, and apps, and the slow ones spend more airtime. Half-duplex. No MU-MIMO miracle, no OFDMA 4× sticker. Megabits are not application success: calls also care about delay, jitter, loss, and the other direction.",
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
    clampRadio(radio, generation);
    radio.enabled = clampStandardToBand(generation, radio.band) != null;
    return radio;
  });
}

const PHY_TONE = {
  n: ["HT", "312.5 kHz"],
  ac: ["VHT", "312.5 kHz"],
  ax: ["HE", "78.125 kHz"],
  be: ["EHT", "78.125 kHz"],
};

function nearInt(n) {
  return Number.isFinite(n) && Math.abs(n - Math.round(n)) < 1e-6;
}

/** Six decimal places, trailing zeros removed. Working precision for the drawer. */
function mathMbps(n) {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function mathFixed(n, digits) {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
}

/** Factors stay two decimals so 40% reads as 0.40, not 0.4. */
function twoDec(n) {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(2);
}

function mathCount(n) {
  if (!Number.isFinite(n)) return "—";
  if (nearInt(n)) return String(Math.round(n));
  return mathFixed(n, 4);
}

function macRule(mac) {
  if (mac >= 0.5) return "0 or 1 active client keeps 50% of PHY";
  if (mac >= 0.45) return "2 to 10 active clients keep 45% of PHY";
  return "11 or more active clients keep 40% of PHY";
}

function servingRadios(est) {
  return (est.radios || []).filter((r) => r.planMbps > 0 && r.share > 0);
}

/**
 * Plain-text arithmetic for one estimate. Each section is a heading plus a
 * preformatted block. The last section is the headline on the card.
 * @param {ReturnType<typeof estimateCapacity>} est
 * @returns {{ heading: string, text: string }[]}
 */
export function capacityArithmetic(est) {
  const n = Math.max(0, Number(est.activeClients) || 0);
  const planMac = est.macPlan ?? PLAN_MAC_EFFICIENCY;
  const liveMac = est.macEfficiency;
  const usePlan = n <= 0;
  const mac = usePlan ? planMac : liveMac;
  const sections = [];

  const placed = servingRadios(est);
  const shareBits = placed.map((r) => `${r.band} GHz ${twoDec(r.share)}`);
  const split =
    est.splitMode === "best"
      ? `Client split: everyone on the highest band they can use${shareBits.length ? ` (${shareBits.join(", ")})` : ""}. An assumption, not a count of associations.`
      : `Client split: band-steered${shareBits.length ? ` (${shareBits.join(", ")})` : ""}. An assumption, not a count of associations.`;
  const headcount = `${n} active client${n === 1 ? "" : "s"}`;
  const macLine = usePlan
    ? `MAC efficiency = ${twoDec(mac)} (busy-room seat count, one factor for the whole AP)`
    : `MAC efficiency = ${twoDec(mac)} (${headcount}; ${macRule(mac)}; one factor for the whole AP)`;
  const rfBits = placed.map((r) => `${r.band} GHz ${twoDec(r.rfUsable)}`);
  const rfLine = !placed.length
    ? `RF fraction = ${twoDec(est.rfUsable)} (${est.neighbor?.label || "neighbors"})`
    : est.sameRf === false
      ? `RF fraction differs by band: ${rfBits.join(", ")}. Coarse assumptions, not a survey.`
      : `RF fraction = ${twoDec(placed[0].rfUsable)} on every band (${est.neighbor?.label || "neighbors"}). Same coarse assumption on every band.`;
  const factorLines = [
    "Coarse assumptions for comparing stories. Not measurements.",
    macLine,
    rfLine,
    split,
    "One MCS per radio, same rate up and down. Real cells rate-shift.",
    "SSID tax applies to extra SSIDs. The first SSID is already inside the MAC factor.",
    `Safety margin = ${twoDec(est.margin ?? DEFAULT_DESIGN_MARGIN)} of the modeled maximum left unused.`,
  ];
  if (usePlan) {
    factorLines.splice(1, 0, "No headcount is typed. This path is the busy-room seat count (MAC 0.40).");
  }
  sections.push({ heading: "Shared factors", text: factorLines.join("\n") });

  for (const radio of est.radios || []) {
    sections.push(radioArithmetic(radio, est, { mac, usePlan }));
  }

  sections.push(headlineArithmetic(est, { n, planMac, liveMac, usePlan }));
  return sections;
}

function radioArithmetic(radio, est, { mac, usePlan }) {
  const heading = `${radio.band} GHz`;
  if (!radio.enabled) {
    return { heading, text: "Off. Left out of the pool." };
  }
  if (!radio.phyMbps) {
    return { heading, text: radio.skip || "Not usable. Left out of the pool." };
  }
  if (!(radio.share > 0)) {
    const why =
      est.splitMode === "best"
        ? "Everyone is on the highest band they can use."
        : "The split puts nobody here.";
    return { heading, text: `Link negotiates, then drops out. ${why} Share is 0, so this radio is left out of the pool.` };
  }

  const protocol = usePlan ? radio.protocolPlanMbps : radio.protocolMbps;
  const usable = usePlan ? radio.planMbps : radio.usableMbps;
  const lines = [];
  const label = [
    radio.standardLabel,
    `${radio.widthMHz} MHz`,
    `${radio.nss}SS`,
    `MCS ${radio.mcs}`,
    radio.qam ? `${radio.modulation} ${radio.codingLabel}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  lines.push(label);
  if (radio.notes?.length) {
    lines.push("");
    for (const note of radio.notes) lines.push(note);
  }
  lines.push("");

  if (radio.phyMath) {
    const m = radio.phyMath;
    const [tone, spacing] = PHY_TONE[m.standard] || [m.standard, ""];
    const nsd = nearInt(m.nsd) ? String(Math.round(m.nsd)) : mathFixed(m.nsd, 4);
    const dbps = nearInt(m.nDbps) ? String(Math.round(m.nDbps)) : mathFixed(m.nDbps, 4);
    const tData = mathFixed(m.tDataUs, 1);
    const gi = mathFixed(m.giUs, 1);
    const tSym = mathFixed(m.tSymUs, 1);
    const term = (name, value) => `  ${name.padEnd(8, " ")}= ${value}`;
    lines.push("PHY");
    lines.push(term("N_SD", `${nsd} (${radio.widthMHz} MHz ${tone}, ${spacing} tones)`));
    lines.push(term("N_SS", String(m.nss)));
    lines.push(term("N_BPSCS", `${m.bpscs} (${m.modulation})`));
    lines.push(term("R", m.codingLabel));
    lines.push(term("N_DBPS", `${nsd} × ${m.nss} × ${m.bpscs} × ${m.codingLabel} = ${dbps} bits/symbol`));
    lines.push(term("T_SYM", `${tData} µs + ${gi} µs GI = ${tSym} µs`));
    lines.push(term("PHY", `${dbps} / ${tSym} µs = ${mathMbps(m.phyMbps)} Mbps`));
  } else if (radio.phyBlended) {
    lines.push("PHY is a harmonic mean across the client mix.");
    lines.push("Slow stations take more airtime for the same bits.");
    lines.push(`  blended PHY = ${mathMbps(radio.phyMbps)} Mbps`);
  } else {
    lines.push(`PHY = ${mathMbps(radio.phyMbps)} Mbps`);
  }

  const tax = radio.ssidMath;
  const chain = (label, value) => `  ${label.padEnd(9, " ")}= ${value}`;
  lines.push("");
  lines.push(chain("protocol", `${mathMbps(radio.phyMbps)} × ${twoDec(mac)} = ${mathMbps(protocol)} Mbps`));
  if (tax && tax.extra > 0) {
    lines.push(
      chain(
        "SSID tax",
        `${mathCount(tax.extra)} extra × (350 B × 8 × 1000/${mathFixed(tax.beaconIntervalMs, 1)}) / ${tax.rateMbps} Mbps × ${mathFixed(tax.probeFactor, 1)}`,
      ),
    );
    lines.push(`             = ${mathFixed(tax.fraction, 10)}${tax.capped ? " (capped at 0.65)" : ""}`);
  } else {
    lines.push(chain("SSID tax", "0"));
  }
  const air = radio.rfUsable * (1 - radio.ssidAirtime);
  lines.push(chain("air", `${twoDec(radio.rfUsable)} × (1 - ${mathFixed(radio.ssidAirtime, 10)}) = ${mathFixed(air, 10)}`));
  lines.push(chain("usable", `${mathMbps(protocol)} × ${mathFixed(air, 10)} = ${mathMbps(usable)} Mbps`));
  lines.push(chain("clients", `${mathCount(est.activeClients)} × ${twoDec(radio.share)} = ${mathCount(radio.clients)}`));
  if (!usePlan && est.speedStory === "crowd" && radio.clients >= 1) {
    lines.push(chain("each here", `${mathMbps(usable)} / ${mathCount(radio.clients)} = ${mathMbps(radio.perUserMbps)} Mbps`));
  } else if (!usePlan && (est.speedStory === "station" || est.activeClients <= 1)) {
    lines.push(chain("alone", `${mathMbps(radio.usableMbps)} Mbps if this person uses this radio`));
  } else if (!usePlan && est.speedStory === "single") {
    lines.push(chain("each here", `${mathMbps(usable)} / ${mathCount(est.activeClients)} = ${mathMbps(radio.perUserMbps)} Mbps`));
  }
  if (radio.share > 0 && est.targetMbps > 0) {
    lines.push(
      chain(
        "allows",
        `${mathMbps(radio.planMbps)} / (${twoDec(radio.share)} × ${mathMbps(est.targetMbps)}) = ${mathFixed(radio.fitHere, 6)} people`,
      ),
    );
  }
  if (!usePlan) lines.push(`  table shows ${formatMbps(radio.usableMbps)} usable on this radio`);
  return { heading, text: lines.join("\n") };
}

function headlineArithmetic(est, { n, planMac, liveMac, usePlan }) {
  const serving = servingRadios(est);
  const lines = [];
  if (!serving.length) {
    lines.push("No radio is in this story.");
    lines.push("Modeled maximum is 0 people.");
    return { heading: "The headline", text: lines.join("\n") };
  }

  const target = est.targetMbps;
  const margin = est.margin ?? DEFAULT_DESIGN_MARGIN;
  const floorN = est.modeledClients ?? Math.floor(est.clientsThatFit || 0);
  lines.push("Each radio limits the headcount under this split. The tight one wins.");
  lines.push("Speeds are not averaged across radios.");
  for (const radio of serving) {
    lines.push(
      `${radio.band} GHz allows ${mathMbps(radio.planMbps)} / (${twoDec(radio.share)} × ${mathMbps(target)}) = ${mathFixed(radio.fitHere, 6)}`,
    );
  }
  lines.push(`tight band = ${est.bindingBand} GHz`);
  lines.push(`modeled maximum = ${mathFixed(est.clientsThatFit, 6)}`);
  lines.push(`floor = ${floorN}`);
  lines.push(`margin = ${twoDec(margin)} left unused`);
  lines.push(`recommended = floor(${floorN} × ${twoDec(1 - margin)}) = ${est.recommendedClients}`);

  if (n > 0 && !usePlan && Math.abs(liveMac - planMac) >= 1e-9) {
    lines.push("");
    lines.push(`Speeds for these ${mathCount(n)} people use MAC ${twoDec(liveMac)}.`);
    lines.push(`The seat count uses MAC ${twoDec(planMac)}.`);
  }

  if (n > 0 && est.speedStory === "crowd") {
    lines.push("");
    for (const radio of serving) {
      lines.push(`${radio.band} GHz: ${mathCount(radio.clients)} people get ${mathMbps(radio.perUserMbps)} Mbps each`);
    }
    lines.push("People on different radios do not share one speed.");
  } else if (n > 0 && est.speedStory === "station") {
    lines.push("");
    lines.push("One device uses one radio. These speeds do not add.");
    for (const radio of serving) {
      lines.push(`${radio.band} GHz alone = ${mathMbps(radio.usableMbps)} Mbps`);
    }
  } else if (n > 0 && est.speedStory === "single") {
    const radio = serving[0];
    lines.push("");
    lines.push(`${radio.band} GHz: ${mathMbps(radio.usableMbps)} / ${mathCount(n)} = ${mathMbps(radio.perUserMbps)} Mbps`);
    lines.push(`shown as ${formatMbps(radio.perUserMbps)}`);
  }
  return { heading: "The headline", text: lines.join("\n") };
}

/**
 * A story is a full snapshot. Each call returns new radios so a previous
 * width, disabled radio, or forced MCS cannot leak in.
 */
export function scenarioInput(id) {
  const common = {
    apId: "custom",
    neighborByBand: {},
    leftover24: null,
    margin: DEFAULT_DESIGN_MARGIN,
    mcsOverride: null,
  };
  /** @type {Record<string, () => object>} */
  const stories = {
    ipad1: () => ({
      ...common,
      id: "ipad1",
      radioCount: 1,
      generation: "n",
      nss: 3,
      radios: [{ id: "r5", enabled: true, band: "5", standard: "n", widthMHz: 20, nss: 3 }],
      deviceId: "ipad-1",
      quality: "excellent",
      neighbor: "isolated",
      ssidCount: 1,
      activeClients: 30,
      appId: "classroom",
      splitMode: "best",
    }),
    air2: () => ({
      ...common,
      id: "air2",
      radioCount: 1,
      generation: "ac",
      nss: 3,
      radios: [{ id: "r5", enabled: true, band: "5", standard: "ac", widthMHz: 20, nss: 3 }],
      deviceId: "ipad-air-2",
      quality: "excellent",
      neighbor: "isolated",
      ssidCount: 1,
      activeClients: 30,
      appId: "classroom",
      splitMode: "best",
    }),
    office: () => ({
      ...common,
      id: "office",
      radioCount: 2,
      generation: "ax",
      nss: 2,
      radios: [
        { id: "r24", enabled: true, band: "2.4", standard: "ax", widthMHz: 20, nss: 2 },
        { id: "r5", enabled: true, band: "5", standard: "ax", widthMHz: 20, nss: 2 },
      ],
      deviceId: "wifi6-laptop",
      quality: "typical",
      neighbor: "typical",
      ssidCount: 3,
      activeClients: 30,
      appId: "office",
      splitMode: "steered",
    }),
    triband: () => ({
      ...common,
      id: "triband",
      radioCount: 3,
      generation: "be",
      nss: 2,
      radios: [
        { id: "r24", enabled: true, band: "2.4", standard: "be", widthMHz: 20, nss: 2 },
        { id: "r5", enabled: true, band: "5", standard: "be", widthMHz: 20, nss: 2 },
        { id: "r6", enabled: true, band: "6", standard: "be", widthMHz: 40, nss: 2 },
      ],
      deviceId: "iphone-16-pro",
      quality: "typical",
      neighbor: "typical",
      ssidCount: 2,
      activeClients: 40,
      appId: "office",
      splitMode: "steered",
    }),
  };
  const build = stories[id];
  if (!build) return null;
  const story = build();
  story.radios = story.radios.map((radio) => ({ ...radio }));
  story.neighborByBand = {};
  return story;
}

export function deviceById(id) {
  return DEVICE_PRESETS.find((d) => d.id === id) || DEVICE_PRESETS.find((d) => d.id === "wifi6-laptop");
}

export function appById(id) {
  return APP_PRESETS.find((a) => a.id === id) || APP_PRESETS[1];
}
