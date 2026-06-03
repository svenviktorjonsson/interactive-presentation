import type { Node } from "../core/model";
import type { Store } from "../core/store";
import { ensureAxisNodeElement, ensureCameraNodeElement, updateAxisNode, updateCameraNode } from "./axisCameraNodes";
import { ensureButtonsNodeElement, ensureSliderNodeElement, updateButtonsControlNode, updateSliderControlNode } from "./controlNodes";
import { ensureMultichoiceNodeElement, ensureTableNodeElement, ensureWheelNodeElement, updateMultichoiceNode, updateTableNode, updateWheelNode } from "./dataDisplayNodes";
import { ensureHtmlFrameNodeElement, ensureJoinNodeElement, ensureVideoNodeElement, updateHtmlFrameNode, updateJoinNode, updateVideoNode } from "./mediaNodes";

type AxisView = { xMin: number; xMax: number; yMin: number; yMax: number };
type AxisState = { view: AxisView; limits: AxisView | null; clamp: boolean; padPx: number };

export type NodeRenderContext = {
  mode: string;
  timeMs: number;
  store: Store;
  cameraZoom: number;
  screen: { w: number; h: number };
  sizePx: () => { wPx: number; hPx: number };
  applyBox: () => void;
  applyBackground: (el: HTMLElement, bgColor: any, bgAlpha: any, bgPadding: any, bgRadius: any, wPx: number, hPx: number) => void;
  renderKatex: (text: string, cache: string[]) => { html: string; cache: string[] };
  inferPlayerId: (node: any) => string;
  ensurePlayerBus: () => void;
  youtubePlayers: Map<string, any>;
  youtubePortals: Map<string, HTMLDivElement>;
  playerLinks: Map<string, any>;
  webcamLinks: Map<string, any>;
  persistButtons: (payload: any) => Promise<void>;
  getAxisState: (node: Node) => AxisState;
  clampAxisView: (view: AxisView, limits: AxisView | null, clamp: boolean) => AxisView;
  renderAxisNode: (ctx: CanvasRenderingContext2D, el: HTMLElement, node: Node, timeMs: number) => void;
  ensureCameraStream: (nodeId: string, opts: { deviceId?: string }) => Promise<MediaStream>;
  stopCameraStream: (nodeId: string) => void;
  ensureWebcamBus: () => void;
  cameraStreams: Map<string, MediaStream>;
  cameraRecorders: Map<string, { rec: MediaRecorder; chunks: BlobPart[] }>;
  cameraErrors: Map<string, string>;
  cameraErrorDetails: Map<string, string>;
  cameraPreviewCooldown: Map<string, number>;
  logCameraDebug: (msg: string, data?: Record<string, unknown>) => void;
  parseYoutubeId: (src: string) => string | null;
  ensureYoutubePlayer: (nodeId: string, iframeEl: HTMLIFrameElement) => Promise<any>;
  ensureYoutubePortal: (nodeId: string, iframeEl: HTMLIFrameElement) => HTMLDivElement;
  releaseYoutubePortal: (nodeId: string, frame: HTMLElement, iframeEl: HTMLIFrameElement) => void;
  ensureVideoPoster: (src: string, timeSec: number) => Promise<string | null>;
  fitCameraToScreen: (camera: { cx: number; cy: number; zoom: number }, store: Store) => { cx: number; cy: number; zoom: number };
  resolveViewCamera: (store: Store, viewId: string) => { cx: number; cy: number; zoom: number };
  worldToScreenScale: (camera: { cx: number; cy: number; zoom: number }, screen: { w: number; h: number }) => { x: number; y: number };
  qrCache: Map<string, string>;
  qrPending: Map<string, Promise<string>>;
  qrToDataUrl: (url: string) => Promise<string>;
  iframePreviewAttempts: Map<string, number>;
  iframePreviewTimers: Map<string, number>;
  parseTimeToSeconds: (raw: string) => number | null;
};

export type NodeRenderAdapter = {
  type: string;
  ensure: (el: HTMLElement) => void;
  update: (el: HTMLElement, node: Node, ctx: NodeRenderContext) => void;
};

