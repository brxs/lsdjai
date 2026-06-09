# 0003. Frontend audio mixing via Web Audio

- **Status:** Accepted
- **Date:** 2026-06-09
- **Deciders:** Daniel Peter

## Context

Two decks each produce a continuous PCM stream (~2 s chunks, 48 kHz) generated
by their model worker (ADR-0002). The DJ experience hinges on the crossfader:
it must respond instantly and smoothly, independent of the model's chunk
cadence. Someone has to mix the two streams into one output — either the
Python backend mixes and ships (or plays) a single stream, or both streams go
to the browser and are mixed there.

Forces in tension:

- A crossfader routed through the backend pays a control round-trip and, in
  the worst case, waits on chunk boundaries — sluggish for a performance
  gesture.
- The backend mixing to a single stream could target a specific output device
  (e.g. an external audio interface), which browsers control less directly.
- Per-deck features on the roadmap (volume faders, metering, waveform visuals,
  session recording of the mix) all want access to the individual streams and
  the mix bus.

## Decision

We will send both decks' PCM streams to the browser and do all mixing in the
Web Audio API: one AudioWorklet ring buffer per deck feeding a per-deck
GainNode (volume fader), both feeding a master bus with equal-power
crossfader gain curves. Session recording taps the master bus and encodes WAV
client-side. The backend never mixes audio.

## Consequences

- Easier: crossfader and volume moves apply at audio rate with zero backend
  round-trip; per-deck metering/visuals are an AnalyserNode away; recording
  the exact mix the user heard is a tap on the master bus; the backend stays
  a pure generation/streaming service with no audio output code (no
  CoreAudio/PortAudio dependency).
- Harder: double the WebSocket bandwidth (two raw PCM streams instead of one
  mixed stream) — trivial on localhost (~3 Mbit/s per stereo deck at 48 kHz
  16-bit).
- Harder: output goes to the browser's default audio device; routing to a
  specific interface relies on macOS-level device selection or
  `setSinkId` support. Acceptable for v1.
- The client must ring-buffer ~2 chunks per deck to absorb generation jitter;
  buffer-health surfacing in the UI becomes necessary follow-up work.

## Alternatives considered

- **Mix in the Python backend, stream one mixed stream** - halves bandwidth
  and centralises audio, but every fader gesture pays a round-trip and mixing
  granularity is tied to chunk handling; per-deck visuals and client-side
  recording of the true mix get harder. Rejected for responsiveness.
- **Backend mixes and plays audio directly to a device** - best for targeting
  an external interface, but turns the frontend into a remote control,
  adds an audio-output stack to Python, and forfeits Web Audio's free
  scheduling/metering. Rejected for v1; reconsider if device routing becomes
  a hard requirement.

<!-- Status values: Proposed | Accepted | Rejected | Deprecated |
     Superseded by ADR-NNNN -->
