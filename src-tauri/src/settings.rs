//! Shell-persisted app settings (ADR-0020 phase A).
//!
//! Settings the SHELL consumes — the output devices and the recordings
//! folder — used to live in webview localStorage, replayed into the engine
//! at boot by App.tsx. Persistence follows ownership: they now persist here
//! (a JSON file under the app data dir, beside the MCP token), hydrate into
//! the engine and the interface store during `setup` — before the webview
//! exists — and mutate through the same commands every controller uses. The
//! webview's pickers become projections. Presentation-only preferences
//! (accent, beat view) deliberately stay webview-side: the shell never
//! consumes them.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// The persisted shape. `#[serde(default)]` keeps old files readable as
/// fields are added; empty strings are the defaults ("system default"
/// device, "same as main" cue, "Downloads" folder).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ShellSettings {
    pub main_device: String,
    pub cue_device: String,
    pub recordings_folder: String,
    /// Per-deck style-pad arrangements (ADR-0020 phase B), indexed by deck.
    /// Text targets + cursor only — sampled chips are session-only (ADR-0011).
    pub deck_styles: Vec<DeckStyleSetting>,
}

/// One deck's persisted style-pad arrangement. The file is user-editable, so
/// hydration sanitises through [`crate::style::sanitize_preset_targets`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DeckStyleSetting {
    pub targets: Vec<crate::store::StyleTargetSnap>,
    pub cursor: crate::store::PadPointSnap,
}

impl Default for DeckStyleSetting {
    fn default() -> Self {
        DeckStyleSetting {
            targets: Vec::new(),
            cursor: crate::store::PadPointSnap { x: 0.5, y: 0.5 },
        }
    }
}

fn settings_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join("settings.json"))
}

/// Load from a concrete path (the testable core): a missing or unreadable
/// file is the defaults — settings must never block boot.
pub fn load_from(path: &Path) -> ShellSettings {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

/// Save to a concrete path, creating the parent dir; best-effort by design
/// (a read-only disk must not break a device switch).
pub fn save_to(path: &Path, settings: &ShellSettings) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(settings) {
        let _ = std::fs::write(path, json);
    }
}

pub fn load(app: &AppHandle) -> ShellSettings {
    settings_file(app).map(|p| load_from(&p)).unwrap_or_default()
}

pub fn save(app: &AppHandle, settings: &ShellSettings) {
    if let Some(path) = settings_file(app) {
        save_to(&path, settings);
    }
}

/// Read-modify-write one field; the single mutation path the commands use.
pub fn update(app: &AppHandle, mutate: impl FnOnce(&mut ShellSettings)) -> ShellSettings {
    let mut settings = load(app);
    mutate(&mut settings);
    save(app, &settings);
    settings
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_defaults_when_missing_or_corrupt() {
        let dir = std::env::temp_dir().join(format!("lsdj-settings-{}", std::process::id()));
        let path = dir.join("settings.json");
        // Missing file → defaults.
        assert_eq!(load_from(&path), ShellSettings::default());
        // Round trip.
        let settings = ShellSettings {
            main_device: "DDJ-FLX4".into(),
            cue_device: "".into(),
            recordings_folder: "/tmp/takes".into(),
            deck_styles: vec![DeckStyleSetting {
                targets: vec![crate::store::StyleTargetSnap {
                    x: 0.2,
                    y: 0.8,
                    text: "dub".into(),
                    sample: None,
                }],
                cursor: crate::store::PadPointSnap { x: 0.3, y: 0.4 },
            }],
        };
        save_to(&path, &settings);
        assert_eq!(load_from(&path), settings);
        // Corrupt file → defaults, not a crash.
        std::fs::write(&path, "not json").unwrap();
        assert_eq!(load_from(&path), ShellSettings::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn old_files_stay_readable_as_fields_grow() {
        let dir = std::env::temp_dir().join(format!("lsdj-settings-old-{}", std::process::id()));
        let path = dir.join("settings.json");
        std::fs::create_dir_all(&dir).unwrap();
        // A file from a build that only knew mainDevice.
        std::fs::write(&path, r#"{ "mainDevice": "Speakers" }"#).unwrap();
        let settings = load_from(&path);
        assert_eq!(settings.main_device, "Speakers");
        assert_eq!(settings.cue_device, "");
        assert_eq!(settings.recordings_folder, "");
        assert!(settings.deck_styles.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
