export type Anchor =
  | "topLeft"
  | "topCenter"
  | "topRight"
  | "centerLeft"
  | "centerCenter"
  | "centerRight"
  | "bottomLeft"
  | "bottomCenter"
  | "bottomRight";

export type Space = "world" | "screen";

export type Transform = {
  x: number;
  y: number;
  w: number;
  h: number;
  rotationDeg: number;
  anchor: Anchor;
};

export type View = {
  id: string;
  camera: { cx: number; cy: number; zoom: number };
};

export type TextNode = {
  id: string;
  type: "text";
  space: Space;
  zIndex: number;
  visible: boolean;
  opacity: number;
  transform: Transform;
  text: string;
  color: string;
  fontPx: number;
};

export type Node = TextNode;

export type Model = {
  defaults: {
    designWidth: number;
    designHeight: number;
    grid: { enabled: boolean };
  };
  views: View[];
  initialViewId: string;
  nodes: Node[];
};

export function defaultModel(): Model {
  return {
    defaults: { designWidth: 1920, designHeight: 1080, grid: { enabled: true } },
    views: [{ id: "home", camera: { cx: 0, cy: 0, zoom: 1 } }],
    initialViewId: "home",
    // No default standard elements: the `.pr` payload (or embedded model) is the source of truth.
    nodes: [],
  };
}

