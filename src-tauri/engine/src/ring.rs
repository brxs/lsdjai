//! Per-deck player ring over `rtrb` (one SPSC ring per deck, never shared).
//!
//! The handoff is the whole point of Slice 1: a single non-RT producer (the
//! decode/transport IO thread, here driven by `DeckHandle::post_pcm`) is the
//! SOLE writer; the RT `Engine::render()` is the SOLE drainer. `rtrb` is a
//! wait-free single-producer / single-consumer ring, so neither side ever takes
//! a lock and the consumer side allocates nothing. The producer allocates the
//! ring's backing store ONCE at construction (off the RT path) and never again.
//!
//! Ported from the per-deck rings in the Spike A `rt_engine`
//! (`spike/rust-audio/engine/src/bin/rt_engine.rs`), split into a producer half
//! (`RingProducer`, lives behind `DeckHandle`) and a consumer half
//! (`RingConsumer`, lives inside `Engine` and is only touched by `render()`).

use std::sync::Arc;

use rtrb::{Consumer, Producer, RingBuffer};

use crate::telemetry::Telemetry;
use crate::{CHANNELS, HISTORY_FRAMES, PREBUFFER_FRAMES, RING_FRAMES, SAMPLE_RATE};

/// Interleaved-stereo samples per frame.
const SAMPLES_PER_FRAME: usize = CHANNELS as usize;

/// Ring capacity in interleaved f32 samples (frames × channels).
const RING_CAPACITY_SAMPLES: usize = RING_FRAMES * SAMPLES_PER_FRAME;

/// Prebuffer high-water mark in interleaved f32 samples.
const PREBUFFER_SAMPLES: usize = PREBUFFER_FRAMES * SAMPLES_PER_FRAME;

/// Construct the producer + consumer halves of one deck's ring.
///
/// Allocates the ring backing store once, here, on the calling (non-RT) thread.
/// Both halves carry the deck index and a shared `Telemetry` handle so the
/// consumer can attribute fill / underrun stats to the right deck.
pub(crate) fn new_deck_ring(
    deck: usize,
    telemetry: Arc<Telemetry>,
) -> (RingProducer, RingConsumer) {
    let (producer, consumer) = RingBuffer::<f32>::new(RING_CAPACITY_SAMPLES);
    (
        RingProducer { producer },
        RingConsumer {
            deck,
            consumer,
            primed: false,
            // Starts playing: a freshly created deck drains its ring as soon as
            // the sidecar feeds it (the worker only feeds once told to play), and
            // deck_stop/deck_play toggle it from there.
            playing: true,
            telemetry,
            history: PlayedHistory::new(),
        },
    )
}

/// A pre-allocated circular buffer of recently-*played* stereo frames (the deck's
/// freeze-pad / style-sample source, M13/M15, ADR-0009). The rtrb live-feed ring
/// is a pure FIFO — `render()` pops a frame and the sample is gone — so a separate
/// retained history is needed for capture. It mirrors the worklet's played-history
/// (`loop-capture-kernel.js`): every consumed frame is written here, and a capture
/// copies the most recent N frames ending at the write head, wrap-aware.
///
/// Unlike the worklet, which reuses the *one* ring (so its history bound shrinks
/// when the producer laps the consumer), this is a dedicated buffer with a single
/// writer — the RT drain — and no concurrent reader on the RT path, so its bound is
/// simply how many frames have been written, capped at the capacity. The capacity
/// ([`HISTORY_FRAMES`], ~30 s) is allocated ONCE here, off the RT path; the per-frame
/// write is a plain index store, alloc/lock/syscall-free.
struct PlayedHistory {
    /// Planar left / right channels, each [`HISTORY_FRAMES`] long. Planar (not
    /// interleaved) so a capture is two block copies per channel, like the
    /// worklet's `captureRecent`.
    left: Vec<f32>,
    right: Vec<f32>,
    /// Where the next played frame is written; wraps at the capacity. The most
    /// recent frame sits at `write_pos - 1`.
    write_pos: usize,
    /// Valid retained frames behind `write_pos`, capped at the capacity. Mirrors
    /// `noteConsumed`'s `min(history + frames, capacity)` (the dedicated buffer
    /// has no producer to lap it, so the `capacity - available` clamp collapses to
    /// the capacity).
    frames: usize,
}

