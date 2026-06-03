import type { Anchor, Transform } from "../core/model";

export type HandleId =
  | "n"
  | "s"
  | "e"
  | "w"
  | "ne"
  | "nw"
  | "se"
  | "sw"
  | `anchor:${Anchor}`;

const ANCHORS: Array<{ a: Anchor; fx: number; fy: number }> = [
  { a: "topLeft", fx: 0, fy: 0 },
  { a: "topCenter", fx: 0.5, fy: 0 },
  { a: "topRight", fx: 1, fy: 0 },
  { a: "centerLeft", fx: 0, fy: 0.5 },
  { a: "centerCenter", fx: 0.5, fy: 0.5 },
  { a: "centerRight", fx: 1, fy: 0.5 },
  { a: "bottomLeft", fx: 0, fy: 1 },
  { a: "bottomCenter", fx: 0.5, fy: 1 },
  { a: "bottomRight", fx: 1, fy: 1 },
];

const SELECTION_STROKE_PX = 2;

export function anchorFrac(a: Anchor): { ax: number; ay: number } {
  const hit = ANCHORS.find((x) => x.a === a) ?? ANCHORS[4]!;
  return { ax: hit.fx, ay: hit.fy };
}

export type HandlesView = {
  root: HTMLElement;
  showForRect: (rect: { left: number; top: number; width: number; height: number }, currentAnchor: Anchor) => void;
  showFor: (nodeEl: HTMLElement, t: Transform, currentAnchor: Anchor) => void;
  hide: () => void;
};

export function createHandlesView(overlay: HTMLElement): HandlesView {
  const root = document.createElement("div");
  root.className = "handles";
  root.style.position = "absolute";
  root.style.inset = "0";
  root.style.pointerEvents = "none";
  root.style.zIndex = "999";
  // Attached to the selected node element when active.
  // Keep a detached root initially.
  void overlay;

  const clear = () => root.replaceChildren();

  const mkSelectionBox = () => {
    const d = document.createElement("div");
    d.className = "selection-box";
    d.style.position = "absolute";
    d.style.left = `${-SELECTION_STROKE_PX / 2}px`;
    d.style.top = `${-SELECTION_STROKE_PX / 2}px`;
    d.style.width = `calc(100% + ${SELECTION_STROKE_PX}px)`;
    d.style.height = `calc(100% + ${SELECTION_STROKE_PX}px)`;
    d.style.border = `${SELECTION_STROKE_PX}px solid rgba(110, 168, 255, 0.95)`;
    d.style.boxSizing = "border-box";
    d.style.pointerEvents = "none";
    root.appendChild(d);
    return d;
  };

  const mk = (cls: string, leftPct: number, topPct: number, handleId: HandleId) => {
    const d = document.createElement("div");
    d.className = cls;
    d.dataset.handleId = handleId;
    d.style.position = "absolute";
    d.style.left = `${leftPct}%`;
    d.style.top = `${topPct}%`;
    d.style.transform = "translate(-50%, -50%)";
    d.style.pointerEvents = "auto";
    root.appendChild(d);
    return d;
  };

  const showFor = (nodeEl: HTMLElement, _t: Transform, currentAnchor: Anchor) => {
    const nr = nodeEl.getBoundingClientRect();
    const or = overlay.getBoundingClientRect();
    showForRect(
      {
        left: nr.left - or.left,
        top: nr.top - or.top,
        width: nr.width,
        height: nr.height,
      },
      currentAnchor
    );
  };

  const showForRect = (rect: { left: number; top: number; width: number; height: number }, currentAnchor: Anchor) => {
    clear();
    // Attach to overlay and use axis-aligned bbox so anchor dots are centered on the bbox.
    if (root.parentElement !== overlay) overlay.appendChild(root);
    const snappedLeft = Math.round(rect.left);
    const snappedTop = Math.round(rect.top);
    const snappedRight = Math.round(rect.left + rect.width);
    const snappedBottom = Math.round(rect.top + rect.height);
    root.style.left = `${snappedLeft}px`;
    root.style.top = `${snappedTop}px`;
    root.style.width = `${Math.max(0, snappedRight - snappedLeft)}px`;
    root.style.height = `${Math.max(0, snappedBottom - snappedTop)}px`;
    root.style.transform = "";
    root.style.transformOrigin = "";

    mkSelectionBox();

    // Anchor dots
    for (const a of ANCHORS) {
      const dot = mk("anchor-dot", a.fx * 100, a.fy * 100, `anchor:${a.a}`);
      dot.classList.toggle("is-current", a.a === currentAnchor);
    }
  };

  const hide = () => {
    clear();
    root.remove();
    root.style.left = "0px";
    root.style.top = "0px";
    root.style.width = "0px";
    root.style.height = "0px";
    root.style.transform = "";
  };

  return { root, showForRect, showFor, hide };
}

