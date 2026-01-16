export function buildShell() {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) throw new Error("#app not found");

  const stage = document.createElement("div");
  stage.className = "stage";

  const canvas = document.createElement("canvas");
  canvas.className = "canvas";

  const overlay = document.createElement("div");
  overlay.className = "overlay";

  stage.append(canvas, overlay);
  app.append(stage);
  return { canvas, overlay, stage };
}

