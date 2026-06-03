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
  viewIds?: string[];
  screenId?: string;
  screenIds?: string[];
  groupId?: string;
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
  bgPadding?: number;
  bgRadius?: number;
  appear?: AnimationSpec;
  disappear?: AnimationSpec;
};

export type TextNode = BaseTextNode & {
  type: "text";
  text: string;
  template?: string;
};

export type BulletsNode = BaseTextNode & {
  type: "bullets";
  items: Array<{ text: string; indent: number }>;
  bullets?: string;
  rawText?: string;
  template?: string;
};

export type ImageNode = {
  id: string;
  type: "image";
  space: Space;
  viewId?: string;
  screenId?: string;
  groupId?: string;
  layer?: "base" | "live";
  zIndex: number;
  visible: boolean;
  opacity: number;
  transform: Transform;
  src?: string;
  bgColor?: string;
  bgAlpha?: number;
  bgPadding?: number;
  bgRadius?: number;
  appear?: AnimationSpec;
  disappear?: AnimationSpec;
};

export type HtmlFrameNode = {
  id: string;
  type: "htmlFrame";
  space: Space;
  viewId?: string;
  screenId?: string;
  groupId?: string;
  layer?: "base" | "live";
  zIndex: number;
  visible: boolean;
  opacity: number;
  transform: Transform;
  src?: string;
  bgColor?: string;
  bgAlpha?: number;
  bgPadding?: number;
  bgRadius?: number;
  appear?: AnimationSpec;
  disappear?: AnimationSpec;
};

export type ArrowNode = {
  id: string;
  type: "arrow";
  space: Space;
  viewId?: string;
  screenId?: string;
  groupId?: string;
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
  bgPadding?: number;
  bgRadius?: number;
  appear?: AnimationSpec;
  disappear?: AnimationSpec;
};

export type MultiChoiceNode = {
  id: string;
  type: "multichoice";
  space: Space;
  viewId?: string;
  screenId?: string;
  groupId?: string;
  layer?: "base" | "live";
  zIndex: number;
  visible: boolean;
  opacity: number;
  transform: Transform;
  answers: Array<{ name: string; color?: string }>;
  choiceType?: string;
  question?: string;
  otherLabel?: string;
  otherLimit?: number;
  counts?: number[];
  showList?: boolean;
  showQuestion?: boolean;
  multichoiceId?: string;
  multichoiceRole?: string;
  bgColor?: string;
  bgAlpha?: number;
  bgPadding?: number;
  bgRadius?: number;
  appear?: AnimationSpec;
  disappear?: AnimationSpec;
};

export type WheelNode = {
  id: string;
  type: "wheel";
  space: Space;
  viewId?: string;
  screenId?: string;
  groupId?: string;
  layer?: "base" | "live";
  zIndex: number;
  visible: boolean;
  opacity: number;
  transform: Transform;
  answers: Array<{ name: string; color?: string }>;
  choiceType?: string;
  question?: string;
  otherLabel?: string;
  otherLimit?: number;
  counts?: number[];
  showList?: boolean;
  showQuestion?: boolean;
  multichoiceId?: string;
  multichoiceRole?: string;
  bgColor?: string;
  bgAlpha?: number;
  bgPadding?: number;
  bgRadius?: number;
  appear?: AnimationSpec;
  disappear?: AnimationSpec;
};

export type JoinNode = {
  id: string;
  type: "join";
  space: Space;
  viewId?: string;
  screenId?: string;
  groupId?: string;
  layer?: "base" | "live";
  zIndex: number;
  visible: boolean;
  opacity: number;
  transform: Transform;
  fields: string[];
  text: string;
  template?: string;
  color?: string;
  bgColor?: string;
  bgAlpha?: number;
  bgPadding?: number;
  bgRadius?: number;
  appear?: AnimationSpec;
  disappear?: AnimationSpec;
};

export type GroupNode = {
  id: string;
  type: "group";
  space: Space;
  viewId?: string;
  screenId?: string;
  groupId?: string;
  layer?: "base" | "live";
  zIndex: number;
  visible: boolean;
  opacity: number;
  transform: Transform;
};

