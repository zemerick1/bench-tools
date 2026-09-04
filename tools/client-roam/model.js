/**
 * Client roam cartoon: rooms and a hallway. Not RF planning.
 * PL = 36.4 + 30*log10(d3d) + 14*walls. Client 5 ft, AP 10 ft.
 */

const PL0 = 36.4;
const PLN = 30;
const WALL_DB = 14;
/** AP + client antennas. Close-in RSSI stays in the −40s; TX power is still log. */
const ANT_GAIN_DB = 6;
const EPS = 1e-9;

export const WING = {
  x: 0,
  y: 0,
  w: 120,
  h: 50,
  hall: { x: 0, y: 20, w: 120, h: 10 },
  hallY0: 20,
  hallY1: 30,
  hallY: 25,
  roomW: 30,
  roomH: 20,
  apHeightFt: 10,
  clientHeightFt: 5,
  wallDb: WALL_DB,
  deskOffsetFt: 6,
};

export const RF_FLOOR_DBM = -90;

export const MIN_RSSI_DBM = { 6: -90, 12: -87, 24: -82 };

export const ROAM = {
  holdDbm: -75,
  dropDbm: -85,
  betterDb: 5,
  btmBetterDb: 8,
  cooldownSec: 2.5,
  reverseDb: 12,
  scanMs: { v: 0, k: 40, full: 400 },
  handshakeMs: { psk: 50, pskFt: 30, dot1x: 800, dot1xFt: 35 },
};

export const DEFAULTS = {
  powerDbm: 15,
  minRateMbps: 6,
  r: false,
  k: false,
  v: false,
  auth: "dot1x",
  fromId: "A2",
  toId: "A3",
  dwellSec: 5,
  walkFtPerSec: 4,
  stepFt: 0.5,
};

const SIDES = [
  { side: "A", y: 0, ids: ["A1", "A2", "A3", "A4"] },
  { side: "B", y: 30, ids: ["B1", "B2", "B3", "B4"] },
];

export const ROOMS = SIDES.flatMap(({ side, y, ids }) =>
  ids.map((id, col) => {
    const x = col * WING.roomW;
    return { id, side, x, y, w: WING.roomW, h: WING.roomH, cx: x + 15, cy: y + 10 };
  }),
);

export const APS = ROOMS.map((room) => ({
  id: room.id,
  roomId: room.id,
  x: room.cx,
  y: room.cy,
  z: WING.apHeightFt,
}));

export const WALLS = [
  { x1: 0, y1: 20, x2: 120, y2: 20 },
  { x1: 0, y1: 30, x2: 120, y2: 30 },
  ...[30, 60, 90].flatMap((x) => [
    { x1: x, y1: 0, x2: x, y2: 20 },
    { x1: x, y1: 30, x2: x, y2: 50 },
  ]),
];

export const JOURNEYS = [
  { id: "next-door", fromId: "A2", toId: "A3" },
  { id: "across", fromId: "A2", toId: "B2" },
  { id: "far", fromId: "A1", toId: "B4" },
];

export const STORIES = [
  { id: "sticky", label: "Sticky client", powerDbm: 20, minRateMbps: 6, fromId: "A2", toId: "A3" },
  { id: "power-down", label: "Turned the power down", powerDbm: 12, minRateMbps: 6, fromId: "A2", toId: "A3" },
  { id: "min-rate", label: "Raised min rates", powerDbm: 15, minRateMbps: 24, fromId: "A2", toId: "A3" },
  { id: "ft-sticky", label: "FT on, still sticky", powerDbm: 20, minRateMbps: 6, r: true, fromId: "A2", toId: "A3" },
  { id: "across", label: "Across the hall", powerDbm: 15, minRateMbps: 12, fromId: "A2", toId: "B2" },
  { id: "full-kit", label: "The full kit", powerDbm: 15, minRateMbps: 12, r: true, k: true, v: true, fromId: "A1", toId: "B4" },
];

