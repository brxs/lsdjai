// Spike A — real-time two-deck engine (criterion 1: device output + RT safety).
//
// Two decks, each fed by its OWN per-deck rtrb SPSC ring (one producer thread =
// the sole writer; the cpal callback = the sole reader — never shared). Ring is
// 30 s capacity, 1.5 s prebuffer. Producers generate synthetic PCM (a distinct
// sine per deck) at worker pace. The cpal output stream is 48000 Hz / 2-ch /
// f32 and requests BufferSize::Fixed(256) (the granted size is logged).
//
// The audio callback (the ONLY real-time path):
//   - sets FTZ/DAZ on its first call (flush denormals on this thread),
//   - drains the requested frames from each deck's ring, counting an underrun
//     (AtomicU64) when a ring is short — excluding the initial prebuffer fill,
//   - mixes the two decks through a fundsp graph: per-deck 3-band EQ (flat) +
//     equal-power crossfade at 0.5 + the master limiter clamp to +-0.9296875,
//   - writes the interleaved stereo output.
// The body is wrapped in assert_no_alloc and does NO heap alloc / lock / syscall
// / log (telemetry is atomics only). The fundsp graph is built OFF-thread and
// only ticked in the callback (tick on a pre-built node is alloc-free).
//
// Authority: ../../docs/spike-rust-audio.md, "Real-time discipline + hazard
// checklist". If no output device / no exact-48000 config is available (likely
// in a sandbox), the binary exits cleanly with a message — it never hangs.

use std::env;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use assert_no_alloc::assert_no_alloc;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
// NOTE: cpal 0.18.1 made SampleRate / ChannelCount / FrameCount plain type
// aliases (u32 / u16 / u32) — not the old SampleRate(u32) tuple struct.
use cpal::{BufferSize, StreamConfig};
use fundsp::prelude32::*;

// In release builds we deliberately turn off assert_no_alloc's `disable_release`
// default and use `warn_release`, so a callback alloc WARNS (never aborts — an
// alloc must not crash the stream). The guard is only armed if AllocDisabler is
// the global allocator, so register it here.
#[global_allocator]
static A: assert_no_alloc::AllocDisabler = assert_no_alloc::AllocDisabler;

const SAMPLE_RATE: u32 = 48_000;
const CHANNELS: u16 = 2;
const REQUESTED_BUFFER: u32 = 256;
const RING_SECS: usize = 30;
const PREBUFFER_SECS: f64 = 1.5;
const MASTER_CEILING: f32 = 0.9296875;
const EQ_SHELF_Q: f32 = std::f32::consts::FRAC_1_SQRT_2; // matches the offline renderer

// Per-deck ring sizes in FRAMES (stereo). One ring per deck, never shared.
const RING_FRAMES: usize = RING_SECS * SAMPLE_RATE as usize;
const PREBUFFER_FRAMES: usize = (PREBUFFER_SECS * SAMPLE_RATE as f64) as usize;

/// Wait-free telemetry shared between the producers, the callback, and main.
/// Everything the callback touches is an atomic; nothing else.
struct Telemetry {
    /// Underruns counted the worklet's way: a callback got fewer frames than
    /// requested from a ring (post-prebuffer). One counter, both decks.
    underruns: AtomicU64,
    /// Callback invocations (for sanity / averaging).
    callbacks: AtomicU64,
    /// Min/max observed ring fill (frames) per deck, post-prebuffer.
    fill_min: [AtomicUsize; 2],
    fill_max: [AtomicUsize; 2],
    /// Has each deck crossed its prebuffer high-water mark yet? Until then,
    /// shortfalls are the expected prebuffer fill, not underruns.
    primed: [AtomicBool; 2],
    /// Granted buffer size (frames), written once from the first callback.
    granted: AtomicUsize,
}

impl Telemetry {
    fn new() -> Self {
        Telemetry {
            underruns: AtomicU64::new(0),
            callbacks: AtomicU64::new(0),
            fill_min: [AtomicUsize::new(usize::MAX), AtomicUsize::new(usize::MAX)],
            fill_max: [AtomicUsize::new(0), AtomicUsize::new(0)],
            primed: [AtomicBool::new(false), AtomicBool::new(false)],
            granted: AtomicUsize::new(0),
        }
    }
}

