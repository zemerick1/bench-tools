/**
 * Device, AP or switch, and NAC. RADIUS is the right-hand protocol.
 */

const NS = "http://www.w3.org/2000/svg";
const TITLE = "Device, AP or switch, and NAC. RADIUS is the protocol on the right wire.";

const POS = {
  device: { x: 32, y: 22 },
  authenticator: { x: 120, y: 22 },
  radius: { x: 208, y: 22 },
  portal: { x: 120, y: 82 },
};
const CARD = { w: 36, h: 24 };
const PORTAL_CARD = { w: 26, h: 14 };

const EAP = [
  { x: POS.device.x + CARD.w / 2, y: POS.device.y },
  { x: POS.authenticator.x - CARD.w / 2, y: POS.authenticator.y },
];
const PATHS = {
  eap: EAP,
  assoc: EAP,
  radius: [
    { x: POS.authenticator.x + CARD.w / 2, y: POS.authenticator.y },
    { x: POS.radius.x - CARD.w / 2, y: POS.radius.y },
  ],
  https: [
    { x: POS.device.x, y: POS.device.y + CARD.h / 2 },
    { x: POS.device.x, y: POS.portal.y },
    { x: POS.portal.x - PORTAL_CARD.w / 2, y: POS.portal.y },
  ],
};
const ENDS = {
  eap: ["device", "authenticator"],
  assoc: ["device", "authenticator"],
  radius: ["authenticator", "radius"],
  https: ["device", "portal"],
};

function el(tag, attrs = {}, ...kids) {
  const node = document.createElementNS(NS, tag);
  for (const [key, val] of Object.entries(attrs)) {
    if (val == null || val === false) continue;
    node.setAttribute(key, String(val));
  }
  for (const kid of kids) {
    if (kid != null) node.append(typeof kid === "string" ? document.createTextNode(kid) : kid);
  }
  return node;
}

function txt(cls, x, y, size, content, extra = {}) {
  return el("text", {
    class: cls, x, y, "font-size": size, visibility: extra.visibility, fill: extra.fill || "currentColor",
    "text-anchor": extra.anchor || "middle", "dominant-baseline": extra.base || "middle",
    "text-rendering": "geometricPrecision",
  }, content);
}

function dOf(pts) {
  return pts.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(" ");
}

function along(pts, t) {
  const u = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  if (!pts.length) return { x: 0, y: 0 };
  let total = 0;
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const len = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    segs.push({ a: pts[i], b: pts[i + 1], len });
    total += len;
  }
  let dist = (total || 1) * u;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (dist <= s.len || i === segs.length - 1) {
      const p = s.len ? dist / s.len : 0;
      return { x: s.a.x + (s.b.x - s.a.x) * p, y: s.a.y + (s.b.y - s.a.y) * p };
    }
    dist -= s.len;
  }
  return { x: pts[0].x, y: pts[0].y };
}

function strokeArc(d) {
  return el("path", { d, fill: "none", stroke: "currentColor", "stroke-width": "0.28", "stroke-linecap": "round" });
}

function apGlyph() {
  return el(
    "g",
    { class: "ca-ap" },
    strokeArc("M-2.4-1.55a3.1 3.1 0 0 1 4.8 0"),
    strokeArc("M-1.55-0.88a1.95 1.95 0 0 1 3.1 0"),
    el("rect", { x: -1.15, y: -0.38, width: 2.3, height: 1.48, rx: 0.4, fill: "currentColor" }),
    el("circle", { cx: 0.52, cy: 0.18, r: 0.22, fill: "var(--bg-elevated)" }),
  );
}

function switchGlyph() {
  const hole = (x, w = 1.05) =>
    el("rect", { x, y: -0.45, width: w, height: 1.05, rx: 0.12, fill: "var(--bg-elevated)" });
  return el(
    "g",
    { class: "ca-switch" },
    el("rect", { x: -3.3, y: -1.15, width: 6.6, height: 2.5, rx: 0.35, fill: "currentColor" }),
    hole(-2.45),
    hole(-0.85),
    hole(0.75),
    hole(2.35, 0.55),
  );
}

function deviceGlyph() {
  return el(
    "g",
    { class: "ca-device" },
    el("rect", { x: -2.7, y: -2.15, width: 5.4, height: 3.7, rx: 0.45, fill: "none", stroke: "currentColor", "stroke-width": "0.35" }),
    el("rect", { x: -2.15, y: -1.55, width: 4.3, height: 2.4, rx: 0.2, fill: "currentColor", opacity: "0.2" }),
    el("rect", { x: -1.5, y: 1.7, width: 3, height: 0.45, rx: 0.12, fill: "currentColor" }),
  );
}

