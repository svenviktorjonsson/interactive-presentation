type CursorKind = "resize" | "rotate";

function svgCursor(svg: string, hotX: number, hotY: number, fallback: string) {
  const encoded = encodeURIComponent(svg)
    .replaceAll("%0A", "")
    .replaceAll("%0D", "")
    .replaceAll("%09", "")
    .replaceAll("%20", " ");
  return `url("data:image/svg+xml,${encoded}") ${hotX} ${hotY}, ${fallback}`;
}

function resizeSvg(angleDeg: number) {
  // Based on `tools/cursors/resize-double-arrow.html`, rotated around center.
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32" shape-rendering="geometricPrecision">
  <g transform="rotate(${angleDeg} 16 16)">
    <line x1="6.5" y1="16" x2="25.5" y2="16" stroke="rgba(0,0,0,0.65)" stroke-width="3.7" stroke-linecap="round"/>
    <line x1="6.5" y1="16" x2="25.5" y2="16" stroke="rgba(255,255,255,0.92)" stroke-width="2.1" stroke-linecap="round"/>
    <g transform="translate(6.5 16) rotate(180) translate(0 -3.6)">
      <path d="M0 0 L6.2 3.6 L0 7.2 Z" fill="rgba(0,0,0,0.65)"/>
      <path d="M0 0 L6.2 3.6 L0 7.2 Z" fill="rgba(255,255,255,0.92)" transform="scale(0.92) translate(0.2 0.3)"/>
    </g>
    <g transform="translate(25.5 16) rotate(0) translate(0 -3.6)">
      <path d="M0 0 L6.2 3.6 L0 7.2 Z" fill="rgba(0,0,0,0.65)"/>
      <path d="M0 0 L6.2 3.6 L0 7.2 Z" fill="rgba(255,255,255,0.92)" transform="scale(0.92) translate(0.2 0.3)"/>
    </g>
  </g>
</svg>`;
}

function rotateSvg(angleDeg: number) {
  // Based on `tools/cursors/rotation-half-circle-left.html`, rotated around center.
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32" shape-rendering="geometricPrecision">
  <g transform="rotate(${angleDeg} 16 16)">
    <path d="M 16.00 26.50
             C 21.80 26.50 26.50 21.80 26.50 16.00
             C 26.50 10.20 21.80 5.50 16.00 5.50"
         fill="none" stroke="rgba(0,0,0,0.65)" stroke-width="3.7" stroke-linecap="round"/>
    <path d="M 16.00 26.50
             C 21.80 26.50 26.50 21.80 26.50 16.00
             C 26.50 10.20 21.80 5.50 16.00 5.50"
         fill="none" stroke="rgba(255,255,255,0.92)" stroke-width="2.1" stroke-linecap="round"/>
    <g transform="translate(16 26.5) rotate(180) translate(0 -3.6)">
      <path d="M0 0 L6.2 3.6 L0 7.2 Z" fill="rgba(0,0,0,0.65)"/>
      <path d="M0 0 L6.2 3.6 L0 7.2 Z" fill="rgba(255,255,255,0.92)" transform="scale(0.92) translate(0.2 0.3)"/>
    </g>
    <g transform="translate(16 5.5) rotate(180) translate(0 -3.6)">
      <path d="M0 0 L6.2 3.6 L0 7.2 Z" fill="rgba(0,0,0,0.65)"/>
      <path d="M0 0 L6.2 3.6 L0 7.2 Z" fill="rgba(255,255,255,0.92)" transform="scale(0.92) translate(0.2 0.3)"/>
    </g>
  </g>
</svg>`;
}

const RESIZE = new Map<number, string>();
const ROTATE = new Map<number, string>();

function cursorFor(kind: CursorKind, angleDeg: number) {
  const a = ((Math.round(angleDeg) % 360) + 360) % 360;
  const m = kind === "resize" ? RESIZE : ROTATE;
  const cached = m.get(a);
  if (cached) return cached;
  const svg = kind === "resize" ? resizeSvg(a) : rotateSvg(a);
  const cur = svgCursor(svg, 16, 16, kind === "resize" ? "move" : "grab");
  m.set(a, cur);
  return cur;
}

export function cursorForResize(angleDeg: number) {
  return cursorFor("resize", angleDeg);
}

export function cursorForRotate(angleDeg: number) {
  return cursorFor("rotate", angleDeg);
}