/// Enable flush-to-zero / denormals-are-zero so a decaying (denormal) tail does
/// not trigger the CPU's slow denormal path on the audio thread.
#[inline]
fn set_ftz_daz() {
    #[cfg(all(target_arch = "x86_64", target_feature = "sse"))]
    unsafe {
        use std::arch::x86_64::{_MM_GET_FLUSH_ZERO_MODE, _MM_SET_FLUSH_ZERO_MODE, _MM_FLUSH_ZERO_ON};
        let _ = _MM_GET_FLUSH_ZERO_MODE();
        _MM_SET_FLUSH_ZERO_MODE(_MM_FLUSH_ZERO_ON);
        // DAZ via the MXCSR DAZ bit (bit 6).
        let mut mxcsr: u32;
        std::arch::asm!("stmxcsr [{}]", in(reg) &mut mxcsr, options(nostack));
        mxcsr |= 1 << 6;
        std::arch::asm!("ldmxcsr [{}]", in(reg) &mxcsr, options(nostack, readonly));
    }
    #[cfg(target_arch = "aarch64")]
    unsafe {
        // AArch64: set the FZ bit (bit 24) of FPCR to flush denormals to zero.
        let mut fpcr: u64;
        std::arch::asm!("mrs {}, fpcr", out(reg) fpcr);
        fpcr |= 1 << 24;
        std::arch::asm!("msr fpcr, {}", in(reg) fpcr);
    }
}

/// A producer for one deck: generates a distinct sine into its ring at worker
/// pace (1.0 s chunks, staying <= 3.0 s ahead by spin-waiting on ring room).
fn spawn_producer(
    deck: usize,
    freq: f32,
    mut producer: rtrb::Producer<f32>,
    stop: Arc<AtomicBool>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let chunk_frames = SAMPLE_RATE as usize; // 1.0 s
        let mut phase: f32 = 0.0;
        let dphase = 2.0 * std::f32::consts::PI * freq / SAMPLE_RATE as f32;
        // Pre-build a reusable chunk buffer (allocated ONCE, off the RT path).
        let mut chunk = vec![0.0f32; chunk_frames * CHANNELS as usize];
        let chunk_period = Duration::from_secs_f64(chunk_frames as f64 / SAMPLE_RATE as f64);

        while !stop.load(Ordering::Relaxed) {
            // Stay <= 3.0 s ahead: only push if there is room for a full chunk
            // AND filled frames would not exceed a 3 s lead's worth of slots.
            let lead_limit_frames = 3 * SAMPLE_RATE as usize * CHANNELS as usize;
            let filled = RING_FRAMES * CHANNELS as usize - producer.slots();
            if filled >= lead_limit_frames || producer.slots() < chunk.len() {
                thread::sleep(Duration::from_millis(2));
                continue;
            }
            // Generate one chunk of the deck's sine (interleaved stereo).
            for f in 0..chunk_frames {
                let s = phase.sin() * 0.25;
                phase += dphase;
                if phase > std::f32::consts::TAU {
                    phase -= std::f32::consts::TAU;
                }
                chunk[2 * f] = s;
                chunk[2 * f + 1] = s;
            }
            // Push the chunk; wait-free per op, spin if briefly short.
            let mut written = 0usize;
            while written < chunk.len() && !stop.load(Ordering::Relaxed) {
                // std::cmp::min: the fundsp prelude glob also brings a Num::min
                // into scope for usize, so qualify to avoid the ambiguity.
                let want = std::cmp::min(chunk.len() - written, producer.slots());
                if want == 0 {
                    thread::sleep(Duration::from_micros(100));
                    continue;
                }
                if let Ok(w) = producer.write_chunk_uninit(want) {
                    let n = w.len();
                    w.fill_from_iter(chunk[written..written + n].iter().copied());
                    written += n;
                }
            }
            // Roughly pace one chunk per chunk-period (worker cadence). The ring
            // lead bound above is the real limiter; this just avoids busy-spin.
            thread::sleep(chunk_period / 4);
        }
        let _ = deck;
    })
}

