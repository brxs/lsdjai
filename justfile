# LSDJai task runner — `just` lists recipes, `just <recipe>` runs one.

default:
    @just --list

# One-time setup: backend deps, all model weights (both Magenta deck
# models + Stable Audio 3), frontend deps + build. Magenta weights go to the
# app-owned data dir (~/Library/Application Support/LSDJai), matching where the
# app reads them (MAGENTA_HOME); an existing MAGENTA_HOME override is honoured.
setup:
    cd backend && uv sync
    cd backend && MAGENTA_HOME="${MAGENTA_HOME:-$HOME/Library/Application Support/LSDJai}" uv run mrt models init
    cd backend && MAGENTA_HOME="${MAGENTA_HOME:-$HOME/Library/Application Support/LSDJai}" uv run mrt models download mrt2_small
    cd backend && MAGENTA_HOME="${MAGENTA_HOME:-$HOME/Library/Application Support/LSDJai}" uv run mrt models download mrt2_base
    just setup-sa3
    cd frontend && npm install
    cargo install tauri-cli
    just build

# Stable Audio 3 (ADR-0012/0013): the pinned checkout, its venv, and a
# warm-up clip per DiT so the weights (~8 GB, medium included) download
# here and never inside a request. The checkout lives in the app-owned data dir
# (the resolver's only non-override location); $SA3_MLX_HOME overrides it.
# Idempotent — an existing checkout is reused, its commit left alone. The repo +
# commit are pinned in sa3-pin.json (the single bump point, shared with the in-app
# installer); the build+warm steps live in scripts/sa3-install.sh.
setup-sa3:
    #!/usr/bin/env bash
    set -euo pipefail
    checkout="${SA3_MLX_HOME:-$HOME/Library/Application Support/LSDJai/stable-audio-3}"
    if [ ! -e "$checkout" ]; then
      repo="$(python3 -c 'import json; print(json.load(open("sa3-pin.json"))["repo"])')"
      commit="$(python3 -c 'import json; print(json.load(open("sa3-pin.json"))["commit"])')"
      git clone "$repo" "$checkout"
      # The CLI vocabulary the backend speaks is measured at this commit
      # (sa3-pin.json, backend/lsdj/sa3.py); a fresh clone honours the pin.
      git -C "$checkout" checkout "$commit"
    fi
    bash scripts/sa3-install.sh "$checkout"

# Relocate existing model weights from the legacy ~/Documents/Magenta (or
# $MAGENTA_HOME) location — and a ~/Repos Stable Audio 3 clone — into the
# app-owned data dir (~/Library/Application Support/LSDJai), so model data is out
# of any iCloud-synced Documents folder. Same-volume moves are instant. The app
# also migrates the Magenta weights automatically on first launch; this is the
# manual equivalent and also covers Stable Audio 3. Idempotent — an item whose
# destination already exists is left alone.
migrate-models:
    #!/usr/bin/env bash
    set -euo pipefail
    old="${MAGENTA_HOME:-$HOME/Documents/Magenta}"
    new="$HOME/Library/Application Support/LSDJai"
    mkdir -p "$new"
    if [ -d "$old/magenta-rt-v2" ] && [ ! -e "$new/magenta-rt-v2" ]; then
      echo "moving magenta-rt-v2 → $new/"
      mv "$old/magenta-rt-v2" "$new/magenta-rt-v2"
    else
      echo "skip magenta-rt-v2 (source missing or destination exists)"
    fi
    if [ -e "$new/stable-audio-3" ]; then
      echo "skip stable-audio-3 (destination exists)"
    else
      moved=0
      for src in "$old/stable-audio-3" "$HOME/Repos/stable-audio-3"; do
        if [ -d "$src" ]; then
          echo "moving stable-audio-3 ($src) → $new/"
          mv "$src" "$new/stable-audio-3"
          moved=1
          break
        fi
      done
      [ "$moved" = 1 ] || echo "skip stable-audio-3 (no checkout found)"
    fi
    echo "done — model data now lives under $new"

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
# commands use the backend project dir; override with LSDJ_SIDECAR_CMD /
# LSDJ_GENERATION_CMD (e.g. the packaged binaries).
tauri-dev: build
    cd src-tauri && LSDJ_SIDECARS=1 cargo tauri dev

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
