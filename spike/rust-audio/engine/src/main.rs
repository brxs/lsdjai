// Spike A — offline fundsp DSP-parity renderer (no audio device).
//
// Usage: engine <case> <input.f32> <output.f32>
//
// Reads interleaved stereo float32 LE @ 48000 (no header), deinterleaves to
// L/R, processes EACH channel independently through the case's fundsp graph
// (filters are stateful, so one node instance per channel), re-interleaves,
// writes float32 LE. See ../CONTRACT.md for the authority on each case.

use std::env;
use std::fs;
use std::process;

use fundsp::prelude32::*;

const SAMPLE_RATE: f64 = 48000.0;
const MASTER_CEILING: f32 = 0.9296875;

// --- EQ helpers (mirror CONTRACT.md exactly) ---

fn eq_value_to_db(v: f32) -> f32 {
    let v = v.clamp(0.0, 1.0);
    if v >= 0.5 {
        ((v - 0.5) / 0.5) * 6.0
    } else {
        (1.0 - v / 0.5) * (-40.0)
    }
}

fn db_to_gain(db: f32) -> f32 {
    10.0_f32.powf(db / 20.0)
}

// Shelf Q chosen to best match the Web Audio fixed-slope shelves, which have
// no Q control. WA's shelving filters are derived with S = 1 (one octave
// transition), which corresponds to Q = 1/sqrt(2) ≈ 0.707 in the RBJ cookbook.
// fundsp shelves take an explicit Q, so we use 0.707 here. Reported in summary.
const EQ_SHELF_Q: f32 = std::f32::consts::FRAC_1_SQRT_2; // ≈ 0.70710678

/// Process one mono channel through a freshly built 3-band EQ graph.
/// `low`/`mid`/`high` are the EQ knob values in [0,1].
fn process_eq_channel(samples: &mut [f32], low: f32, mid: f32, high: f32) {
    let low_gain = db_to_gain(eq_value_to_db(low));
    let mid_gain = db_to_gain(eq_value_to_db(mid));
    let high_gain = db_to_gain(eq_value_to_db(high));

    // 3 biquads in series, one stateful instance for this channel.
    let mut node = lowshelf_hz(250.0, EQ_SHELF_Q, low_gain)
        >> bell_hz(1000.0, 0.7, mid_gain)
        >> highshelf_hz(2500.0, EQ_SHELF_Q, high_gain);
    node.set_sample_rate(SAMPLE_RATE);
    node.reset();

    for x in samples.iter_mut() {
        *x = node.filter_mono(*x);
    }
}

/// Color FX `filter`, amount 0.25 → lowpass at ~1200 Hz, fully wet. The Q is a
/// CLI override (default 1.0) so the spike can sweep it to match Web Audio's
/// lowpass, whose Q parameter is in dB (10^(Q/20)) — the ~3% parity gap.
fn process_filter_lp_channel(samples: &mut [f32], q: f32) {
    // filterCurve(0.25): 18000 * (80/18000)^0.5 ≈ 1200 Hz
    let cutoff = (18000.0 * (80.0_f64 / 18000.0).powf(0.5)) as f32;
    let mut node = lowpass_hz(cutoff, q);
    node.set_sample_rate(SAMPLE_RATE);
    node.reset();

    for x in samples.iter_mut() {
        *x = node.filter_mono(*x);
    }
}

/// Master chain: passthrough + hard clip to ±0.9296875 (per CONTRACT.md the
/// only required behaviour is the ceiling + sub-threshold transparency
/// invariants). The clamp guarantees the ceiling and leaves quiet segments
/// transparent.
fn process_master_channel(samples: &mut [f32]) {
    for x in samples.iter_mut() {
        *x = x.clamp(-MASTER_CEILING, MASTER_CEILING);
    }
}

// --- Bit-crusher (M12) ---

// Mirror frontend/public/crusher-kernel.js exactly: 10-bit quantise with a
// sample-and-hold every `reduction` samples. levels = 2^(bits-1) = 512.
const CRUSH_BITS: f32 = 10.0;
const CRUSH_REDUCTION: usize = 21;

/// Hand-rolled quantise-and-hold, per channel. `held` is updated only when the
/// counter wraps to 0; the `+ 0.5).floor()` reproduces JS `Math.round`.
fn process_crush_channel(samples: &mut [f32]) {
    let levels = 2f32.powf(CRUSH_BITS - 1.0); // 512.0
    let mut counter: usize = 0;
    let mut held: f32 = 0.0;
    for x in samples.iter_mut() {
        if counter == 0 {
            held = (*x * levels + 0.5).floor() / levels;
        }
        *x = held;
        counter = (counter + 1) % CRUSH_REDUCTION;
    }
}

/// fundsp's quantiser, to show it lacks the hold. `Crush(n)` is a staircase of
/// `n` levels per unit computed as `(x * n).round() / n` (verified in the
/// fundsp 0.23.0 source), i.e. exactly `round(x * 512) / 512` for n = 512.
fn process_crush_fundsp_channel(samples: &mut [f32]) {
    let mut node = shape(Crush(512.0));
    node.set_sample_rate(SAMPLE_RATE);
    node.reset();
    for x in samples.iter_mut() {
        *x = node.filter_mono(*x);
    }
}

