# 0028. Stream the master recording to disk

- **Status:** Accepted
- **Date:** 2026-06-28
- **Deciders:** Jake Hartnell

## Context

The master-bus recorder (top-bar ● button) captured the whole take in
RAM: the render thread appended each rendered master block as int16 PCM
into a single growing `Vec<i16>` behind a `Mutex`, and stopping encoded
that buffer to a WAV in one shot (`host.rs`, `encode_wav_i16`). To stop a
forgotten recording from exhausting memory, the buffer was capped at
`RECORDING_MAX_SAMPLES` — 30 minutes of stereo, ~345 MB — past which
`capture` silently dropped samples.

That cap is the problem. A DJ set routinely runs longer than 30 minutes,
and the recording didn't fail loudly at the wall — it kept the transport
"recording" while capturing nothing, so the tail of the set was lost with
no warning. The ceiling was a RAM guard masquerading as a feature.

Two facts about the engine make a better design cheap:

- **`capture` already runs on the render thread, never the cpal
  callback** (`host.rs`, the `RenderLoop::step` tap). That thread is
  decoupled from the realtime callback by the output ring (~75 ms target
  plus render-ahead), so it is explicitly allowed to lock and allocate —
  and, with care, to do off-thread-bounded work. The callback only drains
  the lock-free output ring and is untouched by any of this.
- **The WAV writer is trivial and hand-rolled.** No `hound`/`wav`
  dependency; the header is 44 fixed bytes whose two size fields sit at
  known offsets (4 and 40). And `rtrb` aside, the codebase already leans
  on the "one thread produces, another consumes, hand the buffer across"
  idiom for everything off the callback.

## Decision

**Stream the take to disk through a dedicated writer thread, so a
recording is bounded by free disk space, not RAM.** There is no
length cap.

- The render thread still appends int16 PCM into a shared
  `Mutex<Vec<i16>>` in `capture` (unchanged hot path). A dedicated
  **`lsdj-recorder` writer thread**, spawned at start, swaps that buffer
  empty every `WRITER_PARK` (50 ms) tick and streams what came out to a
  `BufWriter<File>`. The two `Vec`s ping-pong, so after warmup neither
  side reallocates and buffered (un-written) audio — hence RAM — stays
  tiny. **All file I/O lives on the writer thread**, never the render
  thread, so a slow disk can never stall rendering into an output-ring
  underrun.
- The buffer keeps a backstop, `RECORDING_BACKPRESSURE_SAMPLES` (~60 s),
  renamed and recommented: it is now an anti-OOM guard against a *stalled*
  writer (a wedged disk), not a recording-length limit. Normal operation
  keeps the buffer far below it.
- **Streaming WAV header.** Start writes a placeholder header (sizes 0);
  stop seeks back and patches the RIFF + data sizes from the final sample
  count, then flushes. The byte format is identical to the old
  `encode_wav_i16` — 48 kHz / stereo / 16-bit PCM, the speaker feed
  post-limiter/clip-guard.
- **The file path is now minted at start, not stop**, because the file is
  opened when recording begins. The settings-chosen recordings folder
  (empty = OS Downloads) and the timestamped, sanitised filename
  (`library::safe_stem` + `unique_wav_path`) are resolved in
  `start_recording`, which returns the path. The webview holds onto it and
  surfaces the basename once the take stops. `stop_recording` carries no
  payload — just success or a write error.

## Consequences

- **No 30-minute wall, flat memory.** A multi-hour set records fine; RAM
  no longer scales with take length.
- **No new dependency.** `rtrb` and the hand-rolled WAV writer were
  already here; this adds one `std::thread` and a seek-to-patch.
- **Crash recovery is partial, and no worse than before.** The header is
  patched only at stop, so an app crash mid-take leaves a file with
  placeholder sizes that some players reject — but the PCM is on disk and
  a header re-patch recovers it, whereas the old in-RAM design lost the
  whole take on any crash. Periodic header re-patching (every few seconds)
  is the obvious future hardening; left out here to keep the streaming
  path simple.
- **Filename is fixed at start.** Renaming the take mid-recording isn't
  possible (it wasn't before either); the unique-name check runs once, at
  start.
- The audio callback and the render-thread pacing are untouched — this is
  purely a change to where captured samples go.