impl PlayedHistory {
    /// Allocate the history buffers once, off the RT path.
    fn new() -> Self {
        PlayedHistory {
            left: vec![0.0; HISTORY_FRAMES],
            right: vec![0.0; HISTORY_FRAMES],
            write_pos: 0,
            frames: 0,
        }
    }

    /// **RT-path.** Record one consumed (played) stereo frame. A plain index store
    /// into the pre-allocated buffers + a saturating count update — no alloc, no
    /// lock, no syscall. Mirrors the worklet's `enqueue` + `noteConsumed`.
    #[inline]
    fn push(&mut self, l: f32, r: f32) {
        self.left[self.write_pos] = l;
        self.right[self.write_pos] = r;
        self.write_pos = (self.write_pos + 1) % HISTORY_FRAMES;
        if self.frames < HISTORY_FRAMES {
            self.frames += 1;
        }
    }

    /// Reset the retained history (e.g. on a deck reset / model switch). Like the
    /// worklet's `reset`: a capture spanning a discontinuity would splice two
    /// unrelated streams into one "loop", so the history is dropped. Keeps the
    /// allocation — only the count and the head move.
    #[allow(dead_code)] // wired up by Engine::reset_deck in a later slice
    fn clear(&mut self) {
        self.write_pos = 0;
        self.frames = 0;
    }

    /// Copy the most recent `requested` played frames (fewer when less history
    /// exists), ending at the write head, wrap-aware. Two block copies per channel,
    /// like the worklet's `captureRecent`. Non-RT (allocates the output); returns
    /// planar `(left, right)` of the realised frame count.
    fn capture_recent(&self, requested: usize) -> (Vec<f32>, Vec<f32>) {
        let frames = requested.min(self.frames);
        let mut out_left = vec![0.0f32; frames];
        let mut out_right = vec![0.0f32; frames];
        if frames == 0 {
            return (out_left, out_right);
        }
        // Start index of the window, wrap-corrected: write_pos - frames (mod cap).
        let start = (self.write_pos + HISTORY_FRAMES - frames) % HISTORY_FRAMES;
        let first_span = frames.min(HISTORY_FRAMES - start);
        out_left[..first_span].copy_from_slice(&self.left[start..start + first_span]);
        out_right[..first_span].copy_from_slice(&self.right[start..start + first_span]);
        if first_span < frames {
            let rest = frames - first_span;
            out_left[first_span..].copy_from_slice(&self.left[..rest]);
            out_right[first_span..].copy_from_slice(&self.right[..rest]);
        }
        (out_left, out_right)
    }
}

/// The non-RT producer half of a deck's ring. The sole writer. Lives behind the
/// public `DeckHandle`. `post_pcm` is the one entry point; it is wait-free per
/// `rtrb` chunk write and never blocks (it drops the tail if the ring is full,
/// counted by the consumer as the resulting underrun if it starves).
pub(crate) struct RingProducer {
    producer: Producer<f32>,
}

impl RingProducer {
    /// Append interleaved stereo f32 samples to the deck's ring.
    ///
    /// Returns the number of samples actually written. If the ring has less
    /// free space than `samples.len()`, only the prefix that fits is written and
    /// the rest is dropped — the non-RT side must not block the producer thread,
    /// and a persistently full ring means the consumer is keeping up. Callers
    /// that care can compare the return value to `samples.len()`.
    ///
    /// This is the producer side of the SPSC handoff: it never locks and only
    /// touches `rtrb`'s wait-free write path.
    pub(crate) fn post_pcm(&mut self, samples: &[f32]) -> usize {
        let want = samples.len().min(self.producer.slots());
        if want == 0 {
            return 0;
        }
        match self.producer.write_chunk_uninit(want) {
            Ok(chunk) => {
                let n = chunk.len();
                chunk.fill_from_iter(samples[..n].iter().copied());
                n
            }
            Err(_) => 0,
        }
    }

