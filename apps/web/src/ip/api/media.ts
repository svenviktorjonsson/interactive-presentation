import { BACKEND } from "../config";

export async function uploadImageToMedia(file: File): Promise<{ src: string; filename: string }> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`${BACKEND}/api/media/upload`, { method: "POST", body: fd });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  const j = (await res.json()) as any;
  const src = String(j?.src ?? "");
  const filename = String(j?.filename ?? "");
  if (!src) throw new Error("Upload missing src");
  return { src, filename };
}

export async function loadImageSize(src: string): Promise<{ w: number; h: number } | null> {
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = src;
    // Use load event (works everywhere).
    await new Promise<void>((resolve, reject) => {
      img.addEventListener("load", () => resolve(), { once: true });
      img.addEventListener("error", () => reject(new Error("image load failed")), { once: true });
    });
    const w = Number((img as any).naturalWidth ?? 0);
    const h = Number((img as any).naturalHeight ?? 0);
    if (w > 0 && h > 0) return { w, h };
    return null;
  } catch {
    return null;
  }
}