function radiusGlyph() {
  return el(
    "g",
    { class: "ca-radius" },
    el("rect", { x: -2.45, y: -2.25, width: 4.9, height: 4.7, rx: 0.4, fill: "none", stroke: "currentColor", "stroke-width": "0.35" }),
    el("line", { x1: -2.45, y1: -0.55, x2: 2.45, y2: -0.55, stroke: "currentColor", "stroke-width": "0.28" }),
    el("line", { x1: -2.45, y1: 1.05, x2: 2.45, y2: 1.05, stroke: "currentColor", "stroke-width": "0.28" }),
    el("circle", { cx: -1.4, cy: -1.4, r: 0.28, fill: "currentColor" }),
    el("circle", { cx: -1.4, cy: 0.25, r: 0.28, fill: "currentColor" }),
  );
}

function portalGlyph() {
  return el(
    "g",
    { class: "ca-portal-glyph" },
    el("rect", { x: -2.5, y: -1.85, width: 5, height: 3.7, rx: 0.4, fill: "none", stroke: "currentColor", "stroke-width": "0.32" }),
    el("rect", { x: -2.5, y: -1.85, width: 5, height: 1.05, rx: 0.4, fill: "currentColor", opacity: "0.2" }),
    el("circle", { cx: -1.55, cy: -1.32, r: 0.2, fill: "currentColor" }),
  );
}

function actorGroup(id, x, y, label, glyph, card = CARD) {
  return el("g", { class: `ca-actor ca-actor--${id}`, "data-actor": id, transform: `translate(${x} ${y})` },
    el("circle", { class: "ca-actor__pulse", r: Math.max(card.w, card.h) * 0.62, fill: "none" }),
    el("rect", { class: "ca-actor__card", x: -card.w / 2, y: -card.h / 2, width: card.w, height: card.h, rx: 2.2, fill: "var(--bg-elevated)", stroke: "currentColor", "stroke-width": "0.55" }),
    el("g", { class: "ca-actor__glyph", transform: "translate(0 -2.1) scale(2.55)" }, glyph),
    txt("ca-actor__label", 0, card.h / 2 - 2.6, "3.1", label),
  );
}

function lampGroup(id, x, y, caption) {
  return el("g", { class: "ca-lamp ca-lamp--na", "data-lamp": id, transform: `translate(${x} ${y})` },
    el("circle", { class: "ca-lamp__dot", r: 1.15, fill: "currentColor" }),
    txt("ca-lamp__state", 2.1, 0.15, "1.7", "n/a", { anchor: "start" }),
    txt("ca-lamp__label", 2.1, 2.4, "1.55", caption, { anchor: "start" }),
  );
}

function wirePath(mod, pts, sw = "0.95") {
  return el("path", { class: `ca-wire ca-wire--${mod}`, d: dOf(pts), fill: "none", stroke: "currentColor", "stroke-width": sw, "stroke-linecap": "round", "pointer-events": "none" });
}

function dropActor(frame) {
  if (frame.outcome !== "reject") return null;
  if (frame.trust?.deviceTrustsServer === false) return "device";
  return "radius";
}

function portalChip(c) {
  return !!(c && (c.wire === "https" || c.from === "portal" || c.to === "portal"));
}

function chipAlong(chip) {
  if (!chip || (chip.from === "device" && chip.to === "radius") || (chip.from === "radius" && chip.to === "device")) return null;
  const ends = ENDS[chip.wire];
  const pts = PATHS[chip.wire];
  if (!ends || !pts) return null;
  const t = Number(chip.progress);
  if (chip.from === ends[0] && chip.to === ends[1]) return along(pts, t);
  if (chip.from === ends[1] && chip.to === ends[0]) return along(pts, 1 - t);
  return null;
}

