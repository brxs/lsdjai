#!/usr/bin/env bash
# Freeze the LSDJai inference sidecar into a launchable ONEDIR binary for
# bundling into the native app (Phase 2 part 6, ADR-0018/0019).
#
# This is the production form of the proven Spike B recipe (spike/packaging/
# build.sh, docs/spike-packaging.md) — the ONLY change is the entry point:
# backend/lsdj/sidecar.py (the loopback-TCP sidecar) instead of the spike's
# freeze_test.py. The dependency closure (mlx, magenta_rt, sequence_layers, …) is
# identical, so the spike's findings hold: ~931 MB ONEDIR, weights kept external.
#
# Output: dist/lsdj_infer/lsdj_infer (+ _internal/). Spawned by the Rust
# shell as `lsdj_infer --deck <a|b> --model <name> --port <n>`.
#
# Usage: scripts/freeze-sidecar.sh   (needs `just setup` — backend .venv with
# pyinstaller + the inference deps).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
VENV="$REPO/backend/.venv"
SP="$VENV/lib/python3.13/site-packages"
PYI="$VENV/bin/pyinstaller"
BACKEND="$REPO/backend"
# sequence_layers is vendored under magenta_rt with a hyphen dir and injected
# onto sys.path at runtime; point PyInstaller's analysis at it directly.
SEQLAYERS_DIR="$SP/magenta_rt/_vendor/sequence-layers"
OUT="$REPO/src-tauri/sidecar-dist"

rm -rf "$OUT"
"$PYI" \
  --noconfirm \
  --onedir \
  --name lsdj_infer \
  --console \
  --distpath "$OUT" \
  --paths "$BACKEND" \
  --paths "$SEQLAYERS_DIR" \
  --hidden-import lsdj.engine \
  --hidden-import lsdj.worker \
  --collect-submodules lsdj \
  --collect-all mlx \
  --collect-all mlx_metal \
  --collect-submodules magenta_rt \
  --collect-submodules sequence_layers \
  --collect-submodules ai_edge_litert \
  --collect-binaries ai_edge_litert \
  --copy-metadata magenta_rt \
  "$BACKEND/lsdj/sidecar.py"

# THE METALLIB WALL (Spike B): MLX's get_colocated_mtllib_path looks for
# mlx.metallib next to libmlx.dylib; copy the metallib + dylibs next to the exe so
# resolution succeeds regardless of which @rpath MLX takes.
DIST_BIN_DIR="$OUT/lsdj_infer"
MLX_LIB="$SP/mlx/lib"
for f in mlx.metallib libmlx.dylib libjaccl.dylib; do
  if [ -f "$MLX_LIB/$f" ] && [ ! -f "$DIST_BIN_DIR/$f" ]; then
    cp "$MLX_LIB/$f" "$DIST_BIN_DIR/$f"
  fi
done

echo "=== sidecar freeze complete ==="
du -sh "$DIST_BIN_DIR"
echo "Bundle via tauri.conf.json resources (see docs/native-packaging.md), or point"
echo "LSDJ_SIDECAR_CMD at $DIST_BIN_DIR/lsdj_infer for a dev run."
