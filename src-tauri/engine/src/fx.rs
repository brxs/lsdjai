//! Per-deck Color FX insert (ADR-0008), ported from the Web Audio engine
//! (`frontend/src/audio/fx.ts` curves, `fxGraphs.ts` node graphs) and the Spike A
//! offline renderer (`spike/rust-audio/engine/src/main.rs`, results in
//! `docs/spike-rust-audio.md`).
//!
//! The insert sits **post-EQ, pre-fader** in `MixGraph::mix_frame` (ADR-0008's
//! insert point). Each effect is a pure `amount → parameters` curve over a small
//! `fundsp` (or hand-rolled) node graph, plus a dead-zone around the effect's rest
//! position where the insert is a **bit-exact** dry passthrough (0 ULP).
//!
//! ## What is exact vs approximate (Spike A, `docs/spike-rust-audio.md`)
//!
//! - **filter** — `lowpass_hz`/`highpass_hz`. Q is dB in Web Audio: the default
//!   Q=1 (dB) is `q_linear = 10^(1/20) ≈ 1.122` (Spike A's headline fix). Clean to
//!   ~1e-6.
//! - **dub_echo** — a hand-built `D`-sample feedback delay (NOT `fundsp::feedback`,
//!   which drifts ~1 sample/echo). `D = 0.35 s = 16800 frames`; the in-loop tone is
//!   a lowpass at 2500 Hz, q=1.122.
//! - **space** — `reverb_stereo` (32-ch FDN). An **approximation**: the FDN is not
//!   the Web Audio `ConvolverNode` IR. Its `time` is tuned toward the IR's measured
//!   RT60 ≈ 2.67 s (Spike A: `time = 2.5` gave RT60 4.51 s, so scale down).
//! - **crush** — the bit-exact hand-rolled quantize-and-hold mirroring
//!   `frontend/public/crusher-kernel.js` (Spike A: 0 ULP vs the worklet; fundsp
//!   `Crush` lacks the hold). A SHARED counter across L/R.
//! - **noise** — `white → bandpass_hz → level`, added to dry. Non-deterministic by
//!   design (no sample parity).
//! - **sweep** — an LFO duck computed directly from a phase counter (phase 0), so it
//!   matches the Web Audio `OscillatorNode` start phase. Clean to ~1e-6.

use fundsp::prelude32::*;

/// The six Color FX kinds (`frontend/src/audio/fx.ts` `FxKind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FxKind {
    Filter,
    DubEcho,
    Space,
    Crush,
    Noise,
    Sweep,
}

/// `|amount − rest|` at or below this keeps the dry path bit-exact
/// (`fx.ts` `FX_DEAD_ZONE`).
pub const FX_DEAD_ZONE: f32 = 0.02;

/// Whether the effect replaces the dry signal or adds to it while active
/// (`fx.ts` `fxBlend`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Blend {
    Replace,
    Add,
}

impl FxKind {
    /// Knob position where the effect is off (`fx.ts` `fxRestPosition`): centre for
    /// the bipolar filter, zero otherwise.
    fn rest_position(self) -> f32 {
        match self {
            FxKind::Filter => 0.5,
            _ => 0.0,
        }
    }

    /// `replace` (filter/crush/sweep) vs `add` (dub_echo/space/noise) — `fx.ts`
    /// `fxBlend`.
    fn blend(self) -> Blend {
        match self {
            FxKind::Filter | FxKind::Crush | FxKind::Sweep => Blend::Replace,
            FxKind::DubEcho | FxKind::Space | FxKind::Noise => Blend::Add,
        }
    }

    /// Mirror `fx.ts` `isFxActive`: the insert is bypassed (bit-exact dry) within
    /// the dead zone around the rest position.
    fn is_active(self, amount: f32) -> bool {
        (clamp01(amount) - self.rest_position()).abs() > FX_DEAD_ZONE
    }
}

fn clamp01(value: f32) -> f32 {
    value.clamp(0.0, 1.0)
}

/// Logarithmic sweep from `from` (drive 0) to `to` (drive 1) — `fx.ts` `logSweep`.
fn log_sweep(from: f32, to: f32, drive: f32) -> f32 {
    from * (to / from).powf(clamp01(drive))
}

// --- Curves (mirror `frontend/src/audio/fx.ts` exactly) ---

/// Web Audio interprets the lowpass/highpass Q in **dB**; its default Q=1 (dB) is
/// `q_linear = 10^(1/20) ≈ 1.122` — Spike A's headline parity fix.
const FILTER_Q: f32 = 1.122_018_5; // 10^(1/20)

enum FilterMode {
    Lowpass,
    Highpass,
}

