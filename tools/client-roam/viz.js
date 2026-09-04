/**
 * Rooms, a hallway, and which AP the client is on.
 */
import {
  WING,
  ROOMS,
  APS,
  WALLS,
  RF_FLOOR_DBM,
  cartoonRadiusFt,
  minRssiForRate,
} from "./model.js";

const NS = "http://www.w3.org/2000/svg";
const PAD = 4;
const TITLE = "Rooms and a hallway with an AP in each room.";

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

function apGlyph(ap) {
  return el(
    "g",
    { class: "cr-ap", "data-ap": ap.id, transform: `translate(${ap.x} ${ap.y})`, "pointer-events": "none" },
    el("path", {
      d: "M-2.4-1.55a3.1 3.1 0 0 1 4.8 0",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "0.28",
      "stroke-linecap": "round",
    }),
    el("path", {
      d: "M-1.55-0.88a1.95 1.95 0 0 1 3.1 0",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "0.28",
      "stroke-linecap": "round",
    }),
    el("rect", { x: -1.15, y: -0.38, width: 2.3, height: 1.48, rx: 0.4, fill: "currentColor" }),
    el("circle", { cx: 0.52, cy: 0.18, r: 0.22, fill: "var(--bg-elevated)" }),
  );
}

export function mountViz(container) {
  container.querySelector(":scope > svg.cr-svg")?.remove();

  const api = { svg: null, renderPlan, setCoverage, setClient, setPath, setRoams, worldFromEvent, resize() {} };
  let coverG;
  let markG;
  let pathEl;
  let serveEl;
  let hitEl;
  let clientEl;
  let rssiEl;

  function renderPlan() {
    const { w, h } = WING;
    const hall = WING.hall;
    const vb = `${-PAD} ${-PAD} ${w + PAD * 2} ${h + PAD * 2}`;

    if (!api.svg) {
      api.svg = el("svg", {
        class: "cr-svg",
        role: "img",
        title: TITLE,
        viewBox: vb,
        preserveAspectRatio: "xMidYMid meet",
      });
      container.append(api.svg);
    } else {
      api.svg.setAttribute("viewBox", vb);
      api.svg.replaceChildren();
    }

    const svg = api.svg;
    svg.append(el("title", {}, TITLE));
    svg.append(
      el("defs", {}, el("clipPath", { id: "cr-clip" }, el("rect", { x: 0, y: 0, width: w, height: h }))),
    );

    svg.append(el("rect", { class: "cr-hall", x: hall.x, y: hall.y, width: hall.w, height: hall.h }));
    for (const room of ROOMS) {
      svg.append(
        el("rect", {
          class: "cr-room",
          "data-ap": room.id,
          x: room.x,
          y: room.y,
          width: room.w,
          height: room.h,
          rx: 0.35,
        }),
      );
    }

    coverG = el("g", { id: "cr-cover-g", "pointer-events": "none" });
    svg.append(coverG);

    const wallG = el("g", { "pointer-events": "none" });
    wallG.append(el("rect", { class: "cr-wall", x: 0, y: 0, width: w, height: h, "stroke-width": 1.15 }));
    for (const wall of WALLS) {
      wallG.append(
        el("line", {
          class: "cr-wall",
          x1: wall.x1,
          y1: wall.y1,
          x2: wall.x2,
          y2: wall.y2,
          "stroke-width": "1.05",
          "stroke-linecap": "butt",
        }),
      );
    }
    svg.append(wallG);

    const labels = el("g", { "pointer-events": "none" });
    for (const room of ROOMS) {
      const top = room.side === "A";
      labels.append(
        el(
          "text",
          {
            class: "cr-room-label",
            x: room.cx,
            y: top ? room.y + room.h - 2.4 : room.y + 2.6,
            "text-anchor": "middle",
            "dominant-baseline": "middle",
            "font-size": "3.6",
          },
          room.id,
        ),
      );
    }
    labels.append(
      el(
        "text",
        {
          class: "cr-room-label",
          x: hall.x + hall.w / 2,
          y: hall.y + hall.h / 2,
          "text-anchor": "middle",
          "dominant-baseline": "middle",
          "font-size": "2.3",
        },
        "Hall",
      ),
      el(
        "text",
        {
          class: "cr-dim",
          x: w / 2,
          y: h + 2.5,
          "text-anchor": "middle",
          "dominant-baseline": "middle",
          "font-size": "2",
        },
        `${w} ft`,
      ),
      el(
        "text",
        {
          class: "cr-dim",
          x: -2.4,
          y: h / 2,
          "text-anchor": "middle",
          "dominant-baseline": "middle",
          "font-size": "2",
          transform: `rotate(-90 ${-2.4} ${h / 2})`,
        },
        `${h} ft`,
      ),
    );
    svg.append(labels);

    const apG = el("g", { "pointer-events": "none" });
    for (const ap of APS) {
      apG.append(apGlyph(ap));
    }
    svg.append(apG);

    pathEl = el("path", {
      class: "cr-path",
      d: "",
      fill: "none",
      "stroke-width": "0.42",
      "pointer-events": "none",
    });
    serveEl = el("line", {
      class: "cr-serve",
      x1: 0,
      y1: 0,
      x2: 0,
      y2: 0,
      "stroke-width": "0.5",
      "stroke-linecap": "round",
      "pointer-events": "none",
      visibility: "hidden",
    });
    markG = el("g", { class: "cr-marks", "pointer-events": "none" });
    hitEl = el("circle", {
      class: "cr-client__hit",
      cx: hall.x + 12,
      cy: hall.y + hall.h / 2,
      r: 3,
      fill: "transparent",
      stroke: "none",
    });
    clientEl = el("circle", {
      class: "cr-client",
      cx: hall.x + 12,
      cy: hall.y + hall.h / 2,
      r: 1.4,
      "stroke-width": "0.38",
      "pointer-events": "none",
    });
    rssiEl = el("text", {
      class: "cr-rssi",
      x: hall.x + 12,
      y: hall.y + hall.h / 2 - 2.6,
      "text-anchor": "middle",
      "dominant-baseline": "auto",
      "font-size": "2.1",
      "pointer-events": "none",
    });
    svg.append(pathEl, serveEl, markG, hitEl, clientEl, rssiEl);
  }

  function setCoverage(_grid, opts = {}) {
    if (!coverG) return;
    const rRf = cartoonRadiusFt(opts.powerDbm, RF_FLOOR_DBM);
    const rUse = Math.min(rRf, cartoonRadiusFt(opts.powerDbm, minRssiForRate(opts.minRateMbps)));
    const servingId = opts.servingId;
    coverG.replaceChildren();
    for (const ap of APS) {
      const serving = ap.id === servingId;
      const kick = ap.id === opts.kickId;
      const cls = ["cr-cell", serving ? "cr-cell--serving" : "", kick ? "cr-cell--kick" : ""]
        .filter(Boolean)
        .join(" ");
      const g = el("g", {
        class: cls,
        "data-ap": ap.id,
        transform: `translate(${ap.x} ${ap.y})`,
      });
      g.append(
        el("circle", { class: "cr-cell__rf", r: rRf }),
        el("circle", { class: "cr-cell__mbr", r: rUse }),
        el("circle", { class: "cr-cell__ring", r: rUse * 0.42 }),
        el("circle", { class: "cr-cell__ring", r: rUse * 0.7 }),
      );
      if (serving || kick) g.append(el("circle", { class: "cr-cell__pulse", r: rUse }));
      coverG.append(g);
    }
  }

  function setRoams() {
    /* Roam points live in the history list, not as dots on the floor. */
  }

  function setClient({ x, y, servingId, servingWalls, moving, rssiLabel } = {}) {
    if (!clientEl) return;
    hitEl.setAttribute("cx", x);
    hitEl.setAttribute("cy", y);
    clientEl.setAttribute("cx", x);
    clientEl.setAttribute("cy", y);
    clientEl.setAttribute("data-moving", moving ? "1" : "0");
    clientEl.setAttribute("class", servingId ? "cr-client" : "cr-client cr-client--off");
    rssiEl.textContent = rssiLabel || "";
    rssiEl.setAttribute("x", x);
    rssiEl.setAttribute("y", y - 2.6);
    const ap = APS.find((item) => item.id === servingId);
    if (!ap) {
      serveEl.setAttribute("visibility", "hidden");
      return;
    }
    serveEl.setAttribute("visibility", "visible");
    serveEl.setAttribute("x1", x);
    serveEl.setAttribute("y1", y);
    serveEl.setAttribute("x2", ap.x);
    serveEl.setAttribute("y2", ap.y);
    serveEl.setAttribute("class", servingWalls ? "cr-serve cr-serve--walled" : "cr-serve");
  }

  function setPath(points) {
    if (!pathEl) return;
    const pts = points || [];
    if (!pts.length) {
      pathEl.setAttribute("d", "");
      return;
    }
    pathEl.setAttribute("d", pts.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(""));
  }

  function worldFromEvent(evt) {
    const svg = api.svg;
    if (!svg) return null;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    const p = pt.matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }

  renderPlan();
  return api;
}
