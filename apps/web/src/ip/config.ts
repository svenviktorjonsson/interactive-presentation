// Centralized runtime config for the web app.

// When the backend serves the built frontend, same-origin fetch works.
// In dev (vite on :5173), it will still default to :8000 unless overridden.
export const BACKEND =
  import.meta.env.VITE_BACKEND_URL ?? window.location.origin.replace(":5173", ":8000");

export const DEBUG_ANIM =
  new URLSearchParams(window.location.search).get("debugAnim") === "1" ||
  localStorage.getItem("ip_debug_anim") === "1";

export function dlog(..._args: any[]) {
  // Intentionally quiet unless DEBUG_ANIM is enabled.
  if (!DEBUG_ANIM) return;
  // Uncomment for debugging:
  // eslint-disable-next-line no-console
  // console.log("[ip]", ..._args);
}