fn parse_args() -> (u64, usize) {
    let args: Vec<String> = env::args().collect();
    let mut duration: u64 = 600;
    let default_load = thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .saturating_sub(2);
    let default_load = std::cmp::Ord::max(default_load, 1);
    let mut load: usize = 0;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--duration" => {
                duration = args.get(i + 1).and_then(|s| s.parse().ok()).unwrap_or(duration);
                i += 1;
            }
            "--load" => {
                load = args
                    .get(i + 1)
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(default_load);
                if args.get(i + 1).map(|s| s.parse::<usize>().is_ok()) == Some(true) {
                    i += 1;
                }
            }
            other => eprintln!("warning: ignoring unknown arg '{other}'"),
        }
        i += 1;
    }
    (duration, load)
}

fn spawn_load(n: usize, stop: Arc<AtomicBool>) -> Vec<thread::JoinHandle<()>> {
    (0..n)
        .map(|i| {
            let stop = stop.clone();
            thread::spawn(move || {
                let mut x = i as u64 ^ 0x9e37_79b9_7f4a_7c15;
                while !stop.load(Ordering::Relaxed) {
                    for _ in 0..4096 {
                        x = x.wrapping_mul(6364136223846793005).wrapping_add(1);
                        x ^= x >> 33;
                    }
                    std::hint::black_box(x);
                }
            })
        })
        .collect()
}

