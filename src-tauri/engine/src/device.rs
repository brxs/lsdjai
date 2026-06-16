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

use crate::host::OutputConsumer;
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

/// One output device the engine can open, for the picker UI.
pub struct OutputDeviceInfo {
    pub name: String,
    /// Channels of its widest usable (48000/f32, ≥ stereo) config.
    pub channels: u16,
    /// Whether it can carry the headphone cue: a ≥4-channel device lands master
    /// on 1/2 and the cue on 3/4 (the FLX4 phones jack).
    pub cue_capable: bool,
}

/// This device's name, or `<unknown>`.
fn device_name(device: &cpal::Device) -> String {
    device
        .description()
        .map(|d| d.name().to_string())
        .unwrap_or_else(|_| "<unknown>".into())
}

/// Choose a device's best output config for the engine: an exact 48000/f32 config
/// with at least stereo, preferring the WIDEST channel count so a ≥4-channel
/// device (the FLX4) lands its master on 1/2 and the cue on 3/4. Resampling is out
/// of scope, so a device with no 48000/f32 config is simply unusable.
fn pick_config(device: &cpal::Device) -> Option<cpal::SupportedStreamConfig> {
    let configs = device.supported_output_configs().ok()?;
    configs
        .filter(|cfg| {
            cfg.channels() >= CHANNELS
                && cfg.sample_format() == cpal::SampleFormat::F32
                && cfg.min_sample_rate() <= SAMPLE_RATE
                && cfg.max_sample_rate() >= SAMPLE_RATE
        })
        .max_by_key(|cfg| cfg.channels())
        .map(|cfg| cfg.with_sample_rate(SAMPLE_RATE))
}

/// Enumerate the output devices the engine can open (exact 48000/f32, ≥ stereo)
/// with their widest channel count, for the picker. Off the RT path — called from
/// a command when the picker opens. Empty on a headless host.
pub fn list_output_devices() -> Vec<OutputDeviceInfo> {
    let host = cpal::default_host();
    let Ok(devices) = host.output_devices() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for device in devices {
        if let Some(cfg) = pick_config(&device) {
            let channels = cfg.channels();
            out.push(OutputDeviceInfo {
                name: device_name(&device),
                channels,
                cue_capable: channels >= 4,
            });
        }
    }
    out
}

/// Find an output device by its reported name; errors if none matches (a saved
/// device may be unplugged) so the caller keeps the current stream.
fn find_output_device(host: &cpal::Host, name: &str) -> Result<cpal::Device, DeviceError> {
    let devices = host
        .output_devices()
        .map_err(|e| DeviceError::Unavailable(format!("cannot enumerate output devices: {e}")))?;
    devices
        .into_iter()
        .find(|d| device_name(d) == name)
        .ok_or_else(|| DeviceError::Unavailable(format!("output device '{name}' not found")))
}

