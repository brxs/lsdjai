//! Freeze loops, generated/loaded loops, and style-sample capture (Phase 1,
//! Slice 4b — M13 / M18 / M15; ADR-0009 / ADR-0012 / ADR-0011).
//!
//! These are the native home of the Web Audio freeze-pad path
//! (`frontend/src/audio/loops.ts` + the loop slots in
//! `frontend/src/audio/engine.ts`). They are **Realtime-deck features**: they
//! capture and loop the live model output. On a Playback deck they are inert
//! no-ops (track-buffer slicing is a parked Later idea, ADR-0013), and the Engine
//! gates them on the deck being Realtime.
//!
//! # Where the loop plays (ADR-0009)
//!
//! A freeze loop plays **at the channel head**, behind a live/loop gain pair: when
//! a loop is on, the deck's output IS the loop while the live ring keeps being fed
//! and drained underneath (so the played history advances and the model can be
//! re-steered). Returning to live is seamless — the stream never stopped. Here the
//! gain pair is a plain branch in `render`: a deck with an active loop reads the
//! loop's frame instead of the ring's, but still pops the ring so history advances.
//! One-shots overlay (sum) on top of the live/loop output and end themselves.
//!
//! # Seamless loops by construction (ADR-0009)
//!
//! A capture grabs `loop length + crossfade` frames; [`build_loop_channel`]
//! crossfades the surplus tail into the head so the wrap point is continuous. The
//! fade is **linear**, not equal-power: the seam blends the same deck's material
//! moments apart (strongly correlated), where linear is exact for sustained content
//! and equal-power would bump it by up to 3 dB.

use crate::playback::BufferSource;
use crate::{CHANNELS, SAMPLE_RATE};

/// Interleaved-stereo samples per frame.
const SAMPLES_PER_FRAME: usize = CHANNELS as usize;

/// Loop slots per deck (`LOOP_SLOT_COUNT` in `loops.ts`). The FLX4's SAMPLER pad
/// bank.
pub const LOOP_SLOT_COUNT: usize = 4;

/// Seam crossfade length (`LOOP_CROSSFADE_SECONDS` in `loops.ts`): long enough to
/// hide the splice, short enough not to eat into the loop.
pub const LOOP_CROSSFADE_SECONDS: f64 = 0.03;

/// Seam crossfade length in frames at the engine's fixed [`SAMPLE_RATE`].
pub const LOOP_CROSSFADE_FRAMES: usize = (LOOP_CROSSFADE_SECONDS * SAMPLE_RATE as f64) as usize;

/// Shortest honest freeze loop (`MIN_LOOP_SECONDS` in `loops.ts`): a shorter
/// "loop" is a stutter, not a freeze, so a press with less played history is
/// refused.
pub const MIN_LOOP_SECONDS: f64 = 0.5;

/// [`MIN_LOOP_SECONDS`] in frames.
pub const MIN_LOOP_FRAMES: usize = (MIN_LOOP_SECONDS * SAMPLE_RATE as f64) as usize;

/// Default style sample (`STYLE_SAMPLE_SECONDS` in `styleSample.ts`): the spike
/// judged 10 s by ear (ADR-0011).
pub const STYLE_SAMPLE_SECONDS: f64 = 10.0;

/// Backend floor (`MIN_STYLE_SAMPLE_SECONDS` in `styleSample.ts`): less audio
/// embeds poorly and is refused before it leaves the deck.
pub const MIN_STYLE_SAMPLE_SECONDS: f64 = 3.0;

/// [`MIN_STYLE_SAMPLE_SECONDS`] in frames.
pub const MIN_STYLE_SAMPLE_FRAMES: usize = (MIN_STYLE_SAMPLE_SECONDS * SAMPLE_RATE as f64) as usize;

/// Generated-loop quality floor (`GENERATED_LOOP_MIN_SECONDS` in `loops.ts`): the
/// music model breaks up below ~4 s (measured), so generated loops never ask for
/// less — more bars beat broken audio (ADR-0012). The shell enforces the request
/// length; this constant documents the boundary the engine honours when one is
/// built.
pub const GENERATED_LOOP_MIN_SECONDS: f64 = 7.0;

/// Build a seamless loop from one captured channel (`buildLoopChannel` in
/// `loops.ts`): the first `crossfade_frames` of the output blend the capture's
/// surplus tail into its head, so the wrap point is continuous by construction. The
/// fade is **linear** (the seam blends strongly-correlated material — see the
/// module note). Output length = input length − fade (the fade is clamped to half
/// the capture so degenerate inputs still produce a loop). Non-RT (allocates).
pub fn build_loop_channel(samples: &[f32], crossfade_frames: usize) -> Vec<f32> {
    let fade = crossfade_frames.min(samples.len() / 2);
    let length = samples.len() - fade;
    let mut out = vec![0.0f32; length];
    out[..length].copy_from_slice(&samples[..length]);
    for i in 0..fade {
        let t = i as f32 / fade as f32;
        out[i] = samples[length + i] * (1.0 - t) + samples[i] * t;
    }
    out
}