const nodeRenderAdapters: NodeRenderAdapter[] = [
  {
    type: "axis",
    ensure: ensureAxisNodeElement,
    update: (el, node, ctx) =>
      updateAxisNode(el, node, ctx.timeMs, {
        mode: ctx.mode,
        getAxisState: ctx.getAxisState,
        clampAxisView: ctx.clampAxisView,
        renderAxisNode: ctx.renderAxisNode,
        sizePx: ctx.sizePx,
        applyBackground: ctx.applyBackground,
      }),
  },
  {
    type: "camera",
    ensure: ensureCameraNodeElement,
    update: (el, node, ctx) => {
      (window as any).__ipStoreNodes = ctx.store.model.nodes;
      void updateCameraNode(el, node, {
        mode: ctx.mode,
        storeMode: () => ctx.store.mode,
        playerLinks: ctx.playerLinks,
        webcamLinks: ctx.webcamLinks,
        cameraStreams: ctx.cameraStreams,
        cameraRecorders: ctx.cameraRecorders,
        cameraErrors: ctx.cameraErrors,
        cameraErrorDetails: ctx.cameraErrorDetails,
        cameraPreviewCooldown: ctx.cameraPreviewCooldown,
        ensureCameraStream: ctx.ensureCameraStream,
        stopCameraStream: ctx.stopCameraStream,
        ensureWebcamBus: ctx.ensureWebcamBus,
        logCameraDebug: ctx.logCameraDebug,
        sizePx: ctx.sizePx,
        applyBackground: ctx.applyBackground,
      });
    },
  },
  {
    type: "buttons",
    ensure: ensureButtonsNodeElement,
    update: (el, node, ctx) =>
      updateButtonsControlNode(el, node, {
        mode: ctx.mode,
        inferPlayerId: ctx.inferPlayerId,
        ensurePlayerBus: ctx.ensurePlayerBus,
        youtubePlayers: ctx.youtubePlayers,
        playerLinks: ctx.playerLinks,
        webcamLinks: ctx.webcamLinks,
        renderKatex: (text) => ctx.renderKatex(text, []).html,
        persistButtons: ctx.persistButtons,
      }),
  },
  {
    type: "slider",
    ensure: ensureSliderNodeElement,
    update: (el, node, ctx) => updateSliderControlNode(el, node, {
      inferPlayerId: ctx.inferPlayerId,
      ensurePlayerBus: ctx.ensurePlayerBus,
      playerLinks: ctx.playerLinks,
    }),
  },
  {
    type: "table",
    ensure: ensureTableNodeElement,
    update: (el, node, ctx) => updateTableNode(el, node, {
      store: ctx.store,
      cameraZoom: ctx.cameraZoom,
      screen: ctx.screen,
      sizePx: ctx.sizePx,
      applyBox: ctx.applyBox,
      applyBackground: ctx.applyBackground,
      renderKatex: ctx.renderKatex,
    }),
  },
  {
    type: "multichoice",
    ensure: ensureMultichoiceNodeElement,
    update: (el, node, ctx) => updateMultichoiceNode(el, node, {
      sizePx: ctx.sizePx,
      applyBackground: ctx.applyBackground,
    }),
  },
  {
    type: "wheel",
    ensure: ensureWheelNodeElement,
    update: (el, node, ctx) => updateWheelNode(el, node, {
      sizePx: ctx.sizePx,
      applyBackground: ctx.applyBackground,
    }),
  },
  {
    type: "join",
    ensure: ensureJoinNodeElement,
    update: (el, node, ctx) => updateJoinNode(el, node, {
      mode: ctx.mode,
      store: ctx.store,
      sizePx: ctx.sizePx,
      applyBackground: ctx.applyBackground,
      inferPlayerId: ctx.inferPlayerId,
      ensurePlayerBus: ctx.ensurePlayerBus,
      playerLinks: ctx.playerLinks,
      youtubePlayers: ctx.youtubePlayers,
      youtubePortals: ctx.youtubePortals,
      parseYoutubeId: ctx.parseYoutubeId,
      ensureYoutubePlayer: ctx.ensureYoutubePlayer,
      ensureYoutubePortal: ctx.ensureYoutubePortal,
      releaseYoutubePortal: ctx.releaseYoutubePortal,
      ensureVideoPoster: ctx.ensureVideoPoster,
      fitCameraToScreen: ctx.fitCameraToScreen,
      resolveViewCamera: ctx.resolveViewCamera,
      worldToScreenScale: ctx.worldToScreenScale,
      qrCache: ctx.qrCache,
      qrPending: ctx.qrPending,
      qrToDataUrl: ctx.qrToDataUrl,
      iframePreviewAttempts: ctx.iframePreviewAttempts,
      iframePreviewTimers: ctx.iframePreviewTimers,
      parseTimeToSeconds: ctx.parseTimeToSeconds,
    }),
  },
  {
    type: "htmlFrame",
    ensure: ensureHtmlFrameNodeElement,
    update: (el, node, ctx) => updateHtmlFrameNode(el, node, {
      mode: ctx.mode,
      store: ctx.store,
      sizePx: ctx.sizePx,
      applyBackground: ctx.applyBackground,
      inferPlayerId: ctx.inferPlayerId,
      ensurePlayerBus: ctx.ensurePlayerBus,
      playerLinks: ctx.playerLinks,
      youtubePlayers: ctx.youtubePlayers,
      youtubePortals: ctx.youtubePortals,
      parseYoutubeId: ctx.parseYoutubeId,
      ensureYoutubePlayer: ctx.ensureYoutubePlayer,
      ensureYoutubePortal: ctx.ensureYoutubePortal,
      releaseYoutubePortal: ctx.releaseYoutubePortal,
      ensureVideoPoster: ctx.ensureVideoPoster,
      fitCameraToScreen: ctx.fitCameraToScreen,
      resolveViewCamera: ctx.resolveViewCamera,
      worldToScreenScale: ctx.worldToScreenScale,
      qrCache: ctx.qrCache,
      qrPending: ctx.qrPending,
      qrToDataUrl: ctx.qrToDataUrl,
      iframePreviewAttempts: ctx.iframePreviewAttempts,
      iframePreviewTimers: ctx.iframePreviewTimers,
      parseTimeToSeconds: ctx.parseTimeToSeconds,
    }),
  },
  {
    type: "video",
    ensure: ensureVideoNodeElement,
    update: (el, node, ctx) => updateVideoNode(el, node, {
      mode: ctx.mode,
      store: ctx.store,
      sizePx: ctx.sizePx,
      applyBackground: ctx.applyBackground,
      inferPlayerId: ctx.inferPlayerId,
      ensurePlayerBus: ctx.ensurePlayerBus,
      playerLinks: ctx.playerLinks,
      youtubePlayers: ctx.youtubePlayers,
      youtubePortals: ctx.youtubePortals,
      parseYoutubeId: ctx.parseYoutubeId,
      ensureYoutubePlayer: ctx.ensureYoutubePlayer,
      ensureYoutubePortal: ctx.ensureYoutubePortal,
      releaseYoutubePortal: ctx.releaseYoutubePortal,
      ensureVideoPoster: ctx.ensureVideoPoster,
      fitCameraToScreen: ctx.fitCameraToScreen,
      resolveViewCamera: ctx.resolveViewCamera,
      worldToScreenScale: ctx.worldToScreenScale,
      qrCache: ctx.qrCache,
      qrPending: ctx.qrPending,
      qrToDataUrl: ctx.qrToDataUrl,
      iframePreviewAttempts: ctx.iframePreviewAttempts,
      iframePreviewTimers: ctx.iframePreviewTimers,
      parseTimeToSeconds: ctx.parseTimeToSeconds,
    }),
  },
];

export const findNodeRenderAdapter = (type: string): NodeRenderAdapter | undefined =>
  nodeRenderAdapters.find((adapter) => adapter.type === type);

export const listNodeRenderAdapters = () => nodeRenderAdapters.slice();
