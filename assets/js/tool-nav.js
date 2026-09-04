/**
 * Collapsible left tools menu for tool pages.
 * Mounts itself. Import from tools/<id>/ as ../../assets/js/tool-nav.js
 */
import { tools } from "./tools.js";

const STORAGE = "bt-tool-nav";
const MQ = "(max-width: 900px)";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function currentToolId() {
  const m = location.pathname.match(/\/tools\/([^/]+)/);
  return m ? m[1] : null;
}

function isMobile() {
  return window.matchMedia(MQ).matches;
}

function storedOpen() {
  try {
    return localStorage.getItem(STORAGE) === "open";
  } catch {
    return false;
  }
}

function storeOpen(open) {
  try {
    localStorage.setItem(STORAGE, open ? "open" : "closed");
  } catch {
    /* private mode */
  }
}

function linksHtml(currentId) {
  const items = tools
    .filter((t) => t.status === "available")
    .map((t) => {
      const here = t.id === currentId;
      const href = `../${encodeURIComponent(t.id)}/`;
      return `<li>
        <a class="tool-nav__link${here ? " tool-nav__link--current" : ""}" href="${href}"${here ? ' aria-current="page"' : ""}>
          <span class="tool-nav__icon" aria-hidden="true">${escapeHtml(t.icon || "·")}</span>
          <span class="tool-nav__title">${escapeHtml(t.title)}</span>
        </a>
      </li>`;
    });
  return items.join("");
}

function setOpen(root, open, { persist = true } = {}) {
  root.classList.toggle("is-open", open);
  const tab = root.querySelector(".tool-nav__tab");
  const backdrop = root.querySelector(".tool-nav__backdrop");
  if (tab) tab.setAttribute("aria-expanded", open ? "true" : "false");
  if (backdrop) backdrop.hidden = !open;
  document.body.classList.toggle("tool-nav-lock", open && isMobile());
  if (persist && !isMobile()) storeOpen(open);
}

export function mountToolNav() {
  if (document.getElementById("tool-nav")) return;

  const currentId = currentToolId();
  const startOpen = !isMobile() && storedOpen();

  const root = document.createElement("div");
  root.id = "tool-nav";
  root.className = "tool-nav";
  root.innerHTML = `
    <button type="button" class="tool-nav__tab" aria-expanded="false" aria-controls="tool-nav-panel">
      <span class="tool-nav__tab-mark" aria-hidden="true"></span>
      <span class="tool-nav__tab-label">Tools</span>
    </button>
    <div class="tool-nav__backdrop" hidden></div>
    <nav class="tool-nav__panel" id="tool-nav-panel" aria-label="Tools">
      <div class="tool-nav__head">
        <a class="tool-nav__home" href="../../">Toolbox</a>
        <button type="button" class="tool-nav__close" aria-label="Close tools menu">Close</button>
      </div>
      <ul class="tool-nav__list">${linksHtml(currentId)}</ul>
    </nav>
  `;
  document.body.prepend(root);

  const tab = root.querySelector(".tool-nav__tab");
  const close = root.querySelector(".tool-nav__close");
  const backdrop = root.querySelector(".tool-nav__backdrop");

  tab.addEventListener("click", () => setOpen(root, !root.classList.contains("is-open")));
  close.addEventListener("click", () => {
    setOpen(root, false);
    tab.focus();
  });
  backdrop.addEventListener("click", () => setOpen(root, false));
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && root.classList.contains("is-open")) {
      setOpen(root, false);
      tab.focus();
    }
  });
  window.matchMedia(MQ).addEventListener("change", () => {
    if (isMobile()) setOpen(root, false, { persist: false });
    else if (storedOpen()) setOpen(root, true, { persist: false });
  });

  setOpen(root, startOpen, { persist: false });
}

mountToolNav();
