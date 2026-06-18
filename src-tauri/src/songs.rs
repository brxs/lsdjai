//! The generated-songs library: the on-disk folder (`~/Documents/SlipMate/
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
//! # Trust boundary
//!
//! The destination folder is fixed (never a webview-supplied path), and a
//! webview-supplied song name is reduced to one safe path component before it touches
//! the filesystem — [`safe_stem`] for a new write, [`scoped_path`] (canonicalise +
//! direct-child) for a read/delete. See `.claude/rules/security.md`.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// The registry file living inside the songs folder. Excluded from the scan (it is
/// not an audio file).
const REGISTRY_FILE: &str = "registry.json";

/// The audio extensions the scan surfaces (mirrors the folder browser's
/// `commands::AUDIO_EXTENSIONS`), compared case-insensitively — so a track dropped in
/// by hand in any of these formats is picked up, not just our own `.wav`.
const AUDIO_EXTENSIONS: [&str; 7] = ["wav", "mp3", "flac", "m4a", "ogg", "aif", "aiff"];

/// A generous per-song read cap so a pathological file can't OOM the webview (mirrors
/// `commands::MAX_AUDIO_BYTES`).
const MAX_SONG_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// The longest filename stem a take gets. A prompt can now be thousands of chars (even
/// a pasted JSON spec), but a single filename component is OS-capped (~255 bytes), so
/// the filename takes only the first MAX_STEM_CHARS — the registry carries the full
/// title/prompt, the file is just an identifier.
const MAX_STEM_CHARS: usize = 80;

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
    /// The composition prompt; `None` for a file SlipMate didn't generate.
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
    dir: PathBuf,
    lock: Mutex<()>,
}

impl SongLibrary {
    pub fn new(dir: PathBuf) -> Self {
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
        let reconciled = reconcile(load_registry(&self.dir), &audio_files(&self.dir)?);
        save_registry(&self.dir, &reconciled)?;
        Ok(reconciled)
    }

    /// Write a freshly composed take to disk under a non-clobbering name, record it in
    /// the registry, and return the stored entry (the webview keeps the filename to
    /// reload or delete the take later).
    pub fn record(&self, new: NewSong, wav: &[u8]) -> Result<SongEntry, String> {
        let _guard = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        std::fs::create_dir_all(&self.dir)
            .map_err(|e| format!("cannot create songs folder: {e}"))?;
        let path = unique_song_path(&self.dir, &safe_stem(&new.title), |p| p.exists())
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
        let mut entries = load_registry(&self.dir);
        entries.retain(|e| e.file != file);
        entries.push(entry.clone());
        save_registry(&self.dir, &entries)?;
        Ok(entry)
    }

    /// Read one song's bytes, scoped to the folder (`name` is a plain filename, never
    /// a path — see [`scoped_path`]). The bytes are large, so the caller returns them
    /// over binary IPC.
    pub fn read(&self, name: &str) -> Result<Vec<u8>, String> {
        let target = scoped_path(&self.dir, name)?;
        let meta = std::fs::metadata(&target).map_err(|e| format!("cannot stat song: {e}"))?;
        if !meta.is_file() {
            return Err("not a regular file".to_string());
        }
        if meta.len() > MAX_SONG_BYTES {
            return Err("file is too large".to_string());
        }
        std::fs::read(&target).map_err(|e| format!("cannot read song: {e}"))
    }

    /// Move a song to the OS Trash (recoverable) and drop it from the registry, so the
    /// take list and the folder stay in sync without waiting for the next scan.
    pub fn remove(&self, name: &str) -> Result<(), String> {
        let _guard = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        let target = scoped_path(&self.dir, name)?;
        trash::delete(&target).map_err(|e| format!("cannot move song to Trash: {e}"))?;
        let mut entries = load_registry(&self.dir);
        entries.retain(|e| e.file != name);
        save_registry(&self.dir, &entries)?;
        Ok(())
    }
}

/// Reconcile a loaded registry against the filenames actually on disk: keep known
/// entries (in registry order — i.e. composition order) whose file survives, then
/// append any on-disk file the registry doesn't know yet as a hand-added song
/// (`prompt`/`model` = `None`). Pure, so it is unit-tested without the filesystem.
fn reconcile(existing: Vec<SongEntry>, disk: &[String]) -> Vec<SongEntry> {
    let on_disk: HashSet<&str> = disk.iter().map(String::as_str).collect();
    let mut out: Vec<SongEntry> = existing
        .into_iter()
        .filter(|e| on_disk.contains(e.file.as_str()))
        .collect();
    let known: HashSet<String> = out.iter().map(|e| e.file.clone()).collect();
    for file in disk {
        if !known.contains(file) {
            out.push(SongEntry {
                title: title_from_file(file),
                file: file.clone(),
                prompt: None,
                model: None,
            });
        }
    }
    out
}

/// The display title for a hand-added file: its name without the extension.
fn title_from_file(file: &str) -> String {
    Path::new(file)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(file)
        .to_string()
}

/// The audio filenames directly inside `dir` (non-recursive), sorted
/// case-insensitively. `registry.json` and any non-audio file are skipped.
fn audio_files(dir: &Path) -> Result<Vec<String>, String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("cannot read songs folder: {e}"))?;
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && is_audio_file(path))
        .filter_map(|path| path.file_name()?.to_str().map(str::to_string))
        .collect();
    names.sort_by_key(|name| name.to_lowercase());
    Ok(names)
}

