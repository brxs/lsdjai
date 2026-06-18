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
mod generation;
mod sidecar;
mod songs;

/// The default per-deck model the sidecars load (mirrors `controller.py`
/// `DEFAULT_MODEL`).
const DEFAULT_MODEL: &str = "mrt2_small";

/// Tauri-managed audio state held ALONGSIDE the [`Host`]: the running output
/// stream (kept alive so its Drop does not stop audio) and whether the device
/// actually started.
///
/// The `Host` is managed separately so the commands can take it as
/// `tauri::State<'_, Host>` directly. This struct holds the things the commands
/// do not need but the app must keep alive.
struct AudioState {
    /// The running output stream — kept alive (its `Drop` stops audio) and
    /// REPLACED by `set_output_device` to switch the output device. `None` in the
    /// sandbox/headless case.
    stream: Mutex<Option<AudioStream>>,
    device_started: bool,
}

/// Deck producer handles NOT owned by a sidecar (sidecars disabled, or a spawn
/// failed) — held in managed state only to keep their input rings open (dropping
/// a producer closes its ring). Empty when every deck has a live sidecar.
struct IdleHandles(#[allow(dead_code)] Mutex<Vec<DeckHandle>>);

/// A sidecar status line for the webview (the `('status', dict)` worker output,
/// or a synthetic `worker_died`). Emitted on the `sidecar://status` event.
#[derive(Clone, serde::Serialize)]
struct SidecarStatus {
    deck: usize,
    /// The raw status JSON from the worker; the webview parses it.
    json: String,
}

/// Build the host (engine + render thread + decks), start the cpal device that
/// drains the host's output ring, and return the [`Host`], the [`AudioState`]
/// holding the stream, and the two deck producer handles (for the sidecar feed).
/// The device-start path is graceful: a missing device leaves the host running
/// headlessly with `device_started = false`.
fn start_audio() -> (Host, AudioState, [DeckHandle; slipmate_engine::DECK_COUNT]) {
    let (host, output, cue_output, deck_handles) = Host::new();

    let (stream, device_started) = match engine_device::run_host_stream(None, output, cue_output) {
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
        stream: Mutex::new(stream),
        device_started,
    };
    (host, state, deck_handles)
}

/// Spawn one inference sidecar per deck, each fed by its [`DeckHandle`] and
/// reporting status as a `sidecar://status` Tauri event. Gated behind the
/// `SLIPMATE_SIDECARS` env var during the migration (so a plain `tauri dev` does
/// not launch Python until the native inference path is enabled / on the
/// checklist); part 7 (cutover) makes it the default. Handles for decks without a
/// sidecar are returned to keep their rings open.
fn start_sidecars(
    app: &tauri::AppHandle,
    handles: [DeckHandle; slipmate_engine::DECK_COUNT],
    taps: &sidecar::PcmTaps,
) -> (sidecar::Sidecars, Vec<DeckHandle>) {
    const DECK_IDS: [&str; slipmate_engine::DECK_COUNT] = ["a", "b"];
    let enabled = std::env::var("SLIPMATE_SIDECARS").is_ok();
    if !enabled {
        eprintln!("slipmate-app: sidecars disabled (set SLIPMATE_SIDECARS=1 to enable)");
        return (
            sidecar::Sidecars::new(handles.iter().map(|_| None).collect()),
            handles.into_iter().collect(),
        );
    }

    let mut decks = Vec::new();
    for (idx, handle) in handles.into_iter().enumerate() {
        let app = app.clone();
        let deck_id = DECK_IDS[idx];
        match sidecar::Sidecar::spawn(
            deck_id,
            idx,
            DEFAULT_MODEL,
            handle,
            move |json| {
                use tauri::Emitter;
                let _ = app.emit("sidecar://status", SidecarStatus { deck: idx, json });
            },
            taps.clone(),
        ) {
            Ok(sidecar) => decks.push(Some(sidecar)),
            Err(e) => {
                // A failed spawn drops that deck's handle (ring closes); the deck
                // stays silent, like the no-audio-device path.
                eprintln!("slipmate-app: deck {deck_id} sidecar spawn failed: {e}");
                decks.push(None);
            }
        }
    }
    // Every handle was moved into a sidecar (or dropped on a failed spawn), so no
    // idle handles remain in the enabled path.
    (sidecar::Sidecars::new(decks), Vec::new())
}

/// Report the app version and whether the cpal device came up. Lets the frontend
/// (and the integration harness) confirm the shell loaded and the device-start
/// path ran. The full engine surface lives in [`commands`].
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    audio_device_started: bool,
    /// The loopback port the generation server bound (`None` if disabled / not
    /// running). The webview builds the `/api/*` base URL from it (gap 2).
    generation_port: Option<u16>,
}

#[tauri::command]
fn app_info(
    state: tauri::State<'_, AudioState>,
    generation: tauri::State<'_, generation::GenerationServer>,
) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        audio_device_started: state.device_started,
        generation_port: generation.port(),
    }
}

/// One selectable output device for the picker (serde camelCase → `cueCapable`).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputDeviceDto {
    name: String,
    channels: u16,
    cue_capable: bool,
}

