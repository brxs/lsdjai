# Issue 77 live-audio validation checklist

Use a generated stream on both decks and the normal audio-output path. Record
the date, machine/output device, model, prompts, and observations. A displayed
metrical level such as half, double, 2:3, 3:4, 4:3, or 3:2 counts as correct;
an arbitrary or stale number does not.

## Setup

- [x] Build and launch the app from commit `3109e4e` or later with the issue-77
  corpus gate green.
- [x] Record macOS version, machine, output device/rate, model, and prompts.
- [x] Confirm both decks generate and play cleanly before judging analysis.

## Acquisition and honesty

- [x] On a straight four-on-the-floor stream, BPM appears within roughly ten
  seconds of audible rhythm and is a defensible metrical match.
- [x] Repeat with breakbeat/jungle, swung/2-step, and sparse/minimal percussion;
  each acquires within roughly ten seconds without flashing an arbitrary BPM.
- [x] Play at least 30 seconds of a beatless drone/soundscape; BPM and phase stay
  blank throughout.

## Change and reset behaviour

- [x] Change from a slower straight rhythm to a clearly faster non-equivalent
  rhythm; the stale BPM lasts no more than one displayed tick and the new
  metrical clock appears within eight seconds.
- [x] Repeat from faster to slower with the same limits.
- [x] Stop and restart a deck; BPM/phase clear immediately and reacquire only
  from the new stream.
- [x] Switch model while playing; no BPM or phase state leaks across the stream
  boundary.

## Existing consumers

- [x] Phase meter resumes on the audible beat after acquisition and disappears
  whenever BPM is blank.
- [x] Synced dub echo remains musical at the displayed metrical level and falls
  back cleanly while BPM is blank.
- [x] Beat-quantised loops/freeze pads still land consistently after
  acquisition; blank analysis uses the existing free-running fallback.
- [x] No new audio dropouts, UI stalls, or sustained CPU spike are audible
  while both decks analyse concurrently.

## Result

- Date: 2026-07-10
- Tester: Daniel Peter (owner)
- Machine / macOS: MacBook Pro Mac17,2 / Apple M5 / macOS 26.5.1
- Output device / sample rate: MacBook Pro Speakers / 48 kHz
- Model and prompts: `mrt2_small`; representative straight, breakbeat/jungle,
  swung/2-step, sparse/minimal, beatless, and opposed tempo-change cases above
- Result: [x] pass  [ ] fail
- Notes: Owner completed the remaining listening pass and confirmed everything
  behaved correctly.

## Automated native-session evidence (2026-07-10)

This is real app/model/output-path evidence, not a substitute for the remaining
listening judgements above.

- App linked from a clean `lsdj-app` rebuild on a MacBook Pro Mac17,2 / Apple M5
  / macOS 26.5.1 and opened the MacBook Pro Speakers at 48 kHz / 256 frames;
  both `mrt2_small` workers loaded and warmed up.
- Deck B ran at 0.25 volume with `straight four on the floor house drums with
  crisp kick and hi hats`; the published live state reached 130.13 BPM at 0.881
  confidence with a live-beat BPM of 130.13.
- After stop, published BPM, confidence, and live beat cleared immediately.
- A fresh `ambient drone, soft pads, no drums` realtime run remained at null BPM
  / 0 confidence after 35 seconds, then stop again cleared state.
- The app was shut down cleanly after automated validation. The owner
  subsequently completed and passed the human listening checks above.
