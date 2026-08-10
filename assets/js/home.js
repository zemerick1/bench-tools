/**
 * Landing page bootstrap — keep this as an external module so CSP can stay tight
 * without depending on inline script tags for the toolbox grid.
 */
import { renderTools } from "./tools.js";

const root = document.getElementById("tools-root");
if (root) {
  renderTools(root);
}