/// Open `device_name` (or the default when `None`) at exactly 48000/f32, choosing
/// its widest config (so the cue reaches channels 3/4 on a ≥4-channel device).
fn open_output(
    selected: Option<&str>,
) -> Result<(cpal::Device, StreamConfig, StreamInfo), DeviceError> {
    let host = cpal::default_host();
    let device = match selected {
        Some(name) => find_output_device(&host, name)?,
        None => host
            .default_output_device()
            .ok_or_else(|| DeviceError::Unavailable("no default output device".into()))?,
    };

    let device_name = device_name(&device);

    let supported = pick_config(&device).ok_or_else(|| {
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

    Ok((device, config, info))
}

/// Open the default output device at exactly 48000/stereo/f32, build the stream
/// that drains the host's [`OutputConsumer`] in its callback, start it, and return
/// the running stream. The callback is the ONLY real-time path: it does nothing
/// but set FTZ/DAZ once and drain the output ring into the device buffer
/// (zero-filling + counting an underrun on a short ring), all under
/// `assert_no_alloc` — trivially alloc/lock/syscall free.
///
/// This is the host-driven device path (Phase 2, step 2): the [`Engine`] renders
/// on the host's dedicated render thread into the output ring; the callback only
/// pulls from it. See [`crate::host`] for the decoupled-render-thread rationale
/// and the latency trade-off this introduces.
///
/// On any sandbox/headless condition this returns [`DeviceError::Unavailable`]
/// without hanging — the host keeps running headlessly (its render thread fills
/// the ring; with no device nothing drains it, which is fine).
pub fn run_host_stream(
    selected: Option<&str>,
    mut output: OutputConsumer,
    mut cue: OutputConsumer,
) -> Result<AudioStream, DeviceError> {
    let (device, config, info) = open_output(selected)?;
    let device_channels = info.device_channels as usize;

    // The cue feed routes to device channels 3/4 when the device has ≥4 channels
    // (the FLX4 phones jack, ADR-0007's native replacement). On a stereo / 3-ch
    // device there is nowhere to put it: the cue ring is simply not drained (the
    // render thread's push_all drops its overflow, so nothing stalls).
    let cue_routed = device_channels >= 4;

    let mut first_call = true;
    // Per-callback scratch for wide (>2ch) devices: the rings hold interleaved
    // stereo, so on a wider device we drain stereo into these scratches and spread
    // into the device buffer (extra channels zeroed). Sized ONCE here, off the RT
    // path, for a generous worst-case block; the callback never resizes them.
    let mut scratch: Vec<f32> = Vec::new();
    let mut cue_scratch: Vec<f32> = Vec::new();
    if device_channels != CHANNELS as usize {
        scratch_reserve(&mut scratch, REQUESTED_BUFFER as usize * 4);
        if cue_routed {
            scratch_reserve(&mut cue_scratch, REQUESTED_BUFFER as usize * 4);
        }
    }

    let err_fn = |e| eprintln!("slipmate-engine: stream error: {e}");

    let stream = device
        .build_output_stream(
            config,
            move |data: &mut [f32], _info: &cpal::OutputCallbackInfo| {
                no_alloc(|| {
                    if first_call {
                        set_ftz_daz();
                        first_call = false;
                    }
                    let dev_ch = device_channels;
                    if dev_ch == CHANNELS as usize {
                        // Stereo fast path: drain straight into the device buffer.
                        output.drain_into(data);
                    } else {
                        // Wider device: drain stereo into scratch, then spread.
                        let frames = data.len() / dev_ch;
                        let want = frames * CHANNELS as usize;
                        let usable = scratch.len().min(want);
                        output.drain_into(&mut scratch[..usable]);
                        // Drain the cue into channels 3/4 when the device has room.
                        let cue_usable = if cue_routed {
                            let u = cue_scratch.len().min(want);
                            cue.drain_into(&mut cue_scratch[..u]);
                            u
                        } else {
                            0
                        };
                        for f in 0..frames {
                            let base = f * dev_ch;
                            if f * CHANNELS as usize + 1 < usable {
                                data[base] = scratch[2 * f];
                                data[base + 1] = scratch[2 * f + 1];
                            } else {
                                data[base] = 0.0;
                                data[base + 1] = 0.0;
                            }
                            // Cue → channels 3/4 (FLX4 phones); other channels zero.
                            if cue_routed && f * CHANNELS as usize + 1 < cue_usable {
                                data[base + 2] = cue_scratch[2 * f];
                                data[base + 3] = cue_scratch[2 * f + 1];
                                for c in 4..dev_ch {
                                    data[base + c] = 0.0;
                                }
                            } else {
                                for c in 2..dev_ch {
                                    data[base + c] = 0.0;
                                }
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

/// Open the default output device at exactly 48000/stereo/f32, build the stream
/// that renders `engine` in its callback, start it, and return the running
/// stream. The `engine` is MOVED into the audio callback.
///
/// This is the original engine-in-callback path (Phase 1 / `device_run`). The
/// Tauri app now drives audio through [`run_host_stream`] + [`crate::host`]
/// instead, but this path stays for the `device_run` binary and hardware spikes.
///
/// On any sandbox/headless condition (no device, wrong rate) this returns
/// [`DeviceError::Unavailable`] without hanging — the caller decides whether that
/// is fatal.
pub fn run_stream(mut engine: Engine) -> Result<AudioStream, DeviceError> {
    let (device, config, info) = open_output(None)?;
    let device_channels = info.device_channels;

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
