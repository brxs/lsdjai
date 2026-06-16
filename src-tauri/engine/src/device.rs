//! The cpal device wrapper: a thin host around the device-free [`Engine`] core.
//!
//! Opens an exact 48000 / stereo / f32 output stream with `BufferSize::Fixed(256)`
//! and, in its callback, sets FTZ/DAZ once and calls [`Engine::render`] wrapped in
//! `assert_no_alloc`. The callback is the ONLY real-time path; it allocates
//! nothing, takes no lock, makes no syscall, and logs nothing. Ported from the
//! Spike A `rt_engine` device half (`spike/rust-audio/engine/src/bin/rt_engine.rs`),
//! now built on the library so the device path stays exercisable.
//!
//! Graceful no-device exit: if no output device or no exact-48000/f32 config is
//! available (likely in a sandbox / headless CI), [`run_stream`] returns
//! [`DeviceError::Unavailable`] rather than hanging or panicking.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, StreamConfig};

use crate::{Engine, CHANNELS, SAMPLE_RATE};

/// Requested device buffer size (frames). Clamped to the device's supported
/// range; the granted size is reported back in [`StreamInfo`].
const REQUESTED_BUFFER: u32 = 256;

/// Why a device stream could not be opened. `Unavailable` is the sandbox/headless
/// case — callers treat it as "no device, exit cleanly", not a failure.
#[derive(Debug)]
pub enum DeviceError {
    /// No output device, or no exact 48000/stereo/f32 config (e.g. a sandbox, or
    /// a built-in device defaulting to 44100). Not a bug — exit cleanly.
    Unavailable(String),
    /// The stream could not be built or started.
    Stream(String),
}

impl std::fmt::Display for DeviceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DeviceError::Unavailable(m) => write!(f, "audio device unavailable: {m}"),
            DeviceError::Stream(m) => write!(f, "audio stream error: {m}"),
        }
    }
}

impl std::error::Error for DeviceError {}

/// What the device granted, for logging / telemetry.
#[derive(Debug, Clone)]
pub struct StreamInfo {
    pub device_name: String,
    pub device_channels: u16,
    pub sample_rate: u32,
    pub buffer_frames: BufferSize,
}

/// A running output stream driving an [`Engine`]. The cpal stream stops when this
/// is dropped; the `Engine` lives inside the callback for the stream's lifetime.
pub struct AudioStream {
    _stream: cpal::Stream,
    info: StreamInfo,
}

impl AudioStream {
    pub fn info(&self) -> &StreamInfo {
        &self.info
    }
}

