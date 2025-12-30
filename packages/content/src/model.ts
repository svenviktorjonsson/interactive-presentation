export type Space = "world" | "screen";

export type NodeType = "text" | "image" | "qr" | "htmlFrame" | "group" | "bullets" | "table" | "timer";

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
  | { kind: "direct"; delayMs?: number }
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
  zIndex?: number;
  transform: Transform2D;
  visible?: boolean;
  opacity?: number;
  appear?: AnimSpec;
  disappear?: AnimSpec;
}

export interface TextNodeModel extends BaseNodeModel {
  type: "text";
  text: string;
  align?: "left" | "center" | "right";
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
}

export interface TableNodeModel extends BaseNodeModel {
  type: "table";
  rows: string[][];
  delimiter?: string;
}

export interface TimerNodeModel extends BaseNodeModel {
  type: "timer";
  showTime?: boolean;
  barColor?: string;
  lineColor?: string;
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

export type NodeModel =
  | TextNodeModel
  | QrNodeModel
  | ImageNodeModel
  | HtmlFrameNodeModel
  | BulletsNodeModel
  | TableNodeModel
  | TimerNodeModel
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


