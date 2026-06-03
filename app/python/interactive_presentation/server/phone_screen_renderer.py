from __future__ import annotations

import json
from html import escape
from typing import Any


def _screen_html(screen: dict[str, Any]) -> str:
  title = escape(str(screen.get("title", "") or ""))
  subtitle = escape(str(screen.get("subtitle", "") or ""))
  parts = [f"<h1>{title}</h1>"]
  if subtitle:
    parts.append(f"<p>{subtitle}</p>")
  for element in list(screen.get("elements") or []):
    kind = str(element.get("kind", "") or "")
    if kind == "field":
      label = escape(str(element.get("label", "") or ""))
      name = escape(str(element.get("name", "") or ""))
      input_type = escape(str(element.get("input_type", "") or "text"))
      parts.append(f'<label>{label}</label><input name="{name}" type="{input_type}" />')
    elif kind == "button":
      label = escape(str(element.get("label", "") or "Action"))
      parts.append(f"<button type=\"button\">{label}</button>")
    elif kind == "choice_list":
      parts.append("<div class=\"poll-options\">")
      for option in list(element.get("options") or []):
        label = escape(str(option.get("label", "") or ""))
        parts.append(f"<button type=\"button\">{label}</button>")
      parts.append("</div>")
    elif kind == "stopwatch":
      parts.append("<button type=\"button\">Start</button>")
  return "".join(parts)


