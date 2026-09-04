/**
 * Client Auth — two wires. Device, not a capture.
 */

import { DEFAULTS, STORIES, simulate, hopAt, hopsHappened } from "./model.js?v=8";
import { mountViz } from "./viz.js?v=8";

const TUNNELED = new Set(["peap", "eap-ttls", "teap"]);
const NO_CERT = new Set(["open", "mac", "portal"]);
const REDUCE = window.matchMedia("(prefers-reduced-motion: reduce)");

const WIRE = {
  eap: "EAP",
  radius: "RADIUS",
  https: "HTTPS",
  assoc: "Assoc",
};

const $ = (id) => document.getElementById(id);

const els = {
  form: $("ca-form"),
  stories: $("ca-stories"),
  method: $("ca-method"),
  medium: $("ca-medium"),
  serverCert: $("ca-server-cert"),
  clientCert: $("ca-client-cert"),
  certsWrap: $("ca-certs-wrap"),
  clientWrap: $("ca-client-wrap"),
  ocspWrap: $("ca-ocsp-wrap"),
  innerWrap: $("ca-inner-wrap"),
  inner: $("ca-inner"),
  passwordWrap: $("ca-password-wrap"),
  password: $("ca-password"),
  ocsp: $("ca-ocsp"),
  stage: $("ca-stage"),
  play: $("ca-play"),
  reset: $("ca-reset"),
  scrub: $("ca-scrub"),
  speed: $("ca-speed"),
  transport: $("ca-transport"),
  caption: $("ca-caption"),
  eye: $("ca-cap-eye"),
  head: $("ca-cap-head"),
  body: $("ca-cap-body"),
  timeline: $("ca-timeline"),
  history: $("ca-history"),
};

const viz = mountViz(els.stage);

const IDLE = {
  eye: "Two wires",
  head: "Left wire is EAP. Right wire is RADIUS — the protocol, not the box.",
  body: "The box on the right is the NAC (authentication server). The device does not talk to it. Hit Play.",
};

let run = null;
let t = 0;
let playing = false;
let raf = 0;
let lastTs = 0;

function reducedMotion() {
  return REDUCE.matches;
}

function currentSettings() {
  return {
    ...DEFAULTS,
    method: els.method.value,
    medium: els.medium.value === "switch" ? "switch" : "ap",
    serverCert: els.serverCert.value,
    clientCert: els.clientCert.value,
    inner: els.inner.value,
    passwordOk: els.password.value !== "bad",
    ocsp: els.ocsp.value,
  };
}

function actorName(id) {
  if (id === "authenticator") return els.medium.value === "switch" ? "Switch" : "AP";
  if (id === "device") return "Device";
  if (id === "radius") return "NAC";
  if (id === "portal") return "Portal";
  return id || "";
}

function wireName(id) {
  return WIRE[id] || id || "";
}

function tunneledMethod(method) {
  return TUNNELED.has(method);
}

function syncVisibility() {
  const method = els.method.value;
  const eap = !NO_CERT.has(method);
  const show = tunneledMethod(method);
  if (els.certsWrap) els.certsWrap.hidden = !eap;
  if (els.clientWrap) els.clientWrap.hidden = !eap;
  if (els.ocspWrap) els.ocspWrap.hidden = !eap;
  els.innerWrap.hidden = !show;
  els.passwordWrap.hidden = !show || els.inner.value === "tls";
}

function applyKnobs(src) {
  const s = { ...DEFAULTS, ...src };
  els.method.value = s.method;
  els.medium.value = s.medium === "switch" ? "switch" : "ap";
  els.serverCert.value = s.serverCert;
  els.clientCert.value = s.clientCert;
  els.inner.value = s.inner;
  els.password.value = s.passwordOk === false ? "bad" : "good";
  els.ocsp.value = s.ocsp;
  syncVisibility();
}

