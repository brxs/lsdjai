# SlipMate

SlipMate is a generative DJ instrument: two locally-running model decks
(Magenta RealTime 2), generated pads and tracks (Stable Audio 3), mixed by a
native Rust audio engine and playable from a Pioneer DDJ-FLX4. It ships as a
native Tauri app. See [`README.md`](README.md) for the full overview,
[`docs/ROADMAP.md`](docs/ROADMAP.md) for how it got here, and
[`docs/adr/`](docs/adr/) for the architecture decisions.

## Build / run / test

All common tasks live in the root [`justfile`](justfile) — run `just` to list
them.

- `just setup` — backend deps, model weights, frontend deps + build
- `just tauri-dev` — run the native app (the generation server binds an
  ephemeral loopback port)
- `just tauri-build` — build the distributable native app
- `just lint` / `just test` / `just check` (lint + tests; what a PR must pass)

Underlying tools: uv + pytest + ruff in `backend/`, npm + vitest + eslint in
`frontend/`. One branch per roadmap milestone or issue, kebab-case
(e.g. `m1-one-deck-audible`). Project-wide rules live in `.claude/rules/`.

## Architecture

- The native **Rust audio engine** does **all audio mixing**: per-deck player →
  EQ → Color FX insert → cue tap → fader/crossfade. The webview
  (`frontend/`, React + Vite) is the UI and talks to the engine over Tauri IPC.
  The Python sidecars run one Magenta RT model worker per deck; the FastAPI
  controller (`backend/slipmate/`) is a pure generation server (render /
  generate / models) on a loopback port (ADR-0002).
- `frontend/src/` map: `audio/` (engine-facing state, FX curves in `fx.ts`),
  `control/` (Web MIDI link, FLX4 byte translator, `ControlIntent` bus),
  `deck/`, `mixer/`, `ui/` primitives.
- Hardware control is Web MIDI in the frontend (ADR-0005). The DDJ-FLX4 byte
  map — including the position-query SysEx and the PAD FX banks — is
  *measured*, not assumed; it lives in `docs/midi-ddj-flx4.md`. Keep it current
  when adding mappings.
- Headphone cue is handled by the Rust engine: a chosen output device or the
  FLX4's own phones jack. Color FX are pure amount→parameter curves at a
  pre-fader insert with a bit-exact bypass (ADR-0008).
- Model weights live outside the repo in `~/Documents/Magenta/magenta-rt-v2`
  (override with `MAGENTA_HOME`); first run needs `uv run mrt models init` +
  `uv run mrt models download mrt2_small`. Only `backend/slipmate/engine.py`
  may import `magenta_rt` (ADR-0002); measured API facts are in
  `docs/spike-mrt2.md`.
- Changes that touch hardware behaviour cannot be fully verified by tests:
  add/extend a checklist in `docs/` (e.g. `m12-hardware-checklist.md`) and have
  a human tick it before calling the work done.

## Codebase gotchas

- The frontend has **no formatter** on purpose. House style: single quotes, no
  semicolons. Match the file you're in.
- `npx tsc --noEmit` at the frontend root checks **nothing** (solution-style
  tsconfig), and `tsc -b` can pass on stale buildinfo. To type-check for real:
  `npx tsc -p tsconfig.app.json --noEmit` from `frontend/`.
- npm commands must run from `frontend/`, not the repo root.