export type VideoNode = {
  id: string;
  type: "video";
  space: Space;
  viewId?: string;
  screenId?: string;
  groupId?: string;
  playerId?: string;
  layer?: "base" | "live";
  zIndex: number;
  visible: boolean;
  opacity: number;
  transform: Transform;
  src: string;
  thumbnail?: string;
  poster?: string;
  showControls?: boolean;
  bgColor?: string;
  bgAlpha?: number;
  bgPadding?: number;
  bgRadius?: number;
  appear?: AnimationSpec;
  disappear?: AnimationSpec;
};

export type CameraNode = {
  id: string;
  type: "camera";
  space: Space;
  viewId?: string;
  screenId?: string;
  groupId?: string;
  webcamId?: string;
  layer?: "base" | "live";
  zIndex: number;
  visible: boolean;
  opacity: number;
  transform: Transform;
  deviceId?: string;
  bgColor?: string;
  bgAlpha?: number;
  bgPadding?: number;
  bgRadius?: number;
  appear?: AnimationSpec;
  disappear?: AnimationSpec;
};

export type ButtonsNode = {
  id: string;
  type: "buttons";
  space: Space;
  viewId?: string;
  screenId?: string;
  groupId?: string;
  playerId?: string;
  layer?: "base" | "live";
  zIndex: number;
  visible: boolean;
  opacity: number;
  transform: Transform;
  labels?: string[];
  templates?: string[];
  actions?: string[];
  buttonsMode?: "keep" | "click" | "radio";
  buttonsState?: boolean[];
  hSplits?: number[];
  vSplits?: number[];
  rows?: number;
  cols?: number;
  appear?: AnimationSpec;
  disappear?: AnimationSpec;
};

export type SliderNode = {
  id: string;
  type: "slider";
  space: Space;
  viewId?: string;
  screenId?: string;
  groupId?: string;
  playerId?: string;
  layer?: "base" | "live";
  zIndex: number;
  visible: boolean;
  opacity: number;
  transform: Transform;
  min?: number;
  max?: number;
  step?: number;
  value?: number;
  values?: number[];
  appear?: AnimationSpec;
  disappear?: AnimationSpec;
};

export type AxisNode = {
  id: string;
  type: "axis";
  space: Space;
  viewId?: string;
  screenId?: string;
  groupId?: string;
  layer?: "base" | "live";
  zIndex: number;
  visible: boolean;
  opacity: number;
  transform: Transform;
  limits?: { xMin?: number; xMax?: number; yMin?: number; yMax?: number };
  clamp?: boolean;
  padPx?: number;
  maxPoints?: number;
  bins?: number[];
  appear?: AnimationSpec;
  disappear?: AnimationSpec;
};

export type TableNode = {
  id: string;
  type: "table";
  space: Space;
  viewId?: string;
  screenId?: string;
  groupId?: string;
  layer?: "base" | "live";
  zIndex: number;
  visible: boolean;
  opacity: number;
  transform: Transform;
  rows?: number;
  cols?: number;
  cells?: string[][];
  editable?: boolean;
  hHeader?: string[];
  vHeader?: string[];
  hStyle?: Array<"left" | "center" | "right">;
  color?: string;
  bgColor?: string;
  bgAlpha?: number;
  bgPadding?: number;
  bgRadius?: number;
  appear?: AnimationSpec;
  disappear?: AnimationSpec;
};

export type Node =
  | TextNode
  | BulletsNode
  | ImageNode
  | HtmlFrameNode
  | ArrowNode
  | MultiChoiceNode
  | WheelNode
  | ButtonsNode
  | SliderNode
  | JoinNode
  | GroupNode
  | VideoNode
  | CameraNode
  | AxisNode
  | TableNode;

export type Model = {
  defaults: {
    designWidth: number;
    designHeight: number;
    grid: { enabled: boolean };
    publicBaseUrl?: string;
    screenSpace?: "normalized";
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
    views: [{ id: "home", camera: { cx: 0.5, cy: 0.5, zoom: 1 } }],
    initialViewId: "home",
    // No default standard elements: the `.pr` payload (or embedded model) is the source of truth.
    nodes: [],
  };
}