function storyMatches(story, cur) {
  const m = { ...DEFAULTS, ...story };
  if (m.method !== cur.method) return false;
  if (m.medium !== cur.medium) return false;
  if (m.serverCert !== cur.serverCert) return false;
  if (m.clientCert !== cur.clientCert) return false;
  if (m.ocsp !== cur.ocsp) return false;
  if (tunneledMethod(m.method)) {
    if (m.inner !== cur.inner) return false;
    if (!!m.passwordOk !== !!cur.passwordOk) return false;
  }
  return true;
}

function markPressed() {
  const cur = currentSettings();
  for (const btn of els.stories.querySelectorAll("[data-story]")) {
    const story = STORIES.find((s) => s.id === btn.dataset.story);
    btn.setAttribute("aria-pressed", story && storyMatches(story, cur) ? "true" : "false");
  }
}

function fillStories() {
  for (const story of STORIES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn--secondary";
    btn.dataset.story = story.id;
    btn.textContent = story.label || story.id;
    els.stories.append(btn);
  }
}

function applyStory(story) {
  applyKnobs({ ...DEFAULTS, ...story });
  resim({ resetT: true });
}

function durationOf() {
  return Number(run?.duration) || 0;
}

function resim({ resetT = false } = {}) {
  const settings = currentSettings();
  run = simulate(settings);
  const dur = durationOf();
  if (resetT) t = 0;
  t = Math.max(0, Math.min(t, dur));
  els.scrub.max = String(dur || 1);
  els.scrub.step = dur > 40 ? "0.1" : "0.05";
  els.scrub.value = String(t);
  markPressed();
  paintFrame();
}

function hopProgress(hop, now) {
  if (!hop) return 1;
  if (reducedMotion() && now >= hop.t) return 1;
  const dur = Number(hop.dur) || 1.45;
  const fly = dur * 0.7;
  if (now <= hop.t) return 0;
  if (now >= hop.t + fly) return 1;
  return (now - hop.t) / fly;
}

function hopInFlight(hop, now) {
  if (!hop) return false;
  const dur = Number(hop.dur) || 0;
  return now >= hop.t && now <= hop.t + Math.max(dur, 0.05);
}

function outcomeNow(happened, now) {
  if (!run) return null;
  if (now >= durationOf()) return run.outcome || null;
  const last = happened[happened.length - 1];
  if (last && (last.kind === "accept" || last.kind === "reject" || last.kind === "success")) {
    return run.outcome || null;
  }
  return null;
}

function fillCaption(hop, outcome) {
  const idle = !playing && t <= 0;
  const cap =
    !idle && hop
      ? hop.caption || { eye: wireName(hop.wire), head: hop.label, body: hop.tip || "" }
      : IDLE;
  els.eye.textContent = cap.eye || IDLE.eye;
  els.head.textContent = cap.head || hop?.label || IDLE.head;
  els.body.textContent = cap.body || hop?.tip || IDLE.body;
  els.caption.classList.toggle("is-reject", outcome === "reject");
  els.caption.classList.toggle("is-accept", outcome === "accept");
}

function addHistory(text, meta, state) {
  const li = document.createElement("li");
  li.className = "ca-history__hop" + (state ? ` is-${state}` : "");
  const what = document.createElement("span");
  what.className = "ca-history__what";
  what.textContent = text;
  li.append(what);
  if (meta) {
    const right = document.createElement("span");
    right.className = "ca-history__meta";
    right.textContent = meta;
    li.append(right);
  }
  els.history.append(li);
}

function renderHistory(happened, hop, now) {
  els.history.replaceChildren();
  if (!happened.length) {
    addHistory("Nothing has happened yet.", "hit Play", "now");
    return;
  }
  for (const item of happened) {
    const state = hopInFlight(item, now) ? "now" : "done";
    const who = `${actorName(item.from)} → ${actorName(item.to)}`;
    const meta = [item.label, who].filter(Boolean).join(" · ");
    addHistory(item.what || item.caption?.head || item.label, meta, state);
  }
  if (hop && hopInFlight(hop, now)) return;
  const last = happened[happened.length - 1];
  if (last && (last.kind === "accept" || last.kind === "reject" || last.kind === "success")) return;
  const outcome = outcomeNow(happened, now);
  if (outcome === "accept") addHistory("The NAC said yes.", "Access-Accept", "now");
  else if (outcome === "reject") addHistory("Access-Reject", "fail closed", "now");
}

