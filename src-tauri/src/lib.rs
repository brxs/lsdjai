//! LSDJai native shell — the Tauri v2 app host (Phase 2).
//!
//! This embeds the React frontend, wires the WebMIDI plugin, starts the Rust
//! audio engine, and exposes the engine control surface to the webview over IPC.
//!
//! # The audio host lifecycle (the load-bearing bit)
//!
//! On `setup` we build a [`Host`] ([`lsdj_engine::host`]). `Host::new` builds
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
//! We then start the cpal device via [`engine_device::open_main_stream`], which
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

use lsdj_engine::device::{self as engine_device, AudioStream, DeviceError};
use lsdj_engine::host::Host;
use lsdj_engine::DeckHandle;
use tauri::Manager;

mod commands;
mod generation;
mod library;
mod models;
mod samples;
mod sidecar;
mod songs;
mod watcher;

/// The default per-deck model the sidecars load (mirrors `controller.py`
/// `DEFAULT_MODEL`).
const DEFAULT_MODEL: &str = "mrt2_small";

/// Tauri-managed audio state held ALONGSIDE the [`Host`]: the running output
/// streams (kept alive so their Drop does not stop audio), the current device
/// choices, and whether the main device actually started.
///
/// The `Host` is managed separately so the commands can take it as
/// `tauri::State<'_, Host>` directly. This struct holds the things the commands
/// do not need but the app must keep alive.
///
/// Two streams, dual-mode (ADR-0021): the MAIN stream always drains the master
/// ring onto channels 1/2; the CUE stream depends on the chosen cue device:
/// - **combined** (cue = "same as main", an empty `cue_name` or one equal to
///   `main_name`): the cue rides the main device's channels 3/4 (the FLX4 phones
///   jack) and `cue_stream` is `None`.
/// - **split** (a different `cue_name`): a separate `cue_stream` drains the cue
///   ring onto its own device's 1/2, so the cue reaches any second output.
struct AudioState {
    /// The MAIN output stream — master → ch 1/2, and cue → ch 3/4 in combined
    /// mode. Kept alive; replaced when the main device (or the combined/split
    /// mode) changes. `None` in the sandbox/headless case.
    main_stream: Mutex<Option<AudioStream>>,
    /// The CUE output stream in SPLIT mode (a separate device); `None` in combined
    /// mode (the cue rides the main stream's 3/4).
    cue_stream: Mutex<Option<AudioStream>>,
    /// Whether the main device came up at startup (the `app_info` flag).
    device_started: bool,
    /// The current main device name (empty = system default), so a cue-only switch
    /// can recompute the combined/split topology.
    main_name: Mutex<String>,
    /// The current cue device name (empty = "same as main" → combined).
    cue_name: Mutex<String>,
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
fn start_audio() -> (Host, AudioState, [DeckHandle; lsdj_engine::DECK_COUNT]) {
    let (host, master, cue, deck_handles) = Host::new();

    // Start combined on the default device: master → 1/2 and cue → 3/4 if the
    // device is ≥4-channel (the FLX4), exactly as before. A separate cue device is
    // opted into later via `set_cue_device`. These are the ORIGINAL ring consumers
    // matching the render thread's producers, so no ring install is needed yet.
    let (main_stream, device_started) =
        match engine_device::open_main_stream(None, master, Some(cue)) {
            Ok(stream) => {
                let info = stream.info();
                // Non-RT setup logging only; the RT callback itself logs nothing.
                println!(
                    "lsdj-app: audio device started — device='{}' channels={} rate={} buffer={:?}",
                    info.device_name, info.device_channels, info.sample_rate, info.buffer_frames
                );
                (Some(stream), true)
            }
            Err(DeviceError::Unavailable(msg)) => {
                // Expected in a sandbox / headless CI: no exact-48000/f32 device.
                // Log and continue with no stream — the host renders into the ring,
                // the window opens, control/read-back work.
                eprintln!("lsdj-app: audio device unavailable ({msg}) — continuing without audio");
                (None, false)
            }
            Err(DeviceError::Stream(msg)) => {
                eprintln!("lsdj-app: audio stream error ({msg}) — continuing without audio");
                (None, false)
            }
        };

    let state = AudioState {
        main_stream: Mutex::new(main_stream),
        cue_stream: Mutex::new(None),
        device_started,
        main_name: Mutex::new(String::new()),
        cue_name: Mutex::new(String::new()),
    };
    (host, state, deck_handles)
}

/// Spawn one inference sidecar per deck, each fed by its [`DeckHandle`] and
/// reporting status as a `sidecar://status` Tauri event. Gated behind the
/// `LSDJ_SIDECARS` env var during the migration (so a plain `tauri dev` does
/// not launch Python until the native inference path is enabled / on the
/// checklist); part 7 (cutover) makes it the default. Handles for decks without a
/// sidecar are returned to keep their rings open.
fn start_sidecars(
    app: &tauri::AppHandle,
    handles: [DeckHandle; lsdj_engine::DECK_COUNT],
    taps: &sidecar::PcmTaps,
) -> (sidecar::Sidecars, Vec<DeckHandle>) {
    const DECK_IDS: [&str; lsdj_engine::DECK_COUNT] = ["a", "b"];
    let enabled = std::env::var("LSDJ_SIDECARS").is_ok();
    if !enabled {
        eprintln!("lsdj-app: sidecars disabled (set LSDJ_SIDECARS=1 to enable)");
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
                eprintln!("lsdj-app: deck {deck_id} sidecar spawn failed: {e}");
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

/// The webview message for a switch that could not land because the engine's
/// command queue was momentarily full — the caller keeps the old stream and the
/// UI invites a retry.
const ENGINE_BUSY: &str = "the audio engine was momentarily busy — try switching again";

/// True when the cue device choice means "ride the main device" (combined mode):
/// an empty cue name ("same as main") or one equal to the main device.
fn is_combined(main_name: &str, cue_name: &str) -> bool {
    cue_name.is_empty() || cue_name == main_name
}

/// Convert a stored device name into the `open_*` selector (empty → the system
/// default `None`).
fn selector(name: &str) -> Option<&str> {
    (!name.is_empty()).then_some(name)
}

/// (Re)open the MAIN stream for the given device choices. In combined mode the cue
/// rides the main device's channels 3/4 (and any split cue stream is dropped); in
/// split mode the main stream is master-only and the existing cue stream is left
/// running. Opens the new device FIRST and only swaps the render thread's ring(s)
/// on success, so a failed open leaves current audio untouched. Briefly gaps the
/// master (you are changing the master device, or moving the cue onto it).
fn reopen_main(
    host: &Host,
    audio: &AudioState,
    main_name: &str,
    cue_name: &str,
) -> Result<(), String> {
    let combined = is_combined(main_name, cue_name);
    let (master_ring, master_consumer) = host.new_output_ring();
    // In combined mode build a fresh cue ring too, so the cue rides the main
    // device's 3/4; `open_main_stream` drops it if the device is < 4 channels.
    let (cue_ring, cue_consumer) = if combined {
        let (ring, consumer) = host.new_output_ring();
        (Some(ring), Some(consumer))
    } else {
        (None, None)
    };
    let stream = engine_device::open_main_stream(selector(main_name), master_consumer, cue_consumer)
        .map_err(|e| e.to_string())?;
    if !host.install_master_ring(master_ring) {
        return Err(ENGINE_BUSY.into());
    }
    if let Some(cue_ring) = cue_ring {
        // Combined: the cue now rides the main stream's 3/4 — install its ring
        // (best-effort; the cue is secondary) and drop any split cue stream.
        host.install_cue_ring(cue_ring);
        *audio.cue_stream.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }
    let info = stream.info();
    println!(
        "lsdj-app: main output switched — device='{}' channels={} combined_cue={combined}",
        info.device_name, info.device_channels
    );
    *audio.main_stream.lock().unwrap_or_else(|p| p.into_inner()) = Some(stream);
    Ok(())
}

/// (Re)open the SPLIT cue stream on its own device, leaving the main stream (and
/// the master ring) completely untouched — the property that lets a cue-device
/// switch never interrupt the audience's master.
fn reopen_cue_split(host: &Host, audio: &AudioState, cue_name: &str) -> Result<(), String> {
    let (cue_ring, cue_consumer) = host.new_output_ring();
    let stream =
        engine_device::open_cue_stream(selector(cue_name), cue_consumer).map_err(|e| e.to_string())?;
    if !host.install_cue_ring(cue_ring) {
        return Err(ENGINE_BUSY.into());
    }
    let info = stream.info();
    println!(
        "lsdj-app: cue output switched — device='{}' channels={}",
        info.device_name, info.device_channels
    );
    *audio.cue_stream.lock().unwrap_or_else(|p| p.into_inner()) = Some(stream);
    Ok(())
}

/// Switch the MAIN output device by name (EMPTY = the system default). Rebuilds
/// the main stream (carrying the cue on 3/4 if the current cue choice is
/// combined); a split cue stream keeps playing on its own device, undisturbed.
#[tauri::command]
fn set_main_device(
    host: tauri::State<'_, Host>,
    audio: tauri::State<'_, AudioState>,
    name: String,
) -> Result<(), String> {
    let cue_name = audio.cue_name.lock().unwrap_or_else(|p| p.into_inner()).clone();
    reopen_main(&host, &audio, &name, &cue_name)?;
    *audio.main_name.lock().unwrap_or_else(|p| p.into_inner()) = name;
    Ok(())
}

/// Switch the CUE output device by name (EMPTY = "same as main" → combined, the
/// FLX4 phones jack on channels 3/4). A split→split change touches ONLY the cue
/// stream (the master is never interrupted); transitions into or out of combined
/// also reopen the main stream (a brief master gap, the rarer case).
#[tauri::command]
fn set_cue_device(
    host: tauri::State<'_, Host>,
    audio: tauri::State<'_, AudioState>,
    name: String,
) -> Result<(), String> {
    let main_name = audio.main_name.lock().unwrap_or_else(|p| p.into_inner()).clone();
    let was_combined = {
        let cue_name = audio.cue_name.lock().unwrap_or_else(|p| p.into_inner());
        // Re-selecting the already-active cue device would tear down and rebuild
        // the cue stream for no change (a needless cue glitch) — short-circuit.
        if name == *cue_name {
            return Ok(());
        }
        is_combined(&main_name, &cue_name)
    };
    if is_combined(&main_name, &name) {
        // Cue rides the main device's 3/4: reopen main with cue duty (it also drops
        // any split cue stream).
        reopen_main(&host, &audio, &main_name, &name)?;
    } else {
        // Split: open/replace the cue stream on its own device — the user's actual
        // intent, fatal if it fails. Once it returns the cue is live on the new
        // device, so the switch has succeeded.
        reopen_cue_split(&host, &audio, &name)?;
        if was_combined {
            // Leaving combined: reopen main master-only so the cue isn't left
            // duplicated on the old main device's 3/4. Best-effort — the cue
            // switch already succeeded and the master is untouched on failure
            // (reopen_main swaps only on success), so we log rather than fail and
            // leave `cue_name` consistent with the live cue. Any stray duplicate
            // clears on the next main switch.
            if let Err(e) = reopen_main(&host, &audio, &main_name, &name) {
                eprintln!(
                    "lsdj-app: cue moved to '{name}', but clearing it from the old \
                     main device's 3/4 failed: {e}"
                );
            }
        }
    }
    *audio.cue_name.lock().unwrap_or_else(|p| p.into_inner()) = name;
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
            // Relocate the Magenta model weights out of ~/Documents (which users
            // may sync to iCloud) into the app-owned data dir, migrating a prior
            // install. MUST run before any backend process spawns so they — and
            // magenta_rt.paths, read at import — inherit MAGENTA_HOME (issue #43).
            models::ensure_magenta_home();
            // Start the audio host (engine + render thread + device), then spawn
            // the per-deck inference sidecars fed by the deck handles. Everything
            // is held in managed state for the app's lifetime.
            let (host, audio_state, deck_handles) = start_audio();
            // The per-deck analysis PCM taps (gap 1): the sidecars tee model PCM
            // into these, the webview subscribes via subscribe_deck_pcm.
            let taps = sidecar::PcmTaps::new(lsdj_engine::DECK_COUNT);
            let (sidecars, idle_handles) =
                start_sidecars(&app.handle().clone(), deck_handles, &taps);
            // The sa3/Magenta generation server (gap 2): the gen-only FastAPI on a
            // loopback port the webview fetches; gated behind LSDJ_SIDECARS.
            let generation_server = generation::GenerationServer::start();
            // The generated-songs library: a fixed folder under the user's Documents
            // (override never reaches it from the webview) plus a JSON registry the
            // take list restores from. Auto-save / list / load / delete all go
            // through it. Fall back to a relative path only if Documents can't be
            // resolved (effectively never on macOS) so the app still runs.
            let songs_dir = app
                .path()
                .document_dir()
                .map(|d| d.join("LSDJai").join("generated_songs"))
                .unwrap_or_else(|_| std::path::PathBuf::from("LSDJai/generated_songs"));
            app.manage(songs::SongLibrary::new(songs_dir.clone()));
            // The generated-samples library: the short-loop counterpart of the songs
            // folder (ADR-0022), the home for deck freezes / generated pads / composed
            // SFX-Music that used to die at session end. Same fixed-folder + registry
            // discipline.
            let samples_dir = app
                .path()
                .document_dir()
                .map(|d| d.join("LSDJai").join("generated_samples"))
                .unwrap_or_else(|_| std::path::PathBuf::from("LSDJai/generated_samples"));
            app.manage(samples::SampleLibrary::new(samples_dir.clone()));
            // Watch both library folders so the Media Explorer tabs live-reload on a
            // change (a deck auto-saving a sample, a hand-drop/-delete); Rust owns the
            // watch and emits `library://changed` (ADR-0022).
            watcher::watch_libraries(app.handle().clone(), songs_dir, samples_dir);
            // The in-app model manager (issue #43): own the install lifecycle and
            // watch the Magenta models dir so the manager + deck picker live-reload
            // when a model folder appears/disappears (`models://changed`).
            app.manage(models::InstallManager::new());
            watcher::watch_models(app.handle().clone(), models::magenta_models_dir());
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
            set_main_device,
            set_cue_device,
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
            commands::audition_play,
            commands::audition_stop,
            commands::start_recording,
            commands::stop_recording,
            commands::list_audio_files,
            commands::read_audio_file,
            commands::list_generated_songs,
            commands::save_generated_song,
            commands::read_generated_song,
            commands::delete_generated_song,
            commands::open_songs_folder,
            commands::list_generated_samples,
            commands::save_generated_sample,
            commands::read_generated_sample,
            commands::delete_generated_sample,
            commands::open_samples_folder,
            commands::save_loop_slot,
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
            commands::stop_layer,
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
            models::model_status,
            models::install_model,
            models::cancel_install,
            models::open_model_folder,
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
                app.state::<models::InstallManager>().shutdown();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::is_combined;

    /// The cue rides the main device (combined) when no separate cue device is
    /// chosen — an empty cue name is the "same as main" sentinel.
    #[test]
    fn empty_cue_is_combined() {
        assert!(is_combined("", "")); // default main + default cue
        assert!(is_combined("DDJ-FLX4", "")); // named main, "same as main" cue
    }

    /// Naming the cue device the same as the main device is also combined (the
    /// guard that stops the same physical device opening two streams).
    #[test]
    fn cue_equal_to_main_is_combined() {
        assert!(is_combined("DDJ-FLX4", "DDJ-FLX4"));
        assert!(is_combined("", "")); // both default → same device → combined
    }

    /// A cue device distinct from the main device is split (its own stream).
    #[test]
    fn distinct_cue_device_is_split() {
        assert!(!is_combined("MacBook Speakers", "DDJ-FLX4"));
        assert!(!is_combined("", "DDJ-FLX4")); // default main, a named cue device
        assert!(!is_combined("DDJ-FLX4", "Built-in Output"));
    }
}
