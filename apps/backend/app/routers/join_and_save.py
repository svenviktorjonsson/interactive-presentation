from __future__ import annotations

from fastapi import APIRouter, Body
from fastapi.responses import Response

from ..config import PRESENTATION_DIR
from ..content_writer import write_animations_csv, write_geometries_csv, write_presentation_txt
from ..state import STATE

router = APIRouter()


@router.get("/join")
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
          // If an interactive element starts, redirect to the appropriate phone UI.
          const poll = async () => {
            try {
              const pc = await fetch('/api/choices/active', { cache: 'no-store' });
              if (pc.ok) {
                const jc = await pc.json();
                if (jc && jc.pollId) {
                  window.location.href = '/phone/choices?pollId=' + encodeURIComponent(jc.pollId);
                  return;
                }
              }
            } catch {}
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


@router.post("/api/join")
def join(payload: dict = Body(...)):
    # Store in memory for now (later: websocket session, moderation, etc.)
    STATE.joined.append(payload)
    return {"ok": True}


@router.post("/api/save")
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

    # Keep existing debug prints (can remove later if desired).
    for n in nodes:
        if isinstance(n, dict) and n.get("type") == "choices":
            print(f"[DEBUG] Choices node: {n.get('id')}")
            print(f"[DEBUG]   options type: {type(n.get('options'))}")
            opts = n.get("options")
            print(f"[DEBUG]   options value: {opts}")
            if isinstance(opts, list):
                print(f"[DEBUG]   options count: {len(opts)}")
                for i, opt in enumerate(opts):
                    print(f"[DEBUG]     opt[{i}] type={type(opt)}: {opt}")

    write_presentation_txt(pres_dir / "presentation.pr", payload)
    write_geometries_csv(pres_dir / "geometries.csv", payload)
    write_animations_csv(pres_dir / "animations.csv", nodes)
    return {"ok": True}

