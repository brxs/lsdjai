// Spike A — PCM transport bench (criterion 6, fully headless).
//
// Carries 48 kHz / stereo / f32 frames from a MOCK SIDECAR (producer thread)
// to the non-RT IO CONSUMER (consumer thread) over one of three candidate
// transports, and measures the consumer's inter-arrival gap distribution under
// optional CPU load. The authority is ../../docs/spike-rust-audio.md, section
// "PCM transport selection (ADR-0019)".
//
// Usage:
//   transport_bench <tcp|uds|shm> [--load N] [--secs S]
//
// Pacing (mirrors the real worker, worker.py:24): the producer emits 1.0 s
// (48000-frame) chunks and stays <= 3.0 s AHEAD of consumption. The consumer
// drains at real-time wall-clock (48000 frames/sec). A firehose would never
// underrun and would prove nothing — the bound is the whole point.
//
// Decision rule (NOT mean throughput): lowest worst-case (MAX) inter-arrival
// gap that still meets throughput; tie-break on p99.9 then CPU. A channel
// PASSES if its MAX gap stays inside the 1.5 s prebuffer drain margin.

use std::env;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

const SAMPLE_RATE: usize = 48_000;
const CHANNELS: usize = 2;
const FRAME_BYTES: usize = CHANNELS * 4; // interleaved stereo f32
const CHUNK_FRAMES: usize = SAMPLE_RATE; // 1.0 s chunk
const CHUNK_BYTES: usize = CHUNK_FRAMES * FRAME_BYTES; // 384_000 bytes
const LEAD_LIMIT_SECS: f64 = 3.0; // stay <= 3.0 s ahead of consumption
const PREBUFFER_MARGIN_MS: f64 = 1500.0; // 1.5 s drain margin (pass threshold)

/// The mock sidecar's chunk: a deterministic synthetic stereo signal. The bytes
/// themselves don't matter to the gap measurement; we just need a real payload
/// of the right size moving across the wire.
fn make_chunk() -> Vec<u8> {
    let mut buf = vec![0u8; CHUNK_BYTES];
    for f in 0..CHUNK_FRAMES {
        let t = f as f32 / SAMPLE_RATE as f32;
        let l = (2.0 * std::f32::consts::PI * 220.0 * t).sin() * 0.25;
        let r = (2.0 * std::f32::consts::PI * 330.0 * t).sin() * 0.25;
        let off = f * FRAME_BYTES;
        buf[off..off + 4].copy_from_slice(&l.to_le_bytes());
        buf[off + 4..off + 8].copy_from_slice(&r.to_le_bytes());
    }
    buf
}

