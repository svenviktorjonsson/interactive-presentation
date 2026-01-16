from __future__ import annotations

import json
import shutil
from pathlib import Path
import re
import os

from ..pr.parser import parse_presentation_pr
from ..pr.compile import compile_model_payload


def export_bundle(presentation_pr: str, out_dir: str = "dist") -> None:
  """
  Minimal exporter (Milestone 6 stub):
  - Copies `app/web/dist` to out_dir
  - Writes `model.json`
  - Injects the model into `index.html` so the bundle can run from file:// with no server
  """
  pres_path = Path(presentation_pr).resolve()
  pres_dir = pres_path.parent
  # exporter.py lives at: app/python/interactive_presentation/export/exporter.py
  # -> parents[3] is app/
  web_dist = (Path(__file__).resolve().parents[3] / "web" / "dist").resolve()
  out = Path(out_dir).resolve()
  out.mkdir(parents=True, exist_ok=True)

  if not web_dist.exists():
    raise FileNotFoundError(f"web dist not found: {web_dist} (run `cd app/web && npm run build`)")

  # copytree requires empty target; copy content instead
  for child in web_dist.iterdir():
    dst = out / child.name
    if child.is_dir():
      if dst.exists():
        # Windows/OneDrive can intermittently deny deletes (antivirus/indexer).
        # Best-effort delete with chmod retry; if it still fails, keep old dir and overwrite files we copy.
        try:
          shutil.rmtree(dst)
        except PermissionError:
          try:
            for p in dst.rglob("*"):
              try:
                os.chmod(p, 0o666)
              except Exception:
                pass
            shutil.rmtree(dst, ignore_errors=True)
          except Exception:
            pass
      shutil.copytree(child, dst)
    else:
      shutil.copy2(child, dst)

  spec = parse_presentation_pr(pres_path)
  payload = compile_model_payload(spec, base_dir=pres_dir)
  payload_json = json.dumps(payload, ensure_ascii=False)
  (out / "model.json").write_text(payload_json, encoding="utf-8")

  # Inject for true offline usage (no fetch).
  index = out / "index.html"
  if index.exists():
    html = index.read_text(encoding="utf-8")
    marker = "</body>"
    script = f'\n    <script id="ip-model" type="application/json">{payload_json}</script>\n'
    if 'id="ip-model"' in html:
      # Replace existing embedded model.
      html = re.sub(r'<script id="ip-model" type="application/json">.*?</script>', script.strip(), html, flags=re.DOTALL)
    elif marker in html:
      html = html.replace(marker, script + marker)
    else:
      html = html + script
    index.write_text(html, encoding="utf-8")

    # Also generate a single-file offline HTML that inlines CSS+JS, so it works even if the browser
    # blocks loading module assets from file:// (common in some setups).
    #
    # Output: index.inline.html (open this directly)
    m_js = re.search(r'<script[^>]+src="(?P<src>[^"]+)"[^>]*>\s*</script>', html)
    m_css = re.search(r'<link[^>]+rel="stylesheet"[^>]+href="(?P<href>[^"]+)"[^>]*>', html)
    js_src = m_js.group("src") if m_js else ""
    css_href = m_css.group("href") if m_css else ""

    js_txt = ""
    css_txt = ""
    if js_src:
      js_path = (out / js_src.lstrip("./")).resolve()
      if js_path.exists():
        js_txt = js_path.read_text(encoding="utf-8")
    if css_href:
      css_path = (out / css_href.lstrip("./")).resolve()
      if css_path.exists():
        css_txt = css_path.read_text(encoding="utf-8")

    if js_txt and css_txt:
      html_inline = html
      # remove external tags
      html_inline = re.sub(r'<script[^>]+src="[^"]+"[^>]*>\s*</script>', "", html_inline)
      html_inline = re.sub(r'<link[^>]+rel="stylesheet"[^>]+href="[^"]+"[^>]*>', "", html_inline)
      # inject inline css/js in <head>
      head_end = "</head>"
      inject_head = f"\n    <style>\n{css_txt}\n    </style>\n    <script type=\"module\">\n{js_txt}\n    </script>\n"
      if head_end in html_inline:
        html_inline = html_inline.replace(head_end, inject_head + head_end)
      else:
        html_inline = inject_head + html_inline
      (out / "index.inline.html").write_text(html_inline, encoding="utf-8")