function renderTimeline(happened, hop, now) {
  els.timeline.replaceChildren();
  if (!happened.length) {
    const div = document.createElement("div");
    div.className = "ca-frame";
    div.textContent = "Idle · two wires";
    els.timeline.append(div);
    return;
  }
  for (const item of happened) {
    const div = document.createElement("div");
    const current = hopInFlight(item, now) || item === hop;
    div.className = "ca-frame" + (current ? " is-now" : "");
    div.textContent = item.label || wireName(item.wire);
    els.timeline.append(div);
  }
}

function paintFrame() {
  if (!run) return;
  els.scrub.value = String(t);
  const hop = hopAt(run, t);
  const happened = hopsHappened(run, t) || [];
  const idle = !playing && t <= 0;
  const progress = hop && t >= hop.t ? hopProgress(hop, t) : 0;
  let chip = null;
  let pulse = null;
  if (hop && t >= hop.t && !idle) {
    chip = {
      from: hop.from,
      to: hop.to,
      wire: hop.wire,
      label: hop.label,
      kind: hop.kind,
      progress,
      inTunnel: !!hop.inTunnel,
    };
    pulse = hop.kind === "key" ? "handshake" : progress < 0.5 ? hop.from : hop.to;
  } else if (currentSettings().method === "portal") {
    chip = { from: "device", to: "portal", wire: "https", label: "", kind: "portal-https", progress: -1 };
  }
  const outcome = outcomeNow(happened, t);
  viz.setFrame({
    medium: currentSettings().medium,
    certs: run.certs,
    trust: run.trust,
    outcome,
    pulse,
    chip,
    tunnel: !!(hop && (hop.inTunnel || hop.kind === "tunnel")),
  });
  fillCaption(hop, outcome);
  renderTimeline(happened, hop, t);
  renderHistory(happened, hop, t);
}

function speedMul() {
  return Number(els.speed.value) || 1;
}

function play() {
  if (!run) resim();
  if (t >= durationOf()) t = 0;
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
  paintFrame();
}

function tick(ts) {
  if (!playing) return;
  if (!lastTs) lastTs = ts;
  const dt = ((ts - lastTs) / 1000) * speedMul();
  lastTs = ts;
  t = Math.min(durationOf(), t + dt);
  paintFrame();
  if (t >= durationOf()) {
    pausePlayback();
    return;
  }
  raf = requestAnimationFrame(tick);
}

function resetWalk() {
  pausePlayback();
  t = 0;
  paintFrame();
}

function onFormInput(evt) {
  const id = evt.target?.id;
  if (id === "ca-scrub") {
    t = Number(els.scrub.value) || 0;
    paintFrame();
    return;
  }
  if (id === "ca-speed") return;
  pausePlayback();
  syncVisibility();
  resim({ resetT: true });
}

function boot() {
  fillStories();
  applyKnobs(DEFAULTS);
  els.speed.value = "1";
  viz.render?.();

  els.form.addEventListener("submit", (e) => e.preventDefault());
  els.form.addEventListener("input", onFormInput);
  els.form.addEventListener("change", onFormInput);
  els.transport.addEventListener("input", onFormInput);
  els.transport.addEventListener("change", onFormInput);

  els.play.addEventListener("click", () => (playing ? pausePlayback() : play()));
  els.reset.addEventListener("click", resetWalk);

  els.stories.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-story]");
    if (!btn) return;
    const story = STORIES.find((s) => s.id === btn.dataset.story);
    if (story) applyStory(story);
  });

  resim({ resetT: true });
}

boot();
