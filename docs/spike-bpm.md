# BPM steerability — spike findings

Measured 2026-06-10 on `mrt2_small` (script: `backend/scripts/spike_bpm.py`):
16 s generations of "driving techno, four on the floor, {N} bpm", tempo
estimated with librosa beat tracking (octave-tolerant, ±12%).

| Requested | Estimated | Tracks? |
| --------- | --------- | ------- |
| 90 bpm | 144.2 | ✗ |
| 120 bpm | 130.8 | ✓ |
| 150 bpm | 148.0 | ✓ |

**Conclusion:** prompt-based tempo steering is real but *partial* — the model
follows the hint within a style's plausible tempo range and ignores it
outside (techno refuses to crawl at 90). Per the roadmap's M4 rule ("the UI
only exposes the tempo control that actually works"):

- **Ship:** an optional per-deck *tempo hint* appended to the prompt text
  before embedding (`DeckEngine.set_style(bpm=…)`), labelled as a hint.
- **Don't ship:** per-deck nudge/sync, beat-matching, or anything implying
  the model obeys exact tempos. Revisit only if a future MRT exposes real
  tempo conditioning.

## Follow-up: injected beat clock (2026-06-10)

MRT2 also takes per-frame `drums` (and 128-pitch `notes`) conditioning with
its own CFG scale, so we tried steering tempo with a pulse train — a MIDI
clock in conditioning space (`backend/scripts/spike_midi_clock.py`,
`spike_midi_clock2.py`). 16 s generations, beat-tracked; the style's
natural tempo is ~131 bpm.

| Variant | 88 bpm | 100 bpm | 125 bpm | 150 bpm |
| ------- | ------ | ------- | ------- | ------- |
| drums pulse, `0` between ticks, cfg 4 | 131 ✗ | 131 ✗ | 131 ✓* | 131 ✗ |
| drums pulse, masked between ticks, cfg 4 | — | **104 ✓** | — | 131 ✗ |
| note-onset pulse (C2), cfg 4 | — | 131 ✗ | — | 131 ✗ |
| drums pulse, masked, cfg 7 | — | 131 ✗ | — | 131 ✗ |
| clock + matching text hint, cfg 7 | — | 131 ✗ | — | **144 ~** |

\* coincidence: 131 is within tolerance of the 125 request.

**Conclusion:** sparse pulse trains do not reliably entrain the model —
results scatter around the style's preferred tempo with occasional ±10%
pulls, and no variant reproduces across tempos. Likely the drums channel
was trained on dense activity derived from real audio (drums are "on"
nearly continuously in drum-driven music), so a 1-frame-in-15 click reads
as "mostly no drums", not as a clock. **No clock feature ships.** Worth
revisiting if upstream documents the conditioning's training distribution
or an example shows transcription-shaped conditioning steering rhythm.
