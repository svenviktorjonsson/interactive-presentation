from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import Response

router = APIRouter()


@router.get("/phone/timer")
def phone_timer():
    # Minimal phone UI: tap to start/stop, submit, reset.
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


@router.get("/phone/choices")
def phone_choices():
    html = """<!doctype html>
<html>
  <head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <title>Poll</title>
    <style>
      :root { color-scheme: dark; }
      body { margin:0; background:#0b1020; color:rgba(255,255,255,0.92); font-family:system-ui,Segoe UI,Roboto,Arial; }
      .wrap { min-height:100vh; display:grid; place-items:center; padding:20px; }
      .card { width:min(560px, 100%); border:1px solid rgba(255,255,255,0.14); border-radius:16px; background:rgba(255,255,255,0.06); padding:16px; box-sizing:border-box; }
      h1 { font-size:20px; margin:0 0 10px; flex: 1 1 auto; min-width: 0; overflow-wrap:anywhere; }
      p { margin:0 0 10px; color:rgba(255,255,255,0.7); }
      .badge { display:inline-block; padding:6px 10px; border-radius:999px; border:1px solid rgba(255,255,255,0.16); background:rgba(255,255,255,0.06); font-size:12px; white-space:nowrap; }
      .badge.open { border-color: rgba(110,168,255,0.34); background: rgba(110,168,255,0.22); color: rgba(255,255,255,0.95); }
      .opt { display:flex; flex-direction:column; gap:6px; margin-top:10px; }
      .opt button { width:100%; text-align:left; padding:12px; border-radius:12px; border:1px solid rgba(255,255,255,0.14); background:rgba(255,255,255,0.06); color:rgba(255,255,255,0.92); font-weight:800; cursor:pointer; }
      .opt button:disabled { opacity:0.6; cursor:not-allowed; }
      .opt .meta { font-size:13px; color:rgba(255,255,255,0.7); padding-left:4px; }
      .muted { color:rgba(255,255,255,0.7); font-size:13px; margin-top:8px; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap;">
          <h1 id="question">Poll</h1>
          <span class="badge" id="status">Stand by…</span>
        </div>
        <div class="muted" id="total">0 votes</div>
        <div id="options"></div>
        <div class="muted" id="hint">Waiting for poll…</div>
      </div>
    </div>
    <script>
      const params = new URLSearchParams(window.location.search);
      let pollId = params.get('pollId') || '';
      const questionEl = document.getElementById('question');
      const statusEl = document.getElementById('status');
      const optsEl = document.getElementById('options');
      const totalEl = document.getElementById('total');
      const hintEl = document.getElementById('hint');

      function bullet(idx, style) {
        const i = idx + 1;
        if (style === 'a') return String.fromCharCode(96 + i) + '.';
        if (style === 'A') return String.fromCharCode(64 + i) + '.';
        if (style === 'I') {
          const romans = ['I','II','III','IV','V','VI','VII','VIII','IX','X','XI','XII','XIII','XIV','XV','XVI','XVII','XVIII','XIX','XX'];
          return (romans[i-1] || i) + '.';
        }
        return i + '.';
      }

      async function fetchActivePollId() {
        try {
          const r = await fetch('/api/choices/active', { cache:'no-store' });
          if (!r.ok) return '';
          const j = await r.json();
          return j && j.pollId ? j.pollId : '';
        } catch { return ''; }
      }

      async function fetchState() {
        if (!pollId) pollId = await fetchActivePollId();
        if (!pollId) return null;
        try {
          const res = await fetch('/api/choices/state?pollId=' + encodeURIComponent(pollId), { cache:'no-store' });
          if (!res.ok) return null;
          return await res.json();
        } catch { return null; }
      }

      async function vote(optionId) {
        if (!pollId) return;
        try {
          await fetch('/api/choices/vote', {
            method:'POST',
            headers:{'content-type':'application/json'},
            body: JSON.stringify({ pollId, optionId })
          });
        } catch {}
        await refresh();
      }

      function render(state) {
        if (!state) {
          statusEl.textContent = 'Stand by…';
          statusEl.classList.remove('open');
          questionEl.textContent = 'Poll';
          hintEl.textContent = 'Waiting for poll…';
          optsEl.innerHTML = '';
          totalEl.textContent = '';
          return;
        }
        questionEl.textContent = state.question || 'Poll';
        const accepting = !!state.accepting;
        statusEl.textContent = accepting ? 'Open' : 'Closed';
        statusEl.classList.toggle('open', accepting);
        totalEl.textContent = `${state.totalVotes ?? 0} vote${(state.totalVotes||0) === 1 ? '' : 's'}`;
        hintEl.textContent = accepting ? 'Tap an option to vote' : 'Poll is closed';
        optsEl.innerHTML = '';
        const style = (state.bullets || 'A').toString();
        (state.options || []).forEach((opt, idx) => {
          const row = document.createElement('div');
          row.className = 'opt';
          const btn = document.createElement('button');
          btn.type = 'button';
          const label = String(opt.label || ('Option ' + (idx + 1)));
          btn.textContent = `${bullet(idx, style)} ${label}`;
          const color = String(opt.color || '').trim();
          if (color) {
            btn.style.borderColor = color;
            btn.style.background = color;
            btn.style.color = '#000';
          }
          btn.disabled = !accepting;
          btn.addEventListener('click', () => vote(opt.id));
          const meta = document.createElement('div');
          meta.className = 'meta';
          const pct = Math.round(opt.percent ?? 0);
          meta.textContent = `${opt.votes ?? 0} vote${(opt.votes||0) === 1 ? '' : 's'} · ${pct}%`;
          row.append(btn, meta);
          optsEl.appendChild(row);
        });
      }

      async function refresh() {
        const st = await fetchState();
        render(st);
        setTimeout(refresh, 900);
      }
      refresh();
    </script>
  </body>
</html>
"""
    return Response(content=html, media_type="text/html")

