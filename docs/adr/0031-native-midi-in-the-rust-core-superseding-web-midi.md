# 0031. Native MIDI in the Rust core, superseding Web MIDI

- **Status:** Accepted (2026-07-03)
- **Date:** 2026-07-03
- **Deciders:** Daniel Peter

## Context

ADR-0005 put hardware control in the frontend via Web MIDI, when the app was a
browser app (ADR-0002) and everything a controller touched was browser-owned
state. Both premises have since inverted:

- **The app is a native shell** (ADR-0017/0018). WKWebView has no Web MIDI, so
  hardware control survives only through `tauri-plugin-midi` — a polyfill that
  is *already* native `midir`/CoreMIDI underneath (spike-c-midi.md), injecting
  `navigator.requestMIDIAccess` into the webview. Every engine-bound control
  now takes the loop: CoreMIDI → Rust plugin → webview polyfill → TypeScript
  translator (`flx4.ts`) → ControlBus → React handler → Tauri `invoke` →
  `commands.rs` → the store/engine — native to webview and back to native.
- **Rust is the single interface-state store** (ADR-0020, accepted and built:
  `store.rs`, the MCP server, `store://changed` projection). UI, MIDI, and MCP
  are supposed to be symmetric peer controllers of that store, but MIDI is the
  only one still entering through the webview. If the webview stalls, hardware
  control dies with it — the exact dependency ADR-0020 removed for the agent.
- **The musical clock lives in the Rust shell** (ADR-0025: beat anchor + bpm
  per deck, gated, in the store). ADR-0023 makes beat alignment the *sender's*
  job — quantise when you send. A performance-note surface (issue #48: FLX4
  pads and a MIDI keyboard steering generation) needs press-to-send latency
  and on-grid onset timing; a sender in the webview must round-trip the Rust
  clock to quantise, and rides WKWebView's event-loop jitter while doing it.
