from __future__ import annotations

import unittest

from interactive_presentation.server.phone_screen_renderer import render_phone_screen_page


class PhoneScreenRendererTests(unittest.TestCase):
  def test_render_phone_screen_page_renders_typed_screen_shell(self) -> None:
    html = render_phone_screen_page(
      join_id="join_main",
      initial_screen={
        "groupId": "join_main",
        "moduleType": "join",
        "title": "Join",
        "subtitle": "Enter name",
        "active": True,
        "elements": [
          {"kind": "field", "name": "name", "label": "Name", "input_type": "text"},
          {"kind": "button", "label": "Join", "action": {"kind": "server", "action_id": "submit_join", "group_id": "join_main"}},
        ],
      },
    )

    self.assertIn("const joinId = \"join_main\";", html)
    self.assertIn("<h1>Join</h1>", html)
    self.assertIn("fetchCurrentScreen()", html)


if __name__ == "__main__":
  unittest.main()
