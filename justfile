# magenta-dj task runner — `just` lists recipes, `just <recipe>` runs one.

default:
    @just --list

# One-time setup: backend deps, all model weights (both Magenta deck
# models + Stable Audio 3), frontend deps + build.
setup:
    cd backend && uv sync
    cd backend && uv run mrt models init
    cd backend && uv run mrt models download mrt2_small
    cd backend && uv run mrt models download mrt2_base
    just setup-sa3
    cd frontend && npm install
    just build

# Stable Audio 3 (ADR-0012/0013): the pinned checkout, its venv, and a
# warm-up clip per DiT so the weights (~8 GB, medium included) download
# here and never inside a request. Idempotent; honours SA3_MLX_HOME and
# an existing checkout, and leaves an existing checkout's commit alone.
setup-sa3:
    #!/usr/bin/env bash
    set -euo pipefail
    checkout="${SA3_MLX_HOME:-}"
    if [ -z "$checkout" ]; then
      for candidate in "$HOME/Documents/Magenta/stable-audio-3" "$HOME/Repos/stable-audio-3"; do
        if [ -e "$candidate" ]; then checkout="$candidate"; break; fi
      done
    fi
    if [ -z "$checkout" ]; then
      checkout="$HOME/Repos/stable-audio-3"
      git clone https://github.com/Stability-AI/stable-audio-3 "$checkout"
      # The CLI vocabulary the backend speaks is measured at this commit
      # (backend/magenta_dj/sa3.py); a fresh clone honours the pin.
      git -C "$checkout" checkout bccf5b7
    fi
    mlx="$checkout/optimized/mlx"
    if [ ! -x "$mlx/.venv/bin/python" ]; then
      (cd "$mlx" && ./install.sh)
    fi
    # The warm-ups exist to download weights; once stamped, repeat
    # setups skip the three model loads (rm the stamp to re-warm).
    stamp="$mlx/.magenta-dj-warmed"
    if [ -f "$stamp" ]; then
      echo "sa3 weights already warmed ($stamp)"
      exit 0
    fi
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    for spec in "sm-sfx same-s" "sm-music same-s" "medium same-l"; do
      set -- $spec
      echo "warming $1/$2…"
      (cd "$mlx" && .venv/bin/python scripts/sa3_mlx.py --prompt "setup warm-up" \
        --dit "$1" --decoder "$2" --seconds 1 --steps 1 --out "$tmp/warm.wav")
    done
    touch "$stamp"

# Build the frontend (the backend serves frontend/dist).
build:
    cd frontend && npm run build

# Run the app: backend on http://127.0.0.1:8000 serving the built frontend.
run: build
    cd backend && uv run magenta-dj

# Backend only, for frontend development (pair with `just dev-frontend`).
dev-backend:
    cd backend && uv run magenta-dj

# Vite dev server with /ws proxied to the backend (run `just dev-backend` too).
dev-frontend:
    cd frontend && npm run dev

# All tests: backend pytest + frontend vitest.
test:
    cd backend && uv run pytest
    cd frontend && npm run test

# Lint + format check + type-check, both halves.
lint:
    cd backend && uv run ruff format --check .
    cd backend && uv run ruff check .
    cd frontend && npm run lint
    cd frontend && npx tsc -b

# Apply formatting.
format:
    cd backend && uv run ruff format .

# Everything a PR must pass: lint + tests.
check: lint test

# Stream e2e against a running server (`just run` in another terminal).
verify-stream duration="60":
    cd backend && uv run python scripts/verify_m1.py {{duration}}

# Worklet module graph loads in real Chromium (self-contained; jsdom
# executes none of the worklet code).
verify-worklets: build
    cd frontend && node scripts/verify_worklet_modules.mjs

# UI e2e in headless Chromium against a running server.
verify-ui:
    cd backend && uv run python scripts/repro_reconnect_echo.py
    cd frontend && node scripts/verify_m2.mjs
    cd frontend && node scripts/verify_m3.mjs
    cd frontend && node scripts/verify_m4.mjs
    cd frontend && node scripts/verify_m5.mjs
    cd frontend && node scripts/verify_m6.mjs
    cd frontend && node scripts/verify_m17.mjs
    cd frontend && node scripts/verify_m18.mjs
    cd frontend && node scripts/verify_m19.mjs
    cd frontend && node scripts/verify_m20.mjs
    cd frontend && node scripts/verify_m21.mjs
