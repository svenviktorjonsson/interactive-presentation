### Interactive Presentation `.pr` syntax highlighting (local VS Code extension)

This repo’s `.pr` files (e.g. `presentations/**/presentation.pr`, `groups/**/elements.pr`) use a custom DSL.
VS Code doesn’t know how to highlight it by default, so this folder contains a tiny local extension that adds a language + grammar.

### Install

- **Option A (recommended):** "Developer: Install Extension from Location..."
  - In VS Code, open Command Palette and run **Developer: Install Extension from Location...**
  - Pick: `tools/vscode/interactive-presentation-pr`

- **Option B:** Run an Extension Development Host (for hacking on the grammar)
  - Open this folder in VS Code
  - Press F5

### Time literals

The grammar highlights time literals like:

- `00:06` (mm:ss)
- `00:06.53` (mm:ss.fraction)
- `01:23:54.12` (hh:mm:ss.fraction)

