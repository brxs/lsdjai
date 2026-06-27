# 0027. Headphone preview ("audition") for library items

- **Status:** Accepted
- **Date:** 2026-06-27
- **Deciders:** Jake Hartnell

## Context

The Media Explorer lets you load a generated song or sample onto a deck, but
there is no way to *hear* an item before committing it. A DJ wants to cue a
track in the headphones — auditioning it off-air — while a different track plays
out front, then decide whether to load it. Today the only monitoring path is the
per-deck pre-fade-listen (PFL) cue (`graph.rs`), which can only audition audio
that is *already loaded onto a deck*. There is no path to preview an arbitrary
library file.

The forces:

- The preview must be **audible in the phones but never in the master** — it is
  a private monitor, not a performance.
- It must work **regardless of what the decks are doing** (both decks can be
  playing out front), so it cannot borrow a deck or its PFL tap.
- It must stay **RT-safe**: decoding/allocating the preview buffer must not land
  on the audio callback, like every other load (`load_track`, ADR-0013).
- It should be **engine-wide and singular** — one preview at a time keeps the UI
  state ("which item is previewing") honest and the headphone feed uncluttered.

## Decision

We will add a single engine-wide **audition source**: a decoded buffer the
engine plays into the **cue/headphone feed only**, summed onto the cue output
*after* the cue/master blend so it is audible in the phones wherever the cue-mix
knob sits, and **never** mixed into the master. It loops the whole buffer until
stopped, so the UI's "previewing" state matches what the phones hear.

- `Engine::audition_play(samples)` / `audition_stop()` own an
  `Option<BufferSource>`; `render` pops one frame per sample and adds it to the
  cue feed (clip-guarded to the master ceiling). Built off the RT path like
  `load_track`; the render thread only reads.
- The `Host` carries it as fire-and-forget commands (`AuditionPlay(Vec<f32>)` /
  `AuditionStop`) over the existing command ring; the Tauri commands
  `audition_play` (raw-PCM binary IPC, no per-deck header) / `audition_stop`
  expose it; the frontend `AudioEngine` gains `auditionPlay(wav)` /
  `auditionStop()`.
- The Media Explorer puts a **🎧 cue button on every ready song/sample row**.
  One preview at a time: pressing another row switches, pressing the same row
  stops, and loading onto a deck or leaving the pane stops it.

## Consequences

- Auditioning is decoupled from the decks: you can preview a library item with
  both decks live, and the master is untouched.
- A new always-summed term enters the cue feed. It is clip-guarded, but it is
  another source the headphone bus carries; the master path is provably
  unaffected (covered by `audition_previews_into_the_cue_feed_only`).
- The preview is **not** routed through a deck's EQ/FX/trim — it is a flat
  monitor of the file. That is the intent (hear the source), but it means the
  preview level is not the channel-strip level; a future refinement could add a
  preview-gain control if the flat level proves too hot or quiet.
- Because the headphone path is real hardware, the cue routing cannot be fully
  covered by tests — see `docs/media-preview-hardware-checklist.md`.

## Alternatives considered

- **Reuse a deck's PFL tap** — load the item onto a deck and cue it. Rejected:
  it disturbs a deck (and its loaded track) just to preview, and fails the
  "both decks live" case the feature exists for.
- **Preview via Web Audio to the default output** — frontend-only, no engine
  change. Rejected: it plays out the default device (out loud, not isolated to
  the phones) and can bleed into the master path; wrong for a DJ monitor.
- **Per-deck audition buses** — one preview per deck. Rejected as needless: a
  single shared preview matches how a DJ auditions (one thing at a time) and
  keeps the UI state unambiguous.