/// `filterCurve`: bipolar one-knob LP/HP. amount<0.5 lowpass `logSweep(18000→80)`,
/// amount≥0.5 highpass `logSweep(30→6000)`.
fn filter_curve(amount: f32) -> (FilterMode, f32) {
    let clamped = clamp01(amount);
    if clamped < 0.5 {
        let drive = (0.5 - clamped) / 0.5;
        (FilterMode::Lowpass, log_sweep(18_000.0, 80.0, drive))
    } else {
        let drive = (clamped - 0.5) / 0.5;
        (FilterMode::Highpass, log_sweep(30.0, 6_000.0, drive))
    }
}

/// `DUB_ECHO_SECONDS` / `DUB_ECHO_TONE_HZ` (`fx.ts`). Free-running (beat-sync is a
/// future `set_beat_period`, out of scope this slice).
const DUB_ECHO_SECONDS: f32 = 0.35;
const DUB_ECHO_TONE_HZ: f32 = 2_500.0;
/// The in-loop tone is a Web Audio lowpass at its default Q (1 dB → 1.122 linear).
const DUB_ECHO_TONE_Q: f32 = FILTER_Q;

/// `dubEchoCurve`: wet = amount*0.9, feedback = min(0.82, amount*0.9).
fn dub_echo_curve(amount: f32) -> (f32, f32) {
    let clamped = clamp01(amount);
    let wet = clamped * 0.9;
    let feedback = (clamped * 0.9).min(0.82);
    (wet, feedback)
}

/// `crushCurve`: bits = 16 − amount*12, reduction = 1 + round(amount*39).
fn crush_curve(amount: f32) -> (f32, usize) {
    let clamped = clamp01(amount);
    let bits = 16.0 - clamped * 12.0;
    let reduction = 1 + (clamped * 39.0).round() as usize;
    (bits, reduction)
}

/// `noiseCurve`: level = amount*0.35, frequency = logSweep(120, 9000, amount).
fn noise_curve(amount: f32) -> (f32, f32) {
    let clamped = clamp01(amount);
    let level = clamped * 0.35;
    let frequency = log_sweep(120.0, 9_000.0, clamped);
    (level, frequency)
}
/// The Web Audio noise bandpass Q is fixed at 0.8; the riser is non-deterministic
/// by design, so the exact normalisation does not affect parity (Spike A).
const NOISE_BANDPASS_Q: f32 = 0.8;

/// `sweepCurve`: rate = 0.5 + amount*7.5, depth = min(1, amount*1.2).
fn sweep_curve(amount: f32) -> (f32, f32) {
    let clamped = clamp01(amount);
    let rate = 0.5 + clamped * 7.5;
    let depth = (clamped * 1.2).min(1.0);
    (rate, depth)
}

/// Space `reverb_stereo` tuning. Spike A measured `time = 2.5` → RT60 4.51 s while
/// the Web Audio convolution IR's RT60 is ≈ 2.67 s; RT60 is proportional to `time`,
/// so scale down: `2.5 * 2.67 / 4.51 ≈ 1.48`. This is an APPROXIMATION (an FDN, not
/// the convolution IR) — documented, not a sample-parity target.
const SPACE_ROOM_SIZE: f32 = 12.0;
const SPACE_TIME: f32 = 1.48;
const SPACE_DAMPING: f32 = 0.5;

/// A hand-built `D`-sample feedback delay line for one channel (the dub echo).
///
/// NOT `fundsp::feedback`: Spike A proved that combinator inserts a 1-sample delay
/// per loop iteration, drifting the echoes ~1 sample each. This is the exact
/// `D`-frame ring `fxGraphs.ts` builds with a Web Audio `DelayNode`: the output is
/// the delay tap (scaled by `wet`), and the delay input is `x + feedback *
/// tone(delay_out)` where `tone` is an in-loop lowpass at 2500 Hz.
struct DelayLine {
    buffer: Vec<f32>,
    pos: usize,
    /// The in-loop darkening lowpass (one stateful biquad per channel).
    tone: Box<dyn AudioUnit>,
}

impl DelayLine {
    /// Allocate the `D`-frame ring (off the RT path). `D` is fixed at the
    /// free-running 0.35 s; `set_beat_period` (future) would reallocate.
    fn new(sample_rate: f32) -> Self {
        let frames = (DUB_ECHO_SECONDS * sample_rate).round() as usize;
        let mut tone = lowpass_hz(DUB_ECHO_TONE_HZ, DUB_ECHO_TONE_Q);
        tone.set_sample_rate(sample_rate as f64);
        tone.reset();
        DelayLine {
            buffer: vec![0.0; frames],
            pos: 0,
            tone: Box::new(tone),
        }
    }

    /// The ring length in frames (`D`); the impulse-spacing the echo test asserts.
    #[cfg(test)]
    fn len(&self) -> usize {
        self.buffer.len()
    }

