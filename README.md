# Interactive presentation builder

This repo contains:
- A **Python backend** (FastAPI) that serves a presentation from `presentations/default/`
- A **TypeScript web app** (Vite) that renders the presentation, plus an **editor** (Edit mode)

You can author presentations in two ways:
- **(Recommended)** Use the **web editor** to create/move/style nodes, then fine‑tune via files if needed
- Edit the underlying **DSL** in `presentation.pr` + its layout CSV files

---

## Run (recommended)

From repo root:

```bash
poetry install
poetry run python run_presentation.py
```

This script will:
- Install web deps if missing (`npm install` in `apps/web`)
- Build the web app once (`npm run build` in `apps/web`)
- Start the backend on `http://localhost:8000`
- (Optionally) create a public tunnel and generate `presentations/default/media/join_qr.png`

Useful endpoints:
- **health**: `http://localhost:8000/api/health`
- **presentation JSON**: `http://localhost:8000/api/presentation`
- **audience join page**: `http://localhost:8000/join`

---

## Authoring via the web interface (Edit mode)

Open `http://localhost:8000`.

### Modes
- **Edit mode**
  - You can select/move/resize/rotate nodes
  - Right‑click opens a context menu (add text/image, group selection)
  - Drag & drop image files onto the stage to upload + create image nodes
- **Live mode**
  - Navigation (views / cues) is enabled
  - Editing is disabled
  - Interactive elements (timer/polls) can be started/stopped from their buttons

### Common editing actions
- **Select**
  - Click a node to select it
  - Selected nodes show handles for resize/rotate
- **Move / Resize / Rotate**
  - Drag to move
  - Drag edge/corner handles to resize
  - Drag the rotate handles to rotate
- **Edit a node**
  - Double‑click a non‑composite node to open the editor modal (properties + geometry)
- **Save**
  - Saving writes back to `presentations/default/` (`presentation.pr`, `geometries.csv`, `animations.csv`)

### Adding images
- **Context menu**
  - Right‑click → **Add image…** → pick a file
- **Drag & drop**
  - Drop one or more image files onto the stage while in Edit mode

Uploaded images are written into `presentations/default/media/` and referenced via `/media/<filename>`.

### Screen Edit Mode (screen-space nodes)
Some nodes can live in **screen space** (HUD overlays). To edit those without bumping into world nodes:
- Enter Screen Edit Mode (button in the UI)
- Press **Escape** to exit Screen Edit Mode

### Composite edit mode (timer / choices)
Some node types are **composites**: they are rendered as a group with internal sub‑elements (buttons, labels, canvas, etc.).

- Double‑click a composite node (e.g. `timer`, `choices`) to enter **group edit**
- You can drag/resize internal sub‑elements
- Saving writes to `presentations/default/groups/<compositePath>/geometries.csv`

This is how the system supports “special widgets” while still keeping them editable like normal content.

---

## Authoring via files (DSL + CSV)

All presentation content for the default deck lives in:
- `presentations/default/presentation.pr` (**canonical semantic file**)
- `presentations/default/geometries.csv` (layout)
- `presentations/default/animations.csv` (enter/exit animations)
- `presentations/default/defaults.json` (design resolution + global defaults)
- `presentations/default/media/` (images/videos)
- `presentations/default/groups/` (composite internal layouts)

### 1) `presentation.pr` (the DSL)

`presentation.pr` defines:
- which nodes exist (text, image, timer, choices, …)
- which view(s) they belong to
- text content / questions
- node parameters (colors, chart type, etc.)
- view order and view camera placement

Example (from `presentations/default/presentation.pr`):

```text
screen[name=main]:

image[name=EOES_logo,bgColor=white]
text[name=place_date]:
NRM, 24 Jan 2026

view[name=home]:
text[name=title]:
Welcome to my presentation

image[name=join_qr]
```

#### Syntax rules (practical)
- A node is declared with `type[...]` (parameters are optional)
- The `name=...` parameter becomes the **node id**
- Nodes that carry text have a `:` and then their text on the next line(s)
- Views are declared with `view[...]` (and then list which nodes exist in that view)
- `screen[...]` is the screen-space view section (HUD nodes)

#### Parameters
Parameters are comma-separated inside `[...]`:

```text
timer[name=timer1,barColor=orange,binSize=1,min=20,max=40]
```

Some parameters are structured and use braces; the parser handles commas inside balanced braces.

##### Choices / polls (`choices={Label:color,...}`)

Example:

```text
choices[name=fav_subjects,type=pie,bullets=A,choices={Biologi:green,Kemi:red,Fysik:blue,Matematik:magenta,Övrigt:cyan}]:
Vilket ämne tycker ni är roligast i skolan?
```

- Keys are the **labels** shown in the UI
- Values are optional **colors** (CSS color strings)

### 2) `geometries.csv` (layout)

`presentations/default/geometries.csv` stores geometry per node:
- `x,y,w,h`: normalized coordinates (relative to the view’s design height)
- `rotationDeg`
- `anchor` (e.g. `topLeft`, `centerCenter`, …)
- `align` / `vAlign` for text alignment
- `fontH` (font size normalized to design height; derived from editor’s `fontPx`)
- `parent` / `parentId` support for grouping and parent-relative layouts

In most cases, you should **not hand-edit geometry** unless you know you need to; the editor is faster/safer.

### 3) `animations.csv` (enter/exit)

`presentations/default/animations.csv` defines per-node animations like:
- when: enter/exit
- how: fade/slide/pixelate (depending on engine support)
- duration/delay

### 4) `defaults.json` (global deck defaults)

`presentations/default/defaults.json` controls:
- `designWidth`, `designHeight` (authoring resolution)
- `viewTransitionMs`
- `pixelateSteps`

### 5) `media/` (images/videos)

Any file in `presentations/default/media/` is served at:
- `/media/<filename>`

The editor’s image upload endpoint writes files here automatically.

### 6) `groups/` (composite internal layouts)

Composite nodes store their internal layout in folders:

```text
presentations/default/groups/
  timer1/
    elements.pr
    geometries.csv
    animations.csv

  fav_subjects/
    elements.pr
    geometries.csv
    wheel/
      elements.pr
      geometries.csv
```

These files are written when you edit a composite in **group edit mode**.

---

## Recommended workflow

- **Start in the editor**
  - Create text/images
  - Place nodes in the right views
  - Tweak style fields in the modal
- **Then adjust DSL only when needed**
  - Add/change poll options in `choices={...}`
  - Add timer/choices parameters
  - Bulk edits (search/replace) are sometimes faster in text files


