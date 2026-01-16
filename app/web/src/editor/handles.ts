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

export function anchorFrac(a: Anchor): { ax: number; ay: number } {
  const hit = ANCHORS.find((x) => x.a === a) ?? ANCHORS[4]!;
  return { ax: hit.fx, ay: hit.fy };
}

export type HandlesView = {
  root: HTMLElement;
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
    clear();
    // Attach to the node so rotation/anchor behavior matches exactly.
    if (root.parentElement !== nodeEl) nodeEl.appendChild(root);
    root.style.left = "0px";
    root.style.top = "0px";
    root.style.width = "100%";
    root.style.height = "100%";
    root.style.transform = "";
    root.style.transformOrigin = "";

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

  return { root, showFor, hide };
}

