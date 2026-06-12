# magenta-dj task runner — `just` lists recipes, `just <recipe>` runs one.

default:
    @just --list

# One-time setup: backend deps, model weights, frontend deps + build.
setup:
    cd backend && uv sync
    cd backend && uv run mrt models init
    cd backend && uv run mrt models download mrt2_small
    cd frontend && npm install
    just build

# Optional: the higher-quality deck model (per-deck picker in the UI).
download-base-model:
    cd backend && uv run mrt models download mrt2_base

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
