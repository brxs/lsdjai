//! Per-deck Python inference sidecar supervision (Phase 2 part 4, ADR-0019).
//!
//! The Rust shell spawns one Python sidecar per deck (replacing `controller.py`'s
//! `DeckProcess`), connected over **loopback TCP** — the transport Spike A chose
//! (`docs/spike-rust-audio.md`; `127.0.0.1`, `TCP_NODELAY`, beat UDS on every
//! percentile under inference load). The sidecar runs the unchanged
//! `run_deck_worker` generation loop (`backend/slipmate/worker.py`) with its
//! queues bridged to the socket.
//!
//! # Wire protocol
//!
//! Type-tagged, length-prefixed frames in both directions on the one socket —
//! the Spike-A `u32`-length framing plus a one-byte type so PCM, status, and
//! control share the stream:
//!
//! ```text
//! [u8 type][u32 little-endian length][length bytes payload]
//! ```
//!
//! - [`FRAME_PCM`] (sidecar → engine): interleaved-stereo f32 LE @ 48 kHz, the
//!   `('audio', bytes)` worker output → [`DeckHandle::post_pcm`].
//! - [`FRAME_STATUS`] (sidecar → engine): UTF-8 JSON, the `('status', dict)`
//!   worker output → a Tauri event the webview subscribes to.
//! - [`FRAME_CONTROL`] (engine → sidecar): UTF-8 JSON, a deck command
//!   (`play`/`stop`/`set_style`/…) the webview drove over IPC.
//!
//! # Testability
//!
//! The protocol ([`write_frame`]/[`read_frame`]) and the read loop
//! ([`run_reader`]) are decoupled from the process spawn: a test drives a real
//! `TcpStream` pair (or any `Read`/`Write`) and asserts PCM reaches a
//! `DeckHandle` and status reaches a sink — no Python, no models. The full
//! model-loaded round-trip is a native-checklist item.

use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use slipmate_engine::DeckHandle;

/// Sidecar → engine: interleaved-stereo f32 LE PCM (the `('audio', …)` output).
pub const FRAME_PCM: u8 = 1;
/// Sidecar → engine: UTF-8 JSON status (the `('status', …)` output).
pub const FRAME_STATUS: u8 = 2;
/// Engine → sidecar: UTF-8 JSON deck control (`play`/`stop`/`set_style`/…).
pub const FRAME_CONTROL: u8 = 3;

/// Cap on a single frame's payload — a guard against a desynced/hostile stream
/// allocating unbounded memory. A 1 s PCM chunk is 384 000 bytes; 16 MiB is far
/// above any legitimate frame yet bounds a bad `len`.
const MAX_FRAME_BYTES: u32 = 16 * 1024 * 1024;

/// How long the accept waits for the spawned sidecar to dial back before giving
/// up (it connects immediately on startup; a longer hang means it failed to
/// launch).
const ACCEPT_TIMEOUT: Duration = Duration::from_secs(30);

/// Write one framed message: a type byte, a little-endian `u32` length, then the
/// payload. Flushes so the consumer sees it promptly (the socket is `nodelay`).
pub fn write_frame(w: &mut impl Write, frame_type: u8, payload: &[u8]) -> io::Result<()> {
    w.write_all(&[frame_type])?;
    w.write_all(&(payload.len() as u32).to_le_bytes())?;
    w.write_all(payload)?;
    w.flush()
}

/// Read one framed message, or `Ok(None)` on a clean EOF at a frame boundary
/// (the sidecar closed the socket). Errors on a truncated frame or a length
/// above [`MAX_FRAME_BYTES`].
pub fn read_frame(r: &mut impl Read) -> io::Result<Option<(u8, Vec<u8>)>> {
    let mut head = [0u8; 5];
    match r.read_exact(&mut head) {
        Ok(()) => {}
        // A clean EOF before any byte of the next frame is a normal close.
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let frame_type = head[0];
    let len = u32::from_le_bytes([head[1], head[2], head[3], head[4]]);
    if len > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("sidecar frame length {len} exceeds the cap"),
        ));
    }
    let mut payload = vec![0u8; len as usize];
    r.read_exact(&mut payload)?;
    Ok(Some((frame_type, payload)))
}