// --- Dub echo (Color FX "dub_echo"), wet output only ---

// Mirror fxGraphs.ts `dub_echo`: input → delay(D) → wet tap, with the delay
// output also → tone(lowpass) → ×feedback → summed back into the delay input.
// Free-running (no synced beat period), so D = DUB_ECHO_SECONDS. Knob amount 0.7
// → dubEchoCurve: wet = feedback = 0.7*0.9 = 0.63. The loop tone is a Web Audio
// lowpass left at the default Q (1 dB → q = 10^(1/20) ≈ 1.122).
const DUB_ECHO_SECONDS: f32 = 0.35;
const DUB_ECHO_TONE_HZ: f32 = 2500.0;
const DUB_ECHO_TONE_Q: f32 = 1.1220185; // 10^(1/20), the Web Audio Q-in-dB default
const DUB_ECHO_FEEDBACK: f32 = 0.63;
const DUB_ECHO_WET: f32 = 0.63;

/// Wet-only dub echo, per channel. The output is the delay-line tap (pre-tone,
/// no dry leak — the dry path lives outside this graph), scaled by `wet`.
///
/// fundsp expression (delay pre-loop so the node output IS the delay tap, never
/// the undelayed dry input; tone sits in the feedback path only, matching WA):
///   (delay(0.35) >> feedback(lowpass_hz(2500.0, 1.122) * 0.63 >> delay(0.35))) * 0.63
fn process_dub_echo_channel(samples: &mut [f32]) {
    let mut node = (delay(DUB_ECHO_SECONDS)
        >> feedback(
            lowpass_hz(DUB_ECHO_TONE_HZ, DUB_ECHO_TONE_Q) * DUB_ECHO_FEEDBACK
                >> delay(DUB_ECHO_SECONDS),
        ))
        * DUB_ECHO_WET;
    node.set_sample_rate(SAMPLE_RATE);
    node.reset();

    for x in samples.iter_mut() {
        *x = node.filter_mono(*x);
    }
}

// --- Sweep (Color FX "sweep"), amplitude duck by a sine LFO ---

// Mirror fxGraphs.ts `sweep` at knob amount 0.7: sweepCurve → rateHz = 5.75,
// depth = 0.84. The duck gain breathes as base + swing*sin, base = 1 - depth/2 =
// 0.58, swing = depth/2 = 0.42. The Web Audio OscillatorNode starts at phase 0,
// so the LFO is computed directly per sample to nail that phase.
const SWEEP_RATE_HZ: f64 = 5.75;
const SWEEP_BASE: f32 = 0.58;
const SWEEP_SWING: f32 = 0.42;

/// Per channel: x[n] * (base + swing * sin(2π * rate * n / fs)), phase 0.
fn process_sweep_channel(samples: &mut [f32]) {
    for (n, x) in samples.iter_mut().enumerate() {
        let phase = 2.0 * std::f64::consts::PI * SWEEP_RATE_HZ * (n as f64) / SAMPLE_RATE;
        let lfo = SWEEP_BASE + SWEEP_SWING * (phase.sin() as f32);
        *x *= lfo;
    }
}

// --- Noise bandpass (Color FX "noise", deterministic half) ---

// The `noise` FX adds a filtered white-noise riser; its random source can't be
// reproduced bit-for-bit. The deterministic, testable half is the bandpass
// filter itself, so this case runs that bandpass on the INPUT signal. centre =
// noiseCurve(0.7).frequency = logSweep(120, 9000, 0.7) = 120*(9000/120)^0.7. The
// Web Audio bandpass Q is fixed at 0.8 (a dB value), so the linear q default is
// 10^(0.8/20) ≈ 1.0965 — a CLI override (like filter_lp) lets the spike sweep it.
fn process_noise_bp_channel(samples: &mut [f32], q: f32) {
    let centre = (120.0 * (9000.0_f64 / 120.0).powf(0.7)) as f32;
    let mut node = bandpass_hz(centre, q);
    node.set_sample_rate(SAMPLE_RATE);
    node.reset();

    for x in samples.iter_mut() {
        *x = node.filter_mono(*x);
    }
}

// --- Stereo reverb (Color FX "space") ---

// reverb_stereo(room_size_m, time_s, damping) — a 2-in/2-out 32-channel FDN.
// ~2.5 s hall: average-ish room (12 m), 2.5 s tail, moderate HF damping.
const SPACE_ROOM_SIZE: f32 = 12.0;
const SPACE_TIME: f32 = 2.5;
const SPACE_DAMPING: f32 = 0.5;

/// Run the whole stereo signal through ONE reverb_stereo instance, feeding each
/// (L, R) frame and collecting (L', R'). Stereo: handled outside the mono path.
fn process_space_stereo(left: &mut [f32], right: &mut [f32]) {
    let mut node = reverb_stereo(SPACE_ROOM_SIZE, SPACE_TIME, SPACE_DAMPING);
    node.set_sample_rate(SAMPLE_RATE);
    node.reset();
    for (l, r) in left.iter_mut().zip(right.iter_mut()) {
        let (lo, ro) = node.filter_stereo(*l, *r);
        *l = lo;
        *r = ro;
    }
}