export function mountViz(container) {
  container.querySelector(":scope > svg.ca-svg")?.remove();

  let svg = null;
  let n = {};
  let medium = "";
  let stickyPortal = false;
  let frame = {
    medium: "ap",
    certs: { server: null, client: null },
    trust: { deviceTrustsServer: null, serverTrustsDevice: null },
    outcome: null,
    pulse: null,
    chip: null,
    tunnel: false,
  };

  function render() {
    if (!svg) {
      svg = el("svg", { class: "ca-svg", role: "img", title: TITLE, viewBox: "0 0 240 96", preserveAspectRatio: "xMidYMid meet" });
      container.append(svg);
    } else svg.replaceChildren();

    const httpsPath = wirePath("https", PATHS.https, "0.5");
    httpsPath.setAttribute("visibility", "hidden");
    const httpsLab = txt("ca-wire__label ca-wire__label--https", 68, POS.portal.y - 3.4, "2.3", "HTTPS", {
      visibility: "hidden",
    });
    const device = actorGroup("device", POS.device.x, POS.device.y, "Device", deviceGlyph());
    const authenticator = actorGroup("authenticator", POS.authenticator.x, POS.authenticator.y, "AP", apGlyph());
    const radius = actorGroup("radius", POS.radius.x, POS.radius.y, "NAC", radiusGlyph());
    const portal = actorGroup("portal", POS.portal.x, POS.portal.y, "Portal", portalGlyph(), PORTAL_CARD);
    portal.setAttribute("visibility", "hidden");
    const gap = el("g", { class: "ca-gap", "pointer-events": "none" },
      txt("ca-gap__label", 120, 48, "2.4", "no hop"),
      txt("ca-gap__hint", 120, 51.4, "2", "device never talks to the NAC"),
    );
    const x0 = POS.device.x - CARD.w / 2 - 5;
    const x1 = POS.radius.x + CARD.w / 2 + 5;
    const th = 18;
    const tunnel = el("g", { class: "ca-tunnel", visibility: "hidden", "pointer-events": "none" },
      el("rect", {
        class: "ca-tunnel__body",
        x: x0,
        y: POS.device.y - th / 2,
        width: x1 - x0,
        height: th,
        rx: th / 2,
      }),
      txt("ca-tunnel__label", (x0 + x1) / 2, POS.device.y - th / 2 - 2.4, "2.4", "TLS tunnel"),
    );
    const clientCert = el("g", { class: "ca-cert ca-cert--client", "data-cert": "client", transform: `translate(${POS.device.x} 56)`, visibility: "hidden" });
    const serverCert = el("g", { class: "ca-cert ca-cert--server", "data-cert": "server", transform: `translate(${POS.radius.x} 56)`, visibility: "hidden" });
    let chipDom = container.querySelector(":scope > .ca-chip-dom");
    if (!chipDom) {
      chipDom = document.createElement("div");
      chipDom.className = "ca-chip-dom";
      chipDom.hidden = true;
      chipDom.setAttribute("aria-hidden", "true");
      container.append(chipDom);
    }

    svg.append(
      el("title", {}, TITLE),
      el("g", { class: "ca-wires", "pointer-events": "none" },
        wirePath("eap", PATHS.eap), wirePath("radius", PATHS.radius), httpsPath,
        txt("ca-wire__label ca-wire__label--eap", (EAP[0].x + EAP[1].x) / 2, POS.device.y - 5.1, "2.6", "EAP"),
        txt("ca-wire__label ca-wire__label--radius", (PATHS.radius[0].x + PATHS.radius[1].x) / 2, POS.radius.y - 5.1, "2.6", "RADIUS"),
        httpsLab,
      ),
      gap,
      tunnel,
      el("g", { class: "ca-actors" }, device, authenticator, radius, portal),
      el("g", { class: "ca-certs", "pointer-events": "none" }, clientCert, serverCert),
      el("g", { class: "ca-lamps", "pointer-events": "none" },
        lampGroup("deviceTrustsServer", POS.device.x - 14, 36.5, "trusts server"),
        lampGroup("serverTrustsDevice", POS.radius.x - 14, 36.5, "trusts device"),
      ),
    );

    n = {
      device,
      authenticator,
      radius,
      portal,
      authGlyph: authenticator.querySelector(".ca-actor__glyph"),
      authLabel: authenticator.querySelector(".ca-actor__label"),
      httpsPath,
      httpsLab,
      gap,
      tunnel,
      clientCert,
      serverCert,
      lampServer: svg.querySelector('[data-lamp="deviceTrustsServer"]'),
      lampDevice: svg.querySelector('[data-lamp="serverTrustsDevice"]'),
      chipDom,
    };
    medium = "";
    stickyPortal = false;
    paint();
  }

  function paintCert(group, cert, kind) {
    group.replaceChildren();
    if (!cert) {
      group.setAttribute("visibility", "hidden");
      return;
    }
    const ok = cert.ok !== false;
    const ocsp = String(cert.ocsp || "skip");
    const slug = ocsp.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "skip";
    const pill = /ocsp/i.test(ocsp) ? ocsp : `OCSP ${ocsp}`;
    const pillW = Math.max(11, pill.length * 1.12 + 2.4);
    group.setAttribute("class", `ca-cert ca-cert--${kind}${ok ? " ca-cert--ok" : " ca-cert--bad"}`);
    group.setAttribute("visibility", "visible");
    const pillW2 = Math.max(14, pill.length * 1.45 + 4);
    group.append(
      el("rect", { class: "ca-cert__card", x: -17, y: -11, width: 34, height: 22, rx: 2, fill: "var(--bg-elevated)", stroke: "currentColor", "stroke-width": "0.55" }),
      txt("ca-cert__kind", 0, -7.2, "2.3", kind === "client" ? "client cert" : "server cert"),
      txt("ca-cert__signer", 0, -3.1, "3.1", cert.signer || ""),
      txt("ca-cert__expiry", 0, 1.2, "2.5", cert.expiry || ""),
      el("g", { class: `ca-pill ca-pill--${slug}`, transform: "translate(0 6.6)" },
        el("rect", { class: "ca-pill__body", x: -pillW2 / 2, y: -2.3, width: pillW2, height: 4.6, rx: 2.3, fill: "var(--bg-muted)", stroke: "currentColor", "stroke-width": "0.3" }),
        txt("ca-pill__label", 0, 0.2, "2.1", pill),
      ),
    );
  }

  function paintLamp(group, value) {
    const state = value === true ? "yes" : value === false ? "no" : "na";
    group.setAttribute("class", `ca-lamp ca-lamp--${state}`);
    group.querySelector(".ca-lamp__state").textContent = state === "na" ? "n/a" : state;
  }

  function paintChip(chip) {
    const dom = n.chipDom;
    if (!dom) return;
    if (!chip || Number(chip.progress) < 0) {
      dom.hidden = true;
      return;
    }
    const pt = chipAlong(chip);
    if (!pt || !svg) {
      dom.hidden = true;
      return;
    }
    const ctm = svg.getScreenCTM();
    const box = container.getBoundingClientRect();
    if (!ctm) {
      dom.hidden = true;
      return;
    }
    const p = svg.createSVGPoint();
    p.x = pt.x;
    p.y = pt.y;
    const screen = p.matrixTransform(ctm);
    const left = Math.round(screen.x - box.left);
    const top = Math.round(screen.y - box.top);
    const wire = chip.wire || "eap";
    dom.hidden = false;
    dom.className = `ca-chip-dom ca-chip-dom--${wire}${chip.inTunnel ? " ca-chip-dom--tunnel" : ""}`;
    dom.textContent = chip.label || "";
    const dx = Math.round(dom.offsetWidth / 2);
    const dy = Math.round(dom.offsetHeight / 2);
    dom.style.left = `${left - dx}px`;
    dom.style.top = `${top - dy}px`;
  }

  function paint() {
    if (!n.device) return;
    const c = frame.chip;
    if (portalChip(c)) stickyPortal = true;
    else if (c && (c.wire === "eap" || c.wire === "assoc")) stickyPortal = false;
    else if (!c) stickyPortal = false;
    const portalOn = stickyPortal || frame.pulse === "portal";
    const drop = dropActor(frame);
    const nextMed = frame.medium === "switch" ? "switch" : "ap";
    if (nextMed !== medium) {
      medium = nextMed;
      n.authLabel.textContent = medium === "switch" ? "Switch" : "AP";
      n.authenticator.setAttribute("data-medium", medium);
      n.authGlyph.replaceChildren(medium === "switch" ? switchGlyph() : apGlyph());
    }
    const handshake = frame.pulse === "handshake";
    for (const id of ["device", "authenticator", "radius", "portal"]) {
      const pulsing = frame.pulse === id || (handshake && (id === "device" || id === "authenticator"));
      const cls = ["ca-actor", `ca-actor--${id}`];
      if (pulsing) cls.push("ca-actor--pulse");
      if (drop === id) cls.push("ca-actor--drop");
      n[id].setAttribute("class", cls.join(" "));
      n[id].querySelector(".ca-actor__pulse").setAttribute("class", pulsing ? "ca-actor__pulse ca-pulse" : "ca-actor__pulse");
    }
    const vis = (node, on) => node.setAttribute("visibility", on ? "visible" : "hidden");
    vis(n.portal, portalOn);
    vis(n.httpsPath, portalOn);
    vis(n.httpsLab, portalOn);
    vis(n.tunnel, !!frame.tunnel);
    vis(n.gap, !portalOn && !frame.tunnel);
    const certs = frame.certs || {};
    paintCert(n.clientCert, certs.client || null, "client");
    paintCert(n.serverCert, certs.server || null, "server");
    const trust = frame.trust || {};
    paintLamp(n.lampServer, trust.deviceTrustsServer);
    paintLamp(n.lampDevice, trust.serverTrustsDevice);
    paintChip(frame.chip);
  }

  function setFrame(next = {}) {
    frame = {
      medium: next.medium === "switch" ? "switch" : "ap",
      certs: next.certs || { server: null, client: null },
      trust: next.trust || { deviceTrustsServer: null, serverTrustsDevice: null },
      outcome: next.outcome ?? null, pulse: next.pulse ?? null, chip: next.chip ?? null,
      tunnel: !!next.tunnel,
    };
    if (!svg) render();
    else paint();
  }

  render();
  return { render, setFrame };
}