/// Whether `path` has one of [`AUDIO_EXTENSIONS`] (case-insensitive).
fn is_audio_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| AUDIO_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn registry_path(dir: &Path) -> PathBuf {
    dir.join(REGISTRY_FILE)
}

/// Load the registry, treating a missing or corrupt file as empty — the scan rebuilds
/// the list from disk regardless, so a damaged registry only loses provenance, never
/// the songs.
fn load_registry(dir: &Path) -> Vec<SongEntry> {
    std::fs::read(registry_path(dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_registry(dir: &Path, entries: &[SongEntry]) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(entries)
        .map_err(|e| format!("cannot serialise registry: {e}"))?;
    std::fs::write(registry_path(dir), json)
        .map_err(|e| format!("cannot write registry: {e}"))
}

/// Reduce an untrusted song title to a SINGLE safe filename stem: every character that
/// isn't alphanumeric, space, `-`, `_`, or `#` becomes `-` (so no `/`, `\`, `.`, or
/// other separator survives) and an empty result falls back to `song`. With no
/// separator able to survive, the name stays one path component and cannot escape the
/// songs folder — the boundary for a webview-supplied title.
fn safe_stem(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '#') {
                c
            } else {
                '-'
            }
        })
        .collect();
    // Take only the first MAX_STEM_CHARS: a prompt can be thousands of chars now, and
    // a filename that long would blow the OS component limit (the write would fail).
    let capped: String = cleaned.trim().chars().take(MAX_STEM_CHARS).collect();
    let trimmed = capped.trim();
    if trimmed.is_empty() {
        "song".to_string()
    } else {
        trimmed.to_string()
    }
}

/// A non-clobbering path inside `dir`: `<stem>.wav`, else `<stem> (2).wav`,
/// `<stem> (3).wav`, … Auto-save fires on every generation and session ids restart
/// each launch, so two runs can mint the same display name — never overwrite an
/// earlier take. Returns `None` when every candidate up to the bound is taken, so the
/// caller errors rather than clobbering. `exists` is injected so the search is
/// unit-testable without the filesystem.
fn unique_song_path(dir: &Path, stem: &str, exists: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    let first = dir.join(format!("{stem}.wav"));
    if !exists(&first) {
        return Some(first);
    }
    for n in 2..10_000 {
        let candidate = dir.join(format!("{stem} ({n}).wav"));
        if !exists(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// Resolve `name` to a regular file that is a DIRECT CHILD of `dir`, rejecting paths,
/// `..`, and symlinks that escape the folder. The read/delete boundary: `name` comes
/// from the webview, so without this a crafted name could reach any file the user can.
fn scoped_path(dir: &Path, name: &str) -> Result<PathBuf, String> {
    let mut comps = Path::new(name).components();
    if !matches!(
        (comps.next(), comps.next()),
        (Some(Component::Normal(_)), None)
    ) {
        return Err("invalid file name".to_string());
    }
    let base = std::fs::canonicalize(dir).map_err(|e| format!("cannot resolve songs folder: {e}"))?;
    let target =
        std::fs::canonicalize(base.join(name)).map_err(|e| format!("cannot resolve song: {e}"))?;
    if target.parent() != Some(base.as_path()) {
        return Err("song is outside the songs folder".to_string());
    }
    Ok(target)
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
    fn safe_stem_keeps_a_normal_take_name() {
        assert_eq!(safe_stem("late night dub #2"), "late night dub #2");
    }

    #[test]
    fn safe_stem_strips_path_separators() {
        // No separator may survive, so the sanitised name is always ONE path
        // component — the write boundary for an untrusted webview title.
        let stem = safe_stem("a/b\\c");
        assert_eq!(stem, "a-b-c");
        assert!(!stem.contains('/') && !stem.contains('\\'));
    }

    #[test]
    fn safe_stem_neutralises_traversal() {
        let stem = safe_stem("../../etc/passwd");
        assert!(!stem.contains('/'), "separator survived: {stem}");
        assert!(!stem.contains(".."), "dot-dot survived: {stem}");
        assert_ne!(stem, "..");
    }

    #[test]
    fn safe_stem_falls_back_when_empty() {
        assert_eq!(safe_stem("   "), "song");
        assert_eq!(safe_stem(""), "song");
    }

    #[test]
    fn unique_song_path_suffixes_around_existing_takes() {
        let dir = Path::new("/songs");
        let taken: HashSet<PathBuf> = ["/songs/Take.wav", "/songs/Take (2).wav"]
            .iter()
            .map(PathBuf::from)
            .collect();
        let path = unique_song_path(dir, "Take", |p| taken.contains(p)).unwrap();
        assert_eq!(path, dir.join("Take (3).wav"));
    }

    #[test]
    fn unique_song_path_gives_up_rather_than_clobber() {
        // Every candidate "exists" → no free name → None, so `record` errors instead of
        // truncating an earlier take.
        assert!(unique_song_path(Path::new("/songs"), "Take", |_| true).is_none());
    }

    #[test]
    fn safe_stem_caps_a_long_prompt_so_the_filename_fits() {
        // A pasted JSON / paragraph prompt must not produce an over-long filename
        // (the write would fail with ENAMETOOLONG); the registry keeps the full text.
        let stem = safe_stem(&"hyperpop ballad ".repeat(400));
        assert!(stem.chars().count() <= MAX_STEM_CHARS, "stem too long: {stem}");
        assert!(!stem.is_empty());
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
