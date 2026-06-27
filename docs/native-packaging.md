# Native packaging (Phase 2 part 6)

How LSDJai ships as a signed, notarized macOS `.app`/`.dmg` with the Python
inference sidecar bundled and the model weights kept external. This is **build
engineering** — the research risk was retired by Spike B
([`docs/spike-packaging.md`](spike-packaging.md), the PyInstaller MLX freeze) and
Spike C ([`docs/spike-c-midi.md`](spike-c-midi.md), the Tauri MIDI app) — so the
steps below are reproducible on a Mac with an Apple Developer ID. They are NOT
runnable in CI (no signing certificate, no notarization), so the end-to-end build
is a [checklist](native-migration-hardware-checklist.md) item.

## 1. Freeze the inference sidecar

```sh
just setup                 # backend .venv with pyinstaller + inference deps
just freeze-sidecar        # → src-tauri/sidecar-dist/lsdj_infer/ (~931 MB)
```

`scripts/freeze-sidecar.sh` is the production form of the Spike B recipe; the only
change is the entry point (`backend/lsdj/sidecar.py`). ONEDIR (onefile is
unworkable at this size); the metallib is copied next to the exe (the Spike B
"wall"). The 4.3 GB weights are **not** frozen — they stay external (§4).

## 2. Bundle the sidecar into the app

Add the frozen ONEDIR as a Tauri **resource** (a directory, not a single
`externalBin`, because the payload is a tree of dylibs):

```jsonc
// src-tauri/tauri.conf.json → "bundle"
"resources": { "sidecar-dist/lsdj_infer": "lsdj_infer" }
```

At runtime the shell resolves the bundled binary and spawns it. In dev, point the
shell at the freeze directly instead of bundling:

```sh
LSDJ_SIDECAR_CMD="$PWD/src-tauri/sidecar-dist/lsdj_infer/lsdj_infer" \
  just tauri-dev
```

`src-tauri/src/sidecar.rs` (`sidecar_command`) reads `LSDJ_SIDECAR_CMD`;
packaging sets it to the resolved resource path (or the app resolves
`resource_dir()/lsdj_infer/lsdj_infer`). The committed config does **not**
declare the resource, so a UI-only `tauri build` (no freeze) still succeeds — add
the `resources` entry above once the freeze exists.

## 3. Codesign + notarize (Developer ID)

The bundle ships hardened-runtime entitlements
([`src-tauri/entitlements.plist`](../src-tauri/entitlements.plist): JIT for
WKWebView + MLX/LLVM, library validation disabled for the adhoc-signed sidecar
dylibs). `tauri build` signs + notarizes when these env vars are set (Tauri drives
`codesign` + `notarytool`):

```sh
export APPLE_SIGNING_IDENTITY="Developer ID Application: … (TEAMID)"
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="app-specific-password"   # or APPLE_API_KEY/_ISSUER
export APPLE_TEAM_ID="TEAMID"
just tauri-build                                 # → .app + .dmg, signed + stapled
```

The bundled sidecar must itself be signed (PyInstaller adhoc-signs it; re-sign
with the Developer ID + the same entitlements, or sign the whole `.app` tree with
`--deep` and staple). First launch runs a one-time Gatekeeper scan of the ~931 MB
bundle (Spike B measured ~23 s cold, ~1 s thereafter); notarization is what keeps
that a one-time cost rather than a per-launch block.

## 4. First-run model install (the in-app model manager)

The weights live outside the bundle at `$MAGENTA_HOME/magenta-rt-v2` (default the
app-owned `~/Library/Application Support/LSDJai`; see [`CLAUDE.md`](../CLAUDE.md)).
There is no terminal install path — models install **in-app** from the settings
drawer (issue #43). The packaged app follows this flow on first run:

1. On launch, check whether `$MAGENTA_HOME/magenta-rt-v2/<model>` exists.
2. If absent, show the first-run download screen instead of the decks (the
   sidecars are not spawned until weights are present — a missing model is the
   existing graceful "sidecar spawn fails → silent deck" path, surfaced as UI).
3. Trigger the download via the frozen sidecar / `mrt` tooling and show progress.
4. On completion, spawn the sidecars and reveal the decks.

The check + the download orchestration reuse the `mrt models` CLI the backend
already wraps — no new inference code. Wiring this screen is tracked on the
checklist (it needs the live model tooling to verify).

**Realised by the in-app model manager (issue #43).** This first-run flow is now
the model manager (a settings-drawer panel), so the same machinery serves both a
fresh install and later top-ups:

- The packaged download runs the frozen sidecar in a non-deck mode —
  `lsdj_infer --init-resources` then `lsdj_infer --download-model <name>` — which
  reuses the `magenta_rt.cli.models_commands` code path and emits JSON progress
  the Rust shell relays to the UI. The init step is what makes a freshly
  downloaded model *loadable*: a model's two files (`<name>.mlxfn` +
  `<name>_state.safetensors`) are not enough without the shared
  `resources/musiccoca` + `resources/spectrostream`.
- That download path pulls `huggingface_hub` / `fsspec` / `click`, which the deck
  sidecar never imports, so they are collected explicitly in
  [`scripts/freeze-sidecar.sh`](../scripts/freeze-sidecar.sh) (`--collect-all
  huggingface_hub`, `--collect-all fsspec`, `--hidden-import click`). A missing
  collection only fails at runtime in the packaged app — hence the checklist
  item below, which static analysis cannot cover.
- Stable Audio 3 installs in-app too, into the app-owned data dir
  (`~/Library/Application Support/LSDJai/stable-audio-3`, the resolver's first
  candidate): the Rust shell fetches the pinned source
  ([`sa3-pin.json`](../sa3-pin.json)) as a tarball (`curl`), extracts it (`tar`),
  and runs [`scripts/sa3-install.sh`](../scripts/sa3-install.sh) — build+warm
  steps with no git, no tty, no system Python 3.11 (`install.sh -y --python
  3.11`). Both families' weights move there with `just migrate-models`.