function merge(settings = {}) {
  return { ...DEFAULTS, ...settings };
}

function asRoom(room) {
  return typeof room === "string" ? roomById(room) : room;
}

export function roomById(id) {
  return ROOMS.find((room) => room.id === id) ?? null;
}

export function apById(id) {
  return APS.find((ap) => ap.id === id) ?? null;
}

export function roomAt(x, y) {
  if (x < 0 || y < 0 || x > WING.w || y > WING.h) return null;
  if (y > WING.hallY0 && y < WING.hallY1) return { id: "hall" };
  const col = Math.min(3, Math.max(0, Math.floor(x / WING.roomW)));
  const side = y <= WING.hallY0 ? "A" : "B";
  return roomById(`${side}${col + 1}`);
}

export function deskOf(room) {
  const r = asRoom(room);
  return { x: r.cx, y: r.side === "A" ? r.cy + WING.deskOffsetFt : r.cy - WING.deskOffsetFt };
}

export function doorOf(room) {
  const r = asRoom(room);
  return { x: r.cx, y: r.side === "A" ? WING.hallY0 : WING.hallY1 };
}

export function hallOf(room) {
  const r = asRoom(room);
  return { x: r.cx, y: WING.hallY };
}

function hitsWall(x0, y0, x1, y1, wall) {
  const horizontal = Math.abs(wall.y2 - wall.y1) < EPS;
  if (horizontal) {
    const dy = y1 - y0;
    if (Math.abs(dy) < EPS) return false;
    const t = (wall.y1 - y0) / dy;
    if (t <= EPS || t >= 1 - EPS) return false;
    const x = x0 + t * (x1 - x0);
    const lo = Math.min(wall.x1, wall.x2);
    const hi = Math.max(wall.x1, wall.x2);
    return x >= lo - EPS && x <= hi + EPS;
  }
  const dx = x1 - x0;
  if (Math.abs(dx) < EPS) return false;
  const t = (wall.x1 - x0) / dx;
  if (t <= EPS || t >= 1 - EPS) return false;
  const y = y0 + t * (y1 - y0);
  const lo = Math.min(wall.y1, wall.y2);
  const hi = Math.max(wall.y1, wall.y2);
  return y >= lo - EPS && y <= hi + EPS;
}

function inBand(y, wall) {
  const lo = Math.min(wall.y1, wall.y2);
  const hi = Math.max(wall.y1, wall.y2);
  return y >= lo - EPS && y <= hi + EPS;
}

export function countWalls(x0, y0, x1, y1) {
  let n = 0;
  for (const wall of WALLS) {
    const party = Math.abs(wall.x1 - wall.x2) < EPS;
    if (party && (!inBand(y0, wall) || !inBand(y1, wall))) continue;
    if (hitsWall(x0, y0, x1, y1, wall)) n += 1;
  }
  return n;
}

export function dist3dFt(x, y, ap, heightFt = WING.clientHeightFt) {
  const z = (ap.z ?? WING.apHeightFt) - heightFt;
  return Math.hypot(x - ap.x, y - ap.y, z);
}

export function pathLossDb(d3d, walls = 0) {
  return PL0 + PLN * Math.log10(Math.max(d3d, 1)) + WALL_DB * walls;
}

export function rssiDbm(powerDbm, d3d, walls = 0) {
  return powerDbm + ANT_GAIN_DB - pathLossDb(d3d, walls);
}

export function minRssiForRate(rateMbps) {
  return MIN_RSSI_DBM[rateMbps] ?? RF_FLOOR_DBM;
}

export function range3dFt(powerDbm, rateMbps, walls = 0) {
  const db = powerDbm - minRssiForRate(rateMbps) - PL0 - WALL_DB * walls;
  return 10 ** (db / PLN);
}

export function freeSpaceRadiusFt(powerDbm, rateMbps) {
  const d3d = range3dFt(powerDbm, rateMbps, 0);
  const dh = WING.apHeightFt - WING.clientHeightFt;
  return Math.sqrt(Math.max(d3d * d3d - dh * dh, 0));
}