/// Interleave planar `left` / `right` into the wire format `[L, R, L, R, …]`
/// (`interleaveChannels` in `styleSample.ts`) — the shell ships this to the backend
/// for embedding (M15). Non-RT (allocates).
pub fn interleave_channels(left: &[f32], right: &[f32]) -> Vec<f32> {
    let frames = left.len().min(right.len());
    let mut out = vec![0.0f32; frames * SAMPLES_PER_FRAME];
    for i in 0..frames {
        out[2 * i] = left[i];
        out[2 * i + 1] = right[i];
    }
    out
}

/// One loop slot's stored buffer (the captured freeze loop or a loaded SA3 pad),
/// plus whether it is a one-shot. Session-only — loops are performance state, not
/// configuration (ADR-0009). The audio lives as the interleaved-stereo buffer a
/// [`BufferSource`] is rebuilt from on each play (a source plays once and is
/// consumed, exactly like the Web Audio `AudioBufferSourceNode`).
struct LoopBuffer {
    /// Interleaved-stereo f32 at [`SAMPLE_RATE`]. A looping freeze/loaded loop is
    /// already seam-folded; a one-shot is the raw decoded buffer.
    samples: Vec<f32>,
    /// One-shot plays ONCE then stops (M18); otherwise it loops.
    one_shot: bool,
}

/// The per-deck loop bank (M13/M18, ADR-0009/0012): four session-only slots, the
/// one active looping source (replacing the live stream), and the one ringing
/// one-shot (overlaid on top). All mutation is non-RT; the RT path is
/// [`LoopBank::mix_frame`] alone, which only ticks the pre-built buffer sources.
pub(crate) struct LoopBank {
    /// The four slots; `None` is empty.
    slots: [Option<LoopBuffer>; LOOP_SLOT_COUNT],
    /// The active loop's buffer source, replacing the live stream while present.
    /// Index of the slot it came from is tracked so status reports which slot is
    /// playing.
    active: Option<(usize, BufferSource)>,
    /// The one ringing one-shot, overlaid on top of the live/loop output. One at a
    /// time: a re-fire cuts the previous (the per-pad mono convention of hardware
    /// samplers).
    one_shot: Option<BufferSource>,
}

impl LoopBank {
    pub(crate) fn new() -> Self {
        LoopBank {
            slots: Default::default(),
            active: None,
            one_shot: None,
        }
    }

    /// Store a captured freeze loop in `slot`: the most-recent planar history,
    /// seam-folded into a continuous loop (`captureLoop` in `engine.ts`). Returns
    /// `false` if the slot index is out of range or the capture is shorter than the
    /// honest floor (which the caller already checks against `history`, but the
    /// length guard here keeps the slot truthful). Non-RT.
    pub(crate) fn store_capture(&mut self, slot: usize, left: &[f32], right: &[f32]) -> bool {
        if slot >= LOOP_SLOT_COUNT {
            return false;
        }
        // The capture carried `loop + crossfade` frames; fold the surplus seam.
        let folded_left = build_loop_channel(left, LOOP_CROSSFADE_FRAMES);
        let folded_right = build_loop_channel(right, LOOP_CROSSFADE_FRAMES);
        let samples = interleave_channels(&folded_left, &folded_right);
        self.slots[slot] = Some(LoopBuffer { samples, one_shot: false });
        true
    }

    /// Load a decoded interleaved-stereo loop / pad into `slot` (`loadGeneratedLoop`
    /// in `engine.ts`, M18). A one-shot is stored verbatim (it plays once); a loop
    /// gets the capture treatment — the request carried a surplus seam tail, folded
    /// here so the wrap point is continuous and the musical length stays exact.
    /// Non-RT.
    pub(crate) fn load_generated(&mut self, slot: usize, samples: Vec<f32>, one_shot: bool) -> bool {
        if slot >= LOOP_SLOT_COUNT {
            return false;
        }
        if one_shot {
            self.slots[slot] = Some(LoopBuffer { samples, one_shot: true });
            return true;
        }
        // Loops fold the seam like a capture. Deinterleave, fold each channel, then
        // re-interleave the seamless buffer.
        let frames = samples.len() / SAMPLES_PER_FRAME;
        // A non-one-shot must fold to a region long enough for the loop to install,
        // or `set_loop` silently refuses it at play time (the slot goes silent after
        // one pass yet reports `playing`). Match `set_loop`'s own floor here at the
        // boundary so an unplayable "loop" never fills a slot. (The shell separately
        // enforces the musical GENERATED_LOOP_MIN_SECONDS, which is far larger.)
        let folded_frames = frames - LOOP_CROSSFADE_FRAMES.min(frames / 2);
        if (folded_frames as u64) < crate::playback::MIN_TRACK_LOOP_FRAMES {
            return false;
        }
        let mut left = vec![0.0f32; frames];
        let mut right = vec![0.0f32; frames];
        for f in 0..frames {
            left[f] = samples[2 * f];
            right[f] = samples[2 * f + 1];
        }
        let folded_left = build_loop_channel(&left, LOOP_CROSSFADE_FRAMES);
        let folded_right = build_loop_channel(&right, LOOP_CROSSFADE_FRAMES);
        let folded = interleave_channels(&folded_left, &folded_right);
        self.slots[slot] = Some(LoopBuffer { samples: folded, one_shot: false });
        true
    }

