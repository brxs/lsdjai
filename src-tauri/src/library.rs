//! Shared filesystem + security helpers for the on-disk media libraries
//! ([`crate::songs`] generated songs, [`crate::samples`] generated samples). The
//! folder layout is the same for both — a folder of audio files plus a JSON
//! `registry.json` carrying the provenance the filesystem can't — so the traversal
//! defenses (`safe_stem` for a write, `scoped_path` for a read/delete) live here
//! ONCE rather than copy-pasted per library: a fix to the boundary cannot then miss
//! one of them (see `.claude/rules/security.md`).
//!
//! Each library layers its own registry entry type, `reconcile`, and `record` on
//! top of these — the per-entry shape stays boringly explicit in its own module.

use std::path::{Component, Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Serialize;

/// The registry file living inside a library folder. Excluded from the audio scan
/// (it is not an audio file).
pub const REGISTRY_FILE: &str = "registry.json";

/// The audio extensions a scan surfaces (mirrors the folder browser's
/// `commands::AUDIO_EXTENSIONS`), compared case-insensitively — so a file dropped in
/// by hand in any of these formats is picked up, not just our own `.wav`.
pub const AUDIO_EXTENSIONS: [&str; 7] = ["wav", "mp3", "flac", "m4a", "ogg", "aif", "aiff"];

/// A generous per-file read cap so a pathological file can't OOM the webview
/// (mirrors `commands::MAX_AUDIO_BYTES`).
pub const MAX_AUDIO_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// The longest filename stem a take/sample gets. A prompt can be thousands of chars
/// (even a pasted JSON spec), but a single filename component is OS-capped
/// (~255 bytes), so the filename takes only the first MAX_STEM_CHARS — the registry
/// carries the full title/prompt, the file is just an identifier.
pub const MAX_STEM_CHARS: usize = 80;

/// Reduce an untrusted title to a SINGLE safe filename stem: every character that
/// isn't alphanumeric, space, `-`, `_`, or `#` becomes `-` (so no `/`, `\`, `.`, or
/// other separator survives) and an empty result falls back to `fallback`. With no
/// separator able to survive, the name stays one path component and cannot escape
/// the library folder — the boundary for a webview-supplied title.
pub fn safe_stem(name: &str, fallback: &str) -> String {
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
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

/// A non-clobbering path inside `dir`: `<stem>.wav`, else `<stem> (2).wav`,
/// `<stem> (3).wav`, … Auto-save fires on every generation and session ids restart
/// each launch, so two runs can mint the same display name — never overwrite an
/// earlier take. Returns `None` when every candidate up to the bound is taken, so
/// the caller errors rather than clobbering. `exists` is injected so the search is
/// unit-testable without the filesystem.
pub fn unique_wav_path(dir: &Path, stem: &str, exists: impl Fn(&Path) -> bool) -> Option<PathBuf> {
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

/// The audio filenames directly inside `dir` (non-recursive), sorted
/// case-insensitively. `registry.json` and any non-audio file are skipped.
pub fn audio_files(dir: &Path) -> Result<Vec<String>, String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("cannot read library folder: {e}"))?;
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
pub fn is_audio_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| AUDIO_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// The display title for a hand-added file: its name without the extension.
pub fn title_from_file(file: &str) -> String {
    Path::new(file)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(file)
        .to_string()
}

fn registry_path(dir: &Path) -> PathBuf {
    dir.join(REGISTRY_FILE)
}

/// Load a library's registry, treating a missing or corrupt file as empty — the scan
/// rebuilds the list from disk regardless, so a damaged registry only loses
/// provenance, never the files. Generic over the entry type so each library reads
/// its own schema.
pub fn load_registry<T: DeserializeOwned>(dir: &Path) -> Vec<T> {
    std::fs::read(registry_path(dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Write a library's registry as pretty JSON.
pub fn save_registry<T: Serialize>(dir: &Path, entries: &[T]) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(entries)
        .map_err(|e| format!("cannot serialise registry: {e}"))?;
    std::fs::write(registry_path(dir), json).map_err(|e| format!("cannot write registry: {e}"))
}

/// Read one file's bytes scoped to `dir` (`name` is a plain filename, never a path —
/// see [`scoped_path`]), refusing a non-file or one larger than `max_bytes`. The
/// read/delete boundary for a webview-supplied name.
pub fn read_scoped(dir: &Path, name: &str, max_bytes: u64) -> Result<Vec<u8>, String> {
    let target = scoped_path(dir, name)?;
    let meta = std::fs::metadata(&target).map_err(|e| format!("cannot stat file: {e}"))?;
    if !meta.is_file() {
        return Err("not a regular file".to_string());
    }
    if meta.len() > max_bytes {
        return Err("file is too large".to_string());
    }
    std::fs::read(&target).map_err(|e| format!("cannot read file: {e}"))
}

/// Resolve `name` to a regular file that is a DIRECT CHILD of `dir`, rejecting paths,
/// `..`, and symlinks that escape the folder. The read/delete boundary: `name` comes
/// from the webview, so without this a crafted name could reach any file the user
/// can.
pub fn scoped_path(dir: &Path, name: &str) -> Result<PathBuf, String> {
    let mut comps = Path::new(name).components();
    if !matches!(
        (comps.next(), comps.next()),
        (Some(Component::Normal(_)), None)
    ) {
        return Err("invalid file name".to_string());
    }
    let base =
        std::fs::canonicalize(dir).map_err(|e| format!("cannot resolve library folder: {e}"))?;
    let target =
        std::fs::canonicalize(base.join(name)).map_err(|e| format!("cannot resolve file: {e}"))?;
    if target.parent() != Some(base.as_path()) {
        return Err("file is outside the library folder".to_string());
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn safe_stem_keeps_a_normal_take_name() {
        assert_eq!(safe_stem("late night dub #2", "song"), "late night dub #2");
    }

    #[test]
    fn safe_stem_strips_path_separators() {
        // No separator may survive, so the sanitised name is always ONE path
        // component — the write boundary for an untrusted webview title.
        let stem = safe_stem("a/b\\c", "song");
        assert_eq!(stem, "a-b-c");
        assert!(!stem.contains('/') && !stem.contains('\\'));
    }

    #[test]
    fn safe_stem_neutralises_traversal() {
        let stem = safe_stem("../../etc/passwd", "song");
        assert!(!stem.contains('/'), "separator survived: {stem}");
        assert!(!stem.contains(".."), "dot-dot survived: {stem}");
        assert_ne!(stem, "..");
    }

    #[test]
    fn safe_stem_falls_back_when_empty() {
        assert_eq!(safe_stem("   ", "song"), "song");
        assert_eq!(safe_stem("", "sample"), "sample");
    }

    #[test]
    fn safe_stem_caps_a_long_prompt_so_the_filename_fits() {
        // A pasted JSON / paragraph prompt must not produce an over-long filename
        // (the write would fail with ENAMETOOLONG); the registry keeps the full text.
        let stem = safe_stem(&"hyperpop ballad ".repeat(400), "song");
        assert!(stem.chars().count() <= MAX_STEM_CHARS, "stem too long: {stem}");
        assert!(!stem.is_empty());
    }

    #[test]
    fn unique_wav_path_suffixes_around_existing_takes() {
        let dir = Path::new("/lib");
        let taken: HashSet<PathBuf> = ["/lib/Take.wav", "/lib/Take (2).wav"]
            .iter()
            .map(PathBuf::from)
            .collect();
        let path = unique_wav_path(dir, "Take", |p| taken.contains(p)).unwrap();
        assert_eq!(path, dir.join("Take (3).wav"));
    }

    #[test]
    fn unique_wav_path_gives_up_rather_than_clobber() {
        // Every candidate "exists" → no free name → None, so `record` errors instead
        // of truncating an earlier take.
        assert!(unique_wav_path(Path::new("/lib"), "Take", |_| true).is_none());
    }
}