/**
 * Floor-plan ring radius. Two-wall tax so the cartoon fits the map:
 * power and min-rate still move the rings; they don't swallow the map.
 */
export function cartoonRadiusFt(powerDbm, rssiThreshold) {
  const db = powerDbm - rssiThreshold - PL0 - WALL_DB * 2;
  if (db <= 0) return 3.5;
  const d3d = 10 ** (db / PLN);
  const dh = WING.apHeightFt - WING.clientHeightFt;
  return Math.max(3.5, Math.sqrt(Math.max(d3d * d3d - dh * dh, 0)));
}

export function cellRadii(settings = {}) {
  const cfg = merge(settings);
  const rf = cartoonRadiusFt(cfg.powerDbm, RF_FLOOR_DBM);
  const mbr = Math.min(rf, cartoonRadiusFt(cfg.powerDbm, minRssiForRate(cfg.minRateMbps)));
  return { rf, mbr };
}

export function linksAt(x, y, settings = {}) {
  const cfg = merge(settings);
  return APS.map((ap) => {
    const walls = countWalls(x, y, ap.x, ap.y);
    const d3d = dist3dFt(x, y, ap);
    return { id: ap.id, rssi: rssiDbm(cfg.powerDbm, d3d, walls), walls, d3dFt: d3d };
  }).sort((a, b) => b.rssi - a.rssi || a.id.localeCompare(b.id));
}

export function coverageGrid(settings = {}) {
  const cfg = merge(settings);
  const stepFt = 2;
  const heightFt = WING.clientHeightFt;
  const minRssi = minRssiForRate(cfg.minRateMbps);
  const cells = [];
  for (let y = 0; y <= WING.h; y += stepFt) {
    for (let x = 0; x <= WING.w; x += stepFt) {
      const links = linksAt(x, y, cfg);
      const best = links[0];
      cells.push({
        x,
        y,
        bestId: best?.id ?? null,
        bestRssi: best?.rssi ?? -Infinity,
        rfPresent: !!best && best.rssi >= RF_FLOOR_DBM,
        rfIds: links.filter((link) => link.rssi >= RF_FLOOR_DBM).map((link) => link.id),
        connectIds: links.filter((link) => link.rssi >= minRssi).map((link) => link.id),
      });
    }
  }
  return { stepFt, heightFt, cells };
}

function samePoint(a, b) {
  return Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;
}

export function buildPath(fromId, toId) {
  const from = roomById(fromId);
  const to = roomById(toId);
  const raw = [deskOf(from), doorOf(from), hallOf(from), hallOf(to), doorOf(to), deskOf(to)];
  const points = [];
  for (const p of raw) {
    if (!points.length || !samePoint(points[points.length - 1], p)) points.push({ x: p.x, y: p.y });
  }
  let lengthFt = 0;
  for (let i = 1; i < points.length; i += 1) {
    lengthFt += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return { points, lengthFt };
}

export function sampleAt(s, path) {
  const points = path.points ?? path;
  if (!points.length) return { x: 0, y: 0 };
  if (s <= 0) return { x: points[0].x, y: points[0].y };
  let left = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (s <= left + len) {
      const u = len < EPS ? 0 : (s - left) / len;
      return { x: a.x + u * (b.x - a.x), y: a.y + u * (b.y - a.y) };
    }
    left += len;
  }
  const last = points[points.length - 1];
  return { x: last.x, y: last.y };
}