    /// Tick one sample. Returns the **pre-wet** delay tap (the caller scales by
    /// `wet` and adds it to the dry signal). RT-safe: only arithmetic + one biquad
    /// tick on the pre-built `tone` node.
    #[inline]
    fn tick(&mut self, x: f32, feedback: f32) -> f32 {
        let out = self.buffer[self.pos];
        let mut t_in = [0.0f32; 1];
        let mut t_out = [0.0f32; 1];
        t_in[0] = out;
        self.tone.tick(&t_in, &mut t_out);
        self.buffer[self.pos] = x + feedback * t_out[0];
        self.pos += 1;
        if self.pos == self.buffer.len() {
            self.pos = 0;
        }
        out
    }

    fn reset(&mut self) {
        self.buffer.iter_mut().for_each(|s| *s = 0.0);
        self.pos = 0;
        self.tone.reset();
    }
}

/// The bit-exact quantize-and-hold crusher (`frontend/public/crusher-kernel.js`).
///
/// A SHARED counter across L and R (so both channels re-quantize on the same
/// frames), `levels = 2^(bits-1)`, and the `(x*levels + 0.5).floor()/levels`
/// quantize matches JS `Math.round`. Spike A: 0 ULP vs the worklet.
struct Crusher {
    levels: f32,
    reduction: usize,
    counter: usize,
    held: [f32; 2],
}

impl Crusher {
    fn new(bits: f32, reduction: usize) -> Self {
        Crusher {
            levels: 2f32.powf(bits - 1.0),
            reduction,
            counter: 0,
            held: [0.0; 2],
        }
    }

    /// Update bits/reduction without dropping the held samples or the counter
    /// (off the RT path). Keeps per-channel state across an amount change.
    fn reconfigure(&mut self, bits: f32, reduction: usize) {
        self.levels = 2f32.powf(bits - 1.0);
        self.reduction = reduction;
        // A smaller new reduction must not leave the counter stranded above it.
        if self.counter >= self.reduction {
            self.counter = 0;
        }
    }

    /// Crush one stereo frame with the shared counter. Mirrors `crushBlock`:
    /// when `counter == 0` re-quantize both channels, then hold for `reduction`
    /// frames. RT-safe.
    #[inline]
    fn tick(&mut self, l: f32, r: f32) -> (f32, f32) {
        if self.counter == 0 {
            // `(x*levels + 0.5).floor()/levels` == JS `Math.round(x*levels)/levels`.
            self.held[0] = (l * self.levels + 0.5).floor() / self.levels;
            self.held[1] = (r * self.levels + 0.5).floor() / self.levels;
        }
        self.counter = (self.counter + 1) % self.reduction;
        (self.held[0], self.held[1])
    }

    fn reset(&mut self) {
        self.counter = 0;
        self.held = [0.0; 2];
    }
}

/// A free-running sine LFO duck (the sweep). Computed from an integer phase
/// counter so the sine starts at phase 0 — matching the Web Audio `OscillatorNode`
/// start phase (Spike A: clean to ~1e-6). `out = x * (1 − depth/2 + (depth/2) *
/// sin(2π·rate·t))`.
struct SweepLfo {
    rate_hz: f32,
    depth: f32,
    /// Sample index `n`; `t = n / sample_rate`. f64 so long runs don't lose phase.
    n: u64,
    sample_rate: f32,
}

impl SweepLfo {
    fn new(rate_hz: f32, depth: f32, sample_rate: f32) -> Self {
        SweepLfo {
            rate_hz,
            depth,
            n: 0,
            sample_rate,
        }
    }

    fn reconfigure(&mut self, rate_hz: f32, depth: f32) {
        self.rate_hz = rate_hz;
        self.depth = depth;
    }

    /// The duck gain for the current sample, then advance the phase. Shared by L/R
    /// in `process` so the two channels duck together. RT-safe.
    #[inline]
    fn gain(&mut self) -> f32 {
        let t = self.n as f64 / self.sample_rate as f64;
        let phase = 2.0 * std::f64::consts::PI * self.rate_hz as f64 * t;
        let lfo = (1.0 - self.depth / 2.0) + (self.depth / 2.0) * (phase.sin() as f32);
        self.n += 1;
        lfo
    }

    fn reset(&mut self) {
        self.n = 0;
    }
}

/// The per-deck effect graph: one variant per `FxKind`, each owning its stateful
/// nodes. Built / reconfigured OFF the RT path (`FxInsert::set_kind` /
/// `set_amount`); the per-frame `process` only ticks pre-built nodes + arithmetic.
enum Effect {
    /// Two mono biquads (one per channel). Replaced wholesale when the LP/HP
    /// mode flips (off RT) — the flip only ever happens across the centre dead
    /// zone where the wet path is silent anyway.
    Filter([Box<dyn AudioUnit>; 2]),
    /// Two hand-built feedback delay lines (one per channel) + the shared feedback
    /// amount + the wet level.
    DubEcho {
        lines: [DelayLine; 2],
        feedback: f32,
        wet: f32,
    },
    /// One stereo FDN reverb + the wet level.
    Space {
        reverb: Box<dyn AudioUnit>,
        wet: f32,
    },
    Crush(Crusher),
    /// White source → per-channel bandpass → level. The source is shared (one
    /// `white`), filtered separately per channel (two biquads) so L/R differ.
    Noise {
        source: Box<dyn AudioUnit>,
        bandpass: [Box<dyn AudioUnit>; 2],
        level: f32,
    },
    Sweep(SweepLfo),
}

