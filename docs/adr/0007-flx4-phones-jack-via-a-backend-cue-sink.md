# 0007. FLX4 phones jack via a backend cue sink

- **Status:** Superseded by [ADR-0017](0017-native-rust-audio-engine-superseding-web-audio.md) (2026-06-15)
- **Date:** 2026-06-10
- **Deciders:** Daniel Peter

## Context

ADR-0006 routes the headphone cue out a second browser audio sink
because Chromium caps Web Audio output at stereo per device. That leaves
the DDJ-FLX4's own headphone jack — USB output channels 3/4 of its
4-channel sound card — unreachable from the browser, which a spike
re-confirmed even with Chromium's `--audio-output-channels=4` switch.
A DJ reasonably expects the controller's phone jack to work; cueing on
Bluetooth works but adds pairing friction and shares nothing with the
hardware already on the table.

Two facts make a fix possible without touching the browser limitation:
the Python backend has unrestricted multichannel access through
PortAudio, and **CoreAudio mixes multiple clients of one device** — a
second process can write to the FLX4 while Chromium keeps streaming the
master to it.

## Decision

We will add a **backend cue sink**: the browser captures the cue feed
(post-blend, exactly what the phones should hear) with the existing
`pcm-recorder` worklet and streams interleaved stereo float32 over a
WebSocket (`/ws/cue`); the backend plays it through PortAudio
(`sounddevice`) on a chosen ≥4-channel output device, writing the cue
to channels 3/4 and silence to 1/2. The browser's master keeps flowing
to channels 1/2 via its own stereo sink; CoreAudio sums the clients.

The phones picker lists these devices alongside the browser sinks
(via `GET /api/cue/outputs`); ADR-0006's second-sink path remains for
any plain stereo device.

## Consequences

- Easier: the genuine rekordbox topology — master on the FLX4's RCA,
  cue on the FLX4's phone jack, one cable to the table. No Bluetooth.
- The cue feed gains a network + PortAudio-buffer hop (~50–150 ms).
  Acceptable: cueing auditions generated texture, not beat alignment
  (no tempo parameter, ADR-0004).
- The controller process now does audio I/O. It stays out of the model
  workers (ADR-0002 untouched); a new pinned dependency, `sounddevice`
  (the canonical, maintained PortAudio binding).
- A second transport for audio (deck PCM comes down one WebSocket, cue
  PCM goes up another). The frame format is the one the recorder
  already produces; no new encoding.
- Browser-side capture rides the AudioContext, so the stream only
  carries audio while the context runs — same gesture rules as
  everything else.

## Alternatives considered

- **Live with ADR-0006's second device (Bluetooth/jack)** - works and
  remains the fallback, but leaves the controller's own phone jack dead,
  which contradicts how the hardware is meant to be used.
- **macOS speaker remap (Audio MIDI Setup → stereo on channels 3/4)** -
  zero code, but remaps the FLX4's stereo sink wholesale, so the master
  can no longer reach the RCA from the browser; only fits setups where
  the room is fed elsewhere.
- **Chromium multichannel output** - measured twice (plain and with
  `--audio-output-channels=4`): `maxChannelCount` stays 2. Revisit if
  Chromium ships it; that would supersede this ADR.
- **Loopback/virtual-device tools (e.g. Rogue Amoeba Loopback)** -
  third-party paid software and per-machine configuration to solve what
  one small backend module solves in-repo.

<!-- Status values: Proposed | Accepted | Rejected | Deprecated |
     Superseded by ADR-NNNN -->
