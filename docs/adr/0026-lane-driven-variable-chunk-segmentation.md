# 0026. Lane-driven variable chunk segmentation for the modulation timeline

- **Status:** Proposed
- **Date:** 2026-06-27
- **Deciders:** Daniel Peter

## Context

The Harmony Lane / modulation timeline (issue #52) needs the generative
deck's chord, key, and drum state to change on *authored step
boundaries* — "I–V–vi–IV, two bars each, drop the drums for the
breakdown". The model constrains how:

- **MRT2 holds conditioning constant for a whole `generate()` call.**
  `system.py` builds the conditioning block once from `style`/`notes`/
  `drums`, then loops frames reusing it. A conditioning change therefore
  cannot happen mid-chunk; it requires a *new chunk*. Chunk size is ours
  to choose — any multiple of 40 ms (spike-mrt2.md).
- **The worker's pacing assumes a fixed chunk.** `worker.py` advances
  `pace_seconds += CHUNK_SECONDS` (`worker.py:199`) and derives the
  command-drain timeout from the pacing debt (`worker.py:56-61`), which
  needs the *next* chunk's duration known before it is generated.
  `engine.generate_chunk()` hardcodes `frames=FRAMES_PER_CHUNK`
  (`engine.py:146-156`).
- **The model has no clock.** Tempo is emergent and unsteerable
  (ADR-0004); the measured beat (ADR-0010) is one-second-gated,
  two-miss-droppable, and null during load — and steering harmony from
  the audio the beat tracker reads is a feedback loop.

ADR-0023 wired the note/drum channel but deliberately kept a fixed ~1 s
chunk and "the transport stays dumb", leaving the scheduler out of
scope: *"A step-sequencer/harmony-lane feature would push on [chunk
size] … out of scope here."* Making the chunk boundary *be* the step
boundary inverts who owns the deck's pacing — today `worker.py` owns a
fixed clock; with a lane armed, the lane owns a variable one. That is a
new, hard-to-reverse commitment, recorded here rather than folded back
into ADR-0023.

## Decision

- **When a lane is armed, it becomes the deck's chunk clock.** The deck
  stops emitting fixed 1 s chunks. The frontend resolves a forward
  **schedule** of per-step entries `{frames, notes:[128]|null, drums}`
  ahead of the worker's horizon and pushes it over ADR-0023's control
  channel as a new `set_schedule` / `clear_schedule` message. The worker
  pops one entry per loop, calls `generate(frames=…, notes=…, drums=…)`,
  and advances `pace_seconds` by *that step's actual seconds*. An empty
  or cleared schedule reverts to the free-running 1 s behaviour.
- **The lane is its own clock, not a measurement.** We do **not** slave
  the chord clock to `getLiveBeat()` — it is gated, droppable, null
  during load, and a feedback loop against injected harmony. Step
  durations authored in beats are converted using the lane's own counted
  tempo: authored intent, not a measurement. Beat detection stays a
  passive playhead read — `beat.ts` is hop-aligned at 512 samples and
  chunk-size-agnostic, so variable chunks are safe.
- **The wire carries resolved conditioning, not chords.** The frontend
  owns all music theory and the scheduler; the worker receives
  `{frames, notes, drums}` and is a dumb applicator. This keeps ADR-0002
  intact (only `engine.py` imports `magenta_rt`), keeps the chord mapper
  unit-testable, and extends ADR-0023's "the transport stays dumb" from a
  single held state to a forward schedule.
- **Pacing becomes per-step.** `engine.generate_chunk()` gains `frames=`/
  `notes=`/`drums=` (`engine.py:146-156`; `render_clip` untouched).
  `worker.py` increments `pace_seconds` by the actual step duration, not
  `CHUNK_SECONDS` (`worker.py:199`), and **pre-fetches the next step's
  frame count before computing the drain timeout** (`worker.py:56-61`) to
  resolve the chicken-and-egg the fixed-chunk math creates. Time-derived
  `chunk_index` accounting reads cumulative frames, not iteration count.
- **A minimum step floor** — tunable, ≈0.5 s on `mrt2_small`, validated
  per model against its RTF margin — prevents short steps starving the
  stream or exhausting the ~3 s `TARGET_AHEAD` cushion.
- **The schedule resets on stream discontinuity** (play, prime, stop,
  model switch, worker crash), clearing to free-running — the ADR-0009/
  0010/0023 rule.

## Consequences

- The modulation timeline becomes expressible: chord/key/drum changes
  land on authored step boundaries. **Honest scope:** the lane clocks
  *harmonic rhythm*, not the model's beat (ADR-0004) — a change lands
  on-time by the lane's clock but floats against the emergent groove.
- `worker.py`'s pacing gains a second mode (armed-lane vs free-running).
  The drain-timeout pre-fetch and cumulative-frame accounting are the
  subtle parts; getting them wrong reintroduces underruns or drifts the
  playhead — the most likely place to pass tests yet misbehave live.
- The schedule horizon against the ~3 s cushion means live edits land
  1–3 steps later, surfaced as "pending" steps (mirrors the existing
  `effective_from_chunk` honesty).
- Variable chunk sizes do **not** touch beat detection (hop-aligned) or
  the PCM transport (ADR-0019 frames PCM regardless of generate-chunk
  size) — verified, but a regression test pins it.
- This builds on ADR-0023's channel (`set_schedule` rides it) and on
  `generate_chunk` gaining `notes`/`drums`; it should be Accepted with or
  after ADR-0023, not before.

## Alternatives considered

- **Keep fixed 1 s chunks; change conditioning only at 1 s boundaries** —
  no variable segmentation. The lane could only turn chords on a 1 s grid
  and authored step durations (e.g. two bars) would never align.
  Rejected: it defeats the feature.
- **Slave the chord clock to the measured beat (ADR-0010)** — laggy,
  gated, null during load, and a feedback loop (injected harmony
  perturbs the tracker that would drive it). Rejected: the lane is
  authored intent; the beat is a passive read.
- **A per-frame note schedule inside one `generate()` call**
  (frames × 128 conditioning) — would give sub-chunk timing without
  variable chunks, but the exported mlxfn builds the conditioning block
  once per call and applies it to every frame (`system.py`); per-frame
  conditioning is not exposed. Rejected: unsupported by the model API,
  and per-step chunks already give the needed resolution.
- **Move the schedule and music theory into the worker** — would split
  theory across the stack, break ADR-0002's "only `engine.py` imports
  `magenta_rt`" cleanliness, and lose the unit-testable frontend mapper.
  Rejected: the frontend owns theory; the worker stays a dumb applicator.

<!-- Status values: Proposed | Accepted | Rejected | Deprecated |
     Superseded by ADR-NNNN -->
