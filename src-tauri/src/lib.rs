//! SlipMate native shell — the Tauri v2 app host (Phase 2).
//!
//! This embeds the React frontend, wires the WebMIDI plugin, starts the Rust
//! audio engine, and exposes the engine control surface to the webview over IPC.
//!
//! # The audio host lifecycle (the load-bearing bit)
//!
//! On `setup` we build a [`Host`] ([`slipmate_engine::host`]). `Host::new` builds
//! the [`Engine`], creates its two decks, and KEEPS the engine on a dedicated
//! **render thread** — control commands and the RT render both need `&mut Engine`,
//! and some control ops allocate (rebuilding `fundsp` nodes, taking a decoded
//! buffer), so they must NOT run in the cpal callback. The render thread owns the
//! engine, drains a wait-free command channel, and renders into an output ring;
//! the cpal callback only drains that ring (ADR-style decoupling — see the `host`
//! module docs and its latency note).
//!
//! `Host::new` also returns the two [`DeckHandle`]s — the non-RT producer side of
//! each deck's input ring. They are the sidecar PCM feed's writers; a later step
//! moves them onto the sidecar transport thread. Until then they are held in
//! managed state so they stay alive (dropping a producer would close its ring).
//!
//! We then start the cpal device via [`engine_device::run_host_stream`], which
//! drains the host's output ring in its callback. In a sandbox / headless CI
//! there is often no exact-48000/f32 device; that path returns
//! [`DeviceError::Unavailable`] and we continue with no stream — the host's render
//! thread keeps filling the ring (nothing drains it, which is fine), so control
//! and read-back still work and the window still opens.
//!
//! The [`Host`] is held in Tauri **managed state** so every `#[tauri::command]`
//! can drive it; managed state lives for the app's lifetime, so the render thread
//! (and the device stream) run until shutdown.

use std::sync::Mutex;

use slipmate_engine::device::{self as engine_device, AudioStream, DeviceError};
use slipmate_engine::host::Host;
use slipmate_engine::DeckHandle;
use tauri::Manager;

mod commands;

/// Tauri-managed audio state held ALONGSIDE the [`Host`]: the running output
/// stream (kept alive so its Drop does not stop audio), the deck producer handles
/// (kept alive for the future sidecar feed; dropping a producer closes its ring),
/// and whether the device actually started.
///
/// The `Host` itself is managed separately so the commands can take it as
/// `tauri::State<'_, Host>` directly. This struct holds the things the commands
/// do not need but the app must keep alive.
///
/// Wrapped in `Mutex`es only to satisfy Tauri's `Send + Sync` managed-state bound
/// uniformly; neither field is mutated after setup.
struct AudioState {
    /// Held only to keep the cpal stream alive for the app's lifetime — its
    /// `Drop` stops audio. `None` in the sandbox/headless case.
    _stream: Mutex<Option<AudioStream>>,
    /// The deck producer handles for the sidecar PCM feed (a later step). Held so
    /// the input rings stay open; not yet written to.
    _deck_handles: Mutex<Vec<DeckHandle>>,
    device_started: bool,
}

/// Build the host (engine + render thread + decks), start the cpal device that
/// drains the host's output ring, and return both the [`Host`] (for managed
/// state, so the commands can drive it) and the [`AudioState`] holding the stream
/// and the deck handles. The device-start path is graceful: a missing device
/// leaves the host running headlessly with `device_started = false`.
fn start_audio() -> (Host, AudioState) {
    let (host, output, deck_handles) = Host::new();

    let (stream, device_started) = match engine_device::run_host_stream(output) {
        Ok(stream) => {
            let info = stream.info();
            // Non-RT setup logging only; the RT callback itself logs nothing.
            println!(
                "slipmate-app: audio device started — device='{}' channels={} rate={} buffer={:?}",
                info.device_name, info.device_channels, info.sample_rate, info.buffer_frames
            );
            (Some(stream), true)
        }
        Err(DeviceError::Unavailable(msg)) => {
            // Expected in a sandbox / headless CI: no exact-48000/f32 device. Log
            // and continue with no stream — the host renders into the ring, the
            // window opens, control/read-back work.
            eprintln!("slipmate-app: audio device unavailable ({msg}) — continuing without audio");
            (None, false)
        }
        Err(DeviceError::Stream(msg)) => {
            eprintln!("slipmate-app: audio stream error ({msg}) — continuing without audio");
            (None, false)
        }
    };

    let state = AudioState {
        _stream: Mutex::new(stream),
        _deck_handles: Mutex::new(deck_handles.into_iter().collect()),
        device_started,
    };
    (host, state)
}

/// Report the app version and whether the cpal device came up. Lets the frontend
/// (and the integration harness) confirm the shell loaded and the device-start
/// path ran. The full engine surface lives in [`commands`].
#[derive(serde::Serialize)]
struct AppInfo {
    version: String,
    audio_device_started: bool,
}

#[tauri::command]
fn app_info(state: tauri::State<'_, AudioState>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        audio_device_started: state.device_started,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // The WebMIDI shim (ADR-0005): injects `navigator.requestMIDIAccess`
        // into the webview.
        .plugin(tauri_plugin_midi::init())
        .setup(|app| {
            // Start the audio host (engine + render thread + device) and hold the
            // Host and the AudioState in managed state for the app's lifetime.
            let (host, audio_state) = start_audio();
            app.manage(host);
            app.manage(audio_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            commands::set_crossfade,
            commands::set_eq,
            commands::set_volume,
            commands::set_fx,
            commands::set_fx_amount,
            commands::clear_fx,
            commands::set_trim,
            commands::set_on_air,
            commands::load_track,
            commands::unload_track,
            commands::play_track,
            commands::pause_track,
            commands::seek_track,
            commands::set_track_rate,
            commands::set_track_loop,
            commands::clear_track_loop,
            commands::capture_loop,
            commands::play_loop,
            commands::stop_loop,
            commands::stop_one_shot,
            commands::clear_loop,
            commands::load_generated_loop,
            commands::capture_sample,
            commands::engine_telemetry,
            commands::track_status,
            commands::loop_slots,
            commands::track_peaks,
            commands::engine_snapshot,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
