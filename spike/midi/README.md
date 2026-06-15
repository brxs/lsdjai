# Spike C — `tauri-plugin-midi` vs DDJ-FLX4

A minimal Tauri v2 desktop app that exercises the WebMIDI shim
[`tauri-plugin-midi`](https://github.com/specta-rs/tauri-plugin-midi) (midir /
CoreMIDI) against a Pioneer DDJ-FLX4. It tests three things on the device:
MIDI **input**, the **position-query SysEx** round-trip, and MIDI **output**
(LED).

The app builds and launches **without** a controller attached — it lists 0
devices and shows a "plug in the FLX4" banner.

## Run it

```sh
cd spike/midi/src-tauri
cargo tauri dev
```

That is the whole launch command. There is **no frontend toolchain** — the UI
is a static `dist/index.html` + `dist/main.js`, served directly by Tauri
(`frontendDist` in `tauri.conf.json`). No npm install, no vite, no
`beforeDevCommand`.

For a packaged `.app`/`.dmg`: `cargo tauri build` (from `src-tauri/`).

> First `cargo tauri dev` compiles tauri + midir + the plugin (a few minutes).
> Subsequent runs are fast.

## What the harness does

1. Calls `navigator.requestMIDIAccess({ sysex: true })`, lists every input +
   output port by name, and auto-selects any whose name matches `/FLX4/i`
   (manual dropdowns too). Shows a "no FLX4 — plug it in" banner when absent.
2. **Input:** opens the FLX4 input and logs every incoming message as hex with
   a running count; SysEx (status `0xF0`) is flagged and counted separately.
3. **SysEx round-trip:** "Send position query" sends
   `F0 00 40 05 00 00 04 05 00 50 02 F7` to the FLX4 output. The FLX4 replies by
   flooding its current analog positions back as CC/Note input, so the panel
   shows "position flood: N messages in 500 ms after query". Also fired once
   automatically on connect.
4. **Output (LED):** "Light pads" / "Clear pads" send `0x97 0x00..0x07 0x7F`
   (and `…0x00`) to light/clear HOT CUE pads 1–8 on deck 1.
5. A status panel: input count, SysEx flood Y/N + count, output-sent
   confirmation, selected device name.

The FLX4 byte constants come from `docs/midi-ddj-flx4.md`.

## How the plugin is wired (Spike C findings)

- **Crate:** `tauri-plugin-midi = "0.2"` (resolves to 0.2.0) in
  `src-tauri/Cargo.toml`. Tauri `2`, `tauri-build` `2`.
- **Rust init:** one line — `.plugin(tauri_plugin_midi::init())` in the
  `tauri::Builder` (see `src-tauri/src/lib.rs`).
- **JS shim:** *no JS import and no npm package are needed.* The plugin injects
  its polyfill into the webview at startup via Tauri's `js_init_script`, which
  defines `navigator.requestMIDIAccess` (plus `MIDIAccess`, `MIDIInput`,
  `MIDIOutput`, SysEx-enabled `send()`). The page just uses the standard
  WebMIDI API. `withGlobalTauri: true` is set in `tauri.conf.json` because the
  bundled polyfill calls the Tauri IPC.
- **Capability/permission:** add `"midi:default"` to the window capability —
  see `src-tauri/capabilities/default.json`
  (`"permissions": ["core:default", "midi:default"]`). `midi:default` expands
  to allow `open-input`, `close-input`, `open-output`, `close-output`,
  `output-send`.

## Files

```
spike/midi/
├── dist/                       static frontend (served as-is)
│   ├── index.html
│   └── main.js
└── src-tauri/
    ├── Cargo.toml              tauri-plugin-midi = "0.2"
    ├── build.rs
    ├── tauri.conf.json         frontendDist=../dist, withGlobalTauri=true
    ├── capabilities/default.json   midi:default
    ├── icons/                  (borrowed from the plugin example)
    └── src/{lib.rs,main.rs}    .plugin(tauri_plugin_midi::init())
```
