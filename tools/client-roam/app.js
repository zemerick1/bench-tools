/**
 * Client Roam — walk the hallway, read the caption. Device, not a survey.
 */

import {
  DEFAULTS,
  STORIES,
  JOURNEYS,
  ROOMS,
  simulateJourney,
  sampleAt,
  observeAt,
  formatRssi,
  formatFt,
  roomAt,
  randomDestination,
} from "./model.js?v=12";
import { mountViz } from "./viz.js?v=12";

const STORY_LABEL = {
  sticky: "Sticky client",
  "power-down": "Turned the power down",
  "min-rate": "Raised min rates",
  "ft-sticky": "FT on, still sticky",
  across: "Across the hall",
  "full-kit": "The full kit",
};

const WALL_DB = 14;

const $ = (id) => document.getElementById(id);

const els = {
  play: $("cr-play"),
  reset: $("cr-reset"),
  scrub: $("cr-scrub"),
  dwell: $("cr-dwell"),
  dwellVal: $("cr-dwell-val"),
  start: $("cr-start"),
  end: $("cr-end"),
  random: $("cr-random"),
  power: $("cr-power"),
  powerVal: $("cr-power-val"),
  rate: $("cr-rate"),
  ft: $("cr-ft"),
  k: $("cr-k"),
  v: $("cr-v"),
  auth: $("cr-auth"),
  speed: $("cr-speed"),
  stage: $("cr-stage"),
  caption: $("cr-caption"),
  eye: $("cr-cap-eye"),
  head: $("cr-cap-head"),
  body: $("cr-cap-body"),
  gap: $("cr-gap"),
  timeline: $("cr-timeline"),
  history: $("cr-history"),
  stories: $("cr-stories"),
};

const viz = mountViz(els.stage);

let sim = null;
let t = 0;
let playing = false;
let exploring = false;
let raf = 0;
let lastTs = 0;
let coverKey = "";

function currentSettings() {
  return {
    ...DEFAULTS,
    powerDbm: Number(els.power.value),
    minRateMbps: Number(els.rate.value),
    dwellSec: Number(els.dwell.value),
    fromId: els.start.value,
    toId: els.end.value,
    auth: els.auth.value,
    r: els.ft.checked,
    k: els.k.checked,
    v: els.v.checked,
  };
}

function roomName(id) {
  if (!id || id === "hall") return id === "hall" ? "the hall" : "";
  return id;
}

function fillRooms() {
  for (const sel of [els.start, els.end]) {
    sel.replaceChildren();
    for (const room of ROOMS) {
      const opt = document.createElement("option");
      opt.value = room.id;
      opt.textContent = room.id;
      sel.append(opt);
    }
  }
}

function fillStories() {
  for (const story of STORIES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn--secondary";
    btn.dataset.story = story.id;
    btn.textContent = story.label || STORY_LABEL[story.id] || story.id;
    els.stories.append(btn);
  }
}

function applyKnobs(src) {
  const s = { ...DEFAULTS, ...src };
  els.power.value = String(s.powerDbm);
  els.rate.value = String(s.minRateMbps);
  els.dwell.value = String(s.dwellSec);
  els.ft.checked = !!s.r;
  els.k.checked = !!s.k;
  els.v.checked = !!s.v;
  els.auth.value = s.auth === "psk" ? "psk" : "dot1x";
  if ([...els.start.options].some((o) => o.value === s.fromId)) els.start.value = s.fromId;
  if ([...els.end.options].some((o) => o.value === s.toId)) els.end.value = s.toId;
  syncReadouts();
}

function syncReadouts() {
  els.powerVal.textContent = `${els.power.value} dBm`;
  els.dwellVal.textContent = `${els.dwell.value} s`;
}