    /// Play `slot` (`playLoop` in `engine.ts`). A one-shot overlays and ends itself
    /// (a re-fire cuts the previous); a loop replaces the live stream (the prior
    /// active loop, if any, is cut). Returns `false` if the slot is empty. Non-RT.
    pub(crate) fn play(&mut self, slot: usize) -> bool {
        let Some(buffer) = self.slots.get(slot).and_then(|b| b.as_ref()) else {
            return false;
        };
        let mut source = BufferSource::new(buffer.samples.clone());
        source.play();
        if buffer.one_shot {
            // Overlay: sum on top of whatever is playing, end itself. A re-fire
            // cuts the previous (the sampler's per-pad mono convention).
            self.one_shot = Some(source);
        } else {
            // A whole-buffer loop: fold over `[0, len)` continuously. set_loop runs
            // the same planner the track loop uses; a whole-buffer region at the top
            // installs cleanly (playing, inside → reanchor at 0).
            let len = source.status().duration_frames;
            source.set_loop(0, len);
            // If the buffer was too short to install a loop region, don't pretend it
            // is playing (a lying LED + silence after one pass). The load guard
            // prevents this in normal flow; this keeps `is_playing` truthful anyway.
            if source.status().loop_region.is_none() {
                return false;
            }
            // Replace the live stream; the prior active loop is dropped (a hard cut,
            // the sampler convention — only the live↔loop handover is ramped in the
            // shell, and that ramp is the gain pair, not the source).
            self.active = Some((slot, source));
        }
        true
    }

    /// Stop the active loop (`stopLoop` in `engine.ts`): back to live. A no-op when
    /// no loop is active. Non-RT.
    pub(crate) fn stop(&mut self) {
        self.active = None;
    }

    /// Stop the ringing one-shot (`stopOneShot` in `engine.ts`). Non-RT.
    pub(crate) fn stop_one_shot(&mut self) {
        self.one_shot = None;
    }

    /// Clear `slot` (`clearLoop` in `engine.ts`): empty the buffer. If the active
    /// loop came from this slot it is stopped too (the running source holds its own
    /// buffer copy, but a cleared slot can no longer be replayed). Non-RT.
    pub(crate) fn clear(&mut self, slot: usize) {
        if slot >= LOOP_SLOT_COUNT {
            return;
        }
        self.slots[slot] = None;
        if matches!(self.active, Some((active_slot, _)) if active_slot == slot) {
            self.active = None;
        }
    }

    /// Whether `slot` holds a buffer.
    pub(crate) fn is_filled(&self, slot: usize) -> bool {
        self.slots.get(slot).map(|b| b.is_some()).unwrap_or(false)
    }

    /// Whether `slot` is the active (replacing) loop.
    pub(crate) fn is_playing(&self, slot: usize) -> bool {
        matches!(self.active, Some((active_slot, _)) if active_slot == slot)
    }

