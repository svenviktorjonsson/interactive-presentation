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
  refView?: string;
  loc?: string;
  durationMs?: number;
  screenId?: string;
};

export type AnimationSpec = {
  kind: "sudden" | "fade" | "pixelate" | "move";
  durationMs?: number;
  delayMs?: number;
  where?: string;
  borderPx?: number;
  distancePx?: number;
  speedPxS?: number;
};

export type BaseTextNode = {
  id: string;
  space: Space;
  viewId?: string;
  screenId?: string;
  layer?: "base" | "live";
  zIndex: number;
  visible: boolean;
  opacity: number;
  transform: Transform;
  color: string;
  fontPx: number;
  align?: "left" | "center" | "right";
  bgColor?: string;
  bgAlpha?: number;
  appear?: AnimationSpec;
  disappear?: AnimationSpec;
};

export type TextNode = BaseTextNode & {
  type: "text";
  text: string;
};

export type BulletsNode = BaseTextNode & {
  type: "bullets";
  items: Array<{ text: string; indent: number }>;
  bullets?: string;
  rawText?: string;
};

export type ImageNode = {
  id: string;
  type: "image";
  space: Space;
  viewId?: string;
  screenId?: string;
  layer?: "base" | "live";
  zIndex: number;
  visible: boolean;
  opacity: number;
  transform: Transform;
  src?: string;
  bgColor?: string;
  bgAlpha?: number;
  appear?: AnimationSpec;
  disappear?: AnimationSpec;
};

export type ArrowNode = {
  id: string;
  type: "arrow";
  space: Space;
  viewId?: string;
  screenId?: string;
  layer?: "base" | "live";
  zIndex: number;
  visible: boolean;
  opacity: number;
  transform: Transform;
  start: { x: number; y: number };
  end: { x: number; y: number };
  color?: string;
  strokePx?: number;
  bgColor?: string;
  bgAlpha?: number;
  appear?: AnimationSpec;
  disappear?: AnimationSpec;
};

export type JoinNode = {
  id: string;
  type: "join";
  space: Space;
  viewId?: string;
  screenId?: string;
  layer?: "base" | "live";
  zIndex: number;
  visible: boolean;
  opacity: number;
  transform: Transform;
  fields: string[];
  text: string;
  color?: string;
  bgColor?: string;
  bgAlpha?: number;
  appear?: AnimationSpec;
  disappear?: AnimationSpec;
};

export type Node = TextNode | BulletsNode | ImageNode | ArrowNode | JoinNode;

export type Model = {
  defaults: {
    designWidth: number;
    designHeight: number;
    grid: { enabled: boolean };
    publicBaseUrl?: string;
  };
  views: View[];
  initialViewId: string;
  nodes: Node[];
  animationCues?: Array<{
    id: string;
    what: "enter" | "exit";
    when: "same" | "after" | "next";
    viewId?: string;
    screenId?: string;
  }>;
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

