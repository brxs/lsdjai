# magenta-dj

A DJ interface over [Magenta RealTime 2](https://github.com/magenta/magenta-realtime):
two locally-running model decks steered by text prompts, blended with a
crossfader. See [`docs/ROADMAP.md`](docs/ROADMAP.md) for where this is going
and [`docs/adr/`](docs/adr/) for the architecture decisions.

## Requirements

- Apple Silicon Mac (MLX backend)
- [uv](https://docs.astral.sh/uv/)
- ~2 GB disk for model weights (downloaded on first setup)

All common tasks live in the [`justfile`](justfile) — run `just` to list them.

## Setup

```sh
just setup   # backend deps, model weights (~1.8 GB), frontend deps + build
```

Models land in `~/Documents/Magenta/magenta-rt-v2` (override with
`MAGENTA_HOME`). `just download-base-model` additionally fetches `mrt2_base`,
selectable per deck in the UI — heavier and higher-quality; the app warns
when the combined selection looks tight for your RAM.

## Run

```sh
just run
```

Then open <http://127.0.0.1:8000> — set a style prompt, hit play, ride the
volume fader. The health row shows the stream buffer, underrun count, and
generation speed.

For frontend development: `just dev-backend` in one terminal, `just
dev-frontend` in another (the Vite dev server proxies `/ws` to the backend).

## Verify

- `just test` — backend pytest + frontend vitest
- `just lint` — format check, ruff, eslint, tsc
- `just check` — both of the above; what a PR must pass
- `just verify-stream` / `just verify-ui` — e2e against a running server
  (UI e2e needs Playwright Chromium once: `npx playwright install chromium`
  in `frontend/`)
