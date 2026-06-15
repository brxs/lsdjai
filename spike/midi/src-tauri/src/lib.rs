//! Spike C — minimal Tauri v2 host for the tauri-plugin-midi WebMIDI shim.
//!
//! The plugin does all the work: `tauri_plugin_midi::init()` injects a JS
//! polyfill (`navigator.requestMIDIAccess`) into the webview at startup via
//! the plugin's `.js_init_script(...)`. The page therefore uses the plain
//! WebMIDI API — no JS import or npm package is required here.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // The only line that wires the WebMIDI shim into the webview.
        .plugin(tauri_plugin_midi::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