/// Enumerate the output devices the engine can open, with their channel count and
/// whether they can carry the headphone cue (≥4 channels → master 1/2, cue 3/4).
#[tauri::command]
fn list_output_devices() -> Vec<OutputDeviceDto> {
    engine_device::list_output_devices()
        .into_iter()
        .map(|d| OutputDeviceDto {
            name: d.name,
            channels: d.channels,
            cue_capable: d.cue_capable,
        })
        .collect()
}

/// Switch the output device by name (an EMPTY name means the system default — the
/// picker's "System default" option). Opens the NEW device stream FIRST (on fresh
/// rings); only on success swaps the render thread onto them and drops the old
/// stream — so a device that fails to open leaves the current audio untouched and
/// returns the error to the webview.
#[tauri::command]
fn set_output_device(
    host: tauri::State<'_, Host>,
    audio: tauri::State<'_, AudioState>,
    name: String,
) -> Result<(), String> {
    // Empty → the default device (`None`), so "System default" reopens it rather
    // than erroring on an empty name miss.
    let selected = (!name.is_empty()).then_some(name.as_str());
    let (rings, output, cue_output) = host.new_output_rings();
    let stream =
        engine_device::run_host_stream(selected, output, cue_output).map_err(|e| e.to_string())?;
    // The new device is open; re-point the render thread onto its rings. Only on
    // success do we drop the old stream below — if the command queue was full the
    // swap did not land, so keep the old stream (still being filled) and drop the
    // new one (returned by the `?`-less early return) rather than going silent.
    if !host.install_output_rings(rings) {
        return Err("the audio engine was momentarily busy — try switching again".into());
    }
    let info = stream.info();
    println!(
        "slipmate-app: output device switched — device='{}' channels={}",
        info.device_name, info.device_channels
    );
    *audio.stream.lock().unwrap_or_else(|p| p.into_inner()) = Some(stream);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // The WebMIDI shim (ADR-0005): injects `navigator.requestMIDIAccess`
        // into the webview.
        .plugin(tauri_plugin_midi::init())
        // Native file/folder picker for the media browser's folder tab (WKWebView
        // has no File System Access API).
        .plugin(tauri_plugin_dialog::init())
        // Reveal the generated-songs folder in Finder (open_songs_folder); the
        // webview can't download, so songs are written to disk and opened natively.
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Start the audio host (engine + render thread + device), then spawn
            // the per-deck inference sidecars fed by the deck handles. Everything
            // is held in managed state for the app's lifetime.
            let (host, audio_state, deck_handles) = start_audio();
            // The per-deck analysis PCM taps (gap 1): the sidecars tee model PCM
            // into these, the webview subscribes via subscribe_deck_pcm.
            let taps = sidecar::PcmTaps::new(slipmate_engine::DECK_COUNT);
            let (sidecars, idle_handles) =
                start_sidecars(&app.handle().clone(), deck_handles, &taps);
            // The sa3/Magenta generation server (gap 2): the gen-only FastAPI on a
            // loopback port the webview fetches; gated behind SLIPMATE_SIDECARS.
            let generation_server = generation::GenerationServer::start();
            // The generated-songs library: a fixed folder under the user's Documents
            // (override never reaches it from the webview) plus a JSON registry the
            // take list restores from. Auto-save / list / load / delete all go
            // through it. Fall back to a relative path only if Documents can't be
            // resolved (effectively never on macOS) so the app still runs.
            let songs_dir = app
                .path()
                .document_dir()
                .map(|d| d.join("SlipMate").join("generated_songs"))
                .unwrap_or_else(|_| std::path::PathBuf::from("SlipMate/generated_songs"));
            app.manage(songs::SongLibrary::new(songs_dir));
            app.manage(host);
            app.manage(audio_state);
            app.manage(sidecars);
            app.manage(taps);
            app.manage(generation_server);
            app.manage(IdleHandles(Mutex::new(idle_handles)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            list_output_devices,
            set_output_device,
            commands::set_crossfade,
            commands::set_eq,
            commands::set_volume,
            commands::set_fx,
            commands::set_fx_amount,
            commands::clear_fx,
            commands::set_trim,
            commands::set_on_air,
            commands::set_cue,
            commands::set_cue_mix,
            commands::start_recording,
            commands::stop_recording,
            commands::list_audio_files,
            commands::read_audio_file,
            commands::list_generated_songs,
            commands::save_generated_song,
            commands::read_generated_song,
            commands::delete_generated_song,
            commands::open_songs_folder,
            commands::load_track,
            commands::unload_track,
            commands::play_track,
            commands::pause_track,
            commands::seek_track,
            commands::set_track_rate,
            commands::nudge_track_phase,
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
            commands::deck_play,
            commands::deck_stop,
            commands::deck_set_prompt,
            commands::deck_set_style,
            commands::deck_set_model,
            commands::deck_embed_sample,
            commands::subscribe_deck_pcm,
            commands::unsubscribe_deck_pcm,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // Tauri does NOT drop managed state on a macOS quit (tao's event loop ends
        // in `process::exit`, which skips destructors), so the spawned Python
        // servers' `Drop` would never run — leaking them as orphans. Kill them
        // explicitly on `RunEvent::Exit`. (The sidecars also self-terminate on the
        // socket EOF; the generation server has no parent link, so this is the only
        // thing that reaps it.)
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                app.state::<generation::GenerationServer>().shutdown();
                app.state::<sidecar::Sidecars>().shutdown();
            }
        });
}
