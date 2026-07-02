# Issue #46 — note/drum steering: by-ear checklist

Issue #46 (ADR-0023) threads MRT2's note and drum conditioning through the
pipeline: engine → worker `set_notes`/`set_drums` → Rust `deck_set_notes`/
`deck_set_drums` → the webview's multihot mapper — driven end-to-end by the
MCP `set_notes`/`set_drums` tools through the store projection.

The unit tests cover the multihot mapping, the wire, the store, and the reset
rule with the model stubbed. **This checklist is the part tests can't reach**:
that non-empty notes audibly change what the real model plays versus
style-only, that drum suppression audibly works, and that steering at chunk
cadence never underruns. Tick a box only after hearing it on a real stream.

A steering change lands at the next chunk boundary but is *heard* only once
the deck's buffered audio drains — expect **~3–4 s** from tool call to ear
(the 1 s chunk plus the worker's ~3 s pacing cushion).

## Setup

- [ ] `just tauri-dev`, app open; connect an MCP client (Claude Code /
      Desktop) per **Settings → AI co-DJ (MCP)** — the `set_notes` and
      `set_drums` tools are listed.
- [ ] Deck A playing a style with clear pitched content (e.g. "warm dub
      chords") and drums (e.g. add "four on the floor techno").

## Note steering (chord-follow)

- [ ] `set_notes` deck 0 with a C-major triad (`pitches: [60, 64, 67]`):
      within ~4 s the harmony audibly re-centres on the chord versus what the
      style alone was playing.
- [ ] Move to an F-major triad (`[53, 57, 60]`): the harmony audibly follows
      the change.
- [ ] `set_notes` with `pitches: []`: the steering clears — the model drifts
      back to free harmony, not to silence (empty = masked, never all-off).
- [ ] The **`notes_applied`** status is visible in the sidecar log for each
      send (`effective_from_chunk` present).

## Note steering (onset mode)

- [ ] `set_notes` with `mode: "onset"` on a fresh pitch: an audible attack
      articulation lands (vs the smoother chord-follow entry).
- [ ] **Chord-follow constant (decision item):** chord-follow ships as wire
      state 3 (model decides attacks — `CHORD_FOLLOW_STATE` in
      `frontend/src/audio/notes.ts`). Compare it by ear against sustain (1)
      on a held chord; confirm 3, or flip the constant and record it here.

## Drum steering

- [ ] `set_drums` deck 0 `mode: "suppress"` on a drum-heavy style: the kit
      audibly thins/drops within ~4 s while the pitched content continues.
- [ ] `set_drums` `mode: "force"` on a sparse style: drums audibly enter.
- [ ] `set_drums` `mode: "auto"`: the model's own choice returns.

## Reset on discontinuities (ADR-0023)

- [ ] Steer a chord, **stop** the deck, play again: the steering is gone
      (free harmony), and the store snapshot (MCP interface-state resource)
      shows `notes: null` / `drums: null`.
- [ ] Steer a chord, **switch the model**: after the reload the steering is
      gone and the store agrees.
- [ ] Steer while **primed** (off air), then drop on air with PLAY: the
      steering *survives* — the drop is not a stream discontinuity.

## Transport projection (store-owned `playing`, folded into this issue)

The realtime transport moved to the ADR-0020 end state: the Rust store owns
`playing` (written by `deck_play`/`deck_stop` from any controller and dropped
by the status relay on worker death / model switch); the on-screen button is a
pure projection of the snapshot, one IPC round-trip behind the press.

- [ ] PLAY/STOP on screen and on the FLX4 pad: the button lights/unlights with
      no perceptible lag (the round-trip is local IPC) and **never flickers**
      while a deck is playing — the original issue-#74-era bug.
- [ ] Agent `deck_play`/`deck_stop` (MCP): the on-screen transport follows.
- [ ] Switch the model / kill a worker (`kill -9` the deck's sidecar) while
      playing: the transport unlights via the relay, and the MCP
      interface-state resource shows `playing: false`.

## Cadence / underruns

- [ ] Send a different `set_notes` chord roughly once per second for a
      minute on a playing deck: no audible glitches and the deck's underrun
      counter does not advance.
