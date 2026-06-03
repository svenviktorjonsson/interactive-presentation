### Interactive Presentation `.pr` syntax highlighting (local VS Code extension)

This repo’s `.pr` files (e.g. `app/presentations/**/presentation.pr`, `groups/**/elements.pr`) use a custom DSL.

## Coordinate system
All coordinates are **normalized** and **relative to their parent**:
- `(0,0)` is top‑left, `(1,1)` is bottom‑right
- `(0.5,0.5)` is the center
- The same rules apply to views, groups, and screen‑space nodes
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

