type ErrorPayload = {
  kind: "error" | "rejection";
  message: string;
  stack?: string;
};

function ensureOverlay(): HTMLElement {
  let el = document.getElementById("ip-dev-errors");
  if (el) return el;
  el = document.createElement("div");
  el.id = "ip-dev-errors";
  el.style.position = "fixed";
  el.style.left = "12px";
  el.style.right = "12px";
  el.style.bottom = "12px";
  el.style.maxHeight = "45vh";
  el.style.overflow = "auto";
  el.style.padding = "12px 12px";
  el.style.borderRadius = "12px";
  el.style.border = "1px solid rgba(255,255,255,0.18)";
  el.style.background = "rgba(18, 10, 16, 0.92)";
  el.style.backdropFilter = "blur(8px)";
  el.style.color = "rgba(255,255,255,0.92)";
  el.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace";
  el.style.fontSize = "12px";
  el.style.zIndex = "2147483647";
  el.style.display = "none";
  document.body.appendChild(el);
  return el;
}

function render(p: ErrorPayload) {
  const box = ensureOverlay();
  box.style.display = "block";
  const pre = document.createElement("pre");
  pre.style.margin = "0 0 10px 0";
  pre.style.whiteSpace = "pre-wrap";
  pre.style.wordBreak = "break-word";
  pre.textContent = `[${p.kind}] ${p.message}\n${p.stack ?? ""}`.trim();
  box.appendChild(pre);
}

export function installGlobalErrorHandlers() {
  window.addEventListener("error", (ev) => {
    const e = (ev as ErrorEvent).error as any;
    render({
      kind: "error",
      message: String((ev as ErrorEvent).message ?? e?.message ?? "Unknown error"),
      stack: typeof e?.stack === "string" ? e.stack : undefined,
    });
  });

  window.addEventListener("unhandledrejection", (ev) => {
    const r: any = (ev as PromiseRejectionEvent).reason;
    render({
      kind: "rejection",
      message: String(r?.message ?? r ?? "Unhandled rejection"),
      stack: typeof r?.stack === "string" ? r.stack : undefined,
    });
  });
}

