# 0015. Hot cues in deck state, loops on the buffer source

- **Status:** Proposed
- **Date:** 2026-06-13
- **Deciders:** Daniel Peter

> **Partially superseded by [ADR-0020](0020-rust-interface-state-store-and-mcp-server.md)
> (2026-06-28).** The *location* of hot-cue state moves out of React/TS deck state
> into the Rust interface store (issue #37 Phase 1). The other decision recorded
> here — loops live on the buffer source's native `loopStart`/`loopEnd` — stands.

## Context

M19 gave a deck a playback mode (ADR-0013) and M20 gave the loaded
track a beatgrid and varispeed (ADR-0014). M21 makes pads mean
*position*: the HOT CUE bank — style-target snaps on a realtime deck —
should set and jump cues on a playback deck, and the track should loop
beat-quantised regions.

Forces in tension:

- The engine channel owns exactly one `AudioBufferSourceNode` and all
  transport math anchors offsets against context time (`track.ts`,
  pure). A buffer source cannot pause or report a playhead; everything
  positional is *derived*.
- Looping has two candidate mechanisms: the source's native
  `loop`/`loopStart`/`loopEnd` (sample-accurate seams, wraps inside the
  render quantum) or restart scheduling from JS (timer jitter lands
  audibly on the seam).
- Web Audio's loop semantics have an edge: a source playing *past*
  `loopEnd` when `loop` flips on (or a source started past it) wraps
  back on the next position check — surprising re-entry, version-paged
  behaviour. Any design where a loop can be dormant-but-armed inherits
  that ambiguity.
- The M14 consumer rule (extended through M20): show nothing rather
  than a wrong number. A track without a confident grid must still cue
  and loop — just without pretending to know where the beats are.
- Every captured artefact so far is deliberately mortal (sampled style
  targets, ADR-0011; freeze loops die with their worker, ADR-0009).

## Decision

We will keep **hot cues as session-only deck state** (eight slots
mirroring the pad bank, in `useDeck`'s track state, dying with the
load) and implement a **jump as a plain seek** — the engine gains no
cue concept at all.

We will put **the loop on the buffer source's native
`loop`/`loopStart`/`loopEnd`**, owned by the engine channel alongside
the rate: the transport math folds elapsed time into the loop region
(pure, unit-tested), and the loop survives pause/resume and rate
changes exactly as the rate does (the ADR-0014 re-anchor pattern).

**Any seek exits the loop** — hot-cue jumps included. One rule, no
dormant-loop states, no dependence on the wrap-on-reach edge. The two
moments a playhead can sit outside the region get deterministic rules
rather than spec edges: **setting** a loop whose end the playhead has
already passed (a late OUT press snapping backwards) restarts the
source at the folded position with the loop applied; **clearing** a
loop re-anchors the transport on the folded position before the
source runs linear.

Quantise follows the consumer rule: with a confident grid, cue set and
loop in/out snap to the nearest beat (out additionally at least one
beat after in); without a grid, positions are free — but a loop still
owes a minimum length (sub-quantum regions are exactly where
implementations differ) — and no beat length is claimed. Grid
positions live in track seconds, so quantise is varispeed-free by
construction.

The HOT CUE bank's intent is renamed for the **physical gesture**
(`hot_cue_pad` — the panel label), because it is the first intent
whose meaning diverges per deck mode: the pure translator cannot know
the mode, so consumers decide — `applyAppIntent` routes playback decks
to cue set/jump (next to the `track_seek` precedent), DeckColumn keeps
the realtime style-snap meaning, now explicitly mode-gated (previously
a playback deck's pads still drove the parked worker's style cursor —
a latent bug this milestone retires). SHIFT+pad clears a cue via the
shift pad layer (`0x98`/`0x9A` — the firmware habit measured in M13);
the LOOP section maps at last as `track_loop_in/out/exit`
(`0x10`/`0x11`/`0x4D` per the Mixxx chart, monitor-verified like every
bank; the `track_` prefix keeps them clear of ADR-0009's freeze-loop
`loop_pad`/`loop_clear`).

## Consequences

- Easier: cues are trivially testable React state; jumping reuses the
  seek path (and its loop-exit rule) for free. The loop seam is the
  audio thread's job — no JS timer in the audible path.
- Easier: position-derived consumers (playhead, beat clock, phase
  meter, zoom view) stay truthful inside a loop because the *audio*
  actually folds — one loop-aware `positionAt` feeds them all.
- Harder: every place that re-anchors the transport (rate change, bend
  settle, pause) must thread the loop through, or the playhead drifts
  from the audible seam. The fold lives in one pure function to keep
  that one place.
- Accepted: a seek mid-loop drops the loop even when a DJ might expect
  re-entry (Serato keeps a dormant loop; CDJs vary). RELOOP is a
  later refinement if the device run wants it.
- Accepted: cues don't persist across loads — consistent with every
  captured artefact so far; a persistent library is a parked Later
  item.

## Alternatives considered

- **Cues in the engine channel** — rejected: a cue has no audio
  behaviour; it is a bookmark over the seek API. Engine state would
  duplicate React state for no fidelity gain.
- **Loop via JS restart scheduling** — rejected: `setTimeout` jitter
  (±tens of ms) lands directly on the loop seam every revolution; the
  native loop wraps sample-accurately inside the render quantum.
- **Loop survives seek (dormant when outside)** — rejected: inherits
  the wrap-on-reach edge for sources past `loopEnd`, and a dormant
  loop that silently re-arms is exactly the kind of surprise the
  honesty rules exist to prevent.
- **Quantise to the live deck's gated BPM when the track has no grid**
  — rejected: the live clock describes the *other* deck; snapping this
  track's cues to it fabricates a lattice the track never claimed.