- **The note path's external senders already bypass the webview poorly.** MCP
  `set_notes` writes the store and relies on the webview adopting the change
  and re-sending it to the worker (`useDeck`'s adoption effect) — the webview
  is a required relay inside what should be a shell-internal hop.

What ADR-0005 got right and must survive any move: byte maps are *measured*,
not assumed (`docs/midi-ddj-flx4.md` is the arbiter, the monitor verifies
against firmware); translation is pure, tested tables; sources are decoupled
from sinks by typed intents; tempo hardware stays unmapped (ADR-0004).

## Decision

We will move **all MIDI I/O into a native module in the Rust shell crate**
(`src-tauri/src`, beside `analysis/` — not the RT `lsdj-engine` crate), and
remove `tauri-plugin-midi`. Hardware becomes the first fully-native peer
controller of the ADR-0020 store.

- **The shell `midi` module owns the transport**: device enumeration and
  hot-plug via `midir`/CoreMIDI, driver matching by port-name fragment (the
  existing registry semantics), the init/position SysEx on connect, input,
  and LED/SysEx output. Connection status and the device list publish into
  the store; the webview shows them, it no longer mediates them. No user
  gesture is needed (that was a browser-permission artifact).
- **The translation tables port to Rust as pure, unit-tested functions.** The
  FLX4/DDJ-400 byte tables, 14-bit MSB cache, SHIFT layers, and relative
  encoders move from `flx4.ts`/`ddj400.ts` with their test fixtures ported
  byte-for-byte. `docs/midi-ddj-flx4.md` remains the measured contract; the
  port re-verifies on hardware, it does not re-derive.
- **Intents route by domain, preserving ADR-0020's single mutation guard.**
  Engine/store-domain intents (volume, EQ, trim, crossfade, transport, cue,
  loops, hot cues, FX, record) are applied in Rust through the same validated
  mutation path `commands.rs` uses — shared functions, no second copy of the
  clamping rules. UI-domain intents (browse, load, tab, deck prep, style
  sweep, preset load) are forwarded to the webview as a Tauri event
  (`midi://intent`) and dispatched onto the existing ControlBus unchanged —
  ephemeral view state stays React's, per ADR-0020's narrowing.
- **LED feedback is driven from the store.** The semantic LED schemes port to
  Rust and repaint on store changes; any semantic input a LED needs that is
  still React-only moves into the store (finishing that corner of ADR-0020's
  inversion) rather than opening a webview→Rust LED command channel.
- **Note steering gets a single shell-side sender.** A shell note-steering
  service owns held-note state, key/scale, snap-to-scale, and multihot
  construction, sends `set_notes`/`set_drums` directly via `Sidecars::send`,
  and mirrors the store. All sources call it: native MIDI (pads/keyboard),
  MCP tools (today's store-write-and-let-the-webview-relay path is retired),
  and any UI surface via a Tauri command. Onset-mode sends quantise against
  the ADR-0025 beat anchor in-process. The webview only displays.
- **The MIDI monitor survives as a projection**: raw bytes stream to the
  webview over a `midi://monitor` event feed, keeping the
  verify-against-firmware loop ADR-0005 required.

## Consequences

- The webview is no longer a required participant in hardware control or note
  steering — hardware keeps working if the UI hangs, and the co-DJ/headless
  direction (ADR-0020) loses its last input-path dependency on the webview.
- Press-to-generation latency drops to CoreMIDI → Rust → sidecar socket, and
  on-grid onsets quantise against the beat anchor without crossing a process
  or event-loop boundary — the property issue #48 needs.
- **The port must be re-verified on hardware, control by control.** The
  translation layer is measured and shipping; porting it makes it a new
  implementation until the device says otherwise. A full hardware checklist
  (every mapped control, LEDs, the position-query flood, both controllers) is
  part of the cutover, per the house rule that hardware behaviour is verified
  by a human, not assumed.
- The webview `control/` layer shrinks: `midi.ts`, `useMidi`, the translator
  tables and LED builders go; the ControlBus and the UI-domain intent
  dispatch stay, now fed by a Tauri event listener as well as future UI
  sources. `notes.ts` and `useDeck`'s note-adoption effect retire in favour
  of the shell service.
- We take on device lifecycle ourselves: hot-plug notification, reconnect,
  and multi-device arbitration are now our code (`midir` +
  CoreMIDI hot-plug), not the plugin's. One new pinned dependency (`midir`);
  one removed (`tauri-plugin-midi`).
- UI-domain intents cross a new Rust→webview event boundary. These are
  low-rate (browse ticks, loads, mode switches); high-rate gestures that
  matter (faders, jog nudge) are engine-domain and never cross. If a
  UI-domain gesture ever proves rate-sensitive, it earns store state, not a
  fatter event channel.
- External MIDI keyboards come for free: any input port not matching a
  controller driver attaches as a note source — no browser, no shim.
- ADR-0005 flips to Superseded by this record. Its principles (measured maps,
  pure tested tables, monitor verification, intent decoupling) carry forward
  unchanged; only the *where* moves. ADR-0023's "consumers quantise on send
  against the frontend clock" is corrected the rest of the way (ADR-0025
  moved the clock; this record moves the sender).

## Alternatives considered

- **Keep the `tauri-plugin-midi` shim (status quo)** — proven on-device
  (spike C) and zero migration cost, but it hard-wires the webview into every
  hardware path, leaves MIDI the one non-native peer controller, and forces
  the #48 performance surface to quantise across the IPC boundary. Rejected:
  the premises that justified frontend MIDI are gone.
- **Hybrid: native input for the performance surface only, shim for the
  control surface** — the smallest step to #48, and byte-collision-free (the
  KEYBOARD pad bank is unclaimed by the shim path). Rejected: two MIDI stacks
  in one process with split device ownership and two translation homes is a
  worse steady state than either endpoint; chosen instead as unacceptable
  interim debt when the full move is affordable now.
- **Native transport, TypeScript translation (forward raw bytes to the
  webview)** — re-implements the shim by hand: keeps every hop and the
  webview dependency, gains nothing. Rejected.
- **MIDI in the Python sidecars** — rejected in ADR-0005 and more wrong now:
  the generation server is deliberately a pure render service (ADR-0002),
  and controllers drive the instrument, not generation.

<!-- Status values: Proposed | Accepted | Rejected | Deprecated |
     Superseded by ADR-NNNN -->
