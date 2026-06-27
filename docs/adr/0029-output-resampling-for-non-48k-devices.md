# 0029. Output resampling for devices with no 48000/f32 config

- **Status:** Accepted
- **Date:** 2026-06-28
- **Deciders:** Daniel Peter

## Context

The engine renders at exactly `SAMPLE_RATE` = 48000 Hz / stereo / f32 (the model
sample rate; the whole mix graph, the recorder, and the shared audio clock are in
that domain). The cpal device wrapper
([`device.rs`](../../src-tauri/engine/src/device.rs)) opened a device only if it
reported an **exact** 48000/f32 config, and `pick_config` rejected anything else —
"resampling is out of scope" was a deliberate v1 limit
([ADR-0017](0017-native-rust-audio-engine-superseding-web-audio.md)).

That excludes common outputs. A Bluetooth speaker (the motivating case: Sony "ULT
FIELD 3"), AirPods, and many built-in outputs present to CoreAudio at **44100**,
not 48000, so the engine refused them:

> audio device unavailable: device 'ULT FIELD 3' has no exact 48000/f32 output
> config

The forces in tension:

- **Fidelity.** The master feed is the audience's sound. The codebase cares about
  bit-exact paths (the Color-FX bypass of
  [ADR-0008](0008-color-fx-as-one-knob-curves-at-a-pre-fader-insert.md); the
  48 kHz WAV recorder). Whatever we add must not degrade the existing 48 kHz path.
- **Real-time safety.** The cpal callback is the one RT path: alloc-, lock-, and
  syscall-free, proven by `assert_no_alloc`. Anything added there must hold that.
- **The host contract.** The render thread / output ring design
  ([`host.rs`](../../src-tauri/engine/src/host.rs)) is load-bearing; the ring is a
  clean 48 kHz interleaved-stereo hand-off. We do not want device-rate concerns
  leaking into it.

## Decision

We will **resample on the fallback path only**, in the **cpal device callback**,
using the **rubato** crate's synchronous FFT resampler.

- `pick_config` keeps choosing an exact **48000/f32** config first — that path is
  **untouched and bit-exact** (drain the ring straight into the device buffer). No
  resampler is even constructed for a 48 kHz device.
- When no 48000/f32 config exists, the device is opened at its own f32 rate
  (preferring its default/nominal rate, so the OS does not double-resample), and
  an `OutputResampler` converts 48000 → that rate per feed. The resampler (FFT
  plans + scratch) is built **off** the RT path; only rubato's documented
  alloc-free `process_into_buffer` runs in the callback, fed by the existing
  wait-free `OutputConsumer::drain_into`.
- rubato resamples in fixed chunks, but the cpal callback's block size is whatever
  the OS hands that call (some Bluetooth paths do not honour the requested
  `Fixed` size). A small **carry FIFO** inside `OutputResampler` decouples the two:
  it serves leftover resampled samples first, resamples as many chunks as the
  block needs, and stashes the tail of the last one — so any block size is served
  exactly, never a silently zeroed tail or dropped frame. A short input ring still
  surfaces as a counted output underrun (via `drain_into`).
- Resampling lives entirely on the **device side**. The output ring stays a 48 kHz
  contract; the render thread, telemetry, command protocol, and the master
  recorder (still 48 kHz, pre-resample) are unchanged.

rubato is pinned (`=3.0.0`), pulled with `default-features = false` and only the
`fft_resampler` feature — the `log` feature is kept **off** (rubato's own
real-time-safety requirement).

## Consequences

- Bluetooth speakers, AirPods, and 44.1k built-ins are now selectable and play at
  the correct pitch/tempo. The picker (`list_output_devices`) lists them.
- The 48 kHz path (FLX4, pro interfaces) is byte-for-byte as before — zero added
  cost or latency, no resampler instance.
- New dependency (rubato + its `audioadapter`/`realfft` transitive crates),
  justified per [`.claude/rules/security.md`](../../.claude/rules/security.md):
  reputable, maintained, pinned, no network/unsafe surface.
- The legacy `run_stream` (engine-in-callback, `device_run` binary / hardware
  spikes) does **not** resample; it now rejects a non-48000 default device rather
  than play it pitched wrong. The app path (`open_spread_stream`) is the resampled
  one.
- Combined master+cue on a ≥4-channel device that needs resampling builds a
  resampler per feed. In practice the only ≥4-channel device is the FLX4 (48 kHz
  native), so this is correctness insurance, not a hot path.
- Device behaviour can't be unit-tested (no device in CI): the resampling core has
  headless tests (frame-count ratio / no-drift, sine-energy preservation), and a
  human-ticked
  [`bluetooth-output-hardware-checklist.md`](../bluetooth-output-hardware-checklist.md)
  covers the real device.

## Alternatives considered

- **Resample on the render thread (per ring), callback untouched** — would make
  the output ring hold device-rate audio and leak the device rate into `host.rs`,
  its pacing constants, telemetry, and the command protocol (the rate must travel
  with each ring swap). Rejected: it muddies the load-bearing 48 kHz host contract
  to avoid touching a callback that rubato is explicitly designed to run inside.
- **Hand-rolled linear / cubic interpolation** (matching the deck varispeed of
  [ADR-0014](0014-beat-matching-via-varispeed-tracks-against-the-measured-stream.md))
  — no new dependency, but no anti-aliasing; lower fidelity than warranted for the
  master feed. Rejected in favour of rubato's quality.
- **Keep resampling out of scope** — leaves Bluetooth / 44.1k devices unusable,
  the actual reported bug. Rejected.
