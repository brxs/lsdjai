# Native Migration — Implementation Plan

**Tauri v2 shell + Rust audio engine + Python inference sidecars.**

> **Status (2026-06-16): Phase 1 + Phase 2 implemented.** The Rust engine, the
> Tauri shell, the MIDI shim, the UI↔engine IPC, the inference sidecars over
> loopback TCP, native cue routing, and the packaging config are built and green
> under cargo/vitest/pytest; ADR-0003/0006/0007 are superseded and the backend
> cue sink is retired. End-to-end on real hardware + the documented follow-ups
> live in [`native-migration-hardware-checklist.md`](native-migration-hardware-checklist.md).

This is the *how*. The *why* lives in
[ADR-0017](adr/0017-native-rust-audio-engine-superseding-web-audio.md) (Rust
audio engine, supersedes ADR-0003),
[ADR-0018](adr/0018-native-macos-shell-tauri-with-python-sidecars.md) (Tauri
shell + Python sidecars, supersedes ADR-0002's deferral), and
[ADR-0019](adr/0019-pcm-transport-from-python-sidecars-to-the-rust-engine.md)
(PCM transport, supersedes protocol v0's browser consumer). The narrative and
the phase gate live in [`ROADMAP.md`](ROADMAP.md) under *Native migration*.

It is the committed **next phase**, run as one cohesive effort with feature work
paused. The ADRs are **Proposed, spike-gated** — Phase 0 must pass before the
full build commits.

## Guiding principles

- **Parity-or-better.** Every audio slice is verified against a *live Web Audio
  golden reference* before it replaces it. The Web Audio engine stays runnable
  through Phase 1 purely as the parity oracle; it is retired only at cutover.
- **Spike-gated.** No full build ahead of the Phase 0 verdict (M4/M14 tradition).
- **First ship gated on the Rust engine.** The native app never runs Web Audio in
  the shell — there is no WKWebView-audio interim and no Electron fallback.
- **The engine interface is the contract.** `frontend/src/audio/engine.ts`
  already defines `AudioEngine` and `DeckChannel` (the methods decks/mixer/cue
  call). The Rust engine implements that same surface so the React UI changes
  callsites (Web Audio → Tauri IPC), not its shape.
- **Measured, not assumed** — especially `fundsp`'s FX coverage and the RT feed.

## Target architecture

```
┌──────────────────────── Tauri process (Rust) ───────────────────────────┐
│  WKWebView  ── IPC ──►  audio engine (cpal/CoreAudio + fundsp Net)        │
│  (React UI)            ▲   ▲            │                                  │
│      │ tauri-plugin-midi│   │ rtrb (per deck, wait-free)  ──► device(s)   │
│      ▼ (midir/CoreMIDI) │   │                              main/booth/    │
│   FLX4  ◄───────────────┘   │ non-RT IO thread (decode)    FLX4 phones    │
│                             ▲                                              │
│  sidecar supervisor ──spawns│── transport (chosen in Spike A) ────────┐   │
└─────────────────────────────│──────────────────────────────────────│───┘
                              │                                       │
        ┌─────────────────────┴───────────┐         ┌─────────────────┴──────┐
        │ Python sidecar: deck worker A    │  ...    │ Python sidecar: sa3 gen │
        │ (PyInstaller; magenta_rt on MLX) │         │ (PyInstaller)           │
        └──────────────────────────────────┘         └────────────────────────┘
```

The Rust process owns: the WKWebView UI host, the audio engine, MIDI, the
transport's non-RT IO thread + ring handoff, and supervision of the Python
sidecars. Python is reduced to model inference (`engine.py` / `worker.py`
unchanged); it keeps emitting protocol-v0 PCM+control. The React UI emits
`ControlIntent`s/commands and renders telemetry.

## Repository structure changes

- **`src-tauri/`** — new. A cargo workspace:
  - `src-tauri/` — the Tauri app crate (`tauri.conf.json`, sidecar bundling,
    window, IPC commands, MIDI plugin wiring, supervisor).
  - `src-tauri/engine/` — the audio engine as a **library crate**, so it is
    testable headless (`cargo test`) without a window. This is where parity
    tests live.
- **`frontend/`** — stays; becomes the Tauri webview source. Vite still builds
  `dist/`, now embedded in the bundle instead of served by FastAPI.
- **`backend/`** — stays; becomes the sidecar source. `engine.py` and the
  `worker.py` loop are unchanged; the FastAPI controller's serving/WS/supervision
  role moves to Rust, and `cue.py` (sounddevice) is retired (native cue).

## Phase 0 — Feasibility spikes (the gate)

Three throwaway spikes, each with a pass/fail and a short measured write-up.
**All three green → the ADRs move Proposed → Accepted and Phase 1 commits.**

### Spike A — Rust audio core ([`spike-rust-audio.md`](spike-rust-audio.md))

The full executable spec — verified reference constants, the `fundsp` coverage
map, the precise parity method (bit-exact vs epsilon vs invariant), the RT-hazard
checklist, and the transport metrics — lives in
[`spike-rust-audio.md`](spike-rust-audio.md). In brief:

Stand up `cpal` + `fundsp` + `rtrb` and feed two decks of real PCM (replay
captured 48 kHz/stereo chunks, or a live sidecar from Spike B) → mix → device.

- **Transport selection (ADR-0019):** measure jitter/throughput for the
  candidate channels (loopback TCP/WebSocket reusing v0, Unix domain socket,
  shared-memory ring) and pick one. The RT discipline is fixed regardless:
  non-RT IO thread decodes into a per-deck `rtrb`; the `cpal` callback only
  drains it.
- **Parity, not just timing.** Render through `fundsp` and compare against a Web
  Audio golden render:
  - 3-band EQ (`eq.ts`: lowshelf 250 Hz, peak 1 kHz Q 0.7, highshelf 2.5 kHz;
    `eqValueToDb` → −40 dB kill at 0, 0 dB at 0.5, +6 dB at 1).
  - M17 limiter + clip guard (`master.ts`: compressor thr −6 dB, ratio 20,
    attack 2 ms, release 250 ms; **hard ceiling 0.9296875**) — confirm the
    ceiling and the makeup-gain cancellation hold.
  - One Color FX with the **ADR-0008 bit-exact bypass** inside the dead zone
    (`FX_DEAD_ZONE = 0.02`) — output must be sample-identical to dry.
  - A click-free FX swap via `Net::crossfade(Fade::Smooth, …)`.
- **Pass:** no underruns at the target buffer over a sustained run; bypass
  bit-exact; limiter ceiling matched; a transport chosen with measured jitter.
- **Fail path:** if `fundsp` can't reach parity on an effect, that effect drops
  to hand-rolled DSP (ADR-0017 alternative) — not a phase failure.

### Spike B — Sidecar packaging ([`spike-packaging.md`](spike-packaging.md))

**PASS (2026-06-15).** A PyInstaller ONEDIR freeze loads `mrt2_small` and
generates a valid chunk via MLX/Metal, byte-identical to native; the `mlx.metallib`
placement wall is solved in `build.sh`; bundle 931 MB (jax unavoidable via the
vendored `sequence_layers`); first-launch 23 s stall removed by codesign/notarize.
Full record in the linked doc. Original plan:

Freeze the backend (`magenta-rt[mlx]` + the `sa3_mlx` checkout) with PyInstaller
into a launchable binary that loads a model and streams a chunk.

- Confirm MLX/Metal works frozen; vendor the `sa3_mlx` checkout (pinned commit
  `bccf5b7`) rather than pip-freezing it.
- Measure bundle size and cold-start.
- **Pass:** the frozen sidecar streams PCM end-to-end and runs an sa3 render.
- **Fail path:** ship the sidecar unfrozen inside the bundle (heavier) and
  revisit.

### Spike C — MIDI through the shell (`native-migration-hardware-checklist.md`, first pass)

A bare Tauri window that connects the FLX4 via `tauri-plugin-midi`.

- Verify on the device: input (faders/pads/knobs), **position-query SysEx**, and
  **output (LED echo)** — the trio CLAUDE.md flags as the fragile spots.
- **Pass:** input + output + SysEx all confirmed on-device.

## Phase 1 — Audio engine (the bulk)

Build `src-tauri/engine/` as a library crate with a headless harness implementing
the `AudioEngine` / `DeckChannel` surface from `engine.ts`. Each slice is a
reviewable PR, parity-checked against the Web Audio reference.

| Slice | Replaces | Implements | Parity oracle |
| --- | --- | --- | --- |
| **1 — transport + player ring** | `player-worklet.js`, the `/ws/deck` consumer | chosen transport → per-deck `rtrb` → `cpal`; 30 s ring, 1.5 s prebuffer, stats; `postPcm` | M2 buffer-health stats |
| **2 — bare mix** | `eq.ts`, `master.ts`, crossfade in `engine.ts` | trim/volume, 3-band EQ, equal-power crossfade, limiter + clip guard | `verify_m6` (EQ), `verify_m17` (ceiling) analogs |
| **3 — Color FX insert** | `fxGraphs.ts`, `fx.ts`, `crusher-kernel.js` | the six effects mapped to `fundsp` (`reverb_stereo` for Space replaces the `ConvolverNode`; `shape`/custom for Crush; biquad/delay/fdn for the rest), pre-fader dry/wet, dead-zone bypass | ADR-0008 bit-exact bypass |
| **4 — buffer sources** | `loops.ts`/`loop-capture-kernel.js`, the M19 playback path, M21/M23 loops, M15 capture | freeze loops (4 slots, 0.03 s seam), playback decks (rate = varispeed), track loops, generated loops, style-sample capture | `verify_m13/m19/m20/m21/m23` analogs |

- **Telemetry out** to the UI via Tauri events/IPC: per-deck and master meters
  (`getLevel`/`getMasterLevel`/`getMasterGainReduction`), positions, ring fill +
  underrun counts, waveform peaks (`getTrackPeaks`).
- **Analysis stays in TypeScript** (ADR-0017): `beat.ts`/`beatgrid.ts`/`bands.ts`
  are pure `Float32Array` math fed *before* the audio graph today
  (`useDeck.ts:411–423`). Rewire their input to the new transport feed / engine
  telemetry; they do **not** move to Rust.

## Phase 2 — Shell + cutover

1. **Tauri scaffolding.** `src-tauri` app crate, `tauri.conf.json`, embed the
   Vite `dist/`, WKWebView window, IPC command surface mirroring `DeckChannel`.
2. **MIDI.** Replace only `createMidiLink` (`frontend/src/control/midi.ts:55–65`,
   the sole `navigator.requestMIDIAccess` callsite) to use `tauri-plugin-midi`'s
   shim. `flx4.ts`, `bus.ts`, `useMidi.ts` and the byte map are unchanged. Pin
   the plugin; wire its permissions.
3. **UI ↔ engine.** Swap the `DeckChannel` Web Audio calls in `useDeck.ts` /
   `audio/` callers for `invoke()` commands to the Rust engine — same interface,
   different transport. Keep the `ControlIntent` bus in TS (UI side); the engine
   exposes commands.
4. **Sidecars + supervision.** The Rust shell spawns/supervises the per-deck
   workers and the sa3 generator (replacing `controller.py`'s `DeckProcess`
   supervision), feeding them over the Phase-0 transport. Frontend serving moves
   from FastAPI to the Tauri asset host. `worker.py` + `engine.py` stay as the
   inference RPC.
5. **Slice 5 — native cue routing.** Main + booth + FLX4 phones (channels 3/4) as
   `cpal` streams / a CoreAudio aggregate device — replacing **both** the
   second-sink cue (ADR-0006) and the backend `sounddevice` sink (ADR-0007), and
   dropping `sounddevice` from `pyproject.toml`.
6. **Packaging.** `tauri build` → `.app`/`.dmg`; codesign + notarize (Apple
   Developer ID); first-run model-download UI preserving the `just setup` flow.
7. **Cutover.** The native app is the product; the browser/Web Audio path is
   retired and **ADR-0003/0006/0007 are superseded** (status flipped on the
   superseding ADRs' acceptance).

## Phase 3 — Unlocks (follow-on, post-ship)

- Integrate `ssstretch` (when mature) or vendor the Signalsmith single-header
  FFI; add a keylock toggle to varispeed; promote **M25 harmonic mixing advisory
  → corrective**. Off the critical path — first ship does not wait on it.

## Build, tooling & CI

- **`justfile`:** add `tauri-dev` (Tauri dev with the sidecar) and `tauri-build`
  (bundle + sign); keep `dev-frontend`/`dev-backend` for UI/inference iteration.
  `setup` gains the Rust toolchain, `tauri-cli`, and PyInstaller.
- **Rust:** cargo workspace; `cargo test` on the engine crate becomes the audio
  verify backbone; add `cargo clippy`/`fmt` to `lint`/`check`.
- **Frontend:** Vite still emits `dist/` (now consumed by Tauri); the dev `/ws` +
  `/api` proxy stays for inference iteration, but audio dev uses the Rust engine.

## Testing & verification (re-homing the verify corpus)

The `verify_m*.mjs` Playwright corpus exercised the Web Audio path. Re-home it:

- **Audio-path scripts** (`m2`, `m6`, `m13`, `m17`, `m18`, `m19`, `m20`, `m21`,
  `m23`) → Rust integration tests in the engine crate: underruns, **parity
  against the Web Audio golden render**, bit-exact bypass, limiter ceiling.
- **UI-only scripts** (`m3`, `m4`, `m5`, `m7`) → stay Playwright, now against the
  Tauri webview (or the dev frontend).
- **New:** `native-migration-hardware-checklist.md` for the packaged app — MIDI
  in/out/SysEx via `tauri-plugin-midi`, audio-device selection, FLX4 phones cue,
  first-run download, Gatekeeper launch.
- Keep the Web Audio golden-reference build alive through Phase 1 as the parity
  oracle; retire at cutover.

## Dependencies (justified per `.claude/rules/security.md`)

- **Rust:** `cpal`, `rtrb`, `fundsp`, `rubato` — reputable, maintained, pinned;
  `fundsp` coverage validated in Spike A. `ssstretch` (Phase 3) is v0.1, gated on
  maturity — vendor-ready.
- **Tauri:** `tauri` v2, `tauri-plugin-midi` (pinned; thin shim over mature
  `midir`; vendor/fork-ready).
- **Python:** drop `sounddevice` (cue is native); add PyInstaller (build-time).

## Risks & rollback

- **Parity drift across the rewrite** is the headline risk — mitigated by the
  golden-reference parity discipline (every slice diffed against Web Audio).
- Each slice is reversible: the Web Audio engine remains until cutover, so a slice
  that can't reach parity is a contained discussion, not a phase failure.
- Spike fail-paths are recorded above (hand-rolled DSP for an effect; unfrozen
  sidecar for packaging).

## Sequencing summary (the gate chain)

```
Phase 0  Spike A (audio+transport) │ Spike B (packaging) │ Spike C (MIDI)
            └──── all green ───────────────► ADRs 0017/0018/0019 Accepted
Phase 1  slice 1 → 2 → 3 → 4   (each parity-gated vs Web Audio)
Phase 2  shell → MIDI → UI↔engine → sidecars → slice 5 (cue) → package/sign
            └──── first native ship ───────► supersede ADR-0003/0006/0007
Phase 3  keylock / time-stretch            (post-ship, off critical path)
```