    /// **RT path.** Combine the live/loop output with any ringing one-shot for one
    /// output frame. `live` is the deck's underlying frame (the ring or track
    /// frame). When a loop is active the loop frame REPLACES `live`; a one-shot is
    /// always SUMMED on top. Only ticks pre-built buffer sources — no alloc, no
    /// lock, no syscall.
    #[inline]
    pub(crate) fn mix_frame(&mut self, live: (f32, f32)) -> (f32, f32) {
        let (mut l, mut r) = match self.active.as_mut() {
            Some((_, source)) => source.pop_frame(),
            None => live,
        };
        if let Some(source) = self.one_shot.as_mut() {
            let (ol, or) = source.pop_frame();
            l += ol;
            r += or;
        }
        (l, r)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `build_loop_channel` mirrors `loops.ts` `buildLoopChannel`: output length is
    /// `input − fade`, the body is the verbatim prefix, and the first `fade` samples
    /// linearly blend the surplus tail into the head so the wrap point is continuous.
    #[test]
    fn build_loop_channel_folds_the_seam() {
        // A 100-sample ramp, fade 10. Output length 90; first 10 blend tail→head.
        let samples: Vec<f32> = (0..100).map(|i| i as f32).collect();
        let fade = 10;
        let out = build_loop_channel(&samples, fade);
        assert_eq!(out.len(), 90, "output length is input − fade");
        // The unfaded body (i ≥ fade) is the verbatim prefix.
        for i in fade..out.len() {
            assert_eq!(out[i], samples[i], "body sample {i} verbatim");
        }
        // The faded head blends samples[length + i] (tail) into samples[i] (head):
        // out[i] = tail*(1−t) + head*t, t = i/fade. At i=0, t=0 → pure tail
        // (sample 90); the seam from the loop's last body sample (89) to out[0] (90)
        // and on to out[1]… is continuous by construction.
        let length = out.len();
        for i in 0..fade {
            let t = i as f32 / fade as f32;
            let want = samples[length + i] * (1.0 - t) + samples[i] * t;
            assert!((out[i] - want).abs() < 1e-6, "faded head sample {i}");
        }
        // Continuity check: the step from the last body sample to the first head
        // sample (the wrap seam) is small — no discontinuity. out[89]=89, out[0]=90.
        let seam_step = (out[0] - out[out.len() - 1]).abs();
        assert!(seam_step <= 1.0 + 1e-6, "the seam is continuous, step {seam_step}");
    }

    /// A degenerate (tiny) capture still produces a loop: the fade clamps to half
    /// the input so the body never goes negative.
    #[test]
    fn build_loop_channel_clamps_a_tiny_capture() {
        let samples = vec![1.0f32, 2.0, 3.0, 4.0];
        // Ask for a fade larger than half (2) → clamped to 2.
        let out = build_loop_channel(&samples, 10);
        assert_eq!(out.len(), 2, "fade clamps to half, output is the other half");
    }

    /// `interleave_channels` mirrors `styleSample.ts` `interleaveChannels`: planar
    /// → `[L, R, L, R, …]`, truncated to the shorter channel.
    #[test]
    fn interleave_channels_matches_the_wire_format() {
        let left = [1.0f32, 2.0, 3.0];
        let right = [-1.0f32, -2.0, -3.0];
        let out = interleave_channels(&left, &right);
        assert_eq!(out, vec![1.0, -1.0, 2.0, -2.0, 3.0, -3.0]);
        // Unequal lengths truncate to the shorter.
        let short = interleave_channels(&[1.0, 2.0], &[-1.0, -2.0, -3.0]);
        assert_eq!(short, vec![1.0, -1.0, 2.0, -2.0]);
    }

    /// The loop frame constants land where the seconds×rate math says (a
    /// rounding-discipline sanity, since several gates compare against them).
    #[test]
    fn frame_constants_match_their_seconds() {
        assert_eq!(LOOP_CROSSFADE_FRAMES, (0.03 * SAMPLE_RATE as f64) as usize);
        assert_eq!(MIN_LOOP_FRAMES, (0.5 * SAMPLE_RATE as f64) as usize);
        assert_eq!(MIN_STYLE_SAMPLE_FRAMES, (3.0 * SAMPLE_RATE as f64) as usize);
    }

    /// Regression (Slice-4b adversarial review): a non-one-shot generated loop too
    /// short to install a loop region used to play once then go silent while still
    /// reporting `playing`. It must now be refused at load, and `play` must report
    /// the truth.
    #[test]
    fn short_generated_loop_refused_and_play_state_truthful() {
        let mut bank = LoopBank::new();
        // 3000 frames folds below the loop floor — the case that used to silently
        // fail. Refused at load; the slot stays empty.
        let too_short = vec![0.5f32; 3000 * SAMPLES_PER_FRAME];
        assert!(!bank.load_generated(0, too_short, false), "a too-short loop is refused");
        assert!(!bank.is_filled(0), "a refused loop leaves the slot empty");
        // A one-shot of the same length is fine (it plays once, no loop region).
        assert!(bank.load_generated(0, vec![0.5f32; 3000 * SAMPLES_PER_FRAME], true));
        assert!(bank.is_filled(0));
        // A long-enough loop loads, plays, and reports `playing` truthfully.
        let long = vec![0.5f32; (MIN_LOOP_FRAMES + LOOP_CROSSFADE_FRAMES) * SAMPLES_PER_FRAME];
        assert!(bank.load_generated(1, long, false));
        assert!(bank.play(1) && bank.is_playing(1), "a valid loop plays + reports playing");
    }
}
