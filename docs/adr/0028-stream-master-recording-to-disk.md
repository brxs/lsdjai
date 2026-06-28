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
recording is bounded by free disk space, not RAM.** The only remaining
length limit is the WAV format's own (below), ~6 h — far past the old
30-minute RAM wall.

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
- **The WAV format caps the take at ~6 h, and capture stops there.** A
  canonical WAV stores its RIFF + data sizes as `u32`, so 48 kHz stereo
  16-bit PCM can address at most ~6 h 12 m (`RECORDING_MAX_SAMPLES`). Rather
  than let `capture` wrap those fields into a malformed file past that
  point, it stops appending at the ceiling (tracked by a per-take sample
  counter), finalising a valid WAV. Lifting this would mean RF64/WAVE64;
  not worth it for an instrument whose sets don't run six hours.
- **The file path is now minted at start, not stop**, because the file is
  opened when recording begins. The settings-chosen recordings folder
  (empty = OS Downloads) and the timestamped, sanitised filename
  (`library::safe_stem`) are resolved in `start_recording`. The take is
  opened with `library::create_unique_wav`, which picks the next free
  `<stem> (n).wav` and opens it with `create_new` (`O_CREAT | O_EXCL`) in a
  single step — no gap between "this name is free" and "open it" for another
  process to exploit, and `O_EXCL` won't follow a symlink, so the take can
  only ever be a fresh regular file inside the chosen folder.
  `start_recording` returns that path; the webview holds onto it and
  surfaces the basename once the take stops. `stop_recording` carries no
  payload — just success or a write error.

## Consequences

- **No 30-minute wall, flat memory.** A multi-hour set records fine (up to
  the ~6 h WAV ceiling); RAM no longer scales with take length.
- **No path race on the take.** Minting and opening the file are one atomic
  `create_new`, so a take never truncates an existing file or follows a
  symlink out of the chosen folder — the picked-then-opened gap is closed.
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
