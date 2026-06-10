# 0005. Hardware control via Web MIDI in the frontend

- **Status:** Accepted
- **Date:** 2026-06-10
- **Deciders:** Daniel Peter

## Context

A physical DJ controller (first target: Pioneer DDJ-FLX4, a class-compliant
USB MIDI device) should drive the app: deck volumes, crossfade, transport,
and the style pad. Everything those controls touch is **client-side state**
— Web Audio gain nodes, the crossfade bus, the pad cursor — owned by React
components and applied at audio rate in the browser. The backend only ever
sees the resulting style/transport commands it already receives today.

Two places the MIDI integration could live:

1. **Frontend, via the Web MIDI API** (Chromium): hardware events dispatch
   into the same handlers the mouse and keyboard use.
2. **Backend, via a Python MIDI library**, forwarding events over the
   WebSocket: adds a protocol hop and a round-trip to reach state that
   lives in the browser, and splits "what controls the app" across two
   processes.

Controller MIDI charts drift across firmware revisions, so any hard-coded
vendor table is a liability; the mapping must be capturable from the
actual device.

## Decision

We will integrate hardware controllers in the **frontend using Web MIDI**:

- A `ControlBus` (publish/subscribe of typed control intents, e.g.
  `{deck, action: 'volume', value}`) decouples sources from sinks: Deck and
  Mixer components subscribe with their existing handlers; the MIDI module
  publishes. Keyboard/mouse paths are unchanged.
- Device mappings are **pure, tested translation tables** (`MIDI message →
  intent`). The DDJ-FLX4 map is documented in
  [`docs/midi-ddj-flx4.md`](../midi-ddj-flx4.md), sourced from the proven
  Mixxx community mapping and cross-referenced against Pioneer's official
  MIDI message list; an in-app MIDI monitor verifies it against the
  physical device's firmware. Other controllers are additional tables.
- MIDI access is requested on an explicit user gesture ("Connect MIDI"),
  with device status shown in the UI.
- Tempo-related hardware (tempo sliders) stays deliberately unmapped, per
  ADR-0004.

## Consequences

- Easier: zero new wire protocol or backend dependencies; hardware moves
  reflect in the UI instantly because they *are* UI events; the Tauri-wrap
  option (ADR-0002) keeps working since Chromium webviews ship Web MIDI.
- Harder: Web MIDI is Chromium-only — Firefox/Safari users get no hardware
  control (the on-screen UI is unaffected). Accepted for a personal tool.
- LED/display feedback to the controller (MIDI out) becomes possible later
  through the same module; it is out of scope for the first milestone.
- Automated end-to-end testing cannot plug in real hardware; correctness
  rests on the pure translation tables plus ControlBus component tests,
  with a manual checklist against the physical device.

## Alternatives considered

- **Backend MIDI (python-rtmidi/mido) forwarded over the WebSocket** -
  adds latency and a protocol extension to reach browser-owned state;
  splits control handling across processes. No benefit unless headless
  (UI-less) operation becomes a goal.
- **A vendor-specific HID/driver integration** - the FLX4 is
  class-compliant MIDI; HID buys nothing and costs portability.
- **Blind-trusting a single vendor chart** - the map is sourced from the
  Mixxx mapping that thousands of users exercise, and still verified
  against the device with the in-app monitor; charts drift and the cost
  of a wrong byte is silent dead controls.

<!-- Status values: Proposed | Accepted | Rejected | Deprecated |
     Superseded by ADR-NNNN -->