    /// Free space (in interleaved samples) currently available to the producer.
    #[allow(dead_code)] // used by the device_run binary / future flow control
    pub(crate) fn free_samples(&self) -> usize {
        self.producer.slots()
    }
}

/// The RT consumer half of a deck's ring. The sole drainer, only ever touched by
/// `Engine::render()`. Holds the per-deck prebuffer-gate state so the engine
/// stays a thin orchestrator.
pub(crate) struct RingConsumer {
    deck: usize,
    consumer: Consumer<f32>,
    /// Set once the ring first reaches the prebuffer high-water mark. Before
    /// that, shortfalls are the expected initial fill, not underruns.
    primed: bool,
    /// Whether the deck is playing. `deck_stop` clears it; `deck_play` sets it.
    /// When stopped the render loop still DRAINS this ring but outputs silence, so
    /// the live buffer (the sidecar's generate-ahead lead plus its ~3 s shutdown
    /// backlog) runs empty instead of staying audible or being held as stale
    /// future audio — the realtime stream is "live", not a pausable track.
    /// Underruns are suppressed while stopped (a drained buffer is intentional,
    /// not a starvation) and resume re-primes a fresh lead (see [`set_playing`]).
    playing: bool,
    telemetry: Arc<Telemetry>,
    /// Recently-played stereo frames, retained for freeze-pad / style-sample
    /// capture (M13/M15, ADR-0009). `pop_frame` writes every consumed frame here;
    /// the live FIFO drain is untouched (the history write is additive).
    history: PlayedHistory,
}

impl RingConsumer {
    /// Samples currently available to read (the ring fill). For an `rtrb`
    /// `Consumer`, `slots()` IS the count available for reading — not the free
    /// space — so the fill is read directly, no `capacity − slots` inversion.
    #[inline]
    fn filled_samples(&self) -> usize {
        self.consumer.slots()
    }

    /// RT-side per-block bookkeeping: update the prebuffer gate, record fill
    /// stats, and count an underrun if a *primed* ring cannot satisfy
    /// `frames`. Called once per deck per `render()` block, before the drain.
    ///
    /// Wait-free: only atomic stores and `rtrb` slot reads. No alloc, no lock.
    #[inline]
    pub(crate) fn account_block(&mut self, frames: usize) {
        let need = frames * SAMPLES_PER_FRAME;
        let filled = self.filled_samples();

        // Prebuffer gate: once the ring has buffered at least PREBUFFER_SAMPLES,
        // the deck is "primed" and from then on shortfalls count as underruns.
        if !self.primed && filled >= PREBUFFER_SAMPLES {
            self.primed = true;
            self.telemetry.set_primed(self.deck);
        }

        if self.primed {
            self.telemetry.record_fill(self.deck, filled / SAMPLES_PER_FRAME);
            // Only a *playing* deck can underrun: a stopped deck is intentionally
            // not drained, so a short ring is the held buffer, not a starvation.
            if self.playing && filled < need {
                self.telemetry.note_underrun();
            }
        }
    }

    /// Pop one interleaved stereo frame, or `(0.0, 0.0)` if the ring is short.
    /// The drain primitive `render()` calls per frame.
    ///
    /// A popped (actually played) frame is also written into the retained played
    /// history (M13/M15, ADR-0009) — a plain index store into a pre-allocated
    /// buffer, so the RT path stays alloc/lock/syscall-free. A ring shortfall
    /// (zero-fill) is NOT recorded: the worklet only advances its played index when
    /// it actually consumes audio, so the capture window never includes silence the
    /// listener was never fed.
    #[inline]
    pub(crate) fn pop_frame(&mut self) -> (f32, f32) {
        if self.consumer.slots() < SAMPLES_PER_FRAME {
            return (0.0, 0.0);
        }
        let l = self.consumer.pop().unwrap_or(0.0);
        let r = self.consumer.pop().unwrap_or(0.0);
        if self.playing {
            self.history.push(l, r);
            (l, r)
        } else {
            // Stopped: still DRAIN the ring so the live buffer runs empty (the
            // generate-ahead lead and the worker's shutdown backlog are discarded,
            // not held), but output silence and do NOT advance the played history —
            // the listener was never fed this audio, so it must not enter a capture
            // window (ADR-0009). Resume re-primes from fresh generation.
            (0.0, 0.0)
        }
    }

