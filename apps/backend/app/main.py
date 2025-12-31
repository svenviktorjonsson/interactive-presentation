from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi import Body
from fastapi.responses import FileResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import math
import time
import csv

from .content_loader import load_presentation
from .content_writer import write_animations_csv, write_geometries_csv, write_presentation_txt

app = FastAPI(title="interactive-presentation-backend")

app.add_middleware(
    CORSMiddleware,
    # When serving the built frontend from this backend, this is same-origin and CORS doesn't matter.
    # Keep dev origins allowed for debugging.
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:8000", "http://127.0.0.1:8000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

REPO_ROOT = Path(__file__).resolve().parents[3]
WEB_DIST = REPO_ROOT / "apps" / "web" / "dist"
PRESENTATION_DIR = REPO_ROOT / "presentations" / "default"
MEDIA_DIR = PRESENTATION_DIR / "media"


@app.get("/api/health")
def health():
    return {"ok": True}

@app.get("/media/{media_path:path}")
def media(media_path: str):
    # Serve presentation media (png images, videos, generated join QR, etc.)
    # Use no-store so overwriting a file (like join_qr.png) takes effect immediately.
    p = (MEDIA_DIR / media_path).resolve()
    if not str(p).startswith(str(MEDIA_DIR.resolve())):
        return Response(status_code=400)
    if not p.exists() or not p.is_file():
        return Response(status_code=404)
    return FileResponse(p, headers={"Cache-Control": "no-store"})


@app.get("/api/presentation")
def get_presentation(request: Request):
    pres = load_presentation()
    payload = pres.payload

    # Make relative QR urls absolute based on a public base URL so scanning from a phone works.
    # - If you're using a tunnel (localhost.run/ngrok/etc), set PUBLIC_BASE_URL to the public origin.
    # - Otherwise fall back to the request host.
    base = (os.environ.get("PUBLIC_BASE_URL") or str(request.base_url)).rstrip("/")
    for n in payload.get("nodes", []):
        if n.get("type") == "qr":
            url = n.get("url", "")
            if isinstance(url, str) and url.startswith("/"):
                n["url"] = base + url

    return payload


_JOINED: list[dict] = []


# ---- Simple "timer" interactive element (hardcoded MVP) ----
_TIMER_ACCEPTING = False
_TIMER_SAMPLES_MS: list[float] = []


def _timer_stats():
    n = len(_TIMER_SAMPLES_MS)
    if n <= 0:
        return {"n": 0, "meanMs": None, "sigmaMs": None}
    mean = sum(_TIMER_SAMPLES_MS) / n
    if n <= 1:
        return {"n": n, "meanMs": mean, "sigmaMs": 0.0}
    var = sum((x - mean) ** 2 for x in _TIMER_SAMPLES_MS) / (n - 1)
    return {"n": n, "meanMs": mean, "sigmaMs": math.sqrt(max(0.0, var))}


@app.get("/phone/timer")
def phone_timer():
    # Minimal phone UI: tap to start/stop, submit, reset.
    # (Config routing/view assignment will come later.)
    html = """<!doctype html>
<html>
  <head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <title>Timer</title>
    <style>
      :root { color-scheme: dark; }
      body { margin:0; background:#0b1020; color:rgba(255,255,255,0.92); font-family:system-ui,Segoe UI,Roboto,Arial; }
      .wrap { min-height:100vh; display:grid; place-items:center; padding:20px; }
      .card { width:min(560px, 100%); border:1px solid rgba(255,255,255,0.14); border-radius:16px; background:rgba(255,255,255,0.06); padding:16px; }
      h1 { font-size:18px; margin:0 0 10px; }
      p { margin:0 0 10px; color:rgba(255,255,255,0.7); }
      .tap { height: 44vh; border-radius: 14px; border: 1px dashed rgba(255,255,255,0.22);
             background: rgba(255,255,255,0.03); display:grid; place-items:center; user-select:none; }
      .t { font-size: 38px; font-weight: 900; letter-spacing: 0.02em; }
      .row { display:flex; gap:10px; margin-top:12px; }
      button { flex:1; padding:12px 12px; border-radius:12px; border:1px solid rgba(255,255,255,0.16);
               background: rgba(255,255,255,0.06); color:rgba(255,255,255,0.92); font-weight:800; cursor:pointer; }
      button.primary { border-color: rgba(110,168,255,0.34); background: rgba(110,168,255,0.22); }
      button:disabled { opacity:0.45; cursor:not-allowed; }
      .badge { display:inline-block; padding:6px 10px; border-radius:999px; border:1px solid rgba(255,255,255,0.16); background:rgba(255,255,255,0.06); font-size:12px; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h1>Tap timer</h1>
        <p id="status"><span class="badge">Stand by…</span></p>
        <div class="tap" id="tap">
          <div class="t" id="time">0.00</div>
        </div>
        <div class="row">
          <button id="resetBtn">Reset</button>
          <button class="primary" id="submitBtn" disabled>Submit</button>
        </div>
      </div>
    </div>
    <script>
      let accepting = false;
      let running = false;
      let t0 = 0;
      let lastMs = null;
      let raf = 0;

      const $ = (id) => document.getElementById(id);
      const statusEl = $("status");
      const timeEl = $("time");
      const tapEl = $("tap");
      const resetBtn = $("resetBtn");
      const submitBtn = $("submitBtn");

      function fmt(ms) { return (ms/1000).toFixed(2); }
      function forceStandby() {
        // Force the phone UI back into standby (no partial/paused state left behind).
        running = false;
        cancelAnimationFrame(raf);
        lastMs = null;
        timeEl.textContent = '0.00';
        submitBtn.disabled = true;
      }
      function setStatus() {
        statusEl.innerHTML = accepting ? '<span class="badge">Ready</span>' : '<span class="badge">Stand by…</span>';
        tapEl.style.opacity = accepting ? '1' : '0.5';
      }
      async function poll() {
        try {
          const r = await fetch('/api/timer/state', { cache: 'no-store' });
          const j = await r.json();
          accepting = !!j.accepting;
          if (!accepting) { forceStandby(); }
          setStatus();
        } catch {}
      }
      setInterval(poll, 600);
      poll();

      function tick() {
        if (!running) return;
        const ms = performance.now() - t0;
        timeEl.textContent = fmt(ms);
        raf = requestAnimationFrame(tick);
      }

      tapEl.addEventListener('pointerdown', () => {
        if (!accepting) return;
        if (!running) {
          running = true;
          lastMs = null;
          t0 = performance.now();
          cancelAnimationFrame(raf);
          raf = requestAnimationFrame(tick);
          submitBtn.disabled = true;
        } else {
          running = false;
          cancelAnimationFrame(raf);
          lastMs = performance.now() - t0;
          timeEl.textContent = fmt(lastMs);
          submitBtn.disabled = false;
        }
      });

      resetBtn.addEventListener('click', () => {
        running = false;
        cancelAnimationFrame(raf);
        lastMs = null;
        timeEl.textContent = '0.00';
        submitBtn.disabled = true;
      });

      submitBtn.addEventListener('click', async () => {
        if (lastMs == null) return;
        submitBtn.disabled = true;
        try {
          const res = await fetch('/api/timer/submit', {
            method: 'POST',
            headers: {'content-type':'application/json'},
            body: JSON.stringify({ durationMs: lastMs })
          });
          if (!res.ok) throw new Error('submit failed');
          resetBtn.click();
        } catch (e) {
          alert('Submit failed');
          submitBtn.disabled = false;
        }
      });
    </script>
  </body>
</html>
"""
    return Response(content=html, media_type="text/html")


@app.get("/api/timer/state")
def timer_state():
    return {"accepting": _TIMER_ACCEPTING, "samplesMs": _TIMER_SAMPLES_MS[-500:], "stats": _timer_stats(), "serverTimeMs": int(time.time() * 1000)}


@app.post("/api/timer/start")
def timer_start():
    global _TIMER_ACCEPTING
    _TIMER_ACCEPTING = True
    return {"ok": True}


@app.post("/api/timer/stop")
def timer_stop():
    global _TIMER_ACCEPTING
    _TIMER_ACCEPTING = False
    return {"ok": True}


@app.post("/api/timer/reset")
def timer_reset():
    global _TIMER_SAMPLES_MS
    _TIMER_SAMPLES_MS = []
    return {"ok": True}


@app.post("/api/timer/submit")
def timer_submit(payload: dict = Body(...)):
    if not _TIMER_ACCEPTING:
        return Response(status_code=409, content="Not accepting", media_type="text/plain")
    try:
        ms = float(payload.get("durationMs"))
    except Exception:
        return Response(status_code=400, content="Missing durationMs", media_type="text/plain")
    if not (0 <= ms <= 60_000):
        return Response(status_code=400, content="Out of range", media_type="text/plain")
    _TIMER_SAMPLES_MS.append(ms)
    return {"ok": True}


@app.post("/api/timer/composite/save")
def timer_composite_save(payload: dict = Body(...)):
    """
    Save composite-local geometries for timer sub-elements into:
    presentations/default/timer/geometries.csv

    Payload:
      { "geoms": { "<id>": { "x":0..1, "y":0..1, "w":0..1, "h":0..1, "rotationDeg":0, "anchor":"...", "align":"..." } } }
    """
    composite_dir = str(payload.get("compositeDir") or "").strip()
    geoms = payload.get("geoms")
    elements_text = payload.get("elementsText")
    if not composite_dir:
        return Response(status_code=400, content="Missing compositeDir", media_type="text/plain")
    if not composite_dir.replace("_", "").replace("-", "").isalnum():
        return Response(status_code=400, content="Invalid compositeDir", media_type="text/plain")
    if not isinstance(geoms, dict):
        return Response(status_code=400, content="Missing geoms", media_type="text/plain")

    timer_dir = PRESENTATION_DIR / "groups" / composite_dir
    timer_dir.mkdir(parents=True, exist_ok=True)
    out_path = timer_dir / "geometries.csv"
    if isinstance(elements_text, str):
        (timer_dir / "elements.txt").write_text(elements_text, encoding="utf-8")

    fieldnames = ["id", "view", "x", "y", "w", "h", "rotationDeg", "anchor", "align"]
    with out_path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for gid, g in geoms.items():
            if not isinstance(g, dict):
                continue
            w.writerow(
                {
                    "id": gid,
                    "view": "timer",
                    "x": g.get("x", 0),
                    "y": g.get("y", 0),
                    "w": g.get("w", 0.2),
                    "h": g.get("h", 0.1),
                    "rotationDeg": g.get("rotationDeg", 0),
                    "anchor": g.get("anchor", "topLeft"),
                    "align": g.get("align", ""),
                }
            )

    return {"ok": True, "path": str(out_path)}


@app.get("/join")
def join_page():
    # Lightweight audience page (not the presentation UI).
    html = """<!doctype html>
<html>
  <head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <title>Join</title>
    <style>
      :root { color-scheme: dark; }
      body { margin:0; background:#0b1020; color:rgba(255,255,255,0.92); font-family:system-ui,Segoe UI,Roboto,Arial; }
      .wrap { min-height:100vh; display:grid; place-items:center; padding:24px; }
      .card { width:min(520px, 100%); border:1px solid rgba(255,255,255,0.14); border-radius:16px; background:rgba(255,255,255,0.06); padding:18px; }
      h1 { font-size:18px; margin:0 0 10px; }
      p { margin:0 0 14px; color:rgba(255,255,255,0.7); }
      label { display:block; font-size:12px; color:rgba(255,255,255,0.7); margin:10px 0 6px; }
      input { width:100%; box-sizing:border-box; padding:10px 10px; border-radius:12px; border:1px solid rgba(255,255,255,0.14);
              background:rgba(255,255,255,0.06); color:rgba(255,255,255,0.92); }
      button { margin-top:14px; width:100%; padding:10px 12px; border-radius:12px; border:1px solid rgba(110,168,255,0.34);
               background:rgba(110,168,255,0.22); color:rgba(255,255,255,0.92); font-weight:800; cursor:pointer; }
      .ok { display:none; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card" id="formCard">
        <h1>Join</h1>
        <p>Enter your details to join the session.</p>
        <form id="f">
          <label>Name</label>
          <input name="name" autocomplete="name" required />
          <label>Email</label>
          <input name="email" type="email" autocomplete="email" required />
          <label>Year of birth</label>
          <input name="yob" type="number" min="1900" max="2100" required />
          <button type="submit">Join</button>
        </form>
      </div>
      <div class="card ok" id="okCard">
        <h1>Stand by</h1>
        <p>You're connected. Stand by for interactive elements.</p>
      </div>
    </div>
    <script>
      const f = document.getElementById('f');
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(f).entries());
        const res = await fetch('/api/join', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(data) });
        if (res.ok) {
          document.getElementById('formCard').style.display='none';
          document.getElementById('okCard').style.display='block';
          // If a timer session starts, redirect to the phone timer UI.
          const poll = async () => {
            try {
              const r = await fetch('/api/timer/state', { cache: 'no-store' });
              if (r.ok) {
                const j = await r.json();
                if (j && j.accepting) {
                  window.location.href = '/phone/timer';
                  return;
                }
              }
            } catch {}
            setTimeout(poll, 600);
          };
          poll();
        } else {
          alert('Join failed');
        }
      });
    </script>
  </body>
</html>
"""
    return Response(content=html, media_type="text/html")


@app.post("/api/join")
def join(payload: dict = Body(...)):
    # Store in memory for now (later: websocket session, moderation, etc.)
    _JOINED.append(payload)
    return {"ok": True}


@app.post("/api/save")
def save_presentation(payload: dict = Body(...)):
    """
    Save the current model back to:
    - presentations/default/presentation.txt
    - presentations/default/geometries.csv
    - presentations/default/animations.csv
    """
    pres_dir = PRESENTATION_DIR
    nodes = payload.get("nodes", [])
    if not isinstance(nodes, list):
        return Response(status_code=400, content="Invalid nodes", media_type="text/plain")

    write_presentation_txt(pres_dir / "presentation.txt", payload)
    write_geometries_csv(pres_dir / "geometries.csv", payload)
    write_animations_csv(pres_dir / "animations.csv", nodes)
    return {"ok": True}


ASSETS_DIR = WEB_DIST / "assets"
if ASSETS_DIR.exists():
    app.mount("/assets", StaticFiles(directory=str(ASSETS_DIR)), name="assets")


@app.get("/{full_path:path}")
def spa_fallback(full_path: str):
    # If we have a built frontend, serve index.html for any non-API path (SPA fallback).
    # Otherwise, return a helpful message.
    if full_path.startswith("api/"):
        return Response(status_code=404)

    if full_path.startswith("join"):
        return Response(status_code=404)

    index = WEB_DIST / "index.html"
    if index.exists():
        return FileResponse(index)

    return Response(
        content="Frontend not built. Run `npm -w apps/web run build` (or `poetry run python run_presentation.py`).",
        media_type="text/plain",
        status_code=503,
    )