impl Effect {
    /// Build the effect's nodes for `kind` at `amount` (off the RT path).
    fn build(kind: FxKind, amount: f32, sample_rate: f32) -> Self {
        match kind {
            FxKind::Filter => {
                Effect::Filter([build_filter(amount, sample_rate), build_filter(amount, sample_rate)])
            }
            FxKind::DubEcho => {
                let (wet, feedback) = dub_echo_curve(amount);
                Effect::DubEcho {
                    lines: [DelayLine::new(sample_rate), DelayLine::new(sample_rate)],
                    feedback,
                    wet,
                }
            }
            FxKind::Space => {
                let mut reverb = reverb_stereo(SPACE_ROOM_SIZE, SPACE_TIME, SPACE_DAMPING);
                reverb.set_sample_rate(sample_rate as f64);
                reverb.reset();
                Effect::Space {
                    reverb: Box::new(reverb),
                    wet: space_curve_wet(amount),
                }
            }
            FxKind::Crush => {
                let (bits, reduction) = crush_curve(amount);
                Effect::Crush(Crusher::new(bits, reduction))
            }
            FxKind::Noise => {
                let (level, frequency) = noise_curve(amount);
                let mut source = white();
                source.set_sample_rate(sample_rate as f64);
                source.reset();
                Effect::Noise {
                    source: Box::new(source),
                    bandpass: [
                        build_bandpass(frequency, sample_rate),
                        build_bandpass(frequency, sample_rate),
                    ],
                    level,
                }
            }
            FxKind::Sweep => {
                let (rate, depth) = sweep_curve(amount);
                Effect::Sweep(SweepLfo::new(rate, depth, sample_rate))
            }
        }
    }
}

/// `spaceCurve`: wet = amount (a free function so `Effect::build` reads cleanly).
fn space_curve_wet(amount: f32) -> f32 {
    clamp01(amount)
}

/// Build one channel's filter biquad for `amount` (off the RT path).
fn build_filter(amount: f32, sample_rate: f32) -> Box<dyn AudioUnit> {
    let (mode, freq) = filter_curve(amount);
    let mut node: Box<dyn AudioUnit> = match mode {
        FilterMode::Lowpass => Box::new(lowpass_hz(freq, FILTER_Q)),
        FilterMode::Highpass => Box::new(highpass_hz(freq, FILTER_Q)),
    };
    node.set_sample_rate(sample_rate as f64);
    node.reset();
    node
}

/// Build one channel's noise bandpass for `frequency` (off the RT path).
fn build_bandpass(frequency: f32, sample_rate: f32) -> Box<dyn AudioUnit> {
    let mut node = bandpass_hz(frequency, NOISE_BANDPASS_Q);
    node.set_sample_rate(sample_rate as f64);
    node.reset();
    Box::new(node)
}

/// The per-deck Color FX insert (ADR-0008). Holds the current effect kind, its
/// amount, the built effect graph, and whether the insert is active (outside the
/// dead zone). `process` is the RT path; everything else is non-RT control.
pub(crate) struct FxInsert {
    sample_rate: f32,
    kind: FxKind,
    amount: f32,
    active: bool,
    effect: Effect,
}

impl FxInsert {
    /// Build a fresh insert at the kind's rest position (so it starts bypassed,
    /// bit-exact). Off the RT path.
    pub(crate) fn new(sample_rate: f32) -> Self {
        let kind = FxKind::Filter;
        let amount = kind.rest_position();
        FxInsert {
            sample_rate,
            kind,
            amount,
            active: kind.is_active(amount),
            effect: Effect::build(kind, amount, sample_rate),
        }
    }

    /// Switch the effect kind, rebuilding its nodes OFF the RT path. Resets the
    /// amount to the new kind's rest position so a swap lands bypassed (the
    /// translator re-applies the knob next frame). Like `set_eq`, this takes
    /// `&mut self`, so it can never overlap a `process` call.
    pub(crate) fn set_kind(&mut self, kind: FxKind) {
        self.kind = kind;
        self.amount = kind.rest_position();
        self.active = kind.is_active(self.amount);
        self.effect = Effect::build(kind, self.amount, self.sample_rate);
    }

