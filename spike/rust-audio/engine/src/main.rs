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

/// Color FX `filter`, amount 0.25 → lowpass at ~1200 Hz, Q = 1.0, fully wet.
fn process_filter_lp_channel(samples: &mut [f32]) {
    // filterCurve(0.25): 18000 * (80/18000)^0.5 ≈ 1200 Hz
    let cutoff = (18000.0 * (80.0_f64 / 18000.0).powf(0.5)) as f32;
    let mut node = lowpass_hz(cutoff, 1.0);
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
    if args.len() != 4 {
        eprintln!("usage: {} <case> <input.f32> <output.f32>", args[0]);
        process::exit(2);
    }
    let case = args[1].as_str();
    let input_path = args[2].as_str();
    let output_path = args[3].as_str();

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
            process_filter_lp_channel(&mut left);
            process_filter_lp_channel(&mut right);
        }
        "master_limiter" => {
            process_master_channel(&mut left);
            process_master_channel(&mut right);
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