export function roamFrames(settings = {}) {
  const cfg = merge(settings);
  const scanMs = cfg.v ? ROAM.scanMs.v : cfg.k ? ROAM.scanMs.k : ROAM.scanMs.full;
  const ft = !!(cfg.r || cfg.ft);
  const psk = String(cfg.auth).toLowerCase() === "psk";
  const handshakeMs = psk
    ? ft
      ? ROAM.handshakeMs.pskFt
      : ROAM.handshakeMs.psk
    : ft
      ? ROAM.handshakeMs.dot1xFt
      : ROAM.handshakeMs.dot1x;
  const btmMs = cfg.v ? 12 : 0;
  const frames = [];
  if (btmMs) frames.push({ id: "btm", label: "802.11v ask", ms: btmMs });
  if (scanMs) {
    frames.push({
      id: "scan",
      label: cfg.k ? "Directed scan" : "Full scan",
      ms: scanMs,
    });
  }
  frames.push({
    id: "handshake",
    label: ft ? "FT" : psk ? "PSK" : "802.1X",
    ms: handshakeMs,
  });
  return { scanMs, handshakeMs, btmMs, gapMs: btmMs + scanMs + handshakeMs, frames };
}

export function observeAt(x, y, settings = {}, servingId = null) {
  const cfg = merge(settings);
  const { rf, mbr } = cellRadii(cfg);
  const minRssi = minRssiForRate(cfg.minRateMbps);
  const hears = linksAt(x, y, cfg).map((h) => {
    const ap = apById(h.id);
    const d = Math.hypot(x - ap.x, y - ap.y);
    return { ...h, d, inMbr: d <= mbr, inRf: d <= rf };
  });
  const serving = servingId ? hears.find((h) => h.id === servingId) : null;
  const best = hears[0];
  return {
    x,
    y,
    heightFt: WING.clientHeightFt,
    roomId: roomAt(x, y)?.id ?? null,
    servingId: serving?.id ?? null,
    servingRssi: serving?.rssi ?? null,
    servingWalls: serving?.walls ?? null,
    servingInMbr: !!serving?.inMbr,
    servingInRf: !!serving?.inRf,
    bestId: best?.id ?? null,
    bestRssi: best?.rssi ?? null,
    bestWalls: best?.walls ?? null,
    inMbr: hears.filter((h) => h.inMbr).map((h) => h.id),
    sticky: !!(serving && best && serving.id !== best.id),
    disconnected: !serving,
    radii: { rf, mbr },
    links: hears,
  };
}

function eligible(link, cfg) {
  return link.rssi >= minRssiForRate(cfg.minRateMbps);
}

function pickNeighbor(obs, cfg, servingId, servingRssi, lastFromId) {
  return (
    obs.links.find((h) => {
      if (h.id === servingId || !eligible(h, cfg)) return false;
      if (lastFromId && h.id === lastFromId && h.rssi < servingRssi + ROAM.reverseDb) return false;
      return true;
    }) || null
  );
}

function decideRoam(obs, cfg, servingId, lock = {}) {
  const { lastFromId = null, lastRoamT = -1e9, t = 0 } = lock;
  const cooling = t - lastRoamT < ROAM.cooldownSec;

  if (!servingId) {
    const join = obs.links.find((h) => eligible(h, cfg));
    if (!join) return null;
    return {
      toId: join.id,
      trigger: "join",
      kind: "rejoin",
      neighborId: join.id,
      knew: !!cfg.k,
    };
  }

  const serving = obs.links.find((h) => h.id === servingId);
  if (!serving) return { toId: null, trigger: "drop", kind: "drop" };

  const neighbor = pickNeighbor(obs, cfg, servingId, serving.rssi, lastFromId);
  const tooWeak = serving.rssi < minRssiForRate(cfg.minRateMbps) || serving.rssi < ROAM.dropDbm;

  if (cooling && !tooWeak) return null;

  if (cfg.v && neighbor) {
    const leftUsable = serving.inMbr === false;
    const muchBetter = neighbor.rssi >= serving.rssi + ROAM.btmBetterDb;
    const neighborHasCell = neighbor.inMbr;
    if (muchBetter || (leftUsable && neighborHasCell)) {
      return {
        toId: neighbor.id,
        trigger: "btm",
        kind: cfg.r ? "ft" : "steer",
        neighborId: neighbor.id,
        knew: !!cfg.k,
        kickId: servingId,
      };
    }
  }

  const wantsRoam =
    serving.rssi < ROAM.holdDbm && neighbor && neighbor.rssi >= serving.rssi + ROAM.betterDb;

  if (wantsRoam || (tooWeak && neighbor)) {
    if (cfg.r) {
      return {
        toId: neighbor.id,
        trigger: "roam",
        kind: "ft",
        neighborId: neighbor.id,
        knew: !!cfg.k,
      };
    }
    return {
      toId: neighbor.id,
      trigger: "hard",
      kind: "hard",
      neighborId: neighbor.id,
      knew: !!cfg.k,
    };
  }

  if (tooWeak) return { toId: null, trigger: "drop", kind: "drop" };
  return null;
}

