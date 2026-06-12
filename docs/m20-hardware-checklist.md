# M20 hardware checklist — beatgrids and sync

Manual verification of the M20 exit criteria with the device and
ears. The measurable half is `verify_m20.mjs` (in `just verify-ui`);
this covers the audible lock, the platter feel, and the slider
orientation no script can judge (ADR-0014).

## Setup

- [ ] FLX4 connected (green LED), deck A streaming steady techno with
      a gated BPM showing, a composed techno track loaded on deck B
      and playing.

## Tempo and SYNC

- [ ] The FLX4 **tempo slider** on deck 2 rides deck B's rate: the
      BPM readout follows, the pitch audibly shifts with it (the
      varispeed trade-off, ADR-0014). **Check orientation**: Pioneer
      convention is down = faster — if it feels inverted, note it and
      flip the mapping in `tempoSliderToRate`.
- [ ] First touch of the slider jumps the rate to the slider's
      position (no soft-takeover — consistent with volume/EQ). Note
      if this is jarring in practice.
- [ ] **SYNC** on screen matches deck B's readout to deck A's gated
      BPM in one press; with the slider parked at an extreme so the
      target is out of range, SYNC refuses with the message instead
      of landing close.

## The audible lock (the exit criterion)

- [ ] With tempos matched, ride the **jog while playing**: each tick
      audibly drags/pushes the phase (~10 ms), the music bends — no
      clicks, no jumps. Judge the feel; note a better
      `JOG_NUDGE_SECONDS` if 10 ms is too fine or too coarse.
- [ ] Nudge until the kicks coincide: the **phase meter** needle sits
      centre when your ears say locked — the meter must agree with
      the room, not the wire (the buffer-lead correction, ADR-0014).
- [ ] The lock holds for **a minute** by ear with the meter steady;
      small drift corrects with single jog ticks.
- [ ] Pause deck B: the meter goes dark (no track clock); the jog
      reverts to seeking. Stop deck A's stream: dark again (no live
      clock). It must never show a confident needle without both.

## Grid honesty

- [ ] The beat ticks on deck B's overview line up with the audible
      kicks across the whole track (downbeats heavier).
- [ ] Load a beatless track (generate an ambient drone): no ticks, no
      meter, BPM dash — and SYNC still works if the *coarse* verdict
      exists, refuses honestly if not.

When every box ticks, flip M20's status in [`ROADMAP.md`](ROADMAP.md)
to ✅ done and ADR-0014 to Accepted.