    /// Copy the most recent `frames` played frames as planar `(left, right)`,
    /// fewer when less has played (wrap-aware). The freeze-pad / style-sample read
    /// (M13/M15, ADR-0009), mirroring the worklet's `captureRecent`. Non-RT
    /// (allocates the output); only ever called through `Engine`'s `&mut self`
    /// capture API, so it cannot overlap a `render` call.
    pub(crate) fn capture_recent(&self, frames: usize) -> (Vec<f32>, Vec<f32>) {
        self.history.capture_recent(frames)
    }

    /// Reset the prebuffer gate AND drop the retained played history (e.g. after a
    /// deck reload / model switch). The ring itself is drained by the producer
    /// side; this re-arms the gate so the next fill is treated as a fresh
    /// prebuffer, and clears the history so a capture cannot splice two unrelated
    /// streams into one "loop" (ADR-0009, the worklet's `reset` rule).
    #[allow(dead_code)] // wired up by Engine::reset_deck in a later slice
    pub(crate) fn rearm_prebuffer(&mut self) {
        self.primed = false;
        self.history.clear();
    }

    /// Set the play/stop gate (see the `playing` field). `deck_stop` → `false`
    /// (drains to silence), `deck_play` → `true` (audio resumes). Cheap enough to
    /// call from the render thread's command drain.
    pub(crate) fn set_playing(&mut self, playing: bool) {
        // On resume the buffer has drained empty, so re-arm the prebuffer: play
        // refills a fresh ~1.5 s lead before the deck counts as primed, exactly
        // like a cold start, so the post-stop refill is not miscounted as
        // underruns. (No-op on the cold first play — already unprimed.)
        if playing && !self.playing {
            self.primed = false;
        }
        self.playing = playing;
    }
}

/// Compile-time sanity: the prebuffer must fit inside the ring, with headroom.
const _: () = assert!(PREBUFFER_SAMPLES < RING_CAPACITY_SAMPLES);
/// Document the realised sizes so a reviewer sees the seconds, not just frames.
const _: () = assert!(RING_FRAMES == 30 * SAMPLE_RATE as usize);

#[cfg(test)]
mod history_tests {
    use super::*;
    use crate::HISTORY_FRAMES;

    /// A tiny stand-in to drive the wrap logic without allocating 30 s buffers per
    /// case: the real [`PlayedHistory`] uses [`HISTORY_FRAMES`], so the wrap-aware
    /// copy is exercised against the actual capacity, just with a short fill.
    /// Pushes the counter `i → (i, -i)` and asserts a capture reads the most recent
    /// frames in order.
    fn push_counter(history: &mut PlayedHistory, count: usize) {
        for i in 0..count {
            history.push(i as f32, -(i as f32));
        }
    }

    /// Before the buffer laps: a capture reads the last N pushed frames in order,
    /// and an over-ask clamps to what exists.
    #[test]
    fn capture_recent_reads_the_tail_in_order() {
        let mut history = PlayedHistory::new();
        push_counter(&mut history, 1000);
        assert_eq!(history.frames, 1000);

        let (left, right) = history.capture_recent(10);
        assert_eq!(left.len(), 10);
        for f in 0..10 {
            let expect = (1000 - 10 + f) as f32;
            assert_eq!(left[f], expect, "tail L frame {f}");
            assert_eq!(right[f], -expect, "tail R frame {f}");
        }
        // Over-ask clamps to the 1000 frames that exist.
        let (all, _) = history.capture_recent(5000);
        assert_eq!(all.len(), 1000, "an over-ask clamps to the history");
        assert_eq!(all[0], 0.0, "the oldest retained frame is the first push");
    }