function walkStops(lengthFt, stepFt) {
  const out = [];
  for (let s = 0; s < lengthFt - EPS; s += stepFt) out.push(s);
  if (!out.length || Math.abs(out[out.length - 1] - lengthFt) > EPS) out.push(lengthFt);
  return out;
}

export function simulateJourney(settings = {}) {
  const cfg = merge(settings);
  const path = buildPath(cfg.fromId, cfg.toId);
  const walkSec = path.lengthFt / cfg.walkFtPerSec;
  const durationSec = cfg.dwellSec * 2 + walkSec;
  const samples = [];
  const roams = [];
  let servingId = cfg.fromId;
  let lastFromId = null;
  let lastRoamT = -1e9;

  function emit(t, s, moving) {
    const pos = sampleAt(s, path);
    let obs = observeAt(pos.x, pos.y, cfg, servingId);
    const decision = decideRoam(obs, cfg, servingId, { lastFromId, lastRoamT, t });
    if (decision) {
      const useFt = decision.kind === "ft";
      const pack =
        decision.kind === "drop"
          ? { frames: [], gapMs: 0 }
          : roamFrames({ ...cfg, r: useFt, v: decision.trigger === "btm" });
      roams.push({
        t,
        s,
        x: pos.x,
        y: pos.y,
        fromId: servingId,
        toId: decision.toId,
        trigger: decision.trigger,
        kind: decision.kind,
        neighborId: decision.neighborId || decision.toId || null,
        knew: !!decision.knew,
        kickId: decision.kickId || null,
        frames: pack.frames,
        gapMs: pack.gapMs,
      });
      lastFromId = servingId;
      lastRoamT = t;
      servingId = decision.toId;
      obs = observeAt(pos.x, pos.y, cfg, servingId);
    }
    samples.push({
      t,
      s,
      x: pos.x,
      y: pos.y,
      heightFt: WING.clientHeightFt,
      moving,
      roomId: obs.roomId,
      servingId: obs.servingId,
      servingRssi: obs.servingRssi,
      servingWalls: obs.servingWalls,
      bestId: obs.bestId,
      bestRssi: obs.bestRssi,
      bestWalls: obs.bestWalls,
      sticky: obs.sticky,
      disconnected: obs.disconnected,
      kickId: decision && decision.trigger === "btm" ? decision.kickId : null,
    });
  }

  emit(0, 0, false);
  for (const s of walkStops(path.lengthFt, cfg.stepFt)) {
    if (s <= EPS) continue;
    emit(cfg.dwellSec + s / cfg.walkFtPerSec, s, s < path.lengthFt - EPS);
  }
  emit(durationSec, path.lengthFt, false);

  return { settings: cfg, path, durationSec, samples, roams };
}

export function randomDestination(fromId = DEFAULTS.fromId) {
  const others = ROOMS.filter((room) => room.id !== fromId);
  return others[Math.floor(Math.random() * others.length)].id;
}

export function formatRssi(dbm) {
  if (!Number.isFinite(dbm)) return "—";
  return `${Math.round(dbm)} dBm`;
}

export function formatFt(ft) {
  if (!Number.isFinite(ft)) return "—";
  return `${Math.round(ft)} ft`;
}
