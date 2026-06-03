from __future__ import annotations

import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from interactive_presentation.server.app import create_app


class MediaRouteTests(unittest.TestCase):
  def _make_client(self):
    tmp_dir = tempfile.TemporaryDirectory()
    self.addCleanup(tmp_dir.cleanup)
    root = Path(tmp_dir.name) / "presentation.pr"
    root.write_text("view[id=home]:\n", encoding="utf-8")
    return root, create_app(str(root)).test_client()

  def test_media_upload_accepts_html_and_writes_media_file(self) -> None:
    root, client = self._make_client()

    response = client.post(
      "/api/media/upload",
      data={"file": (io.BytesIO(b"<html><body>Hello</body></html>"), "widget.html", "text/html")},
      content_type="multipart/form-data",
    )

    self.assertEqual(response.status_code, 200)
    payload = response.get_json()
    self.assertEqual(payload["ok"], True)
    self.assertTrue((root.parent / "media" / payload["filename"]).exists())

  def test_iframe_proxy_retries_localhost_https_as_http(self) -> None:
    _root, client = self._make_client()

    class _Res:
      def __init__(self, data: bytes, content_type: str) -> None:
        self._data = data
        self.headers = {"Content-Type": content_type}

      def read(self):
        return self._data

      def __enter__(self):
        return self

      def __exit__(self, *_args):
        return False

    calls: list[str] = []

    def _open(req, timeout=10):
      url = req.full_url
      calls.append(url)
      if url.startswith("https://localhost"):
        raise RuntimeError("ssl")
      return _Res(b"<html><head></head><body>ok</body></html>", "text/html")

    with patch("urllib.request.urlopen", side_effect=_open):
      response = client.get("/iframe-proxy?url=https://localhost:9999/demo")

    self.assertEqual(response.status_code, 200)
    self.assertEqual(calls[0], "https://localhost:9999/demo")
    self.assertEqual(calls[1], "http://localhost:9999/demo")
    self.assertIn("<base href=\"http://localhost:9999/demo\">", response.get_data(as_text=True))


if __name__ == "__main__":
  unittest.main()