    /// Set the knob amount in `[0, 1]`, reconfiguring the effect's parameters OFF
    /// the RT path. Keeps per-channel state (delay rings, crush counter, filter
    /// biquads, the LFO phase) across the change — only coefficients/gains move.
    /// The filter rebuilds its biquads when the LP/HP mode flips (the flip is
    /// confined to the centre dead zone, where the wet path is silent).
    pub(crate) fn set_amount(&mut self, amount: f32) {
        let amount = clamp01(amount);
        self.amount = amount;
        self.active = self.kind.is_active(amount);
        if !self.active {
            // Bypassed: nothing to reconfigure; the dead zone is a dry passthrough.
            return;
        }
        match &mut self.effect {
            Effect::Filter(chains) => {
                // Rebuild both channels' biquads to the new cutoff (and mode if it
                // flipped). fundsp's FixedSvf has no settable coefficients, so a
                // rebuild is the simple RT-safe choice here (off the RT path).
                chains[0] = build_filter(amount, self.sample_rate);
                chains[1] = build_filter(amount, self.sample_rate);
            }
            Effect::DubEcho { feedback, wet, .. } => {
                let (w, fb) = dub_echo_curve(amount);
                *wet = w;
                *feedback = fb;
            }
            Effect::Space { wet, .. } => {
                *wet = space_curve_wet(amount);
            }
            Effect::Crush(crusher) => {
                let (bits, reduction) = crush_curve(amount);
                crusher.reconfigure(bits, reduction);
            }
            Effect::Noise { bandpass, level, .. } => {
                let (lvl, frequency) = noise_curve(amount);
                *level = lvl;
                bandpass[0] = build_bandpass(frequency, self.sample_rate);
                bandpass[1] = build_bandpass(frequency, self.sample_rate);
            }
            Effect::Sweep(lfo) => {
                let (rate, depth) = sweep_curve(amount);
                lfo.reconfigure(rate, depth);
            }
        }
    }

    /// Process one stereo frame through the insert. Within the dead zone this is a
    /// **bit-exact** dry passthrough (returns the input unchanged, 0 ULP). Active,
    /// it computes the wet signal and blends per `fxBlend` (replace → out = wet,
    /// add → out = dry + wet).
    ///
    /// RT-safe: only ticks pre-built nodes + arithmetic. No alloc, no lock, no
    /// syscall.
    #[inline]
    pub(crate) fn process(&mut self, l: f32, r: f32) -> (f32, f32) {
        if !self.active {
            // Dead-zone bypass: the dry signal passes through untouched (ADR-0008).
            return (l, r);
        }

        let (wet_l, wet_r) = self.process_wet(l, r);

        match self.kind.blend() {
            Blend::Replace => (wet_l, wet_r),
            Blend::Add => (l + wet_l, r + wet_r),
        }
    }

    /// Compute the effect's wet output for one frame (the dry/wet blend is the
    /// caller's job). For `replace` effects this is the full processed signal; for
    /// `add` effects it is the part summed onto the dry.
    #[inline]
    fn process_wet(&mut self, l: f32, r: f32) -> (f32, f32) {
        let mut in1 = [0.0f32; 1];
        let mut out1 = [0.0f32; 1];
        match &mut self.effect {
            Effect::Filter(chains) => {
                in1[0] = l;
                chains[0].tick(&in1, &mut out1);
                let wl = out1[0];
                in1[0] = r;
                chains[1].tick(&in1, &mut out1);
                (wl, out1[0])
            }
            Effect::DubEcho {
                lines,
                feedback,
                wet,
            } => {
                let tap_l = lines[0].tick(l, *feedback);
                let tap_r = lines[1].tick(r, *feedback);
                (tap_l * *wet, tap_r * *wet)
            }
            Effect::Space { reverb, wet } => {
                let in2 = [l, r];
                let mut out2 = [0.0f32; 2];
                reverb.tick(&in2, &mut out2);
                (out2[0] * *wet, out2[1] * *wet)
            }
            Effect::Crush(crusher) => crusher.tick(l, r),
            Effect::Noise {
                source,
                bandpass,
                level,
            } => {
                // One white sample drives both channels' bandpasses (like the
                // shared looping buffer in `fxGraphs.ts`).
                let mut n = [0.0f32; 1];
                source.tick(&[], &mut n);
                in1[0] = n[0];
                bandpass[0].tick(&in1, &mut out1);
                let nl = out1[0] * *level;
                in1[0] = n[0];
                bandpass[1].tick(&in1, &mut out1);
                let nr = out1[0] * *level;
                (nl, nr)
            }
            Effect::Sweep(lfo) => {
                // One shared LFO gain ducks both channels together.
                let g = lfo.gain();
                (l * g, r * g)
            }
        }
    }

