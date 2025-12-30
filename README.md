# Interactive presentation builder

This repo now contains:
- A **Python backend** that serves a presentation model from `presentations/default/`.
- A **vanilla TS frontend** (Vite) that renders a single pan+zoom stage with a welcome title + QR code.

## Run the presentation (dev)

From repo root:

```bash
poetry install
poetry run python run_presentation.py
```

It will open the browser to `http://localhost:8000` (and show an “Enter fullscreen” button).

### (Debug only) Direct commands

- Backend health: `http://localhost:8000/api/health`
- Presentation JSON: `http://localhost:8000/api/presentation`

## Tunnel (optional)

If you want a public HTTPS URL for the backend (ngrok-like), `localhost.run` supports SSH tunneling.

- Manual command (from `localhost.run` docs):

```bash
ssh -R 80:localhost:8000 nokey@localhost.run
```

It will print an assigned public hostname (e.g. `https://<name>.localhost.run`). Use that as your audience URL: `https://<name>.localhost.run/join`.

On the free tier you may instead get a `*.lhr.life` hostname (example: `https://7d8c6daa6b27b8.lhr.life`).

If you want the QR code in the presenter UI to use that public URL, set:

```bash
set PUBLIC_BASE_URL=https://<name>.localhost.run
poetry run python run_presentation.py
```

Docs: `https://localhost.run/`

## Old plot prototype

`plot.py` / `plots.html` are the earlier field-viewer prototype and can be ignored for the new app.

## Presentation content files

`presentations/default/` is now driven by:
- `presentation.txt`: semantic content + view order
- `geometries.csv`: positions/sizes/anchors/alignments (pure layout)
- `animations.csv`: intro animation specs (e.g. fade-in from left)
- `media/`: png images and web-ready videos (including generated `join_qr.png`)

