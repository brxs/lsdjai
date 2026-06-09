# magenta-dj

A DJ interface over [Magenta RealTime 2](https://github.com/magenta/magenta-realtime):
two locally-running model decks steered by text prompts, blended with a
crossfader. See [`docs/ROADMAP.md`](docs/ROADMAP.md) for where this is going
and [`docs/adr/`](docs/adr/) for the architecture decisions.

## Requirements

- Apple Silicon Mac (MLX backend)
- [uv](https://docs.astral.sh/uv/)
- ~2 GB disk for model weights (downloaded on first setup)

## Setup

```sh
cd backend
uv sync
uv run mrt models init                  # shared resources (~1.3 GB)
uv run mrt models download mrt2_small   # deck model (~450 MB)

cd ../frontend
npm install
npm run build
```

Models land in `~/Documents/Magenta/magenta-rt-v2` (override with
`MAGENTA_HOME`).

## Run

```sh
cd backend
uv run magenta-dj
```

Then open <http://127.0.0.1:8000> — set a style prompt, hit play, ride the
volume fader. The health row shows the stream buffer, underrun count, and
generation speed.

For frontend development, run the backend as above plus `npm run dev` in
`frontend/` (the Vite dev server proxies `/ws` to the backend).

## Verify

- Backend tests: `uv run pytest` (in `backend/`)
- Frontend tests: `npm run test` (in `frontend/`)
- Stream e2e: `uv run python scripts/verify_m1.py 60` against a running server
- UI e2e: `node scripts/verify_m2.mjs` (in `frontend/`, needs Playwright
  Chromium: `npx playwright install chromium`) against a running server