/// Open the default output device at exactly 48000/stereo/f32, build the stream
/// that renders `engine` in its callback, start it, and return the running
/// stream. The `engine` is MOVED into the audio callback.
///
/// On any sandbox/headless condition (no device, wrong rate) this returns
/// [`DeviceError::Unavailable`] without hanging — the caller decides whether that
/// is fatal.
pub fn run_stream(mut engine: Engine) -> Result<AudioStream, DeviceError> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or_else(|| DeviceError::Unavailable("no default output device".into()))?;

    let device_name = device
        .description()
        .map(|d| d.name().to_string())
        .unwrap_or_else(|_| "<unknown>".into());

    let configs = device
        .supported_output_configs()
        .map_err(|e| DeviceError::Unavailable(format!("cannot query output configs: {e}")))?;

    // Require an EXACT 48000/f32 config with at least stereo. Resampling is out
    // of scope (a later phase / rubato).
    let mut chosen = None;
    for cfg in configs {
        let rate_ok = cfg.min_sample_rate() <= SAMPLE_RATE && cfg.max_sample_rate() >= SAMPLE_RATE;
        if cfg.channels() >= CHANNELS && cfg.sample_format() == cpal::SampleFormat::F32 && rate_ok {
            chosen = Some(cfg.with_sample_rate(SAMPLE_RATE));
            break;
        }
    }
    let supported = chosen.ok_or_else(|| {
        DeviceError::Unavailable(format!(
            "device '{device_name}' has no exact {SAMPLE_RATE}/f32 output config \
             (built-in macOS often defaults to 44100)"
        ))
    })?;

    let device_channels = supported.channels();
    let buffer_size = match supported.buffer_size() {
        cpal::SupportedBufferSize::Range { min, max } => {
            BufferSize::Fixed(REQUESTED_BUFFER.clamp(*min, *max))
        }
        cpal::SupportedBufferSize::Unknown => BufferSize::Fixed(REQUESTED_BUFFER),
    };

    let config = StreamConfig {
        channels: device_channels,
        sample_rate: SAMPLE_RATE,
        buffer_size,
    };

    let info = StreamInfo {
        device_name,
        device_channels,
        sample_rate: SAMPLE_RATE,
        buffer_frames: buffer_size,
    };

    // Per-callback scratch for wide (>2ch) devices: the engine renders exactly
    // stereo, so on a wider device we render into this stereo scratch and spread
    // it into the device buffer (extra channels zeroed). On the common stereo
    // device the scratch stays empty and the fast path renders straight into
    // `data`. Sized ONCE here, off the RT path, for a generous worst-case block
    // (4× the requested buffer); the callback never resizes it.
    let mut first_call = true;
    let mut scratch: Vec<f32> = Vec::new();
    if device_channels as usize != CHANNELS as usize {
        scratch_reserve(&mut scratch, REQUESTED_BUFFER as usize * 4);
    }

    let err_fn = |e| eprintln!("slipmate-engine: stream error: {e}");

    let stream = device
        .build_output_stream(
            config,
            move |data: &mut [f32], _info: &cpal::OutputCallbackInfo| {
                // Everything below MUST be alloc/lock/syscall/log free. The guard
                // proves it (warns in release if violated).
                crate::device::no_alloc(|| {
                    if first_call {
                        crate::device::set_ftz_daz();
                        first_call = false;
                    }
                    let dev_ch = device_channels as usize;
                    let frames = data.len() / dev_ch;

                    if dev_ch == CHANNELS as usize {
                        // Stereo fast path: render straight into the device buffer.
                        engine.render(data, frames);
                    } else {
                        // Wider device: render stereo into scratch, then spread.
                        // `scratch` was pre-sized below on the first wide call;
                        // if cpal ever hands a bigger block than expected we skip
                        // the overflow rather than alloc on the RT thread.
                        let want = frames * CHANNELS as usize;
                        let usable = scratch.len().min(want);
                        let frames_usable = usable / CHANNELS as usize;
                        engine.render(&mut scratch[..usable], frames_usable);
                        for f in 0..frames {
                            let base = f * dev_ch;
                            if f < frames_usable {
                                data[base] = scratch[2 * f];
                                data[base + 1] = scratch[2 * f + 1];
                            } else {
                                data[base] = 0.0;
                                data[base + 1] = 0.0;
                            }
                            for c in 2..dev_ch {
                                data[base + c] = 0.0;
                            }
                        }
                    }
                });
            },
            err_fn,
            None,
        )
        .map_err(|e| DeviceError::Stream(format!("failed to build output stream: {e}")))?;

    stream
        .play()
        .map_err(|e| DeviceError::Stream(format!("failed to start stream: {e}")))?;

    Ok(AudioStream {
        _stream: stream,
        info,
    })
}

/// Pre-size the scratch buffer (off the RT path), before it is moved into the
/// callback. Pulled out so the intent — allocate the worst-case block ONCE,
/// never on the RT thread — is explicit.
fn scratch_reserve(scratch: &mut Vec<f32>, frames: usize) {
    scratch.resize(frames * CHANNELS as usize, 0.0);
}

/// `assert_no_alloc` wrapper, isolated here so `lib.rs`/tests don't depend on the
/// allocator guard. The guard only arms if `AllocDisabler` is the global
/// allocator (registered by the binary); otherwise it is a transparent passthrough.
#[inline]
pub(crate) fn no_alloc<T>(f: impl FnOnce() -> T) -> T {
    assert_no_alloc::assert_no_alloc(f)
}

/// Enable flush-to-zero / denormals-are-zero on the calling (audio) thread so a
/// decaying denormal tail never trips the CPU's slow denormal path. Ported
/// verbatim from the spike.
#[inline]
pub(crate) fn set_ftz_daz() {
    #[cfg(all(target_arch = "x86_64", target_feature = "sse"))]
    unsafe {
        use std::arch::x86_64::{
            _MM_FLUSH_ZERO_ON, _MM_GET_FLUSH_ZERO_MODE, _MM_SET_FLUSH_ZERO_MODE,
        };
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