/// Reinterpret interleaved f32 LE bytes as samples (any trailing partial frame
/// is dropped). The PCM path's per-chunk conversion.
fn pcm_from_le_bytes(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// The read loop: drain frames from the sidecar until EOF/error. PCM frames are
/// posted to the deck's ring (the non-RT producer side); status frames go to
/// `on_status` (the Tauri-event sink in production, a recorder in tests).
///
/// Returns the [`DeckHandle`] when the stream closes — the supervisor reclaims it
/// (the engine's ring is permanent across a sidecar exit; the handle outlives any
/// one connection), and `on_status` is borrowed so the supervisor can still
/// report the exit afterwards.
pub fn run_reader(
    mut stream: impl Read,
    mut deck_handle: DeckHandle,
    on_status: &mut impl FnMut(String),
) -> DeckHandle {
    loop {
        match read_frame(&mut stream) {
            Ok(Some((FRAME_PCM, payload))) => {
                let samples = pcm_from_le_bytes(&payload);
                // post_pcm is non-blocking: an overrun drops the surplus (the ring
                // is the prebuffer). The worker paces ~3 s ahead, so this is rare.
                deck_handle.post_pcm(&samples);
            }
            Ok(Some((FRAME_STATUS, payload))) => {
                if let Ok(text) = String::from_utf8(payload) {
                    on_status(text);
                }
            }
            // An unknown frame type is ignored (forward-compatible), not fatal.
            Ok(Some(_)) => {}
            Ok(None) | Err(_) => break,
        }
    }
    deck_handle
}

/// One supervised deck sidecar: the spawned Python process, the control writer
/// (engine → sidecar), and the reader thread (sidecar → engine). Dropping it
/// stops the reader, closes the socket, and kills the child.
pub struct Sidecar {
    deck_id: String,
    /// The control-writer half of the socket; `None` until the sidecar connects,
    /// and after a teardown. Behind a `Mutex` so IPC callers serialise writes.
    control: Arc<Mutex<Option<TcpStream>>>,
    child: Arc<Mutex<Option<Child>>>,
    stop: Arc<AtomicBool>,
    reader: Option<JoinHandle<()>>,
}

impl Sidecar {
    /// Spawn and supervise the sidecar for `deck_id`, feeding `deck_handle` and
    /// reporting status through `on_status`. Binds a loopback listener, launches
    /// the Python sidecar pointed at the bound port, accepts its connection, and
    /// starts the reader thread. The spawn command is [`sidecar_command`]
    /// (overridable via `SLIPMATE_SIDECAR_CMD` for dev vs. the packaged binary).
    ///
    /// Errors if the listener cannot bind or the process cannot launch — the
    /// caller logs and leaves that deck without a sidecar (the engine still runs,
    /// silent on that deck), exactly like the graceful no-audio-device path.
    pub fn spawn(
        deck_id: &str,
        model: &str,
        deck_handle: DeckHandle,
        on_status: impl FnMut(String) + Send + 'static,
    ) -> io::Result<Sidecar> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        listener.set_nonblocking(false).ok();
        let port = listener.local_addr()?.port();

        let child = sidecar_command(deck_id, model, port)?.spawn()?;

        let control: Arc<Mutex<Option<TcpStream>>> = Arc::new(Mutex::new(None));
        let stop = Arc::new(AtomicBool::new(false));

        // Accept + read on one thread: it owns the listener until the sidecar
        // dials back, stashes the control writer, then runs the read loop.
        let control_for_reader = control.clone();
        let stop_for_reader = stop.clone();
        let deck_label = deck_id.to_string();
        let mut on_status = on_status;
        let reader = thread::Builder::new()
            .name(format!("slipmate-sidecar-{deck_id}"))
            .spawn(move || {
                // Bound the accept so a sidecar that never connects cannot hang
                // the thread forever; poll the listener until the deadline.
                let stream = match accept_with_timeout(&listener, ACCEPT_TIMEOUT) {
                    Some(s) => s,
                    None => {
                        eprintln!("slipmate-sidecar-{deck_label}: sidecar never connected");
                        return;
                    }
                };
                stream.set_nodelay(true).ok();
                match stream.try_clone() {
                    Ok(writer) => *control_for_reader.lock().unwrap() = Some(writer),
                    Err(e) => {
                        eprintln!("slipmate-sidecar-{deck_label}: cannot split socket: {e}");
                        return;
                    }
                }
                let _handle = run_reader(stream, deck_handle, &mut on_status);
                // Reader returned → the sidecar exited / disconnected. Report it
                // unless we asked it to stop (a clean shutdown / model switch). The
                // handle is dropped here; v1 spawns one sidecar per deck for the
                // app's lifetime (in-process restart is a documented follow-up).
                *control_for_reader.lock().unwrap() = None;
                if !stop_for_reader.load(Ordering::Acquire) {
                    on_status(format!(
                        "{{\"event\":\"worker_died\",\"deck\":\"{deck_label}\"}}"
                    ));
                }
            })?;

        Ok(Sidecar {
            deck_id: deck_id.to_string(),
            control,
            child: Arc::new(Mutex::new(Some(child))),
            stop,
            reader: Some(reader),
        })
    }

    /// Send a JSON deck command to the sidecar (`{"type":"play"}`, `set_style`,
    /// …). A no-op (logged) if the sidecar is not connected — control must never
    /// block or panic the IPC thread.
    pub fn send_control(&self, json: &str) {
        let mut guard = self.control.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(stream) = guard.as_mut() {
            if let Err(e) = write_frame(stream, FRAME_CONTROL, json.as_bytes()) {
                eprintln!("slipmate-sidecar-{}: control write failed: {e}", self.deck_id);
                *guard = None;
            }
        }
    }
}

