import QRCode from "qrcode";
import type { PresentationModel } from "@interactive/content";
import type { Engine } from "@interactive/engine";

export async function hydrateQrImages(engine: Engine, model: PresentationModel) {
  const qrNodes = model.nodes.filter((n) => n.type === "qr");
  for (const n of qrNodes) {
    // Content model typings are intentionally loose here; treat as runtime-validated.
    const q: any = n as any;
    if (q.type !== "qr") continue;
    const el = engine.getNodeElement(q.id);
    if (!el) continue;
    const img = el.querySelector<HTMLImageElement>(".qr-img");
    if (!img) continue;
    img.alt = `QR: ${q.url}`;
    img.src = await QRCode.toDataURL(String(q.url ?? ""), {
      margin: 1,
      width: 512,
      // Use rgba() to avoid any ambiguity about 8-digit hex support.
      // Standard QR colors; pixelate animation controls fade-in.
      color: { dark: "#000000ff", light: "#ffffffff" },
    });
  }
}

