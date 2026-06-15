# Spike C — `tauri-plugin-midi` on the DDJ-FLX4

**Status: harness ready — builds + launches (2026-06-15); on-device verification
pending.**
Phase-0 Spike C of the [native migration](native-migration-plan.md). Confirms
`tauri-plugin-midi` (the WebMIDI shim over `midir`/CoreMIDI) drives the FLX4 in a
Tauri v2 / WKWebView app — the premise behind keeping the measured `control/`
layer ([ADR-0005](adr/0005-hardware-control-via-web-midi-in-the-frontend.md)) when
WKWebView itself has no Web MIDI. Harness: `spike/midi/`.

## Why

WKWebView has no Web MIDI, so a naive Tauri wrap would silently delete FLX4
control. `tauri-plugin-midi` shims `navigator.requestMIDIAccess` over native
`midir`/CoreMIDI. Spike C verifies the three fragile things on the real device —
**input**, the **position-query SysEx round-trip**, and **MIDI output (LED)** —
the trio CLAUDE.md flags (the Playwright/Chromium MIDI-output renderer crash, the
`midi`+`midi-sysex` grant). If they work here, the existing `control/` layer (the
`flx4` translator + the byte map in `docs/midi-ddj-flx4.md` + the ControlBus)
ports to the native shell unchanged.

## How to run (operator, with the FLX4 attached)

1. Plug the DDJ-FLX4 in over USB.
2. `cd spike/midi/src-tauri && cargo tauri dev` (first build ~30 s; or
   `cargo tauri build` for a packaged `.app`).
3. The window opens, auto-selects the FLX4 (it appears within ~1 s of connecting),
   and sends the position query.

## The three checks

1. **Input** — move a channel fader / turn an EQ knob / hit a pad. The log shows
   incoming messages (e.g. a channel fader → `B0 13 xx`, EQ → `B0 07 xx`).
   **PASS** = controls produce messages.
2. **SysEx round-trip** — on connect (or the **Send position query** button) the
   app sends `F0 00 40 05 00 00 04 05 00 50 02 F7`; the FLX4 replies with a burst
   of position CCs. **PASS** = the "position flood" counter jumps (≳ a dozen
   messages) right after the query. This proves SysEx **output** works *and* the
   controller responded — exactly what a fresh connection needs to start in sync.
3. **Output / LED** — click **Light pads**. HOT CUE pads 1–8 on deck 1 light up
   (`97 0N 7F`); **Clear pads** turns them off. **PASS** = the pads physically
   light, and toggling is stable (no app/window crash).

Bonus watch: this is the exact path CLAUDE.md records as crashing Chromium's
renderer (MIDI *output* with the FLX4 attached). Through `tauri-plugin-midi` the
MIDI never touches the webview — it's native `midir` — so that crash class should
be gone. Note any instability while sending output.

## Exit criteria

All three green on the device → `tauri-plugin-midi` is confirmed, ADR-0018's MIDI
premise holds, and the `control/` layer ports unchanged. Any failure → record
whether it's the plugin (shim/permission/grant), a CoreMIDI issue, or a byte-map
mismatch, and the fix-forward.

## Harness — `tauri-plugin-midi` setup (confirmed, off-device)

The harness builds (`cargo build` 27 s; `tauri-cli 2.11.2`) and launches clean with
no controller (0 devices, "plug in the FLX4"). The setup that worked — itself a
Spike C result for the real migration:

- **Crate:** `tauri-plugin-midi = "0.2"` (0.2.0; Tauri 2.11.1, `midir 0.11`,
  `coremidi-hotplug-notification`); links `CoreMIDI.framework` + `WebKit.framework`.
- **Rust:** one line — `.plugin(tauri_plugin_midi::init())`.
- **JS shim — no import, no npm, no frontend build.** The plugin injects its
  polyfill via Tauri's `js_init_script`, defining `navigator.requestMIDIAccess`
  (with `sysexEnabled` always true and a SysEx-capable `send()`). The page calls
  the standard WebMIDI API. **Requires `withGlobalTauri: true`** (the polyfill uses
  Tauri IPC); the frontend is plain static files.
- **v2 capability:** `"midi:default"` in `capabilities/default.json` (expands to
  open/close input + output, output-send).
- **Caveats for the real migration:** the plugin does not work inside iframes
  (their issue #7); `docs.rs` is broken for 0.2.0 (use the repo source).

So the plugin integrates cleanly into a Tauri v2 app; the only open question is
whether it drives the FLX4 on the device — the three checks above.

## Results

**On-device PASS (2026-06-15).** All three checks confirmed on the FLX4 via
`tauri-plugin-midi` in the Tauri v2 / WKWebView harness:

- **Input** — controls produce MIDI messages.
- **SysEx round-trip** — the position query floods the controller's current
  positions back.
- **Output / LED** — the pads light, and sending output is stable: no renderer
  crash. The native `midir` path sidesteps the Chromium MIDI-output crash class
  CLAUDE.md warns about, exactly as predicted.

`tauri-plugin-midi` drives the FLX4 from a native (WKWebView) shell. ADR-0018's
MIDI premise holds, and the measured `control/` layer (the `flx4` translator +
the byte map + the ControlBus) ports to the native shell unchanged. Spike C:
**PASS.**