/// All per-deck sidecars, held in Tauri managed state. The deck-control commands
/// forward validated JSON to the matching sidecar; a deck with no sidecar (spawn
/// failed, or sidecars disabled) silently drops the command.
pub struct Sidecars {
    decks: Vec<Option<Sidecar>>,
}

impl Sidecars {
    pub fn new(decks: Vec<Option<Sidecar>>) -> Self {
        Sidecars { decks }
    }

    /// Forward a JSON deck command to the sidecar for `deck` (a no-op for a deck
    /// without a live sidecar). `deck` is validated by the IPC layer.
    pub fn send(&self, deck: usize, json: &str) {
        if let Some(Some(sidecar)) = self.decks.get(deck) {
            sidecar.send_control(json);
        }
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        // Closing the control writer + killing the child closes the socket, so
        // the reader's `read_frame` returns and the thread exits.
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        *self.control.lock().unwrap() = None;
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

/// Poll-accept the first connection within `timeout`, or `None` on timeout. Uses
/// a brief non-blocking poll loop so the wait is bounded without a dedicated
/// timer thread.
fn accept_with_timeout(listener: &TcpListener, timeout: Duration) -> Option<TcpStream> {
    let deadline = std::time::Instant::now() + timeout;
    listener.set_nonblocking(true).ok();
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                stream.set_nonblocking(false).ok();
                return Some(stream);
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                if std::time::Instant::now() >= deadline {
                    return None;
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return None,
        }
    }
}

/// Build the command that launches the Python sidecar for a deck, pointed at the
/// loopback `port`. Overridable via `SLIPMATE_SIDECAR_CMD` (whitespace-split) so
/// dev (`uv run python -m slipmate.sidecar`) and the packaged PyInstaller binary
/// (part 6) differ without a recompile; arguments `--deck`/`--model`/`--port`
/// are always appended.
pub fn sidecar_command(deck_id: &str, model: &str, port: u16) -> io::Result<Command> {
    let spec = std::env::var("SLIPMATE_SIDECAR_CMD")
        .unwrap_or_else(|_| "uv run python -m slipmate.sidecar".to_string());
    let mut parts = spec.split_whitespace();
    let program = parts
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "empty SLIPMATE_SIDECAR_CMD"))?;
    let mut cmd = Command::new(program);
    cmd.args(parts);
    cmd.args([
        "--deck",
        deck_id,
        "--model",
        model,
        "--port",
        &port.to_string(),
    ]);
    Ok(cmd)
}

