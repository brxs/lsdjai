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
```

Models land in `~/Documents/Magenta/magenta-rt-v2` (override with
`MAGENTA_HOME`).

## Run

```sh
cd backend
uv run magenta-dj
```

Then open <http://127.0.0.1:8000> — the M1 test page: connect, set a prompt,
play. The page shows buffer level and underrun count.

`backend/scripts/verify_m1.py` checks the M1 exit criteria end-to-end against
a running server (`uv run python scripts/verify_m1.py 660`).