/// CPU-burning threads to simulate model-inference contention. They busy-spin
/// on a volatile-ish accumulation until `stop` is set.
fn spawn_load(n: usize, stop: Arc<AtomicBool>) -> Vec<thread::JoinHandle<()>> {
    (0..n)
        .map(|i| {
            let stop = stop.clone();
            thread::spawn(move || {
                let mut x = i as u64 ^ 0x9e37_79b9_7f4a_7c15;
                while !stop.load(Ordering::Relaxed) {
                    // ~a few thousand cheap ops between stop checks.
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

/// Shared pacing state: how many chunks the consumer has fully drained. The
/// producer reads this to bound its lead to <= 3.0 s.
struct Pacing {
    consumed_chunks: AtomicU64,
    stop: AtomicBool,
}

/// Producer pacing loop: emit chunks but never get more than LEAD_LIMIT_SECS
/// ahead of the consumer. `send` ships one chunk over the chosen transport.
fn run_producer<F: FnMut(&[u8])>(pacing: Arc<Pacing>, total_chunks: u64, mut send: F) {
    let chunk = make_chunk();
    let mut produced: u64 = 0;
    let lead_limit = LEAD_LIMIT_SECS as u64; // chunks are 1 s, so secs == chunks
    while produced < total_chunks && !pacing.stop.load(Ordering::Relaxed) {
        let consumed = pacing.consumed_chunks.load(Ordering::Acquire);
        if produced.saturating_sub(consumed) >= lead_limit {
            // Too far ahead — wait for the consumer to drain (worker behaviour).
            thread::sleep(Duration::from_millis(2));
            continue;
        }
        send(&chunk);
        produced += 1;
    }
}

/// Recorded delivery gaps (ms) plus byte total, summarised at the end.
struct Stats {
    /// Per-chunk DELIVERY gap: how long the consumer waited, AT its real-time
    /// deadline, for the transport to hand over the next chunk. This is the
    /// jitter that competes with the 1.5 s prebuffer drain margin — not the
    /// ~1000 ms cadence of the consumer's own real-time pacing. Healthy =~ 0
    /// (data is prebuffered ahead); under contention it spikes.
    gaps_ms: Vec<f64>,
    bytes: u64,
    wall: Duration,
    /// Chunks whose delivery gap exceeded one chunk period (1000 ms) — i.e. the
    /// transport could not keep the consumer fed at real-time.
    underruns: u64,
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let rank = (p / 100.0) * (sorted.len() as f64 - 1.0);
    let lo = rank.floor() as usize;
    let hi = rank.ceil() as usize;
    if lo == hi {
        sorted[lo]
    } else {
        let frac = rank - lo as f64;
        sorted[lo] * (1.0 - frac) + sorted[hi] * frac
    }
}

/// The consumer drains at real-time wall-clock: it does not ask for the next
/// chunk until that chunk's audio would be due. At each deadline it calls
/// `recv_chunk` and TIMES how long that call blocks — the transport's delivery
/// gap. With a healthy 3 s lead the chunk is already buffered and the gap is
/// ~0; under contention the gap is the transport's latency spike, which is what
/// must stay inside the 1.5 s prebuffer drain margin. After each chunk it
/// advances the pacing counter so the producer may keep its bounded lead.
///
/// `recv_chunk` blocks until a full chunk is available and returns its byte
/// length (transport-specific). An "underrun" is a delivery gap > one chunk
/// period (1000 ms): the transport failed to keep the consumer fed at
/// real-time.
fn run_consumer<F: FnMut() -> Option<usize>>(
    pacing: Arc<Pacing>,
    total_chunks: u64,
    mut recv_chunk: F,
) -> Stats {
    let chunk_period = Duration::from_secs_f64(CHUNK_FRAMES as f64 / SAMPLE_RATE as f64);
    let chunk_period_ms = chunk_period.as_secs_f64() * 1000.0;
    let mut gaps_ms: Vec<f64> = Vec::with_capacity(total_chunks as usize);
    let mut bytes: u64 = 0;
    let mut underruns: u64 = 0;

    let start = Instant::now();
    // The real-time deadline for the NEXT chunk to be drained.
    let mut next_deadline = start + chunk_period;

    for _ in 0..total_chunks {
        // Real-time drain: don't consume the next chunk before its audio would
        // have finished playing.
        let now = Instant::now();
        if now < next_deadline {
            thread::sleep(next_deadline - now);
        }

        // Time the receive itself: this IS the transport delivery gap.
        let ask = Instant::now();
        match recv_chunk() {
            Some(n) => {
                let gap = ask.elapsed().as_secs_f64() * 1000.0;
                bytes += n as u64;
                gaps_ms.push(gap);
                if gap > chunk_period_ms {
                    underruns += 1;
                }
                next_deadline += chunk_period;
                pacing.consumed_chunks.fetch_add(1, Ordering::Release);
            }
            None => break,
        }
    }

    let wall = start.elapsed();
    pacing.stop.store(true, Ordering::Release);
    Stats { gaps_ms, bytes, wall, underruns }
}

// --- Transport: in-process lock-free SPSC ring (rtrb) — the shm best case ---

fn run_shm(pacing: Arc<Pacing>, total_chunks: u64) -> Stats {
    // Ring carries raw bytes. Size it to a few chunks of headroom so the
    // producer's 3 s lead fits without the ring itself being the bottleneck.
    let cap = CHUNK_BYTES * 6;
    let (mut producer, mut consumer) = rtrb::RingBuffer::<u8>::new(cap);

    let prod_pacing = pacing.clone();
    let prod = thread::spawn(move || {
        run_producer(prod_pacing, total_chunks, |chunk| {
            // Push the whole chunk; spin-wait for room (wait-free per op).
            let mut written = 0usize;
            while written < chunk.len() {
                match producer.write_chunk_uninit(
                    (chunk.len() - written).min(producer.slots()),
                ) {
                    Ok(w) => {
                        let n = w.len();
                        if n == 0 {
                            thread::sleep(Duration::from_micros(50));
                            continue;
                        }
                        w.fill_from_iter(chunk[written..written + n].iter().copied());
                        written += n;
                    }
                    Err(_) => thread::sleep(Duration::from_micros(50)),
                }
            }
        });
    });

    let stats = run_consumer(pacing, total_chunks, || {
        let mut got = 0usize;
        let mut scratch = [0u8; FRAME_BYTES]; // not used; we count bytes only
        let _ = &mut scratch;
        while got < CHUNK_BYTES {
            let want = (CHUNK_BYTES - got).min(consumer.slots());
            if want == 0 {
                thread::sleep(Duration::from_micros(50));
                continue;
            }
            match consumer.read_chunk(want) {
                Ok(r) => {
                    let n = r.len();
                    r.commit_all();
                    got += n;
                }
                Err(_) => thread::sleep(Duration::from_micros(50)),
            }
        }
        Some(got)
    });

    let _ = prod.join();
    stats
}

// --- Transport: loopback TCP / Unix domain socket (stream of bytes) ---

/// Drive a generic byte stream transport. `connect` yields a connected
/// (writer, reader) pair already established by the caller.
fn run_stream(
    pacing: Arc<Pacing>,
    total_chunks: u64,
    mut writer: impl Write + Send + 'static,
    mut reader: impl Read,
) -> Stats {
    let prod_pacing = pacing.clone();
    let prod = thread::spawn(move || {
        run_producer(prod_pacing, total_chunks, |chunk| {
            // Length-prefix framing (reuses v0's framed-chunk shape).
            let len = chunk.len() as u32;
            if writer.write_all(&len.to_le_bytes()).is_err() {
                return;
            }
            if writer.write_all(chunk).is_err() {
                return;
            }
            let _ = writer.flush();
        });
    });

    let mut buf = vec![0u8; CHUNK_BYTES];
    let stats = run_consumer(pacing, total_chunks, || {
        let mut len_bytes = [0u8; 4];
        if reader.read_exact(&mut len_bytes).is_err() {
            return None;
        }
        let len = u32::from_le_bytes(len_bytes) as usize;
        if len > buf.len() {
            buf.resize(len, 0);
        }
        if reader.read_exact(&mut buf[..len]).is_err() {
            return None;
        }
        Some(len)
    });

    let _ = prod.join();
    stats
}

fn run_tcp(pacing: Arc<Pacing>, total_chunks: u64) -> Stats {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind tcp");
    let addr = listener.local_addr().expect("local_addr");
    let accept = thread::spawn(move || listener.accept().expect("accept tcp").0);
    let client = TcpStream::connect(addr).expect("connect tcp");
    client.set_nodelay(true).ok();
    let server = accept.join().expect("accept join");
    server.set_nodelay(true).ok();
    // Producer writes on the client; consumer reads on the server.
    run_stream(pacing, total_chunks, client, server)
}

fn run_uds(pacing: Arc<Pacing>, total_chunks: u64) -> Stats {
    let dir = env::temp_dir();
    let path = dir.join(format!("slipmate_uds_{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).expect("bind uds");
    let path_for_accept = path.clone();
    let accept = thread::spawn(move || {
        let s = listener.accept().expect("accept uds").0;
        let _ = path_for_accept; // keep listener path alive for the accept
        s
    });
    let client = UnixStream::connect(&path).expect("connect uds");
    let server = accept.join().expect("accept join");
    let stats = run_stream(pacing, total_chunks, client, server);
    let _ = std::fs::remove_file(&path);
    stats
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: {} <tcp|uds|shm> [--load N] [--secs S]", args[0]);
        std::process::exit(2);
    }
    let channel = args[1].clone();

    let default_load = num_cpus_minus_two();
    let mut load: usize = 0;
    let mut load_explicit = false;
    let mut secs: u64 = 30;
    let mut i = 2;
    while i < args.len() {
        match args[i].as_str() {
            "--load" => {
                load_explicit = true;
                load = args
                    .get(i + 1)
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(default_load);
                // `--load` with no number == default (cores-2).
                if args.get(i + 1).map(|s| s.parse::<usize>().is_ok()) == Some(true) {
                    i += 1;
                }
            }
            "--secs" => {
                secs = args.get(i + 1).and_then(|s| s.parse().ok()).unwrap_or(secs);
                i += 1;
            }
            other => {
                eprintln!("warning: ignoring unknown arg '{other}'");
            }
        }
        i += 1;
    }
    let _ = load_explicit;

    let total_chunks = secs; // 1.0 s chunks

    let pacing = Arc::new(Pacing {
        consumed_chunks: AtomicU64::new(0),
        stop: AtomicBool::new(false),
    });

    let load_stop = Arc::new(AtomicBool::new(false));
    let load_handles = if load > 0 {
        spawn_load(load, load_stop.clone())
    } else {
        Vec::new()
    };

    eprintln!(
        "transport_bench: channel={channel} secs={secs} load={load} \
         (chunk={CHUNK_BYTES}B = 1.0s, lead<= {LEAD_LIMIT_SECS}s)"
    );

    let stats = match channel.as_str() {
        "tcp" => run_tcp(pacing, total_chunks),
        "uds" => run_uds(pacing, total_chunks),
        "shm" => run_shm(pacing, total_chunks),
        other => {
            eprintln!("error: unknown channel '{other}' (tcp|uds|shm)");
            std::process::exit(2);
        }
    };

    load_stop.store(true, Ordering::Release);
    for h in load_handles {
        let _ = h.join();
    }

    report(&channel, load, &stats);
}

fn num_cpus_minus_two() -> usize {
    let cores = thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    cores.saturating_sub(2).max(1)
}

fn report(channel: &str, load: usize, stats: &Stats) {
    let mut gaps = stats.gaps_ms.clone();
    gaps.sort_by(|a, b| a.partial_cmp(b).unwrap());

    let p50 = percentile(&gaps, 50.0);
    let p99 = percentile(&gaps, 99.0);
    let p999 = percentile(&gaps, 99.9);
    let max = gaps.last().copied().unwrap_or(0.0);

    let mb = stats.bytes as f64 / (1024.0 * 1024.0);
    let secs = stats.wall.as_secs_f64();
    let throughput = if secs > 0.0 { mb / secs } else { 0.0 };

    // Throughput floor: ~1.5 MB/s aggregate per the spec. One deck at 48k
    // stereo f32 == 384_000 B/s == ~0.366 MB/s; the bench drives one stream.
    let meets_throughput = throughput >= 0.30;
    let within_margin = max <= PREBUFFER_MARGIN_MS;

    println!("\n===== RESULT  channel={channel}  load={load} =====");
    println!("samples (chunks)    : {}", gaps.len());
    println!("inter-arrival gap ms: p50={p50:.3}  p99={p99:.3}  p99.9={p999:.3}  MAX={max:.3}");
    println!("throughput          : {throughput:.3} MB/s  ({mb:.1} MB in {secs:.1} s)");
    println!("late chunks         : {}", stats.underruns);
    println!(
        "MAX within 1.5s margin: {}   meets throughput: {}",
        if within_margin { "YES" } else { "NO" },
        if meets_throughput { "YES" } else { "NO" }
    );
    // One-line machine-greppable row for the jitter table.
    println!(
        "ROW\t{channel}\tload={load}\t{p50:.3}\t{p99:.3}\t{p999:.3}\t{max:.3}\t{throughput:.3}\t{}\t{}",
        if within_margin { "pass" } else { "FAIL" },
        stats.underruns
    );
}
