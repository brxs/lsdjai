# 0006. Cue output via a second audio sink

- **Status:** Accepted
- **Date:** 2026-06-10
- **Deciders:** Daniel Peter

## Context

Pre-fade listening (M9) needs two simultaneous, independent stereo
outputs: the master mix for the audience and a private cue feed for the
DJ's headphones. All audio lives in one Web Audio graph (ADR-0003).

The obvious hardware path exists: the DDJ-FLX4's USB sound card exposes
four output channels at 48 kHz (measured on the device via
`system_profiler`) — channels 1/2 feed the MASTER RCA, 3/4 the headphone
jack; rekordbox routes exactly this way. But Chromium's Web Audio output
is **stereo per sink**: after `AudioContext.setSinkId(flx4)`,
`destination.maxChannelCount` reports 2, not 4 (measured in
`frontend/scripts/spike_cue_routing.mjs`). The FLX4's phones jack is
therefore unreachable from the browser, and a single-context 4-channel
merger cannot work today.

The same spike measured the alternative: a
`MediaStreamAudioDestinationNode` feeding an `<audio>` element whose
sink is set to a second output device — `element.setSinkId()` resolves
and plays. Device enumeration with labels requires a granted media
permission (a one-off microphone grant, released immediately after
listing).

## Decision

We will route the cue feed through a **second audio sink**: the master
bus keeps `context.destination` (the system-default output device), and
the cue bus terminates in a `MediaStreamAudioDestinationNode` whose
stream plays through an `<audio>` element pinned to a user-chosen
output device via `setSinkId`.

The intended FLX4 setup is: system default output = DDJ-FLX4 (master
RCA → speakers), cue device = any second output (the laptop's headphone
jack, Bluetooth headphones, or built-in speakers). Both buses stay in
the one AudioContext; only the last hop differs.

## Consequences

- Easier: works with any pair of output devices, FLX4 present or not;
  no second AudioContext; the cue tap is ordinary graph wiring, so
  per-channel cue toggles and the cue/master blend are plain gain nodes.
- Harder: the FLX4's own headphone jack cannot carry the cue — the DJ
  uses headphones on another device. Revisit (new ADR superseding this
  one) if Chromium ships multichannel output sinks.
- The `<audio>` element hop adds buffering latency (~tens of ms) to the
  cue feed only. Acceptable: cueing here auditions generated *texture*,
  not beat alignment (no tempo parameter, ADR-0004).
- Choosing a cue device costs a one-off microphone permission prompt to
  unlock device labels; the stream is stopped immediately after
  enumeration.
- The cue feed bypasses the recorder and master meters by construction —
  the audience and the WAV can never hear the DJ's preview.

## Alternatives considered

- **One context, 4-channel sink on the FLX4 (master → ch 1/2, cue →
  ch 3/4)** - the rekordbox topology and the preferred design; rejected
  because Chromium caps `maxChannelCount` at 2 per sink (measured, not
  read — see the spike script). Reconsider when that changes.
- **Two AudioContexts, one per sink** - reaches the same two devices but
  adds a second rendering thread and still crosses contexts via a
  MediaStream; the `<audio>` element does the same job with less
  machinery.
- **Hardware monitoring on the FLX4 mixer itself** - the FLX4's
  HEADPHONES MIX knob sends MIDI rather than blending in hardware
  (Mixxx mapping), so the unit performs no analog monitor mix of USB
  audio; there is nothing to delegate to.

<!-- Status values: Proposed | Accepted | Rejected | Deprecated |
     Superseded by ADR-NNNN -->
