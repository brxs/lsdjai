# 0023. MIDI note and drum conditioning over the deck control channel

- **Status:** Proposed
- **Date:** 2026-06-27
- **Deciders:** Daniel Peter

## Context

MRT2 exposes two conditioning axes besides style: a per-frame **note**
signal — a 128-pitch multihot (`0` off, `1` sustain, `2` onset, `3`
model-decides) injected every 40 ms codec frame — and a **drum**
suppression flag that lets a deck sit beside another. `magenta_rt`'s
`generate()` already accepts `notes=` and `drums=` (spike-mrt2.md), but
LSDJ never passes them: `engine.generate_chunk()` calls `generate` with
`style=` only ([engine.py:154](../../backend/lsdj/engine.py)), and the
worker's control loop handles `set_prompt`/`set_style` and nothing else
([worker.py:122](../../backend/lsdj/worker.py)). A whole expressive axis —
harmony/melody steering, drum-sit layering, harmonic auto-mix — is dark.

The forces that decide *how* we wire it:

- **A control channel already exists and fits.** Style updates travel as
  framed JSON (`FRAME_CONTROL`) over the per-deck socket: frontend
  `send()` → `deck_set_style` → `Sidecars::send()` → a daemon pump thread
  enqueues to the worker's `cmd_queue`, which the generation loop drains
  between chunks (sidecar.rs, sidecar.py, worker.py). It is already
  streaming-capable and loss-order-sensitive only if we make it so.
- **Note input changes at performance rate, not per frame.** A held chord
  is stable for many frames; a human press/release is an occasional event,
  not a 25-messages-per-second stream.
- **The beat clock lives in the frontend** (ADR-0010, ADR-0017). The worker
  has no tempo; anything that wants note changes to land on a bar must
  align where the clock is, not in the worker.
- **Commands apply at chunk boundaries.** The worker drains the queue, then
  generates `FRAMES_PER_CHUNK` (25 = 1 s today). Steering latency is
  therefore the chunk size, and chunk size is ours to choose (any multiple
  of 40 ms; RTF is per-frame-dominated — spike-mrt2.md).

## Decision

- **Reuse the existing control channel; add two state-carrying kinds.**
  Note and drum conditioning travel as new JSON control messages —
  `set_notes` (the full current 128-multihot) and `set_drums` (the flag) —
  over the same `FRAME_CONTROL` framing style already uses, with matching
  `deck_set_notes` / `deck_set_drums` Tauri commands. ADR-0019's framing
  carries them; no new transport.
- **Messages carry state, not deltas.** `set_notes` replaces the deck's
  current multihot wholesale; `set_drums` sets the flag. Each message is
  idempotent, so a dropped or reordered frame cannot desync held notes —
  the property `set_style` already relies on.
- **The engine holds current note/drum state and applies it every chunk.**
  `generate_chunk()` passes the held `notes`/`drums` into `generate()`
  alongside `style`, exactly as it threads the persistent style blend. State
  persists until changed.
- **Conditioning takes effect at the next chunk boundary; a steered deck may
  shrink its chunk.** Default decks keep the 1 s chunk. A deck in a
  performance/steering mode reduces `FRAMES_PER_CHUNK` toward ~5 frames
  (200 ms) to buy responsiveness — cheap in RTF, paid only in
  message/`generate()` rate. Chunk size becomes a per-deck, mode-dependent
  knob.
- **Default note mode is chord-follow; onset is opt-in.** Held notes map to
  `sustain`; the model picks attacks — forgiving for held chords. A
  performance surface that wants its own timing marks `onset` on the chunk
  carrying a fresh press. The UI→multihot mapping lives in the engine.
- **Beat alignment is the consumer's job.** The channel ships note state the
  moment it changes; features that want a change on a bar quantise *when
  they send*, against the deck's existing frontend beat clock
  (`liveBeatRef`) — the way the dub echo and freeze captures align to beats
  in ADR-0010. The transport stays dumb.
- **Note/drum state resets on stream discontinuities** — play, prime, stop,
  model switch, worker crash — the rule freeze captures (ADR-0009) and the
  beat gate (ADR-0010) already follow.

## Consequences

- A new steering source — pads, a keyboard, the on-screen overlay, harmonic
  auto-mix — is "build a 128-multihot and call `setNotes`": no protocol or
  engine-signature churn past this ADR. State-not-deltas makes it
  crash/restart-safe like style.
- The 1 s default chunk means ~1 s steering latency unless a deck opts into
  a smaller chunk; smaller chunks raise control-message and per-call
  overhead (more `generate()` calls/s) without moving RTF.
- Adds two control kinds, two Tauri commands, and note/drum fields on the
  engine state and the `generate()` call; the worker's command dispatch
  grows two branches.
- Frame-exact onset *sequences* are bounded by chunk size — a chunk spanning
  many frames cannot express a different onset per 40 ms frame. A
  step-sequencer/harmony-lane feature would push on this with a smaller
  chunk or a per-chunk note schedule; out of scope here.

## Alternatives considered

- **A separate high-rate (per-frame) note channel** — rejected: human note
  input changes at performance rate, the framed control channel already
  delivers state changes promptly, and per-frame fidelity (if ever needed)
  is a chunk-size or per-chunk-schedule change, not a new transport.
- **Note on/off deltas instead of full multihot** — rejected: a dropped or
  reordered event desyncs held state; idempotent full-state messages match
  `set_style` and survive worker restarts.
- **Aligning notes to the beat inside the worker** — rejected: tempo lives
  in the frontend (ADR-0010/0017); a second clock in the worker splits beat
  state across processes, the coupling ADR-0010 deliberately avoided.
  Consumers quantise on send.
- **Defaulting to onset/performance mode** — rejected: chord-follow is the
  forgiving default for held input; onset is opt-in where timing is the
  point.

<!-- Status values: Proposed | Accepted | Rejected | Deprecated |
     Superseded by ADR-NNNN -->