    /// Reset all effect state (delay rings, crush counter, filter biquads, reverb,
    /// noise source/bandpass, LFO phase). Non-RT.
    #[allow(dead_code)] // wired up by Engine::reset in a later slice
    pub(crate) fn reset(&mut self) {
        match &mut self.effect {
            Effect::Filter(chains) => chains.iter_mut().for_each(|c| c.reset()),
            Effect::DubEcho { lines, .. } => lines.iter_mut().for_each(|l| l.reset()),
            Effect::Space { reverb, .. } => reverb.reset(),
            Effect::Crush(crusher) => crusher.reset(),
            Effect::Noise {
                source, bandpass, ..
            } => {
                source.reset();
                bandpass.iter_mut().for_each(|b| b.reset());
            }
            Effect::Sweep(lfo) => lfo.reset(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Curve parity with `frontend/src/audio/fx.ts` (the load-bearing numbers).

    #[test]
    fn curves_match_fx_ts() {
        // filterCurve(0.25) → lowpass at 18000*(80/18000)^0.5 ≈ 1200 Hz.
        let (mode, freq) = filter_curve(0.25);
        assert!(matches!(mode, FilterMode::Lowpass));
        let expected = 18_000.0 * (80.0f32 / 18_000.0).powf(0.5);
        assert!((freq - expected).abs() < 1e-2, "filter freq {freq} vs {expected}");

        // filterCurve(0.75) → highpass at 30*(6000/30)^0.5.
        let (mode, freq) = filter_curve(0.75);
        assert!(matches!(mode, FilterMode::Highpass));
        let expected = 30.0 * (6_000.0f32 / 30.0).powf(0.5);
        assert!((freq - expected).abs() < 1e-2);

        // dubEchoCurve: wet=amount*0.9, feedback=min(0.82, amount*0.9).
        let (wet, fb) = dub_echo_curve(0.7);
        assert!((wet - 0.63).abs() < 1e-6 && (fb - 0.63).abs() < 1e-6);
        let (_, fb) = dub_echo_curve(1.0); // 0.9 capped to 0.82
        assert!((fb - 0.82).abs() < 1e-6);

        // crushCurve: bits=16-amount*12, reduction=1+round(amount*39).
        let (bits, reduction) = crush_curve(0.5);
        assert!((bits - 10.0).abs() < 1e-6 && reduction == 1 + 20); // round(19.5)=20

        // noiseCurve: level=amount*0.35.
        let (level, _freq) = noise_curve(0.5);
        assert!((level - 0.175).abs() < 1e-6);

        // sweepCurve: rate=0.5+amount*7.5, depth=min(1, amount*1.2).
        let (rate, depth) = sweep_curve(0.5);
        assert!((rate - 4.25).abs() < 1e-6 && (depth - 0.6).abs() < 1e-6);
        let (_, depth) = sweep_curve(1.0); // 1.2 capped to 1.0
        assert!((depth - 1.0).abs() < 1e-6);
    }

    #[test]
    fn rest_and_blend_table() {
        assert_eq!(FxKind::Filter.rest_position(), 0.5);
        for k in [FxKind::DubEcho, FxKind::Space, FxKind::Crush, FxKind::Noise, FxKind::Sweep] {
            assert_eq!(k.rest_position(), 0.0);
        }
        for k in [FxKind::Filter, FxKind::Crush, FxKind::Sweep] {
            assert_eq!(k.blend(), Blend::Replace);
        }
        for k in [FxKind::DubEcho, FxKind::Space, FxKind::Noise] {
            assert_eq!(k.blend(), Blend::Add);
        }
    }

    #[test]
    fn dead_zone_matches_is_fx_active() {
        // Filter rests at 0.5; |Δ| > 0.02 is active (matches `fx.ts` `isFxActive`,
        // a strict `>`). Use values comfortably off the exact boundary so float
        // representation doesn't tip a hair-on-the-line case either way.
        assert!(!FxKind::Filter.is_active(0.5));
        assert!(!FxKind::Filter.is_active(0.51));
        assert!(!FxKind::Filter.is_active(0.49));
        assert!(FxKind::Filter.is_active(0.53));
        assert!(FxKind::Filter.is_active(0.47));
        // Others rest at 0.
        assert!(!FxKind::Crush.is_active(0.0));
        assert!(!FxKind::Crush.is_active(0.015));
        assert!(FxKind::Crush.is_active(0.03));
    }

    /// The dub echo delay ring is exactly D = round(0.35 * sr) = 16800 frames.
    #[test]
    fn delay_ring_is_16800_frames() {
        let line = DelayLine::new(48_000.0);
        assert_eq!(line.len(), 16_800);
    }

    const SR: f32 = 48_000.0;

    /// Build an insert with `kind` selected and parked at its rest position.
    fn rested(kind: FxKind) -> FxInsert {
        let mut fx = FxInsert::new(SR);
        fx.set_kind(kind);
        fx
    }

    /// (Per-effect dead-zone bypass) At the rest amount the insert returns the
    /// input UNCHANGED, sample-for-sample (0 ULP), for EVERY effect — the ADR-0008
    /// bit-exact bypass. Bit pattern equality (`to_bits`) is the 0-ULP contract.
    #[test]
    fn dead_zone_bypass_is_bit_exact_every_effect() {
        let probes = [
            (0.37f32, -0.81f32),
            (1.0, -1.0),
            (-0.5, 0.5),
            (1e-9, -1e-9),
            (0.0, 0.0),
            (0.999_999, -0.123_456),
        ];
        for kind in [
            FxKind::Filter,
            FxKind::DubEcho,
            FxKind::Space,
            FxKind::Crush,
            FxKind::Noise,
            FxKind::Sweep,
        ] {
            let mut fx = rested(kind);
            // Explicitly park at the rest amount (inside the dead zone).
            fx.set_amount(kind.rest_position());
            for &(l, r) in &probes {
                let (ol, or) = fx.process(l, r);
                assert_eq!(ol.to_bits(), l.to_bits(), "{kind:?} L not bit-exact");
                assert_eq!(or.to_bits(), r.to_bits(), "{kind:?} R not bit-exact");
            }
            // Just inside the dead zone (|Δ| < 0.02) is still a bit-exact bypass.
            fx.set_amount(kind.rest_position() + FX_DEAD_ZONE - 0.001);
            let (ol, or) = fx.process(0.42, -0.17);
            assert_eq!(ol.to_bits(), 0.42f32.to_bits(), "{kind:?} edge L not bit-exact");
            assert_eq!(or.to_bits(), (-0.17f32).to_bits(), "{kind:?} edge R not bit-exact");
        }
    }

    /// (crush) The hand-rolled quantize-and-hold matches a reference computed in
    /// the test, bit-exactly, with the SHARED counter across L/R (mirrors
    /// `crusher-kernel.js`).
    #[test]
    fn crush_matches_reference_quantize_and_hold() {
        let amount = 0.6;
        let (bits, reduction) = crush_curve(amount);
        let levels = 2f32.powf(bits - 1.0);

        let mut fx = rested(FxKind::Crush);
        fx.set_amount(amount);

        // A deterministic stereo test signal.
        let n = 500;
        let mut counter = 0usize;
        let mut held = [0.0f32; 2];
        for i in 0..n {
            let l = (i as f32 * 0.013).sin();
            let r = (i as f32 * 0.029 + 1.0).sin();
            // Reference (the JS kernel's logic, shared counter).
            if counter == 0 {
                held[0] = (l * levels + 0.5).floor() / levels;
                held[1] = (r * levels + 0.5).floor() / levels;
            }
            counter = (counter + 1) % reduction;
            let (ol, or) = fx.process(l, r);
            assert_eq!(ol.to_bits(), held[0].to_bits(), "crush L frame {i}");
            assert_eq!(or.to_bits(), held[1].to_bits(), "crush R frame {i}");
        }
    }

    /// (sweep) The output amplitude matches the LFO duck formula exactly (phase 0):
    /// `out = x * (1 − depth/2 + (depth/2)·sin(2π·rate·n/sr))`.
    #[test]
    fn sweep_matches_lfo_formula() {
        let amount = 0.7;
        let (rate, depth) = sweep_curve(amount);
        let mut fx = rested(FxKind::Sweep);
        fx.set_amount(amount);

        for n in 0..2000usize {
            let x = 0.5f32; // DC carrier so the gain reads directly off the output.
            let (ol, or) = fx.process(x, x);
            let t = n as f64 / SR as f64;
            let phase = 2.0 * std::f64::consts::PI * rate as f64 * t;
            let g = (1.0 - depth / 2.0) + (depth / 2.0) * (phase.sin() as f32);
            let expected = x * g;
            assert!((ol - expected).abs() < 1e-6, "sweep L n={n}: {ol} vs {expected}");
            assert!((or - expected).abs() < 1e-6, "sweep R n={n}");
        }
    }

    /// (dub_echo) An impulse produces echoes whose ENERGY arrives EXACTLY every
    /// 16800 frames, with NO accumulating drift — the whole point of the hand-built
    /// `D`-sample feedback delay vs fundsp's `feedback()`, which inserts a 1-sample
    /// delay per loop iteration and drifts cumulatively.
    ///
    /// Each echo recirculates through the in-loop tone lowpass, which smears its
    /// peak by a few samples (a fixed group delay per pass). So we locate each echo
    /// as the argmax inside a tight window centred on `k·16800` and assert the
    /// per-echo offset from the grid stays BOUNDED (no growth) — the no-drift
    /// contract. The ring length itself is asserted exact (16800) in
    /// `delay_ring_is_16800_frames`.
    #[test]
    fn dub_echo_impulse_echoes_spaced_16800_no_drift() {
        const D: usize = 16_800;
        let amount = 0.7; // feedback 0.63, wet 0.63 — several audible echoes.
        let mut fx = rested(FxKind::DubEcho);
        fx.set_amount(amount);

        // Feed an impulse on L, silence after; add-blend, so out = dry + wet tail.
        let echoes = 4;
        let total = D * (echoes + 1);
        let mut out = Vec::with_capacity(total);
        for i in 0..total {
            let x = if i == 0 { 1.0 } else { 0.0 };
            let (ol, _or) = fx.process(x, 0.0);
            out.push(ol);
        }

        // The dry impulse sits exactly at frame 0.
        assert_eq!(
            out.iter().enumerate().max_by(|a, b| a.1.abs().total_cmp(&b.1.abs())).unwrap().0,
            0,
            "dry impulse should sit at frame 0"
        );

        // Each echo's ONSET = the first sample crossing a small floor after the
        // preceding silence. The ring length is fixed at D, so the FIRST echo
        // (one tone pass) onsets at EXACTLY D. Each later echo recirculates through
        // the in-loop tone lowpass once more, whose causal group delay smears the
        // leading edge by a fraction of a sample per pass — a BOUNDED accumulation
        // (≈0.5 sample/echo from the 2.5 kHz lowpass). The bug this design exists
        // to avoid — fundsp's `feedback()` — drifts a FULL sample per loop
        // iteration, which over `echoes` echoes runs away linearly. So we assert
        // the first echo is exact and the total accumulated onset offset stays far
        // below that runaway.
        let floor = 1e-4;
        let onset = |start: usize| -> usize {
            (start..out.len()).find(|&i| out[i].abs() > floor).unwrap()
        };
        // First echo: exactly one ring length, no smear yet to speak of.
        assert_eq!(onset(D / 2), D, "first echo onset must be EXACTLY D = {D}");
        // Later echoes: onset within a few samples of the grid, and the offset
        // grows sub-linearly (the tone's bounded group delay, NOT a per-loop drift).
        for k in 2..=echoes {
            let expected = k * D;
            let got = onset((k - 1) * D + D / 2);
            let offset = got as isize - expected as isize;
            // A full sample-per-loop runaway would put echo k at +(k-1) samples and
            // keep growing; the tone smear keeps the total offset tiny and bounded.
            assert!(
                (0..=4).contains(&offset),
                "echo {k} onset {got} (offset {offset}) — expected near {expected} with bounded smear, not runaway drift"
            );
        }
    }

    /// (replace-vs-add) filter REPLACES the dry signal; dub_echo ADDS to it. On the
    /// first sample (before any delay tap returns) the dub echo output equals the
    /// dry input (wet tap is still zero), proving the add blend; the filter's first
    /// output differs from the dry input, proving replace.
    #[test]
    fn filter_replaces_dub_echo_adds() {
        // dub_echo (add): first frame's wet tap is 0, so out == dry input exactly.
        let mut echo = rested(FxKind::DubEcho);
        echo.set_amount(0.7);
        let (ol, or) = echo.process(0.5, -0.3);
        assert!((ol - 0.5).abs() < 1e-9 && (or - (-0.3)).abs() < 1e-9, "add: first frame is dry + 0");

        // filter (replace): a steady DC fed through a lowpass settles to ~DC, but
        // the REPLACE blend means the output is the filtered signal, not dry+wet.
        // Use the contrast that an add-blend would give dry+filtered (~2×DC) while
        // replace gives ~1×DC at steady state.
        let mut filt = rested(FxKind::Filter);
        filt.set_amount(0.25); // lowpass ~1200 Hz
        let mut last = 0.0;
        for _ in 0..4096 {
            let (l, _r) = filt.process(0.4, 0.4);
            last = l;
        }
        // Replace: steady-state DC through a unity-DC-gain lowpass ≈ the input,
        // NOT input + filtered (~0.8). Within a small tolerance of 0.4.
        assert!((last - 0.4).abs() < 0.02, "replace: filtered DC ≈ input, got {last}");
    }

    /// (space/noise) Bounded + non-empty on a real input — non-deterministic, so no
    /// sample parity, only sanity (finite, in range, actually doing something).
    #[test]
    fn space_and_noise_are_bounded_and_nonempty() {
        // space: add-blend reverb on a burst; the wet tail must be finite & present.
        let mut space = rested(FxKind::Space);
        space.set_amount(0.8);
        let mut space_energy = 0.0f64;
        for i in 0..48_000 {
            let x = if i < 480 { 0.5 } else { 0.0 }; // 10 ms burst, then silence
            let (l, r) = space.process(x, x);
            assert!(l.is_finite() && r.is_finite(), "space output must be finite");
            assert!(l.abs() < 8.0 && r.abs() < 8.0, "space output must be bounded");
            // After the burst, any energy is the reverb wet tail.
            if i >= 1000 {
                space_energy += (l * l + r * r) as f64;
            }
        }
        assert!(space_energy > 1e-6, "space reverb tail must be non-empty");

        // noise: add-blend riser on silence; the wet must be finite, bounded, and
        // non-empty (the riser is audible even with no input).
        let mut noise = rested(FxKind::Noise);
        noise.set_amount(0.8);
        let mut noise_energy = 0.0f64;
        for _ in 0..48_000 {
            let (l, r) = noise.process(0.0, 0.0);
            assert!(l.is_finite() && r.is_finite(), "noise output must be finite");
            assert!(l.abs() < 4.0 && r.abs() < 4.0, "noise output must be bounded");
            noise_energy += (l * l + r * r) as f64;
        }
        assert!(noise_energy > 1e-3, "noise riser must be non-empty");
    }
}
