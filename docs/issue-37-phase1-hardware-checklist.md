# Issue #37 Phase 1 — interface-state inversion: hardware checklist

Phase 1 of issue #37 (ADR-0020) inverts interface-state ownership: a shell-level
Rust `InterfaceStore` becomes the single source of truth for the instrument's
semantic / audio-param state, and the webview becomes a projection of it. The unit
and integration tests cover the store mutations, the projection hooks, and the
existing control surface; **this checklist is the part tests can't reach** — that
the operator cannot tell the inversion happened, from the screen *and* from the
FLX4, with real audio.

It is a **living checklist**: Phase 1 lands as a sequence of green slices, so each
section is marked with the slice that makes it checkable. Tick a section only once
its slice has landed.

## Setup

- [ ] `just tauri-dev`, app open, both decks audible, mixer visible in the centre,
      FLX4 connected (Connect MIDI lit).

## Store foundation + global mixer projection — **landed**

The store records every mixer mutation and emits `store://changed`; App projects
the crossfade and cue-mix from it (optimistic during a drag, reconciled to the
store).

- [ ] **Crossfader, screen.** Drag the on-screen crossfader end to end: the audio
      blends A↔B smoothly with no stutter or lag, exactly as before.
- [ ] **Crossfader, hardware.** Move the FLX4 crossfader: the on-screen crossfader
      follows it and the audio blends — UI and hardware drive the same value.
- [ ] **Cue mix, screen + hardware.** Move the cue-mix control (screen) and the
      FLX4 HEADPHONES MIX knob: the headphone blend shifts cue↔master and the
      on-screen control tracks the knob.
- [ ] **No boot flash.** On launch the crossfader and cue-mix sit at their
      persisted positions immediately — no visible jump from a centre default.
- [ ] **Persistence.** Move both, quit, relaunch: they restore where you left them.

## Per-deck mixer projection — **landed**

useDeck projects volume/EQ/CUE/FX/trim from the store and adopts external store
changes (the future MCP writer) via a synced-gate reconcile.

- [ ] Volume faders, the three EQ knobs, TRIM, CUE, and the Color FX knob/bank all
      behave exactly as before from the screen and the FLX4; high-rate sweeps stay
      smooth (the optimistic local render).

## Realtime model/playing + hot cues + track identity — **landed (write-only mirrors)**

These are *read-back* state the webview derives and writes UP into the store for a
future MCP read; there is **no operator-facing change** in Phase 1 (nothing reads
them back into the UI). So the only check is that nothing regressed:

- [ ] Play/stop, model switching, hot-cue set/jump/clear, and loading/unloading a
      track all behave exactly as before. (Cue state location moved to the store
      per ADR-0015 → ADR-0020, but the set/jump logic and the operator experience
      are unchanged.)

## Style targets+cursor projection, loop labels, full bidirectional projection — *pending (later slices / Phase 2)*

- [ ] The 2D style pad and prompt edits behave as before once style targets+cursor
      project from the store.
- [ ] (Phase 2) An MCP agent can *set* a cue / move the style cursor and the UI
      follows — the bidirectional projection of the mirrored state.

## Whole-instrument regression — *run once all slices land*

- [ ] A full pass: generate, blend, EQ-kill, Color FX, freeze/sample pads, load and
      beat-match a track, hot cues and loops — all from the FLX4 — behaves exactly
      as the pre-inversion build. The inversion is invisible to the operator.
