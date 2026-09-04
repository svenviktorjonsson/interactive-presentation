export type RenderRuntime = {
  colorProbe: HTMLElement | null;
  colorCache: Map<string, string>;
  qrCache: Map<string, string>;
  qrPending: Map<string, Promise<string>>;
  videoPosterCache: Map<string, string>;
  videoPosterPending: Map<string, Promise<string | null>>;
  youtubePlayers: Map<string, any>;
  youtubePortals: Map<string, HTMLDivElement>;
  cameraStreams: Map<string, MediaStream>;
  cameraRecorders: Map<string, { rec: MediaRecorder; chunks: BlobPart[] }>;
  cameraErrors: Map<string, string>;
  cameraErrorDetails: Map<string, string>;
  cameraPreviewCooldown: Map<string, number>;
  iframePreviewAttempts: Map<string, number>;
  iframePreviewTimers: Map<string, number>;
  axisState: Map<string, any>;
  activeAxisId: string | null;
  playerLinks: Map<string, any>;
  webcamLinks: Map<string, any>;
  youtubePending: Map<string, Promise<any>>;
  playerBusInstalled: boolean;
  webcamBusInstalled: boolean;
};

export const createRenderRuntime = (): RenderRuntime => ({
  colorProbe: null,
  colorCache: new Map<string, string>(),
  qrCache: new Map<string, string>(),
  qrPending: new Map<string, Promise<string>>(),
  videoPosterCache: new Map<string, string>(),
  videoPosterPending: new Map<string, Promise<string | null>>(),
  youtubePlayers: new Map<string, any>(),
  youtubePortals: new Map<string, HTMLDivElement>(),
  cameraStreams: new Map<string, MediaStream>(),
  cameraRecorders: new Map<string, { rec: MediaRecorder; chunks: BlobPart[] }>(),
  cameraErrors: new Map<string, string>(),
  cameraErrorDetails: new Map<string, string>(),
  cameraPreviewCooldown: new Map<string, number>(),
  iframePreviewAttempts: new Map<string, number>(),
  iframePreviewTimers: new Map<string, number>(),
  axisState: new Map<string, any>(),
  activeAxisId: null,
  playerLinks: new Map<string, any>(),
  webcamLinks: new Map<string, any>(),
  youtubePending: new Map<string, Promise<any>>(),
  playerBusInstalled: false,
  webcamBusInstalled: false,
});

export const sharedRenderRuntime = createRenderRuntime();
