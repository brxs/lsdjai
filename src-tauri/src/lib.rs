//! SlipMate native shell — the Tauri v2 app host (Phase 2, step 1).
//!
//! This is the foundation the later Phase-2 steps build on: it embeds the React
//! frontend, wires the WebMIDI plugin, and starts the Rust audio engine's cpal
//! device on launch. The full engine command surface (mirroring `DeckChannel`),
//! the Python sidecars, the MIDI rewire, and the UI ↔ engine cutover are the
//! later steps — this step only proves the shell + device + frontend load.
//!
//! # The audio device lifecycle (the load-bearing bit)
//!
//! On `setup` we build an [`Engine`], create its two decks, and start the cpal
//! output stream via [`engine_device::run_stream`]. That call MOVES the engine
//! into the audio callback and returns an [`AudioStream`] whose `Drop` stops the
//! stream — so the stream must be kept alive for the app's lifetime. We hold it
//! in Tauri **managed state** ([`AudioState`]); managed state lives as long as
//! the app, so the stream runs until shutdown.
//!
//! In a sandbox / headless CI there is often no exact-48000/f32 output device.
//! `run_stream` reports that as [`DeviceError::Unavailable`] rather than
//! panicking; we log it and continue with no stream so the window still opens.
//! The deck producers are not spawned here — feeding the rings is a later step
//! (the sidecar transport); this step only proves the device path runs.

use std::sync::Mutex;

use serde::Serialize;
use slipmate_engine::device::{self as engine_device, AudioStream, DeviceError};
use slipmate_engine::{Engine, DECK_COUNT};
use tauri::Manager;

/// Tauri-managed audio state: the running output stream (kept alive so its Drop
/// does not stop audio) and whether the device actually started. `None` stream
/// in the sandbox/headless case — the window still opens.
///
/// Wrapped in a `Mutex` only to satisfy Tauri's `Send + Sync` managed-state
/// bound uniformly; the stream itself is never mutated after setup. (cpal's
/// CoreAudio `Stream` is `Send + Sync`.)
struct AudioState {
    /// Held only to keep the cpal stream alive for the app's lifetime — its
    /// `Drop` stops audio. Never read (the `_` mirrors `AudioStream::_stream`).
    _stream: Mutex<Option<AudioStream>>,
    device_started: bool,
}

/// What [`app_info`] returns to the webview: the app version and whether the
/// audio device started. The minimal "the shell is alive" probe — the real
/// engine command surface (decks/mixer/cue) is a later step.
#[derive(Serialize)]
struct AppInfo {
    version: String,
    audio_device_started: bool,
}

/// The one IPC command for this step: report the app version and whether the
/// cpal device came up. Lets the frontend (and the integration harness) confirm
/// the shell loaded and the device-start path ran without building out the full
/// engine surface yet.
#[tauri::command]
fn app_info(state: tauri::State<'_, AudioState>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        audio_device_started: state.device_started,
    }
}

/// Build the engine, create its decks, and start the cpal device. Returns the
/// managed [`AudioState`] — with the live stream on success, or no stream (and
/// `device_started = false`) when no device is available, so the caller never
/// has to crash the window over a missing device.
fn start_audio() -> AudioState {
    let mut engine = Engine::new();
    for index in 0..DECK_COUNT {
        engine.create_deck(index);
    }

    match engine_device::run_stream(engine) {
        Ok(stream) => {
            let info = stream.info();
            // Non-RT setup logging only; the RT callback itself logs nothing.
            println!(
                "slipmate-app: audio device started — device='{}' channels={} rate={} buffer={:?}",
                info.device_name, info.device_channels, info.sample_rate, info.buffer_frames
            );
            AudioState {
                _stream: Mutex::new(Some(stream)),
                device_started: true,
            }
        }
        Err(DeviceError::Unavailable(msg)) => {
            // Expected in a sandbox / headless CI: no exact-48000/f32 device.
            // Log and continue with no stream — the window must still open.
            eprintln!("slipmate-app: audio device unavailable ({msg}) — continuing without audio");
            AudioState {
                _stream: Mutex::new(None),
                device_started: false,
            }
        }
        Err(DeviceError::Stream(msg)) => {
            eprintln!("slipmate-app: audio stream error ({msg}) — continuing without audio");
            AudioState {
                _stream: Mutex::new(None),
                device_started: false,
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // The WebMIDI shim (ADR-0005): injects `navigator.requestMIDIAccess`
        // into the webview. The frontend rewire to it is a later Phase-2 step;
        // wiring it here carries the plugin from the start.
        .plugin(tauri_plugin_midi::init())
        .setup(|app| {
            // Start the audio engine's device and hold the stream in managed
            // state for the app's lifetime (its Drop stops audio).
            app.manage(start_audio());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![app_info])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
