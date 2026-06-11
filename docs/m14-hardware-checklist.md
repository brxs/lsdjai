# M14 hardware checklist — beat detection by ear

Manual verification of the M14 exit criteria. The estimator, gate, and
consumer math are unit-tested and corpus-measured
([`spike-beat-detection.md`](spike-beat-detection.md)); this covers
what only ears and a clock can: the readout against a hand count, the
synced echo's lock, and quantised loops wrapping on the grid.

## Setup

- [ ] App open in Chromium, deck A playing a steadily rhythmic style
      (e.g. "driving techno, four on the floor"), given ~20 s to
      settle — acquisition is deliberately slow.

## The readout, against a hand count

- [ ] The BPM stat appears in deck A's health row within ~20 s and
      then holds steady (no flicker between numbers).
- [ ] Hand-count the tempo (tap along for 30 s; beats × 2). The
      readout matches within ±2 % — **or** sits on a clean metrical
      level of your count (double, half, 4:3 on shuffly material);
      note which.
- [ ] Hold the readout against the count for a full minute: it stays
      within tolerance the whole time.
- [ ] Switch deck A to an ambient/beatless style (e.g. "ambient drone,
      soft pads, no drums"): within a few seconds of the style taking
      over the stream the readout goes to — and stays there. No number
      ever flashes up for the drone.
- [ ] STOP blanks the readout immediately; play re-acquires from
      scratch.
- [ ] Deck B's readout is independent throughout.

## Synced dub echo

- [ ] With a confident BPM showing, select Dub Echo and bring the knob
      up: the repeats sit ON the groove — tap along; the echoes land
      with your taps, not between them.
- [ ] Kill the readout (switch to the beatless style, or stop/start):
      the echo keeps working, free-running — no silence, no glitch at
      the moment the sync engages or disengages.
- [ ] Ride the knob while synced: feedback and wet respond as before;
      parking at zero still lets the tail die and returns the stream
      to its dry self.

## Beat-quantised freeze loops

- [ ] With a confident BPM showing, freeze a SAMPLER pad: the loop
      wraps ON the beat — let it cycle ten times and tap along; it
      never drifts against your tapping.
- [ ] Without a BPM (beatless style or right after play), freezing
      still works at the raw loop length — the M13 behaviour
      unchanged.
- [ ] The loop-length picker still applies: 2 s vs 8 s captures
      audibly differ (each rounded to whole beats).

## Integration

- [ ] Recording while the synced echo runs: the WAV contains what was
      heard.
- [ ] The other deck streams untouched through all of the above (zero
      new underruns).

When every box ticks, flip M14 in [`ROADMAP.md`](ROADMAP.md) to ✅ done.
