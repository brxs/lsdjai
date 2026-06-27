#!/usr/bin/env bash
# Post-acquire Stable Audio 3 install (ADR-0012/0013): build the MLX venv and
# warm the three DiTs so the ~8 GB of weights download here and never inside a
# request. Idempotent — the `.lsdj-warmed` stamp, written ONLY here, gates
# re-warming (rm it to re-warm).
#
# Run by the in-app model manager (the Rust shell, after a tarball extract). Pass
# the checkout ROOT (the dir that contains `optimized/mlx`).
#
# Usage: scripts/sa3-install.sh <checkout_root>
set -euo pipefail

root="${1:?usage: sa3-install.sh <checkout_root>}"
mlx="$root/optimized/mlx"
[ -d "$mlx" ] || { echo "no optimized/mlx under $root" >&2; exit 1; }

if [ ! -x "$mlx/.venv/bin/python" ]; then
  # -y skips install.sh's interactive [Y/n] uv-bootstrap prompt (no controlling
  # tty when the shell spawns us); --python 3.11 has uv provision a standalone
  # interpreter, so no system Python 3.11 is required.
  (cd "$mlx" && ./install.sh -y --python 3.11)
fi

stamp="$mlx/.lsdj-warmed"
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