def render_phone_screen_page(*, join_id: str, initial_screen: dict[str, Any]) -> str:
  initial_html = _screen_html(initial_screen)
  initial_screen_json = json.dumps(initial_screen)
  return f"""<!doctype html>
<html>
  <head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <title>Join</title>
    <style>
      :root {{ color-scheme: dark; }}
      body {{ margin:0; background:#0b1020; color:rgba(255,255,255,0.92); font-family:system-ui,Segoe UI,Roboto,Arial; }}
      .wrap {{ min-height:100vh; display:grid; place-items:center; padding:24px; }}
      .card {{ width:min(560px, 100%); border:1px solid rgba(255,255,255,0.14); border-radius:16px; background:rgba(255,255,255,0.06); padding:18px; }}
      h1 {{ font-size:18px; margin:0 0 10px; }}
      p {{ margin:0 0 14px; color:rgba(255,255,255,0.7); }}
      label {{ display:block; font-size:12px; color:rgba(255,255,255,0.7); margin:10px 0 6px; }}
      input {{ width:100%; box-sizing:border-box; padding:10px 10px; border-radius:12px; border:1px solid rgba(255,255,255,0.14); background:rgba(255,255,255,0.06); color:rgba(255,255,255,0.92); }}
      button {{ margin-top:14px; width:100%; padding:10px 12px; border-radius:12px; border:1px solid rgba(110,168,255,0.34); background:rgba(110,168,255,0.22); color:rgba(255,255,255,0.92); font-weight:800; cursor:pointer; }}
      .stack {{ display:flex; flex-direction:column; gap:12px; }}
      .choice-list {{ display:flex; flex-direction:column; gap:10px; }}
      .choice-btn {{ display:flex; align-items:center; gap:10px; margin-top:0; }}
      .choice-dot {{ width:14px; height:14px; border-radius:999px; flex:0 0 auto; }}
      .stopwatch {{ display:grid; grid-template-rows:4fr 1fr; gap:10px; min-height:60vh; }}
      .stopwatch-main {{ margin-top:0; font-size:32px; }}
      .stopwatch-row {{ display:grid; grid-template-columns:1fr 1fr; gap:10px; }}
      .muted {{ color:rgba(255,255,255,0.7); }}
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <div id="app">{initial_html}</div>
      </div>
    </div>
    <script>
      const joinId = {json.dumps(join_id)};
      let joined = false;
      let currentScreen = {initial_screen_json};
      let stopwatchState = {{ running: false, startMs: 0, elapsedMs: 0, tick: null }};
      const app = document.getElementById('app');

      const stopTick = () => {{
        if (stopwatchState.tick) {{
          clearInterval(stopwatchState.tick);
          stopwatchState.tick = null;
        }}
      }};
      const startTick = (labelEl, showTime) => {{
        stopTick();
        stopwatchState.tick = setInterval(() => {{
          if (!stopwatchState.running) return;
          stopwatchState.elapsedMs = Math.max(0, performance.now() - stopwatchState.startMs);
          if (showTime && labelEl) labelEl.textContent = `${{(stopwatchState.elapsedMs / 1000).toFixed(2)}} s`;
        }}, 100);
      }};
      const readValues = () => {{
        const values = {{}};
        app.querySelectorAll('input[name]').forEach((input) => {{
          values[input.name] = input.value;
        }});
        return values;
      }};
      const postAction = async (groupId, actionId, extra) => {{
        const res = await fetch(`/api/interactive/${{encodeURIComponent(groupId)}}/action`, {{
          method: 'POST',
          headers: {{ 'content-type': 'application/json' }},
          body: JSON.stringify({{ actionId, values: readValues(), ...(extra || {{}}) }}),
        }});
        if (!res.ok) {{
          alert('Action failed');
          return null;
        }}
        return res.json();
      }};
      const renderScreen = (screen) => {{
        currentScreen = screen;
        app.replaceChildren();
        const stack = document.createElement('div');
        stack.className = 'stack';
        const title = document.createElement('h1');
        title.textContent = String(screen?.title || (joined ? 'Stand by' : 'Join'));
        stack.appendChild(title);
        if (screen?.subtitle) {{
          const subtitle = document.createElement('p');
          subtitle.textContent = String(screen.subtitle || '');
          stack.appendChild(subtitle);
        }}
        const elements = Array.isArray(screen?.elements) ? screen.elements : [];
        if (!elements.length && joined) {{
          const standby = document.createElement('p');
          standby.className = 'muted';
          standby.textContent = "You're connected.";
          stack.appendChild(standby);
        }}
        for (const element of elements) {{
          const kind = String(element?.kind || '');
          if (kind === 'field') {{
            const label = document.createElement('label');
            label.textContent = String(element.label || element.name || '');
            const input = document.createElement('input');
            input.name = String(element.name || '');
            input.type = String(element.input_type || 'text');
            if (element.placeholder) input.placeholder = String(element.placeholder);
            if (element.value) input.value = String(element.value);
            stack.append(label, input);
          }} else if (kind === 'button') {{
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = String(element.label || 'Action');
            btn.onclick = async () => {{
              const action = element.action || {{}};
              const payload = await postAction(String(action.group_id || screen.groupId || joinId), String(action.action_id || ''), {{}});
              if (payload && payload.joined) joined = true;
              await fetchCurrentScreen();
            }};
            stack.appendChild(btn);
          }} else if (kind === 'choice_list') {{
            const list = document.createElement('div');
            list.className = 'choice-list';
            const action = element.action || {{}};
            for (const option of Array.isArray(element.options) ? element.options : []) {{
              const btn = document.createElement('button');
              btn.type = 'button';
              btn.className = 'choice-btn';
              const dot = document.createElement('span');
              dot.className = 'choice-dot';
              dot.style.background = String(option.color || 'rgba(255,255,255,0.5)');
              const label = document.createElement('span');
              label.textContent = String(option.label || option.id || '');
              btn.append(dot, label);
              btn.onclick = async () => {{
                await postAction(String(action.group_id || screen.groupId || ''), String(action.action_id || ''), {{ choice: String(option.id || '') }});
                await fetchCurrentScreen();
              }};
              list.appendChild(btn);
            }}
            stack.appendChild(list);
          }} else if (kind === 'stopwatch') {{
            stopwatchState.running = false;
            stopwatchState.elapsedMs = 0;
            stopTick();
            const props = element.props || {{}};
            const shell = document.createElement('div');
            shell.className = 'stopwatch';
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'stopwatch-main';
            toggle.textContent = String(props.toggleLabel || 'Start');
            const row = document.createElement('div');
            row.className = 'stopwatch-row';
            const reset = document.createElement('button');
            reset.type = 'button';
            reset.textContent = String(props.resetLabel || 'Reset');
            const submit = document.createElement('button');
            submit.type = 'button';
            submit.textContent = String(props.submitLabel || 'Submit');
            const actions = Array.isArray(element.actions) ? element.actions : [];
            const actStart = actions[0] || {{}};
            const actStop = actions[1] || {{}};
            const actReset = actions[2] || {{}};
            const actSubmit = actions[3] || {{}};
            const showTime = !!props.showTime;
            const updateToggle = () => {{
              toggle.textContent = showTime ? `${{(stopwatchState.elapsedMs / 1000).toFixed(2)}} s` : (stopwatchState.running ? String(props.stopLabel || 'Stop') : String(props.startLabel || 'Start'));
            }};
            toggle.onclick = async () => {{
              if (!stopwatchState.running) {{
                stopwatchState.running = true;
                stopwatchState.startMs = performance.now() - stopwatchState.elapsedMs;
                startTick(toggle, showTime);
                await postAction(String(actStart.group_id || screen.groupId || ''), String(actStart.action_id || 'start_timer'), {{}});
              }} else {{
                stopwatchState.running = false;
                stopwatchState.elapsedMs = Math.max(0, performance.now() - stopwatchState.startMs);
                stopTick();
                await postAction(String(actStop.group_id || screen.groupId || ''), String(actStop.action_id || 'stop_timer'), {{}});
              }}
              updateToggle();
            }};
            reset.onclick = async () => {{
              stopwatchState.running = false;
              stopwatchState.elapsedMs = 0;
              stopTick();
              updateToggle();
              await postAction(String(actReset.group_id || screen.groupId || ''), String(actReset.action_id || 'reset_timer'), {{}});
            }};
            submit.onclick = async () => {{
              stopwatchState.running = false;
              stopwatchState.elapsedMs = Math.max(0, stopwatchState.running ? performance.now() - stopwatchState.startMs : stopwatchState.elapsedMs);
              stopTick();
              await postAction(String(actSubmit.group_id || screen.groupId || ''), String(actSubmit.action_id || 'submit_timer'), {{ elapsedMs: Math.round(stopwatchState.elapsedMs) }});
              await fetchCurrentScreen();
            }};
            row.append(reset, submit);
            shell.append(toggle, row);
            stack.appendChild(shell);
            updateToggle();
          }}
        }}
        app.appendChild(stack);
      }};
      const fetchCurrentScreen = async () => {{
        const res = await fetch(`/api/interactive/current?joinId=${{encodeURIComponent(joinId)}}`);
        if (!res.ok) return;
        const payload = await res.json();
        if (payload && payload.joined) joined = true;
        renderScreen(payload?.screen || null);
      }};
      const events = new EventSource('/events');
      events.addEventListener('interactive-screen', () => fetchCurrentScreen());
      events.addEventListener('multichoice-prompt', () => fetchCurrentScreen());
      events.addEventListener('timer-prompt', () => fetchCurrentScreen());
      fetchCurrentScreen();
    </script>
  </body>
</html>"""
