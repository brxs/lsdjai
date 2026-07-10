# Issue 77 live-audio validation checklist

Use a generated stream on both decks and the normal audio-output path. Record
the date, machine/output device, model, prompts, and observations. A displayed
metrical level such as half, double, 2:3, 3:4, 4:3, or 3:2 counts as correct;
an arbitrary or stale number does not.

## Setup

- [ ] Build and launch the app from commit `3109e4e` or later with the issue-77
  corpus gate green.
- [ ] Record macOS version, machine, output device/rate, model, and prompts.
- [ ] Confirm both decks generate and play cleanly before judging analysis.

## Acquisition and honesty

- [ ] On a straight four-on-the-floor stream, BPM appears within roughly ten
  seconds of audible rhythm and is a defensible metrical match.
- [ ] Repeat with breakbeat/jungle, swung/2-step, and sparse/minimal percussion;
  each acquires within roughly ten seconds without flashing an arbitrary BPM.
- [ ] Play at least 30 seconds of a beatless drone/soundscape; BPM and phase stay
  blank throughout.

## Change and reset behaviour

- [ ] Change from a slower straight rhythm to a clearly faster non-equivalent
  rhythm; the stale BPM lasts no more than one displayed tick and the new
  metrical clock appears within eight seconds.
- [ ] Repeat from faster to slower with the same limits.
- [ ] Stop and restart a deck; BPM/phase clear immediately and reacquire only
  from the new stream.
- [ ] Switch model while playing; no BPM or phase state leaks across the stream
  boundary.

## Existing consumers

- [ ] Phase meter resumes on the audible beat after acquisition and disappears
  whenever BPM is blank.
- [ ] Synced dub echo remains musical at the displayed metrical level and falls
  back cleanly while BPM is blank.
- [ ] Beat-quantised loops/freeze pads still land consistently after
  acquisition; blank analysis uses the existing free-running fallback.
- [ ] No new audio dropouts, UI stalls, or sustained CPU spike are audible
  while both decks analyse concurrently.

## Result

- Date:
- Tester:
- Machine / macOS:
- Output device / sample rate:
- Model and prompts:
- Result: [ ] pass  [ ] fail
- Notes:
