# SlipMate task runner — `just` lists recipes, `just <recipe>` runs one.

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
      # (backend/slipmate/sa3.py); a fresh clone honours the pin.
      git -C "$checkout" checkout bccf5b7
    fi
    mlx="$checkout/optimized/mlx"
    if [ ! -x "$mlx/.venv/bin/python" ]; then
      (cd "$mlx" && ./install.sh)
    fi
    # The warm-ups exist to download weights; once stamped, repeat
    # setups skip the three model loads (rm the stamp to re-warm).
    stamp="$mlx/.slipmate-warmed"
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

# Build the frontend into frontend/dist (the Tauri webview loads it via
# tauri.conf's frontendDist; tauri-dev / tauri-build depend on this).
build:
    cd frontend && npm run build

# Native shell: run the full native app in dev — the Rust audio engine (cpal) +
# the per-deck Python inference sidecars + the sa3 generation server. The `build`
# dependency rebuilds frontend/dist first (the webview loads it via frontendDist);
# this must happen here, not in tauri.conf's beforeDevCommand, because Tauri runs
# that hook from the repo root and a fresh dist is required or the decks hang in
# 'Connecting'. Needs cargo-tauri (`cargo install tauri-cli@^2`) and the backend
# deps + model weights (`just setup`). The default `uv run` sidecar/generation
# commands use the backend project dir; override with SLIPMATE_SIDECAR_CMD /
# SLIPMATE_GENERATION_CMD (e.g. the packaged binaries).
tauri-dev: build
    cd src-tauri && SLIPMATE_SIDECARS=1 cargo tauri dev

# Freeze the Python inference sidecar into a ONEDIR binary for bundling
# (src-tauri/sidecar-dist/). The production form of Spike B; see
# docs/native-packaging.md. Needs `just setup` (backend .venv + pyinstaller).
freeze-sidecar:
    ./scripts/freeze-sidecar.sh

# Native shell (Phase 2): build + bundle the Tauri app (.app/.dmg) into
# src-tauri/target/release/bundle/. The `build` dependency rebuilds frontend/dist
# first (embedded via frontendDist). Codesign + notarize when the APPLE_* env vars
# are set (docs/native-packaging.md §3). Needs cargo-tauri
# (`cargo install tauri-cli@^2`); bundle the sidecar first with `freeze-sidecar`.
tauri-build: build
    cd src-tauri && cargo tauri build

# All tests: backend pytest + frontend vitest + the Rust engine/shell.
test:
    cd backend && uv run pytest
    cd frontend && npm run test
    cd src-tauri && cargo test --workspace

# Lint + format check + type-check, all three stacks. (No `cargo fmt --check`:
# the Rust follows a hand-style like the frontend, not rustfmt — clippy is the
# gate.)
lint:
    cd backend && uv run ruff format --check .
    cd backend && uv run ruff check .
    cd frontend && npm run lint
    cd frontend && npx tsc -b
    cd src-tauri && cargo clippy --workspace --all-targets -- -D warnings

# Apply formatting.
format:
    cd backend && uv run ruff format .

# Everything a PR must pass: lint + tests.
check: lint test
