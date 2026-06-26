# 0021. Split master and cue to independent output devices (dual-mode)

- **Status:** Accepted
- **Date:** 2026-06-26
- **Deciders:** Daniel Peter

## Context

Pre-fade listening needs two simultaneous, independent stereo outputs: the
master mix for the audience and a private cue feed for the DJ's headphones. The
native Rust engine already renders both as separate stereo feeds every block
(`render_with_cue`) into two rings (master + cue).

But the device layer collapsed them onto **one** cpal output stream (the single
combined stream, then `run_host_stream`): master on channels 1/2 and cue on
channels 3/4 of a single device, and only when that device reports ≥4 channels.
That topology came from
[ADR-0017](0017-native-rust-audio-engine-superseding-web-audio.md), which
superseded the Web-Audio two-sink design of
[ADR-0006](0006-cue-output-via-a-second-audio-sink.md) and the FLX4-phones plan
of [ADR-0007](0007-flx4-phones-jack-via-a-backend-cue-sink.md).

The cost: the cue is **locked to the master's physical device**. A typical
"speakers/interface on 1/2 + headphones on the laptop jack" rig has nowhere to
put the cue (the master device has no channels 3/4), so the cue is silent. The
DJ can only cue when the master device is the one ≥4-channel device (the FLX4).

The constraint that shapes the fix: cpal can't target channels 3/4 of a device
from a second stream — a stream always writes from channel 0. So the FLX4's own
phones jack (3/4 of its single USB device) *requires* the combined stream; it
cannot be reached by opening a second stereo stream on the same device.

## Decision

We will run **two output streams** with a derived **dual-mode** topology:

- **Combined mode** (cue device = "same as main", and the main device is ≥4
  channels): one stream drains master → 1/2 and cue → 3/4. This is the FLX4
  one-cable path, kept bit-for-bit, and the default at startup.
- **Split mode** (cue device = a different device): a second cpal stream opens on
  the cue device and drains the cue ring → its channels 1/2 on a stereo device
  (laptop jack, Bluetooth), or → channels **3/4** on a ≥4-channel cue device (the
  FLX4 chosen purely as a cue device, whose phones jack is 3/4 and whose 1/2 is
  the MASTER RCA). The main stream becomes master-only.

Mode is **derived**, not a stored flag: `combined = cue_name == "" || cue_name ==
main_name` (the shell's `is_combined`). Whether a combined cue is actually audible
also needs a ≥4-channel main — that channel check lives one layer down in the
device opener, so a stereo main with "same as main" yields a combined-but-silent
cue (the documented behaviour). The master and cue rings become independently
swappable (`SwapMasterRing` / `SwapCueRing`), so a cue-device change in split mode
never disturbs the master stream.

## Consequences

- The cue reaches **any** second output (laptop jack, Bluetooth, a second
  interface), not just an FLX4 — the original UX gap closed.
- The FLX4 single-cable workflow is unchanged; an empty persisted cue device
  (every install before this change) starts combined exactly as before.
- A **split-mode cue-device switch leaves the master untouched** (a property the
  audience depends on). Transitions into/out of combined reopen the main stream
  (a brief master gap) — the rarer case.
- Two independent device **clocks drift**: the render thread paces on the master
  ring, so the cue ring is filled at the master's pace but drained on the cue
  device's clock, producing occasional tiny cue-only glitches over minutes.
  Acceptable — cueing auditions *texture*, not beat alignment (ADR-0004/0006).
  A future refinement could pace the cue ring independently.
- Channel spreading is a single pure, unit-tested `spread` helper (a buffer plus
  a small list of `(channel_offset, stereo_block)` placements) shared by both
  streams; the callbacks stay alloc-free.
- This **supersedes the cue-routing stance of ADR-0007** and natively revives the
  two-sink idea of ADR-0006. A new hardware checklist
  (`docs/split-cue-hardware-checklist.md`) covers what tests can't.

## Alternatives considered

- **Always two independent streams (drop the combined 3/4 path)** - the simplest,
  symmetric engine change, but the FLX4's own phones jack becomes unreachable
  (you can't open a second stream onto channels 3/4 of one device), forcing the
  cue onto a second device and regressing ADR-0007 for the headline controller.
  Rejected.
- **Keep one stream, require a ≥4-channel master** - the status quo; rejected
  because it leaves the common stereo-master rig with a silent cue.
- **Resample/aggregate the two devices into one clock domain** - removes the
  drift but adds a resampler and an aggregate-device dependency for a cue feed
  that doesn't need sample-accuracy. Not worth it for v1.

<!-- Status values: Proposed | Accepted | Rejected | Deprecated |
     Superseded by ADR-NNNN -->
