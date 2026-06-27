# Bluetooth / non-48 kHz output hardware checklist — output resampling

Manual verification of output resampling (ADR-0029): a device with no 48000/f32
config (a Bluetooth speaker, AirPods, many built-in outputs — all 44100) is now
opened at its own rate and the 48 kHz engine feed is resampled to it inside the
cpal callback. Device I/O cannot be e2e-automated: the resampling core
(`OutputResampler` in `device.rs`) and the config fallback (`pick_config`) have
the unit tests they can; this checklist is the last hop — real devices, real
clocks, real ears.

## Setup

- [x] `just tauri-dev`, app open, audio playing on at least one deck.
- [x] A 44.1 kHz output available: a **Bluetooth speaker** (e.g. Sony ULT FIELD 3,
      the motivating device) and/or **AirPods**.
- [x] A 48 kHz device also available (the **DDJ-FLX4** or a pro interface) to
      confirm the bit-exact path is untouched.

## The bug is fixed (the motivating case)

- [x] Connect the Bluetooth speaker; open the mixer's **Main output** picker — the
      speaker now **appears** in the list (it was absent before).
- [x] Select it. Audio plays — **no** "has no exact 48000/f32 output config"
      error.
- [x] Pitch and tempo are **correct** (a known track sounds at normal speed, not
      sharp/flat — proof the resample ratio is right, not a raw 48 k→44.1 k
      mis-play).
- [x] The startup/switch log line reads `rate=44100` for this device.

## The 48 kHz path is untouched (no regression)

- [x] Select the **FLX4** (or a 48 kHz interface) as Main output: audio plays as
      before; the log line reads `rate=48000`.
- [x] No audible change versus before this build on the 48 kHz device (it takes
      the bit-exact drain, no resampler).

## Quality

- [x] A few minutes of continuous playback on the Bluetooth speaker: **no**
      clicks, dropouts, pitch wobble, or growing latency/underruns.
- [x] A bright/full-range track sounds clean (no obvious aliasing harshness) on
      the resampled device.
- [x] Watch the dev console: **no** `assert_no_alloc` warnings from the audio
      callback while the resampled stream runs (rubato `process_into_buffer` must
      stay alloc-free on the RT path).

## Live device switching

- [x] Switch Main output **48 kHz → 44.1 kHz** (FLX4 → Bluetooth) while audio
      plays: it re-points cleanly, no crash, no stuck/looping audio.
- [x] Switch back **44.1 kHz → 48 kHz**: clean again.
- [x] Disconnect the Bluetooth speaker mid-playback: handled gracefully (error
      surfaced / falls back), no panic.

## Split cue at a non-48 kHz rate (ADR-0021 × ADR-0029)

- [x] Main output = a 48 kHz device, **Cue output = the Bluetooth speaker/AirPods**
      (a separate 44.1 kHz cue device): the cue plays out there at correct pitch;
      the master stays clean and is never interrupted by the cue-device change.

## Notes

- Bluetooth adds its own latency and its clock drifts against the engine; the
  output ring absorbs the drift (the resample ratio is fixed, the render thread
  paces to the ring). Occasional tiny artefacts under heavy Bluetooth congestion
  are the link's, not the resampler's.
