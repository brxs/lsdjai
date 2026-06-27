# Mixer cleanup checklist — record to top bar, outputs to settings

Manual verification of the mixer UX pass: output routing moved to Settings, the
record control moved to the top bar, the cue-mix knob moved between the cue
buttons, the limiter readout removed, and the channel signal meter aligned to the
fader. The state plumbing and the record/cue logic are unit-tested
(`MixerStrip.test.tsx`, `RecordControl.test.tsx`); this checklist is the last hop —
real window, real hardware, real audio.

## Setup

- [ ] `just tauri-dev`, app open, decks audible, mixer visible in the centre.

## Output routing → Settings

- [ ] Open Settings: an **Audio** section sits between Appearance and the model
      manager, with the **Main output** and **Cue output** pickers.
- [ ] Switching the main/cue device from Settings still routes audio (and a
      failed switch still surfaces its error and leaves audio undisturbed).
- [ ] The mixer no longer shows the output pickers.

## Record control (top bar)

- [ ] A **● REC** control sits next to Connect MIDI. At rest it's neutral.
- [ ] Click it: it goes **red**, the dot pulses, and the label shows the elapsed
      time (`REC 1:23`) ticking up.
- [ ] Click again (or trigger the hardware record button on the FLX4): recording
      stops and the WAV downloads. The control returns to its neutral ● REC rest
      state.
- [ ] The FLX4 hardware **record** mapping still toggles recording from the new
      top-bar control (the `record_toggle` intent moved out of the mixer).
- [ ] A recording failure surfaces an error rather than failing silently.

## Cue section

- [ ] Each deck's **Cue** button sits at the bottom of its channel strip, under
      the fader (its original position); it toggles the deck's headphone cue and
      lights when active.
- [ ] The **Cue mix** knob sits in the centre column, landing between the two
      cue buttons.

## Centre column + master meter

- [ ] The **master output meter** sits in the centre column between the two
      decks, labelled **MASTER** (no longer floating, unlabelled, on its own
      row).
- [ ] The old **Limiter** readout is gone (the limiter itself still protects the
      master bus — peaks are still caught, just not displayed).

## Fader + meter

- [ ] In each channel, the signal LED meter is the **same height as the fader
      well** beside it and aligned top-and-bottom — the fader's caption no longer
      pushes the meter down.
- [ ] The faders read as proper faders: a recessed centre groove with a cap that
      carries the deck's accent colour, and they still drag/keyboard normally.
