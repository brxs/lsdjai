# Issue 47 hardware checklist — beat detection and track decode in the shell

Manual verification of the issue #47 cutover (ADR-0025 live beat analysis in
the Rust shell, ADR-0030 shell-side decode + offline analysis). The estimator,
gates, grid, and bands are unit-tested and the corpus gate is green; this
covers what only ears, a clock, and real files can:

- the readout and phase through the new IPC path — ADR-0025 names the
  phase-anchor frame-domain remap "the most likely to pass tests yet drift in
  the field";
- the load flow's error states — ADR-0030: decode failures changed shape
  (symphonia command errors instead of `decodeAudioData` rejections) and
  "cannot be fully verified by tests".

## Setup

- [ ] Native app via `just tauri-dev`, models installed, deck A playing a
      steadily rhythmic style (e.g. "driving techno, four on the floor"),
      given ~20 s to settle — acquisition is deliberately slow.
- [ ] A folder of real files at hand, one per allowlisted extension:
      `.wav`, `.aif`/`.aiff`, `.flac`, `.m4a`, `.mp3`, `.ogg` — plus one file
      the allowlist excludes (e.g. `.opus`) renamed to `.ogg`, and any
      non-audio file renamed to `.wav`.

## The live readout, through the Rust gate

The M14 semantics, now measured shell-side and round-tripped over the store.

- [ ] The BPM stat appears in deck A's health row within ~20 s and holds
      steady (no flicker between numbers); hand-count confirms it (or a clean
      metrical level of it — note which).
- [ ] Switch to a beatless style ("ambient drone, soft pads, no drums"): the
      readout blanks within a few seconds and stays blank. No number ever
      flashes for the drone.
- [ ] STOP blanks the readout immediately; play re-acquires from scratch.
      A model switch does the same.
- [ ] Deck B's readout is independent throughout.

## The phase anchor, at the speakers

The frame-domain remap (played-frames origin, engine time) is the named field
risk — the meter must tick with what you HEAR, not with the buffer lead.

- [ ] With a confident BPM showing, watch the Beat phase meter while tapping
      along at the speakers: the tick lands on the audible beat, not ahead
      of it.
- [ ] Leave the deck running ~5 minutes: the tick has not walked off the
      beat (no slow drift against your tapping).
- [ ] STOP → play: the meter re-anchors on the new stream, no stale phase.

## Beat-synced dub echo, now in the engine

- [ ] With a confident BPM showing, select Dub Echo and bring the knob up:
      the repeats sit ON the groove — the echoes land with your taps, not
      between them.
- [ ] Kill the readout (beatless style, or stop/start): the echo keeps
      working, free-running — no silence, no glitch at the moment sync
      engages or disengages.
- [ ] Load a gridded track onto the deck: the echo follows the TRACK's tempo
      the moment the load lands (the clock hand-off), and reverts to the live
      gate after "Back to live".

## Track loads, across the decoder switch

CoreAudio decoded anything; symphonia decodes the allowlist. Every format the
browser offers must actually load (ADR-0030: the allowlist mirrors the
features).

- [ ] Each of `.wav`, `.aif`/`.aiff`, `.flac`, `.m4a`, `.mp3`, `.ogg` loads:
      the deck enters playback, the waveform/band strip draws, duration and
      position read sane, and a rhythmic track shows a plausible BPM + grid
      ticks ("why no ticks?" answers itself in the shell stderr and the
      webview console).
- [ ] A 44.1 kHz file plays at correct pitch and speed (the offline resample
      path).

## Refusals are explicit, and leave the deck alone

- [ ] The mis-extensioned unsupported file: the load fails with the shell's
      reason visible in the browser row (e.g. "unsupported audio codec: …")
      — not a silent nothing, not a spinner.
- [ ] The non-audio file renamed `.wav`: an explicit "unsupported audio
      format" style error, same surfacing.
- [ ] A file over the 2 GB cap refuses with "file is too large" (fake one
      with `mkfile -n 3g big.wav` — it doubles as the non-audio case if you
      let it load).
- [ ] After every refusal above, the deck is exactly as it was: a rolling
      live deck kept rolling, a loaded track kept playing, nothing parked.

## Load-while-playing hand-off

- [ ] Load a track onto a ROLLING live deck: the stream parks (worker idles
      warm), the track takes over rolling — no gap of silence on the master
      beyond the hand-off itself, no leftover live audio.
- [ ] Load a second track while the first plays: the first stops, the second
      takes over rolling from the top.
- [ ] "Back to live" returns the deck to the stream; the live gate re-owns
      the readout (blank first, then re-acquire).

## Integration

- [ ] The other deck streams untouched through all of the above (zero new
      underruns in its health row).
- [ ] Recording while the synced echo runs on a loaded track: the WAV
      contains what was heard.

When every box ticks, close issue #47.