    /// After the writer laps the buffer: the oldest frames are overwritten, and a
    /// capture of the last N still reads the correct most-recent values across the
    /// circular seam.
    #[test]
    fn capture_recent_is_wrap_aware_after_lapping() {
        let mut history = PlayedHistory::new();
        // Push just over one full capacity so the write head wraps and the count
        // pins at the capacity.
        let total = HISTORY_FRAMES + 12_345;
        push_counter(&mut history, total);
        assert_eq!(history.frames, HISTORY_FRAMES, "the count pins at the capacity");

        // The last N frames are total-N .. total-1, read across the wrap.
        let n = 20_000;
        let (left, right) = history.capture_recent(n);
        assert_eq!(left.len(), n);
        for f in 0..n {
            let expect = (total - n + f) as f32;
            assert_eq!(left[f], expect, "wrapped L frame {f}");
            assert_eq!(right[f], -expect, "wrapped R frame {f}");
        }
    }

    /// `clear` drops the history so a capture across it returns nothing.
    #[test]
    fn clear_drops_the_history() {
        let mut history = PlayedHistory::new();
        push_counter(&mut history, 5000);
        history.clear();
        assert_eq!(history.frames, 0);
        let (left, right) = history.capture_recent(100);
        assert!(left.is_empty() && right.is_empty(), "no history after clear");
    }
}

#[cfg(test)]
mod gate_tests {
    use super::*;
    use std::sync::Arc;

    /// The native-stop behaviour: a stopped deck still DRAINS its ring but outputs
    /// silence, so the live buffer runs empty (not held as stale future audio) and
    /// counts NO underrun. Resume re-primes a fresh lead.
    #[test]
    fn a_stopped_ring_drains_to_silence_without_underruns() {
        let telemetry = Arc::new(Telemetry::new());
        let (mut producer, mut consumer) = new_deck_ring(0, telemetry.clone());

        // Fill past the prebuffer high-water with a constant 0.5 so the ring primes.
        let frames = PREBUFFER_FRAMES + 100;
        let pcm = vec![0.5f32; frames * SAMPLES_PER_FRAME];
        assert_eq!(producer.post_pcm(&pcm), pcm.len(), "the ring accepts the fill");

        // Prime + output one frame while playing (the default).
        consumer.account_block(64);
        assert!(telemetry.primed(0), "the ring primes past the high-water");
        assert_eq!(consumer.pop_frame(), (0.5, 0.5), "a playing ring outputs audio");
        let playing_fill = consumer.filled_samples();

        // Stop: pop is silent, but the ring still DRAINS so the live buffer empties.
        consumer.set_playing(false);
        assert_eq!(consumer.pop_frame(), (0.0, 0.0), "a stopped ring is silent");
        assert!(
            consumer.filled_samples() < playing_fill,
            "a stopped ring still drains — the live buffer runs empty",
        );

        // Drain the rest while stopped: it empties and counts NO underrun.
        let before = telemetry.underruns();
        while consumer.filled_samples() >= SAMPLES_PER_FRAME {
            assert_eq!(consumer.pop_frame(), (0.0, 0.0), "stays silent while draining");
        }
        consumer.account_block(64);
        assert_eq!(consumer.filled_samples(), 0, "the buffer runs fully empty");
        assert_eq!(
            telemetry.underruns(),
            before,
            "an intentionally drained stopped deck must not count underruns",
        );

        // Resume re-arms the prebuffer; once refed it re-primes and outputs audio.
        consumer.set_playing(true);
        producer.post_pcm(&vec![0.25f32; (PREBUFFER_FRAMES + 10) * SAMPLES_PER_FRAME]);
        consumer.account_block(64);
        assert_eq!(consumer.pop_frame(), (0.25, 0.25), "play resumes audio after a refill");
    }

    /// Guard the converse so the suppression above is not blanket: a PLAYING primed
    /// ring that cannot satisfy a block still counts an underrun.
    #[test]
    fn a_playing_primed_short_ring_still_underruns() {
        let telemetry = Arc::new(Telemetry::new());
        let (mut producer, mut consumer) = new_deck_ring(0, telemetry.clone());
        let frames = PREBUFFER_FRAMES + 10;
        producer.post_pcm(&vec![0.25f32; frames * SAMPLES_PER_FRAME]);
        consumer.account_block(64); // primes (need ≪ filled)
        assert!(telemetry.primed(0));
        let before = telemetry.underruns();
        consumer.account_block(frames + 5000); // need ≫ filled, still playing
        assert!(
            telemetry.underruns() > before,
            "a playing short ring underruns",
        );
    }
}
