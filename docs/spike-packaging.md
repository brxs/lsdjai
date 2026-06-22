# Spike B — PyInstaller sidecar packaging

**Status: PASS (2026-06-15).** Phase 0, Spike B of the
[native migration](native-migration-plan.md). Gates
[ADR-0018](adr/0018-native-macos-shell-tauri-with-python-sidecars.md). A
PyInstaller-frozen ONEDIR binary loads `mrt2_small` and generates a valid 1 s PCM
chunk via MLX/Metal — **byte-identical to the native venv** — proving the Python
inference backend can ship as a frozen Tauri sidecar. Harness:
`spike/packaging/` (`freeze_test.py`, `build.sh`, `run.sh`).

## Objective

Retire the biggest Phase-0 packaging unknown: can PyInstaller freeze the
MLX + `magenta_rt` stack (Python 3.13, native Metal/LLVM libs) into a launchable
sidecar that runs Metal inference, with the 4.3 GB weights kept external?

## Result (independently reproduced)

- **PASS.** `dist/lsdj_infer/lsdj_infer` (`frozen=True`) loads the model in
  ~1.5 s and generates a 1.0 s chunk in **0.33 s** (~3× realtime, full Metal speed,
  identical to native); 384000 bytes of valid interleaved-stereo f32, peak 0.333 —
  byte-identical to the unfrozen baseline. Re-run wall 2.13 s.
- **PyInstaller 6.21.0**, **ONEDIR** (onefile is unworkable at this size).

## The recipe (`build.sh`)

`pyinstaller --onedir --name lsdj_infer --paths backend --paths
magenta_rt/_vendor/sequence-layers --hidden-import lsdj.engine
--collect-submodules lsdj --collect-all mlx --collect-all mlx_metal
--collect-submodules magenta_rt --collect-submodules sequence_layers
--collect-submodules ai_edge_litert --collect-binaries ai_edge_litert
--copy-metadata magenta_rt freeze_test.py`, **plus the metallib fix**. Built and
ran on the first iteration. Two non-obvious load-bearing facts:

- `lsdj.engine` stays in `backend/` (never copied/modified) — reached via
  `--paths backend` + `--hidden-import lsdj.engine`.
- `sequence_layers` is vendored at `magenta_rt/_vendor/sequence-layers/` (a hyphen
  dir injected onto `sys.path` by a runtime `_vendor_hook`); PyInstaller can't
  follow that, so `--paths` points straight at it.

## The metallib wall — solved

`--collect-all mlx` puts the 157 MB `mlx.metallib` (+ `libmlx.dylib`,
`libjaccl.dylib`) under `_internal/mlx/lib/`, but MLX's
`get_colocated_mtllib_path` resolves it next to the **executable**. `build.sh`
copies all three next to the exe → MLX loads cleanly, **no "Failed to load the
default metallib."** Kernels are precompiled in the metallib, so there is no
runtime Metal compilation — and Metal + LLVM JIT ran with **no entitlements**
needed (PyInstaller adhoc-signs the binary).

## Findings for ADR-0018

1. **The sidecar is viable** — the biggest Phase-0 packaging unknown is retired.
2. **jax is unavoidable.** The recon hoped the MLX path needed no jax; in fact the
   vendored `sequence_layers.mlx` does a top-level `import jax`, so jaxlib
   (247 MB), flax, numba/llvmlite (110 MB, via `librosa` / `magenta_rt.audio`),
   tensorstore, and scipy all come along. Only `sklearn` (16 MB, bundled but
   unimported) is trimmable. **Bundle: 931 MB** per frozen backend.
3. **Two decks share one binary.** The two model workers spawn the same frozen
   binary twice — 931 MB once, not doubled. Weights (4.3 GB) stay external in
   `~/Documents/Magenta` (`MAGENTA_HOME`), never bundled.
4. **Codesign + notarize is load-bearing for UX, not just distribution.** First
   launch from a fresh install path stalls **23–34 s** — proven to be macOS
   Gatekeeper / `amfid` verifying the 931 MB adhoc-signed bundle once (a fresh
   `cp -R` reproduces 22.9 s; the next run is 1.18 s). The codesign + notarization
   ADR-0018 already plans pre-validates the bundle and removes the stall.
5. **sa3 is frozen-safe** (untested, per recon): it spawns its own external-venv
   subprocess (`backend/lsdj/sa3.py`), decoupled from this freeze.

## Verdict

**PASS.** PyInstaller ships the MLX inference backend as a ~931 MB ONEDIR sidecar
that runs Metal inference at native speed; the only real wall (metallib placement)
is solved in `build.sh`, and the first-launch stall is removed by the
codesign/notarize step ADR-0018 already requires. ADR-0018's "Python sidecar via
PyInstaller" premise holds — the remaining packaging work (Tauri sidecar wiring,
signing/notarization, first-run model download) is build engineering, not a
feasibility unknown.
