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
