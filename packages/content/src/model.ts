export type Space = "world" | "screen";

export type NodeType =
  | "text"
  | "image"
  | "qr"
  | "htmlFrame"
  | "group"
  | "bullets"
  | "table"
  | "timer"
  | "choices";

export type Anchor =
  | "topLeft"
  | "top"
  | "topCenter"
  | "topRight"
  | "left"
  | "center"
  | "centerLeft"
  | "centerCenter"
  | "centerRight"
  | "right"
  | "bottomLeft"
  | "bottom"
  | "bottomCenter"
  | "bottomRight";

export type Easing = "linear" | "easeInOut" | "easeOut" | "easeIn";

export type AnimSpec =
  | { kind: "none" }
  | { kind: "sudden"; delayMs?: number }
  | {
      kind: "fade";
      durationMs: number;
      easing?: Easing;
      /**
       * - left/right/top/bottom: moving alpha gradient reveals content.
       * - all: uniform opacity over time (no spatial gradient).
       */
      from?: "left" | "right" | "top" | "bottom" | "all";
      /** Soft edge size as a fraction of the element size (e.g. 0.2 = 20%). */
      borderFrac?: number;
      delayMs?: number;
    }
  | { kind: "appear"; durationMs: number; easing?: Easing }
  | { kind: "pixelate"; durationMs: number; easing?: Easing };

export interface Transform2D {
  x: number;
  y: number;
  w: number;
  h: number;
  rotationDeg?: number;
  anchor?: Anchor;
}

export interface BaseNodeModel {
  id: string;
  type: NodeType;
  space: Space;
  /** Optional background fill color (CSS color or hex/rgba tuple). */
  bgColor?: string;
  /** Optional background alpha (0..1) when bg provided without alpha. */
  bgAlpha?: number;
  /** Optional border radius in CSS pixels. */
  borderRadius?: number;
  zIndex?: number;
  transform: Transform2D;
  /** Optional hierarchical parent (used by `group`). If set, transform is interpreted in parent-local coords. */
  parentId?: string;
  visible?: boolean;
  opacity?: number;
  appear?: AnimSpec;
  disappear?: AnimSpec;
}

export interface TextNodeModel extends BaseNodeModel {
  type: "text";
  text: string;
  align?: "left" | "center" | "right";
  vAlign?: "top" | "center" | "bottom";
  /** Font size in world/design pixels (scaled by camera zoom at render time). */
  fontPx?: number;
}

export interface QrNodeModel extends BaseNodeModel {
  type: "qr";
  url: string;
}

export interface ImageNodeModel extends BaseNodeModel {
  type: "image";
  src: string;
}

export interface HtmlFrameNodeModel extends BaseNodeModel {
  type: "htmlFrame";
  src: string;
}

export interface BulletsNodeModel extends BaseNodeModel {
  type: "bullets";
  items: string[];
  bullets?: "a" | "A" | "1" | "I" | "X" | "i" | "." | "-";
}

export interface TableNodeModel extends BaseNodeModel {
  type: "table";
  rows: string[][];
  delimiter?: string;
  /** Column style spec (LaTeX-like), e.g. "||c|c|c||" */
  hstyle?: string;
  /** Row style spec (LaTeX-like), e.g. "b||c|...||" */
  vstyle?: string;
}

export interface TimerNodeModel extends BaseNodeModel {
  type: "timer";
  showTime?: boolean;
  barColor?: string;
  lineColor?: string;
  /** Canvas stroke width in CSS pixels (used for gaussian + ticks). */
  lineWidth?: number;
  stat?: "gaussian";
  /** Histogram bin size in seconds (must divide (maxS-minS)). */
  binSizeS?: number;
  /** Histogram domain min in seconds. */
  minS?: number;
  /** Histogram domain max in seconds. */
  maxS?: number;
  /** Composite folder name under the presentation dir (e.g. "timer"). */
  compositeDir?: string;
}

export interface ChoiceOption {
  id: string;
  label: string;
  color?: string;
}

export interface ChoicesNodeModel extends BaseNodeModel {
  type: "choices";
  question: string;
  /** Options as defined in presentation.txt (order preserved). */
  options: ChoiceOption[];
  /** Rendering style; currently only "pie" is supported. */
  chart?: "pie";
  /**
   * Bullet marker style for the option list:
   * - "a": a, b, c, ...
   * - "A": A, B, C, ...
   * - "1": 1, 2, 3, ...
   * - "I": I, II, III, ...
   */
  bullets?: "a" | "A" | "1" | "I";
}

export interface GroupNodeModel extends BaseNodeModel {
  type: "group";
}

export type NodeModel =
  | TextNodeModel
  | QrNodeModel
  | ImageNodeModel
  | HtmlFrameNodeModel
  | BulletsNodeModel
  | TableNodeModel
  | TimerNodeModel
  | ChoicesNodeModel
  | GroupNodeModel
  | BaseNodeModel;

export interface CameraKeyframe {
  cx: number;
  cy: number;
  zoom: number;
}

export interface ViewModel {
  id: string;
  camera: CameraKeyframe;
  show: string[];
  /** Optional original (string) camera parameters preserved from presentation.txt (e.g. cx=right, zoom=inBottomRight). */
  cameraSpec?: Record<string, string>;
  /** Optional transition duration when navigating to this view (overrides defaults.viewTransitionMs). */
  transitionMs?: number;
}

export type AnimationCue = {
  id: string;
  when: "enter" | "exit";
};

export interface PresentationModel {
  id: string;
  nodes: NodeModel[];
  initialViewId: string;
  views: ViewModel[];
  animationCues?: AnimationCue[];
  defaults?: {
    designWidth: number;
    designHeight: number;
    viewTransitionMs: number;
    pixelateSteps: number;
  };
}