#[cfg(test)]
mod tests {
    use super::*;
    use slipmate_engine::Engine;
    use std::net::TcpStream;

    #[test]
    fn frame_round_trips_through_a_buffer() {
        let mut buf = Vec::new();
        write_frame(&mut buf, FRAME_STATUS, b"{\"event\":\"ready\"}").unwrap();
        write_frame(&mut buf, FRAME_PCM, &[1, 2, 3, 4]).unwrap();

        let mut cursor = std::io::Cursor::new(buf);
        let (t1, p1) = read_frame(&mut cursor).unwrap().unwrap();
        assert_eq!(t1, FRAME_STATUS);
        assert_eq!(p1, b"{\"event\":\"ready\"}");
        let (t2, p2) = read_frame(&mut cursor).unwrap().unwrap();
        assert_eq!(t2, FRAME_PCM);
        assert_eq!(p2, vec![1, 2, 3, 4]);
        // Clean EOF at a boundary → None.
        assert!(read_frame(&mut cursor).unwrap().is_none());
    }

    #[test]
    fn over_cap_length_is_rejected() {
        let mut buf = Vec::new();
        buf.push(FRAME_PCM);
        buf.extend_from_slice(&(MAX_FRAME_BYTES + 1).to_le_bytes());
        let mut cursor = std::io::Cursor::new(buf);
        assert!(read_frame(&mut cursor).is_err());
    }

    /// The read loop routes a PCM frame into the deck's ring and a status frame to
    /// the sink — the production data path minus the Python process. `run_reader`
    /// returns the handle on EOF, so the test reclaims it and asserts the ring's
    /// free space dropped by exactly the posted sample count.
    #[test]
    fn reader_routes_pcm_to_the_deck_and_status_to_the_sink() {
        let mut engine = Engine::new();
        let handle = engine.create_deck(0);
        let free_before = handle.free_samples();

        // A mock sidecar stream: one 256-frame stereo PCM chunk + one status,
        // then EOF — built in a buffer the reader drains synchronously.
        let frames = 256usize;
        let samples = frames * 2; // interleaved stereo
        let mut pcm = Vec::with_capacity(samples * 4);
        for _ in 0..samples {
            pcm.extend_from_slice(&0.1f32.to_le_bytes());
        }
        let mut wire = Vec::new();
        write_frame(&mut wire, FRAME_PCM, &pcm).unwrap();
        write_frame(&mut wire, FRAME_STATUS, b"{\"event\":\"chunk\"}").unwrap();

        let mut statuses = Vec::<String>::new();
        let handle = {
            let mut sink = |s: String| statuses.push(s);
            run_reader(std::io::Cursor::new(wire), handle, &mut sink)
        };

        assert_eq!(
            free_before - handle.free_samples(),
            samples,
            "the deck ring should hold exactly the posted PCM"
        );
        assert_eq!(statuses, vec!["{\"event\":\"chunk\"}".to_string()]);
    }

    /// A status frame arriving over a real loopback socket reaches the sink — the
    /// transport itself (accept/connect/nodelay), end to end without Python.
    #[test]
    fn status_routes_over_a_loopback_socket() {
        let mut engine = Engine::new();
        let handle = engine.create_deck(0);

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let mut client = TcpStream::connect(addr).unwrap();
        let (server, _) = listener.accept().unwrap();

        write_frame(&mut client, FRAME_STATUS, b"{\"event\":\"ready\"}").unwrap();
        drop(client); // EOF → reader returns

        let mut statuses = Vec::<String>::new();
        let mut sink = |s: String| statuses.push(s);
        let _handle = run_reader(server, handle, &mut sink);
        assert_eq!(statuses, vec!["{\"event\":\"ready\"}".to_string()]);
    }
}