fn read_f32_le(path: &str) -> Vec<f32> {
    let bytes = fs::read(path).unwrap_or_else(|e| {
        eprintln!("error: cannot read {path}: {e}");
        process::exit(1);
    });
    if bytes.len() % 4 != 0 {
        eprintln!("error: {path} length {} is not a multiple of 4", bytes.len());
        process::exit(1);
    }
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

fn write_f32_le(path: &str, samples: &[f32]) {
    let mut out = Vec::with_capacity(samples.len() * 4);
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    fs::write(path, &out).unwrap_or_else(|e| {
        eprintln!("error: cannot write {path}: {e}");
        process::exit(1);
    });
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 4 || args.len() > 5 {
        eprintln!("usage: {} <case> <input.f32> <output.f32> [filter_q]", args[0]);
        process::exit(2);
    }
    let case = args[1].as_str();
    let input_path = args[2].as_str();
    let output_path = args[3].as_str();
    // Web Audio lowpass/highpass Q is in dB (10^(Q/20)); the real fxGraphs filter
    // leaves Q at the default 1 dB → 1.122 linear. Match that unless the CLI
    // overrides it (the parity sweep). Confirmed: q = 10^(1/20) -> −140 dBFS.
    let filter_q: f32 = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(10.0_f32.powf(1.0 / 20.0));

    // bypass is a byte-for-byte passthrough — no float round-trip, no DSP.
    if case == "bypass" {
        let bytes = fs::read(input_path).unwrap_or_else(|e| {
            eprintln!("error: cannot read {input_path}: {e}");
            process::exit(1);
        });
        fs::write(output_path, &bytes).unwrap_or_else(|e| {
            eprintln!("error: cannot write {output_path}: {e}");
            process::exit(1);
        });
        println!("bypass: copied {} bytes verbatim", bytes.len());
        return;
    }

    let interleaved = read_f32_le(input_path);
    if interleaved.len() % 2 != 0 {
        eprintln!("error: input sample count {} is not even (stereo)", interleaved.len());
        process::exit(1);
    }
    let frames = interleaved.len() / 2;

    // Deinterleave to L / R.
    let mut left: Vec<f32> = Vec::with_capacity(frames);
    let mut right: Vec<f32> = Vec::with_capacity(frames);
    for f in 0..frames {
        left.push(interleaved[2 * f]);
        right.push(interleaved[2 * f + 1]);
    }

    match case {
        "eq_flat" => {
            process_eq_channel(&mut left, 0.5, 0.5, 0.5);
            process_eq_channel(&mut right, 0.5, 0.5, 0.5);
        }
        "eq_kill_low" => {
            process_eq_channel(&mut left, 0.0, 0.5, 0.5);
            process_eq_channel(&mut right, 0.0, 0.5, 0.5);
        }
        "eq_boost" => {
            process_eq_channel(&mut left, 1.0, 1.0, 1.0);
            process_eq_channel(&mut right, 1.0, 1.0, 1.0);
        }
        "filter_lp" => {
            process_filter_lp_channel(&mut left, filter_q);
            process_filter_lp_channel(&mut right, filter_q);
        }
        "dub_echo" => {
            process_dub_echo_channel(&mut left);
            process_dub_echo_channel(&mut right);
        }
        "sweep" => {
            process_sweep_channel(&mut left);
            process_sweep_channel(&mut right);
        }
        // The bandpass Q is the dB-convention guess for Web Audio's fixed Q=0.8
        // (10^(0.8/20) ≈ 1.0965). The optional CLI arg overrides it for sweeps;
        // it parses with the shared `filter_q` default only when supplied.
        "noise_bp" => {
            let q = args
                .get(4)
                .and_then(|s| s.parse().ok())
                .unwrap_or(10.0_f32.powf(0.8 / 20.0));
            process_noise_bp_channel(&mut left, q);
            process_noise_bp_channel(&mut right, q);
        }
        "master_limiter" => {
            process_master_channel(&mut left);
            process_master_channel(&mut right);
        }
        "crush" => {
            process_crush_channel(&mut left);
            process_crush_channel(&mut right);
        }
        "crush_fundsp" => {
            process_crush_fundsp_channel(&mut left);
            process_crush_fundsp_channel(&mut right);
        }
        // `space` is a true stereo node (2-in/2-out reverb), so it processes L
        // and R jointly through one instance rather than the per-channel path.
        "space" => {
            process_space_stereo(&mut left, &mut right);
        }
        other => {
            eprintln!("error: unknown case '{other}'");
            process::exit(2);
        }
    }

    // Re-interleave.
    let mut out: Vec<f32> = Vec::with_capacity(interleaved.len());
    for f in 0..frames {
        out.push(left[f]);
        out.push(right[f]);
    }

    write_f32_le(output_path, &out);

    let max_abs = out.iter().fold(0.0_f32, |m, &x| m.max(x.abs()));
    println!("{case}: {frames} frames, max|out| = {max_abs:.9}");
}