function markPressed() {
  const start = els.start.value;
  const dest = els.end.value;
  for (const btn of document.querySelectorAll("[data-journey]")) {
    const j = JOURNEYS.find((item) => item.id === btn.dataset.journey);
    const on = !!(j && j.fromId === start && j.toId === dest);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
  const cur = currentSettings();
  for (const btn of document.querySelectorAll("[data-story]")) {
    const story = STORIES.find((s) => s.id === btn.dataset.story);
    btn.setAttribute("aria-pressed", story && storyMatches(story, cur) ? "true" : "false");
  }
}

function storyMatches(story, cur) {
  const merged = { ...DEFAULTS, ...story };
  return (
    merged.powerDbm === cur.powerDbm &&
    merged.minRateMbps === cur.minRateMbps &&
    !!merged.r === !!cur.r &&
    !!merged.k === !!cur.k &&
    !!merged.v === !!cur.v &&
    merged.auth === cur.auth &&
    merged.fromId === cur.fromId &&
    merged.toId === cur.toId
  );
}

function applyStory(story) {
  applyKnobs({ ...DEFAULTS, ...story });
  exploring = false;
  resim({ resetT: true });
}

function applyJourney(token) {
  if (token === "random") {
    rollRandom();
    return;
  }
  const j = JOURNEYS.find((item) => item.id === token);
  if (!j) return;
  if ([...els.start.options].some((o) => o.value === j.fromId)) els.start.value = j.fromId;
  if ([...els.end.options].some((o) => o.value === j.toId)) els.end.value = j.toId;
  exploring = false;
  resim({ resetT: true });
}

function rollRandom() {
  const from = els.start.value;
  const dest = randomDestination(from);
  if (dest && [...els.end.options].some((o) => o.value === dest) && dest !== from) {
    els.end.value = dest;
  }
  exploring = false;
  resim({ resetT: true });
}

function resim({ resetT = false } = {}) {
  const settings = currentSettings();
  sim = simulateJourney(settings);
  const dur = sim.durationSec || 0;
  if (resetT) t = 0;
  t = Math.max(0, Math.min(t, dur));
  els.scrub.max = String(dur || 1);
  els.scrub.step = dur > 40 ? "0.1" : "0.05";
  els.scrub.value = String(t);
  viz.setPath(sim.path.points, 0);
  coverKey = "";
  markPressed();
  paintFrame();
}

function timeToS(journey, time) {
  const cfg = journey.settings;
  const lengthFt = journey.path.lengthFt || 0;
  const walkSec = lengthFt / (cfg.walkFtPerSec || 4);
  const dwell = cfg.dwellSec || 0;
  if (time <= dwell) return { s: 0, moving: false };
  if (time >= dwell + walkSec) return { s: lengthFt, moving: false };
  return { s: (time - dwell) * cfg.walkFtPerSec, moving: true };
}

function nearestSample(time) {
  const samples = sim?.samples || [];
  if (!samples.length) return null;
  let best = samples[0];
  let err = Math.abs(best.t - time);
  for (const row of samples) {
    const e = Math.abs(row.t - time);
    if (e < err) {
      best = row;
      err = e;
    }
  }
  return best;
}

function sampleNow() {
  if (!sim) return null;
  const { s, moving } = timeToS(sim, t);
  const pos = sampleAt(s, sim.path);
  const snap = nearestSample(t) || {};
  const here = roomAt(pos.x, pos.y);
  return {
    ...snap,
    x: pos.x,
    y: pos.y,
    s,
    t,
    moving,
    roomId: snap.roomId ?? here?.id ?? null,
  };
}

function roamAtTime(sample) {
  const roams = sim?.roams || [];
  const now = sample?.t ?? t;
  for (const r of roams) {
    const dur = (r.gapMs || 0) / 1000;
    if (now >= r.t && now <= r.t + Math.max(dur, 0.05)) return r;
  }
  return null;
}

function hopKind(roam) {
  if (roam.kind === "drop") return "off the radio";
  if (roam.kind === "rejoin" || roam.kind === "hard") return "hard roam";
  if (roam.kind === "ft") return "FT";
  if (roam.kind === "steer") return "802.11v";
  return "";
}

function hopLine(roam) {
  if (roam.kind === "drop") return `${roam.fromId || "Client"} dropped`;
  if (roam.kind === "rejoin" || roam.trigger === "join") return `Joined ${roam.toId}`;
  if (roam.fromId && roam.toId) return `${roam.fromId} → ${roam.toId}`;
  if (roam.toId) return `Joined ${roam.toId}`;
  return "Off the radio";
}

function roamHeadline(roam) {
  if (roam.kind === "drop") return `${roam.fromId || "Client"} dropped`;
  if (roam.kind === "rejoin" || roam.trigger === "join") return `Joining ${roam.toId}`;
  if (roam.trigger === "btm") return `${roam.fromId} sent the client to ${roam.toId}`;
  if (roam.fromId && roam.toId) return `Roaming ${roam.fromId} → ${roam.toId}`;
  if (roam.toId) return `Joining ${roam.toId}`;
  return "Off the radio";
}

function hopNote(roam) {
  const kNote = roam.knew
    ? ` Already knew ${roam.neighborId || roam.toId} was nearby (802.11k), so it skipped a full scan.`
    : "";
  if (roam.trigger === "btm") {
    const how = roam.kind === "ft" ? " Then FT." : " Then a full reconnect.";
    return `${roam.fromId} told the client to move to ${roam.toId} (802.11v).${how}${kNote}`;
  }
  if (roam.kind === "drop") return "Signal too weak and no neighbor to join. Not a roam.";
  if (roam.kind === "hard") {
    return `Hard roam: dropped ${roam.fromId}, then a full join to ${roam.toId}.${kNote || " Had to discover the next AP from scratch."}`;
  }
  if (roam.kind === "rejoin") {
    return `Hard roam: the radio went dark, then a full join.${kNote || " Had to discover the next AP from scratch."}`;
  }
  if (roam.kind === "ft") {
    return `Fast roam — keys were already there (802.11r).${kNote}`;
  }
  return "";
}

function hopMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return "";
  if (ms >= 1000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")} s`;
  return `${Math.round(ms)} ms`;
}

function activeRoamIndex(sample) {
  const roams = sim?.roams || [];
  const now = sample?.t ?? t;
  let idx = -1;
  for (let i = 0; i < roams.length; i += 1) {
    if (now >= roams[i].t) idx = i;
  }
  return idx;
}

function renderHistory(sample) {
  const ol = els.history;
  if (!ol) return;
  ol.replaceChildren();
  if (!sim) return;
  const roams = sim.roams || [];
  const now = sample?.t ?? t;
  const start = sim.settings.fromId;

  function add(text, meta, state, note) {
    const li = document.createElement("li");
    li.className = "cr-history__hop" + (state ? ` is-${state}` : "");
    const left = document.createElement("span");
    left.textContent = text;
    li.append(left);
    if (meta) {
      const right = document.createElement("span");
      right.className = "cr-history__meta";
      right.textContent = meta;
      li.append(right);
    }
    if (note) {
      const extra = document.createElement("span");
      extra.className = "cr-history__note";
      extra.textContent = note;
      li.append(extra);
    }
    ol.append(li);
  }

  const happened = roams.filter((roam) => now >= roam.t);
  if (!happened.length) {
    if (sample?.disconnected) add("Off the radio", "no eligible AP", "now");
    else add(`Holding ${sample?.servingId || start}`, "", "now");
    return;
  }

  for (const roam of happened) {
    const end = roam.t + Math.max((roam.gapMs || 0) / 1000, 0.05);
    const state = now <= end ? "now" : "done";
    const kind = hopKind(roam);
    const meta =
      roam.kind === "drop" ? "off the radio" : [hopMs(roam.gapMs), kind].filter(Boolean).join(" · ");
    add(hopLine(roam), meta, state, hopNote(roam));
  }

  const last = happened[happened.length - 1];
  if (now > last.t + (last.gapMs || 0) / 1000) {
    if (last.kind === "drop" && !sample?.servingId) add("Off the radio", "", "now");
    else if (sample?.servingId) add(`Holding ${sample.servingId}`, "", "now");
    else if (last.toId) add(`Holding ${last.toId}`, "", "now");
  }
}

function renderTimeline(sample) {
  els.timeline.replaceChildren();
  const roam = roamAtTime(sample);
  const frames = (roam?.frames || []).filter((f) => f.ms > 0);
  if (frames.length) {
    for (const f of frames) {
      const div = document.createElement("div");
      div.className = "cr-frame";
      const label = f.label || (f.id === "scan" ? "Scan" : f.id === "handshake" ? "Handshake" : f.id);
      div.textContent = `${label} · ${Math.round(f.ms)} ms`;
      div.style.flexGrow = String(Math.max(1, f.ms));
      els.timeline.append(div);
    }
    return;
  }
  const div = document.createElement("div");
  div.className = "cr-frame";
  div.textContent = sample?.disconnected || !sample?.servingId ? "Off the radio" : `Holding ${sample?.servingId || "AP"}`;
  els.timeline.append(div);
}

function gapText(sample) {
  if (sample?.disconnected || (!sample?.servingId && !sample?.moving && sample)) return "dropped";
  const roam = roamAtTime(sample);
  if (!roam || roam.kind === "drop") return "";
  return roam.gapMs >= 1000
    ? `${(roam.gapMs / 1000).toFixed(1).replace(/\.0$/, "")} s hole`
    : `${Math.round(roam.gapMs)} ms hole`;
}

function fillCaption(sample, { exploring: isExplore = false } = {}) {
  const serving = sample?.servingId;
  const room = sample?.roomId;
  const inHall = !room || room === "hall";
  const walls = Number(sample?.servingWalls) || 0;
  const sticky = !!(sample?.sticky || (serving && room && !inHall && room !== serving));
  const roam = roamAtTime(sample);
  const rate = Number(els.rate.value);
  const dropped = !!(sample?.disconnected || roam?.kind === "drop" || (!serving && !isExplore));

  let eye = serving ? `Holding ${serving}` : "Floor plan";
  if (isExplore) eye = "You dragged the client";
  else if (dropped && !roam) eye = "Off the radio";
  else if (roam) eye = roamHeadline(roam);
  else if (sample?.moving) eye = serving ? `Walking · ${serving}` : "Walking";

  let head = "Sit, then walk. Teleporting is not a roam.";
  let body = "Change power or min rate on the left. Watch the cells and the device.";

  if (isExplore) {
    const where = inHall ? "the hallway" : room ? `room ${roomName(room)}` : "the floor";
    const rssi = sample?.servingRssi ?? sample?.bestRssi;
    const who = serving || sample?.bestId || "the nearest AP";
    head = `In ${where}, ${who} is ${rssi != null ? formatRssi(rssi) : "what you hear"}.`;
    if (!serving) body = "Nothing eligible here. Raise power or lower the min basic rate.";
    else if (walls >= 2) body = `Two walls (${walls * WALL_DB} dB) on that link.`;
    else if (walls === 1) body = `One wall (${WALL_DB} dB) on that link.`;
    else body = "No wall on the serving link.";
  } else if (dropped) {
    const rssi = sample?.bestRssi;
    head =
      rssi != null
        ? `Off the radio. Best heard is ${sample.bestId || "nobody"} at ${formatRssi(rssi)}.`
        : "Off the radio. Outside every usable cell.";
    body = "Signal too weak to stay associated, and nobody eligible to join. 802.11r will not catch a device that already fell off.";
  } else if (roam && roam.trigger === "btm") {
    head = `${roam.fromId} sent the client to ${roam.toId}.`;
    body =
      roam.kind === "ft"
        ? "802.11v is the AP asking. 802.11r made the actual handoff fast."
        : "802.11v is the AP asking the client to leave. Without 802.11r, that join is still a full auth.";
  } else if (sticky && room && !inHall) {
    const rssi = sample?.servingRssi;
    const best = sample?.bestId;
    const bestRssi = sample?.bestRssi;
    head =
      rssi != null
        ? `Still on ${serving} at ${formatRssi(rssi)} even though you’re in ${roomName(room)}.`
        : `Still on ${serving} even though you’re in ${roomName(room)}.`;
    if (best && best !== serving && bestRssi != null) {
      body = `${best} is ${formatRssi(bestRssi)}. Turn power down or raise min rate to force a leave — 802.11r will not.`;
    } else body = "That’s a sticky client. 802.11r will not fix when it leaves.";
  } else if (walls >= 2) {
    head = `Two walls (${walls * WALL_DB} dB) to the AP across the hall.`;
    body =
      rate >= 24
        ? "Energy is still there. The device cannot hold 24 Mbps through that."
        : "That is why the AP across the hall is not “right there.”";
  } else if (roam) {
    const hole = Math.round(roam.gapMs || 0);
    if (roam.kind === "rejoin" || roam.trigger === "join") {
      head = `Joining ${roam.toId}.`;
      body = hopNote(roam) || `Full reconnect, about ${hole} ms.`;
    } else if (roam.kind === "hard") {
      head = `Hard roam ${roam.fromId} → ${roam.toId}.`;
      body = `Dropped ${roam.fromId}, then a full join. About ${hole} ms.${hole >= 400 ? " Voice would drop." : ""}`;
    } else if (roam.kind === "ft") {
      head = `Leaving ${roam.fromId} for ${roam.toId}.`;
      body = `FT hole about ${hole} ms. Fast roam did not move the roam point.`;
    } else if (roam.fromId && roam.toId) {
      head = `Leaving ${roam.fromId} for ${roam.toId}.`;
      body = `About ${hole} ms.${hole >= 400 ? " Voice would drop." : ""}`;
    } else {
      head = roamHeadline(roam);
      body = hopNote(roam) || "The radio went dark.";
    }
  } else if (sample?.moving) {
    head = `Walking, still on ${serving || "the old AP"}.`;
    body = sticky ? "The device has not decided to leave yet." : "When it leaves, the history on the right is the hole.";
  } else if (room) {
    const len = sim?.path?.lengthFt;
    head = `Sitting in ${inHall ? "the hall" : roomName(room)}, on ${serving || "an AP"}.`;
    body = len
      ? `It’s a ${formatFt(len)} walk, not a teleport.`
      : "Hit play. Walking the hallway is a walk, not a teleport.";
  }

  els.eye.textContent = eye;
  els.head.textContent = head;
  els.body.textContent = body;
  els.gap.textContent = gapText(sample);
  els.caption.classList.toggle("is-sticky", !!(sticky && !isExplore && !dropped));
  els.caption.classList.toggle("is-drop", !!(dropped && !isExplore));
}

function paintCoverage(servingId, kickId) {
  const powerDbm = Number(els.power.value);
  const minRateMbps = Number(els.rate.value);
  const key = `${servingId || ""}|${kickId || ""}|${powerDbm}|${minRateMbps}`;
  if (key === coverKey) return;
  coverKey = key;
  viz.setCoverage(null, { servingId, kickId, powerDbm, minRateMbps });
}

function paintFrame() {
  if (exploring) return;
  const sample = sampleNow();
  if (!sample) return;
  els.scrub.value = String(t);
  viz.setClient({
    x: sample.x,
    y: sample.y,
    servingId: sample.servingId,
    servingWalls: sample.servingWalls,
    moving: !!sample.moving,
    rssiLabel: sample.servingId
      ? `${sample.servingId} ${formatRssi(sample.servingRssi)}`
      : `off ${formatRssi(sample.bestRssi)}`,
  });
  viz.setPath(sim.path.points, sample.s);
  viz.setRoams(sim.roams, activeRoamIndex(sample));
  paintCoverage(sample.servingId, sample.kickId || roamAtTime(sample)?.kickId);
  fillCaption(sample);
  renderTimeline(sample);
  renderHistory(sample);
}

function speedMul() {
  return Number(els.speed.value) || 4;
}

function play() {
  if (!sim) resim();
  exploring = false;
  if (t >= sim.durationSec) t = 0;
  playing = true;
  els.play.textContent = "Pause";
  lastTs = 0;
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(tick);
}

function pausePlayback() {
  playing = false;
  els.play.textContent = "Play";
  cancelAnimationFrame(raf);
  raf = 0;
}

function tick(ts) {
  if (!playing) return;
  if (!lastTs) lastTs = ts;
  const dt = ((ts - lastTs) / 1000) * speedMul();
  lastTs = ts;
  t = Math.min(sim.durationSec, t + dt);
  paintFrame();
  if (t >= sim.durationSec) {
    pausePlayback();
    return;
  }
  raf = requestAnimationFrame(tick);
}

function resetWalk() {
  pausePlayback();
  exploring = false;
  t = 0;
  paintFrame();
}

function exploreAt(evt) {
  const world = viz.worldFromEvent(evt);
  if (!world) return;
  exploring = true;
  pausePlayback();
  const obs = observeAt(world.x, world.y, currentSettings());
  const sample = {
    x: obs.x,
    y: obs.y,
    t,
    moving: false,
    roomId: obs.roomId,
    servingId: obs.servingId,
    servingRssi: obs.servingRssi,
    servingWalls: obs.servingWalls,
    bestId: obs.bestId,
    bestRssi: obs.bestRssi,
    bestWalls: obs.bestWalls,
    sticky: obs.sticky,
  };
  viz.setClient({
    x: sample.x,
    y: sample.y,
    servingId: sample.servingId,
    servingWalls: sample.servingWalls,
    moving: false,
    rssiLabel: sample.servingId
      ? `${sample.servingId} ${formatRssi(sample.servingRssi)}`
      : `off ${formatRssi(sample.bestRssi)}`,
  });
  paintCoverage(sample.servingId, null);
  fillCaption(sample, { exploring: true });
  renderTimeline(sample);
  renderHistory(sample);
}

function onFormInput(evt) {
  const id = evt.target?.id;
  if (id === "cr-scrub") {
    t = Number(els.scrub.value) || 0;
    exploring = false;
    paintFrame();
    return;
  }
  if (id === "cr-speed") return;
  if (id === "cr-power" || id === "cr-dwell") syncReadouts();
  exploring = false;
  pausePlayback();
  resim({ resetT: true });
}

function boot() {
  fillRooms();
  fillStories();
  applyKnobs(DEFAULTS);
  els.speed.value = "4";

  $("cr-form").addEventListener("submit", (e) => e.preventDefault());
  $("cr-form").addEventListener("input", onFormInput);
  $("cr-form").addEventListener("change", onFormInput);
  $("cr-transport").addEventListener("input", onFormInput);
  $("cr-transport").addEventListener("change", onFormInput);

  els.play.addEventListener("click", () => (playing ? pausePlayback() : play()));
  els.reset.addEventListener("click", resetWalk);

  document.addEventListener("click", (e) => {
    const journeyBtn = e.target.closest("[data-journey]");
    if (journeyBtn && $("cr-form").contains(journeyBtn)) {
      applyJourney(journeyBtn.dataset.journey);
      return;
    }
    const storyBtn = e.target.closest("[data-story]");
    if (storyBtn) {
      const story = STORIES.find((s) => s.id === storyBtn.dataset.story);
      if (story) applyStory(story);
    }
  });

  els.stage.addEventListener("pointerdown", (e) => {
    els.stage.setPointerCapture?.(e.pointerId);
    exploreAt(e);
  });
  els.stage.addEventListener("pointermove", (e) => {
    if (!(e.buttons & 1) && e.pointerType !== "touch") return;
    if (!exploring) return;
    exploreAt(e);
  });

  resim({ resetT: true });
}

boot();
