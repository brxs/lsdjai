# Native migration — hardware & integration checklist

Behaviour the automated suite (cargo / vitest / pytest) cannot reach: the live
Tauri webview, real audio devices, the FLX4, the model sidecars, and packaging.
Per [`CLAUDE.md`](../CLAUDE.md), a human ticks these before the work is "done".

Run the native stack with `just tauri-dev-native` (Tauri app + sidecars; needs
`just setup` for backend deps + model weights).

## Part 2 — MIDI (`tauri-plugin-midi`)

- [ ] FLX4 plugged in: the app sees it within ~1 s (the plugin's 1 s poll).
- [ ] Moving a knob/fader sends CC that reaches the mixer (input path).
- [ ] On connect the position-query SysEx fires and the controls sync.
- [ ] Pad LEDs light (output path) — feedback from the app reaches the hardware.
- [ ] Unplug + replug mid-set recovers without a permission prompt.

## Part 3 — UI ↔ engine over IPC

- [ ] Channel meters, master meter, and limiter-GR readout move with audio.
- [ ] EQ kills, volume, crossfade, and the six Color FX audibly match the Web
      Audio build (the parity oracle: same gestures, `just dev-frontend`).
- [ ] Trim (gain staging) and the on-air gate behave: off-air mutes the master
      feed but the channel meter stays live.
- [ ] Selecting / clearing an effect (FX-none) engages / removes it.
- [ ] Load a track: waveform overview renders, transport (play/pause/seek), the
      varispeed tempo, and a track loop work; the playhead is exact.
- [ ] Freeze pads, generated pads (one-shots + loops), and style-sample capture.
- [ ] Known gaps (documented stubs, not bugs): synced dub echo (`setBeatPeriod`),
      jog-wheel phase nudge, master recording — all show their stub behaviour
      (recording surfaces a handled error).

## Part 4 — Inference sidecars

- [ ] `SLIPMATE_SIDECARS=1`: each deck spawns `python -m slipmate.sidecar`; the
      Rust log shows the loopback port and the sidecar connecting.
- [ ] Audio generates: PCM streams sidecar → engine → speakers, no underruns
      (watch `engine_snapshot` deck-ring fill / underruns).
- [ ] Deck control reaches the worker: play/stop, set-prompt, set-style change
      the output within a few seconds.
- [ ] `sidecar://status` events surface in the webview (ready / chunk / errors).
- [ ] Killing a sidecar process emits `worker_died`; the deck goes silent without
      crashing the app. (In-process auto-restart / model-switch is a follow-up.)
- [ ] Quitting the app cleanly kills the sidecar processes (no orphans).

## Part 5 — Native cue routing

The engine derives a headphone-cue feed (PFL bus blended with master per the cue
mix) and the device routes it to channels 3/4 on a ≥4-channel output (the FLX4).
Replaces the second-sink cue (ADR-0006) and the backend `sounddevice` sink
(ADR-0007). (`sounddevice` + `cue.py` + `/ws/cue` are retired at cutover, part 7,
with the browser path that still depends on them.)

- [ ] FLX4 selected as the output: master plays on the main out (channels 1/2)
      and the cue plays on the phones jack (channels 3/4).
- [ ] Cue a deck (PFL): it is audible in the phones even when crossfaded fully
      out of the master.
- [ ] The cue-mix knob blends cue ↔ master in the phones (0 = cue, 1 = master).
- [ ] On a plain stereo output device the master is unaffected and the cue is
      simply absent (no crash, no glitch).
- [ ] Booth output (a third pair mirroring the master) — follow-up, not yet
      wired.

## Part 6 — Packaging (`docs/native-packaging.md`)

- [ ] `just freeze-sidecar` produces `src-tauri/sidecar-dist/slipmate_infer/`
      (~931 MB) and the frozen binary runs: `slipmate_infer --deck a --model
      mrt2_small --port <n>` connects to a listener and streams a chunk.
- [ ] The frozen sidecar is added as a Tauri `resources` entry and the packaged
      app spawns it (SLIPMATE_SIDECAR_CMD / resolved resource path).
- [ ] `just tauri-build` with the `APPLE_*` env set produces a signed, notarized,
      stapled `.app` + `.dmg` (entitlements applied; the sidecar tree signed).
- [ ] First launch on a clean Mac: Gatekeeper passes (no "unidentified
      developer"); the one-time scan completes; subsequent launches are fast.
- [ ] First run with NO weights: the model-download screen appears, downloads to
      `$MAGENTA_HOME/magenta-rt-v2`, then reveals the decks (preserves
      `just setup`).

## Part 7 — Cutover

The native app is the product; ADR-0003/0006/0007 are superseded; the backend cue
sink + `sounddevice` are removed. Deck control routes to the sidecars over IPC and
status arrives as `sidecar://status` events (`useDeck` selects this with
`isTauri()`).

- [ ] In the native app, deck play/stop and set-style reach the sidecar (audio
      responds) — no `/ws/deck` socket is opened.
- [ ] Sidecar status (ready / chunk / errors) drives the deck UI state.
- [ ] The browser dev path (`just dev-frontend`) still works as the parity oracle
      (control + status over the WebSocket, Web Audio mixing).
- [ ] Remaining native integration (follow-ups, need the live stack):
  - [x] Beat/loudness analysis fed from a sidecar/engine feature tap (the model
        PCM no longer transits the UI). — done: the sidecar reader tees model PCM
        over a per-deck Tauri Channel (`subscribe_deck_pcm`); `useDeck` pushes it
        to beat/loudness/band. On the live stack, verify:
    - [ ] The deck BPM (M14) detects from a live generative deck, same as web.
    - [ ] The live beat-phase meter + the zoom beat lattice (M20) track correctly
          and stay BLANK (not wrong) when stale — the native per-stream
          played-frame origin fix is timing math only checkable with live audio.
    - [ ] The `Channel` raw-bytes path delivers an `ArrayBuffer` on WKWebView
          (the less-battle-tested raw-RESPONSE direction); if it degrades, fall
          back to a base64/`Vec<u8>` framed encoding. Confirm the CSP allows it.
    - [ ] Auto-gain (M17) tracks loudness on the native deck.
  - [x] In-process model switch / sidecar restart (the model is fixed at spawn).
        — done: `deck_set_model` restarts the sidecar reusing the deck ring. On
        the live stack, verify: switching a deck's model reloads + plays the new
        model; no `worker_died`; the other deck is uninterrupted; a bad/missing
        model leaves the old sidecar running (bind/launch fails) or surfaces
        `worker_died` recoverable by re-selecting. Known follow-up: the old
        model's already-buffered ~3 s of ring PCM is not flushed on switch (needs
        an engine-side realtime-ring reset), so a brief old-model tail can play.
  - [ ] The sa3 pad/track HTTP generation path (`/api/render`, `/api/generate`)
        rehosted for the native app.
  - [ ] Remove the now-inert browser cue UI (phones picker / `cueStream`).
