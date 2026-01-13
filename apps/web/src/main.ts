import "katex/dist/katex.min.css";
import "./styles.css";

// Expose KaTeX as a global for @cellmax/katex-renderer (it expects `globalThis.katex`).
import katex from "katex";
(globalThis as any).katex = katex;

import { bootstrap } from "./ip/bootstrap";

const hidePreload = () => {
  const el = document.getElementById("ip-preload");
  if (!el) return;
  el.style.opacity = "0";
  el.style.transition = "opacity 180ms ease";
  window.setTimeout(() => el.remove(), 220);
};

void bootstrap().finally(() => {
  hidePreload();
});
