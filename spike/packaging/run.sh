#!/usr/bin/env bash
# Run the frozen sidecar. Weights stay external at $MAGENTA_HOME/magenta-rt-v2.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export MAGENTA_HOME="${MAGENTA_HOME:-$HOME/Documents/Magenta}"
echo "=== running frozen binary (MAGENTA_HOME=$MAGENTA_HOME) ==="
time "$HERE/dist/slipmate_infer/slipmate_infer"