fn main() {
    let (duration, load) = parse_args();

    // --- Pick a device + an EXACT 48000 / stereo / f32 config, or bail clean ---
    let host = cpal::default_host();
    let device = match host.default_output_device() {
        Some(d) => d,
        None => {
            println!("rt_engine: no output device available — exiting cleanly (sandbox).");
            return;
        }
    };
    // cpal 0.18.1: name lives on DeviceDescription, fetched via description().
    let name = device
        .description()
        .map(|d| d.name().to_string())
        .unwrap_or_else(|_| "<unknown>".into());

    let configs = match device.supported_output_configs() {
        Ok(c) => c,
        Err(e) => {
            println!("rt_engine: cannot query output configs ({e}) — exiting cleanly.");
            return;
        }
    };
    let mut chosen = None;
    for cfg in configs {
        // SampleRate is a u32 alias in cpal 0.18.1 — compare directly.
        let exact_rate =
            cfg.min_sample_rate() <= SAMPLE_RATE && cfg.max_sample_rate() >= SAMPLE_RATE;
        if cfg.channels() >= CHANNELS
            && cfg.sample_format() == cpal::SampleFormat::F32
            && exact_rate
        {
            chosen = Some(cfg.with_sample_rate(SAMPLE_RATE));
            break;
        }
    }
    let supported = match chosen {
        Some(c) => c,
        None => {
            println!(
                "rt_engine: device '{name}' has no exact 48000/f32 output config \
                 (built-in macOS often defaults to 44100) — exiting cleanly. \
                 Resampling is out of scope for the spike."
            );
            return;
        }
    };

    let dev_channels = supported.channels();
    let buffer_size = match supported.buffer_size() {
        cpal::SupportedBufferSize::Range { min, max } => {
            println!("rt_engine: device buffer range = [{min}, {max}] frames");
            BufferSize::Fixed(REQUESTED_BUFFER.clamp(*min, *max))
        }
        cpal::SupportedBufferSize::Unknown => {
            println!("rt_engine: device buffer size unknown; requesting Fixed(256) anyway");
            BufferSize::Fixed(REQUESTED_BUFFER)
        }
    };

    let config = StreamConfig {
        channels: dev_channels,
        sample_rate: SAMPLE_RATE,
        buffer_size,
    };
    println!(
        "rt_engine: device='{name}' channels={dev_channels} rate={SAMPLE_RATE} \
         requested BufferSize::Fixed({REQUESTED_BUFFER})"
    );

    // --- Per-deck rings: one producer thread each, callback the sole reader ---
    let stop = Arc::new(AtomicBool::new(false));
    let (prod_a, cons_a) = rtrb::RingBuffer::<f32>::new(RING_FRAMES * CHANNELS as usize);
    let (prod_b, cons_b) = rtrb::RingBuffer::<f32>::new(RING_FRAMES * CHANNELS as usize);
    let h_a = spawn_producer(0, 220.0, prod_a, stop.clone());
    let h_b = spawn_producer(1, 330.0, prod_b, stop.clone());

    // CPU contention (model-inference simulation).
    let load_stop = Arc::new(AtomicBool::new(false));
    let load_handles = if load > 0 {
        spawn_load(load, load_stop.clone())
    } else {
        Vec::new()
    };

    let telemetry = Arc::new(Telemetry::new());

    // --- Build the fundsp graph OFF-thread, then move it into the callback ---
    // Per-deck 3-band EQ (flat), one stateful chain per (deck, channel). The
    // crossfade and master clamp are plain arithmetic in the callback.
    let mut eq: Vec<Box<dyn AudioUnit>> = (0..4) // deckA L,R + deckB L,R
        .map(|_| {
            let node = lowshelf_hz(250.0, EQ_SHELF_Q, 1.0)
                >> bell_hz(1000.0, 0.7, 1.0)
                >> highshelf_hz(2500.0, EQ_SHELF_Q, 1.0);
            let mut boxed: Box<dyn AudioUnit> = Box::new(node);
            boxed.set_sample_rate(SAMPLE_RATE as f64);
            boxed.reset();
            boxed
        })
        .collect();

    // Equal-power crossfade at p = 0.5: a = cos(pi/4), b = sin(pi/4).
    let xf_a = (std::f32::consts::FRAC_PI_2 * 0.5).cos();
    let xf_b = (std::f32::consts::FRAC_PI_2 * 0.5).sin();

    let mut cons_a = cons_a;
    let mut cons_b = cons_b;
    let tele = telemetry.clone();
    let mut first_call = true;
    let mut prebuffer_done = [false; 2];

    let err_fn = |e| eprintln!("rt_engine: stream error: {e}");

    let stream = device.build_output_stream(
        config,
        move |data: &mut [f32], _info: &cpal::OutputCallbackInfo| {
            // Everything below MUST be alloc/lock/syscall/log free. The guard
            // proves it (warns in release if violated).
            assert_no_alloc(|| {
                if first_call {
                    set_ftz_daz();
                    first_call = false;
                }
                let frames = data.len() / dev_channels as usize;
                tele.granted.store(frames, Ordering::Relaxed);
                tele.callbacks.fetch_add(1, Ordering::Relaxed);

                // Per-deck prebuffer gate: do not count shortfalls as underruns
                // until the ring has first reached the prebuffer high-water.
                let need = frames * CHANNELS as usize;
                let fill_a = RING_FRAMES * CHANNELS as usize - cons_a.slots();
                let fill_b = RING_FRAMES * CHANNELS as usize - cons_b.slots();
                if !prebuffer_done[0] && cons_a.slots() <= (RING_FRAMES * CHANNELS as usize - PREBUFFER_FRAMES * CHANNELS as usize) {
                    prebuffer_done[0] = true;
                    tele.primed[0].store(true, Ordering::Relaxed);
                }
                if !prebuffer_done[1] && cons_b.slots() <= (RING_FRAMES * CHANNELS as usize - PREBUFFER_FRAMES * CHANNELS as usize) {
                    prebuffer_done[1] = true;
                    tele.primed[1].store(true, Ordering::Relaxed);
                }

                // Record ring-fill extremes (frames) post-prebuffer.
                if prebuffer_done[0] {
                    update_min(&tele.fill_min[0], fill_a / CHANNELS as usize);
                    update_max(&tele.fill_max[0], fill_a / CHANNELS as usize);
                }
                if prebuffer_done[1] {
                    update_min(&tele.fill_min[1], fill_b / CHANNELS as usize);
                    update_max(&tele.fill_max[1], fill_b / CHANNELS as usize);
                }

                // Underrun (worklet definition): ring short of a full callback,
                // only after it has been primed.
                if prebuffer_done[0] && cons_a.slots() < need {
                    tele.underruns.fetch_add(1, Ordering::Relaxed);
                }
                if prebuffer_done[1] && cons_b.slots() < need {
                    tele.underruns.fetch_add(1, Ordering::Relaxed);
                }

                // Render frame by frame. Pop each deck's stereo frame (or 0 on
                // shortfall), run per-channel EQ, equal-power mix, master clamp.
                for f in 0..frames {
                    let (al, ar) = pop_frame(&mut cons_a);
                    let (bl, br) = pop_frame(&mut cons_b);

                    let mut in1 = [0.0f32; 1];
                    let mut out1 = [0.0f32; 1];

                    in1[0] = al;
                    eq[0].tick(&in1, &mut out1);
                    let al = out1[0];
                    in1[0] = ar;
                    eq[1].tick(&in1, &mut out1);
                    let ar = out1[0];
                    in1[0] = bl;
                    eq[2].tick(&in1, &mut out1);
                    let bl = out1[0];
                    in1[0] = br;
                    eq[3].tick(&in1, &mut out1);
                    let br = out1[0];

                    // Equal-power crossfade at 0.5, then master ceiling clamp.
                    let mut ol = (al * xf_a + bl * xf_b).clamp(-MASTER_CEILING, MASTER_CEILING);
                    let mut or = (ar * xf_a + br * xf_b).clamp(-MASTER_CEILING, MASTER_CEILING);
                    // Flush any denormal that slipped through (belt-and-braces).
                    if ol.abs() < 1.0e-30 { ol = 0.0; }
                    if or.abs() < 1.0e-30 { or = 0.0; }

                    let base = f * dev_channels as usize;
                    data[base] = ol;
                    data[base + 1] = or;
                    // On a >2ch device, zero the rest (cue/multi-out out of scope).
                    for c in 2..dev_channels as usize {
                        data[base + c] = 0.0;
                    }
                }
            });
        },
        err_fn,
        None,
    );

    let stream = match stream {
        Ok(s) => s,
        Err(e) => {
            println!("rt_engine: failed to build output stream ({e}) — exiting cleanly.");
            stop.store(true, Ordering::Release);
            load_stop.store(true, Ordering::Release);
            let _ = h_a.join();
            let _ = h_b.join();
            for h in load_handles {
                let _ = h.join();
            }
            return;
        }
    };

    if let Err(e) = stream.play() {
        println!("rt_engine: failed to start stream ({e}) — exiting cleanly.");
        stop.store(true, Ordering::Release);
        load_stop.store(true, Ordering::Release);
        let _ = h_a.join();
        let _ = h_b.join();
        return;
    }

    println!(
        "rt_engine: stream RUNNING for {duration}s (load={load}); two decks, \
         per-deck rings ({RING_SECS}s cap, {PREBUFFER_SECS}s prebuffer)."
    );
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(duration) {
        thread::sleep(Duration::from_millis(250));
    }
    drop(stream); // stop the callback before reading final telemetry

    stop.store(true, Ordering::Release);
    load_stop.store(true, Ordering::Release);
    let _ = h_a.join();
    let _ = h_b.join();
    for h in load_handles {
        let _ = h.join();
    }

    // --- Report ---
    let granted = telemetry.granted.load(Ordering::Relaxed);
    let underruns = telemetry.underruns.load(Ordering::Relaxed);
    let callbacks = telemetry.callbacks.load(Ordering::Relaxed);
    println!("\n===== rt_engine RESULT =====");
    println!("granted buffer size : {granted} frames (requested 256)");
    println!("callbacks           : {callbacks}");
    println!("underruns (post-pre): {underruns}");
    for d in 0..2 {
        let mn = telemetry.fill_min[d].load(Ordering::Relaxed);
        let mx = telemetry.fill_max[d].load(Ordering::Relaxed);
        let primed = telemetry.primed[d].load(Ordering::Relaxed);
        let mn = if mn == usize::MAX { 0 } else { mn };
        println!(
            "deck {d} ring fill     : min={mn} max={mx} frames ({:.2}-{:.2} s)  primed={primed}",
            mn as f64 / SAMPLE_RATE as f64,
            mx as f64 / SAMPLE_RATE as f64
        );
    }
    println!(
        "verdict             : {}",
        if underruns == 0 { "ZERO underruns" } else { "UNDERRUNS PRESENT" }
    );
}

/// Pop one interleaved stereo frame; return (0,0) if the ring is short.
#[inline]
fn pop_frame(cons: &mut rtrb::Consumer<f32>) -> (f32, f32) {
    if cons.slots() >= 2 {
        let l = cons.pop().unwrap_or(0.0);
        let r = cons.pop().unwrap_or(0.0);
        (l, r)
    } else {
        (0.0, 0.0)
    }
}

#[inline]
fn update_min(a: &AtomicUsize, v: usize) {
    let mut cur = a.load(Ordering::Relaxed);
    while v < cur {
        match a.compare_exchange_weak(cur, v, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => break,
            Err(x) => cur = x,
        }
    }
}

#[inline]
fn update_max(a: &AtomicUsize, v: usize) {
    let mut cur = a.load(Ordering::Relaxed);
    while v > cur {
        match a.compare_exchange_weak(cur, v, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => break,
            Err(x) => cur = x,
        }
    }
}
