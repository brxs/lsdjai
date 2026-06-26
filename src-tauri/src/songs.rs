//! The generated-songs library: the on-disk folder (`~/Documents/LSDJai/
//! generated_songs`) plus a JSON registry recording each take's prompt and model, so
//! the webview can restore its take list across launches.
//!
//! # The registry and the scan
//!
//! `registry.json` in the folder maps each `.wav` to its display title, the prompt
//! that composed it, and the engine/model used. [`SongLibrary::list`] reconciles it
//! against what is actually on disk on every read (the webview calls it at startup):
//! files added by hand appear with `model = None` ("none"), and files deleted from
//! the folder drop out. So the folder is the source of truth; the registry only adds
//! the provenance the filesystem can't carry.
//!
//! The filesystem + security helpers (the `safe_stem` write boundary, the
//! `scoped_path` read/delete boundary, the registry IO) live in [`crate::library`],
//! shared with the parallel [`crate::samples`] library; this module is just the
//! `SongEntry` schema and the song-specific reconcile/record on top.

use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::library;

/// One row of the song registry — what the webview shows and loads from. `serde`
/// camelCase so the field names match the TS `SongEntry`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SongEntry {
    /// The `.wav` filename inside the folder — the registry identity.
    pub file: String,
    /// Display label: the prompt plus its session id for a composed take, or the
    /// filename stem for a file added by hand.
    pub title: String,
    /// The composition prompt; `None` for a file LSDJai didn't generate.
    pub prompt: Option<String>,
    /// The engine/model that composed the take; `None` ("none") for a hand-added file.
    pub model: Option<String>,
}

/// The metadata the webview sends with a freshly composed take. The WAV bytes ride in
/// the same binary frame, immediately after this JSON (see `commands`).
#[derive(Deserialize)]
pub struct NewSong {
    pub title: String,
    pub prompt: String,
    pub model: String,
}

/// The songs folder plus a lock serialising registry read-modify-write — auto-save
/// can fire for two decks at once, and a delete races with both. Held in Tauri
/// managed state for the app's life. The path is fixed at startup from the user's
/// Documents folder; nothing the webview sends can redirect it.
pub struct SongLibrary {
    dir: std::path::PathBuf,
    lock: Mutex<()>,
}

impl SongLibrary {
    pub fn new(dir: std::path::PathBuf) -> Self {
        Self {
            dir,
            lock: Mutex::new(()),
        }
    }

    /// The folder songs are written to (for the "Open songs folder" reveal).
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Reconcile the registry against the folder and return the current take list.
    /// Writes the reconciled registry back so a hand-added or hand-deleted file is
    /// remembered. Called at webview startup.
    pub fn list(&self) -> Result<Vec<SongEntry>, String> {
        let _guard = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        std::fs::create_dir_all(&self.dir)
            .map_err(|e| format!("cannot create songs folder: {e}"))?;
        let reconciled = reconcile(library::load_registry(&self.dir), &library::audio_files(&self.dir)?);
        library::save_registry(&self.dir, &reconciled)?;
        Ok(reconciled)
    }

    /// Write a freshly composed take to disk under a non-clobbering name, record it in
    /// the registry, and return the stored entry (the webview keeps the filename to
    /// reload or delete the take later).
    pub fn record(&self, new: NewSong, wav: &[u8]) -> Result<SongEntry, String> {
        let _guard = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        std::fs::create_dir_all(&self.dir)
            .map_err(|e| format!("cannot create songs folder: {e}"))?;
        let stem = library::safe_stem(&new.title, "song");
        let path = library::unique_wav_path(&self.dir, &stem, |p| p.exists())
            .ok_or("too many songs with this name")?;
        std::fs::write(&path, wav).map_err(|e| format!("cannot write song: {e}"))?;
        let file = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or("written song has no filename")?
            .to_string();
        let entry = SongEntry {
            file: file.clone(),
            title: new.title,
            prompt: Some(new.prompt),
            model: Some(new.model),
        };
        let mut entries: Vec<SongEntry> = library::load_registry(&self.dir);
        entries.retain(|e| e.file != file);
        entries.push(entry.clone());
        library::save_registry(&self.dir, &entries)?;
        Ok(entry)
    }

    /// Read one song's bytes, scoped to the folder (`name` is a plain filename, never
    /// a path). The bytes are large, so the caller returns them over binary IPC.
    pub fn read(&self, name: &str) -> Result<Vec<u8>, String> {
        library::read_scoped(&self.dir, name, library::MAX_AUDIO_BYTES)
    }

    /// Move a song to the OS Trash (recoverable) and drop it from the registry, so the
    /// take list and the folder stay in sync without waiting for the next scan.
    pub fn remove(&self, name: &str) -> Result<(), String> {
        let _guard = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        let target = library::scoped_path(&self.dir, name)?;
        trash::delete(&target).map_err(|e| format!("cannot move song to Trash: {e}"))?;
        let mut entries: Vec<SongEntry> = library::load_registry(&self.dir);
        entries.retain(|e| e.file != name);
        library::save_registry(&self.dir, &entries)?;
        Ok(())
    }
}

/// Reconcile a loaded registry against the filenames actually on disk: keep known
/// entries (in registry order — i.e. composition order) whose file survives, then
/// append any on-disk file the registry doesn't know yet as a hand-added song
/// (`prompt`/`model` = `None`). Pure, so it is unit-tested without the filesystem.
fn reconcile(existing: Vec<SongEntry>, disk: &[String]) -> Vec<SongEntry> {
    let on_disk: std::collections::HashSet<&str> = disk.iter().map(String::as_str).collect();
    let mut out: Vec<SongEntry> = existing
        .into_iter()
        .filter(|e| on_disk.contains(e.file.as_str()))
        .collect();
    let known: std::collections::HashSet<String> = out.iter().map(|e| e.file.clone()).collect();
    for file in disk {
        if !known.contains(file) {
            out.push(SongEntry {
                title: library::title_from_file(file),
                file: file.clone(),
                prompt: None,
                model: None,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(file: &str, model: Option<&str>) -> SongEntry {
        SongEntry {
            file: file.to_string(),
            title: file.trim_end_matches(".wav").to_string(),
            prompt: model.map(|_| "a prompt".to_string()),
            model: model.map(str::to_string),
        }
    }

    #[test]
    fn reconcile_keeps_known_entries_in_order_and_drops_missing() {
        let existing = vec![entry("first.wav", Some("track")), entry("gone.wav", Some("sfx"))];
        let disk = vec!["first.wav".to_string()];
        let out = reconcile(existing, &disk);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].file, "first.wav");
        assert_eq!(out[0].model.as_deref(), Some("track"));
    }

    #[test]
    fn reconcile_adds_hand_dropped_files_with_no_model() {
        let existing = vec![entry("first.wav", Some("track"))];
        let disk = vec!["first.wav".to_string(), "mixtape.mp3".to_string()];
        let out = reconcile(existing, &disk);
        assert_eq!(out.len(), 2);
        // The known entry keeps its provenance and its place…
        assert_eq!(out[0].file, "first.wav");
        // …and the hand-dropped file is appended with no prompt/model ("none").
        assert_eq!(out[1].file, "mixtape.mp3");
        assert_eq!(out[1].title, "mixtape");
        assert!(out[1].prompt.is_none());
        assert!(out[1].model.is_none());
    }
}
