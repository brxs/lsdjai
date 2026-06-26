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

/// Spread an interleaved-stereo source onto channels 1/2 of a wider interleaved
/// device buffer, zeroing every other channel. `src` is the already-drained
/// stereo block; any device frame past it is silenced (the overflow guard for a
/// block bigger than the pre-sized scratch). Pure and alloc-free — RT-safe.
fn spread_stereo(data: &mut [f32], dev_ch: usize, src: &[f32]) {
    let frames = data.len() / dev_ch;
    for f in 0..frames {
        let base = f * dev_ch;
        if 2 * f + 1 < src.len() {
            data[base] = src[2 * f];
            data[base + 1] = src[2 * f + 1];
        } else {
            data[base] = 0.0;
            data[base + 1] = 0.0;
        }
        for c in 2..dev_ch {
            data[base + c] = 0.0;
        }
    }
}

/// Spread interleaved-stereo master + cue onto a ≥4-channel device buffer: master
/// on channels 1/2, cue on 3/4, any further channel zeroed (the FLX4 combined
/// path). `master`/`cue` are the already-drained stereo blocks; frames past
/// either are silenced on those channels. Pure and alloc-free — RT-safe.
fn spread_master_cue(data: &mut [f32], dev_ch: usize, master: &[f32], cue: &[f32]) {
    let frames = data.len() / dev_ch;
    for f in 0..frames {
        let base = f * dev_ch;
        if 2 * f + 1 < master.len() {
            data[base] = master[2 * f];
            data[base + 1] = master[2 * f + 1];
        } else {
            data[base] = 0.0;
            data[base + 1] = 0.0;
        }
        if 2 * f + 1 < cue.len() {
            data[base + 2] = cue[2 * f];
            data[base + 3] = cue[2 * f + 1];
        } else {
            data[base + 2] = 0.0;
            data[base + 3] = 0.0;
        }
        for c in 4..dev_ch {
            data[base + c] = 0.0;
        }
    }
}

/// Open `selected` at exactly 48000/f32, build a stream that drains `primary` onto
/// channels 1/2 — and, when `secondary` is `Some` AND the device has ≥4 channels,
/// also drains it onto channels 3/4 (the FLX4 combined master+cue path). On a
/// narrower device the `secondary` is dropped: the stream is primary-only and the
/// secondary ring stays undrained (its `push_all` overflow is discarded, so the
/// render thread never stalls). Start it and return the running stream.
///
/// The callback is the ONLY real-time path: it sets FTZ/DAZ once, drains the
/// ring(s), and spreads into the device buffer, all under `assert_no_alloc` —
/// trivially alloc/lock/syscall free. The [`Engine`] renders on the host's
/// dedicated render thread into the rings; the callback only pulls from them (see
/// [`crate::host`] for the decoupled-render-thread rationale and latency note).
///
/// On any sandbox/headless condition this returns [`DeviceError::Unavailable`]
/// without hanging — the host keeps running headlessly (its render thread fills
/// the rings; with no device nothing drains them, which is fine).
fn open_spread_stream(
    selected: Option<&str>,
    mut primary: OutputConsumer,
    secondary: Option<OutputConsumer>,
) -> Result<AudioStream, DeviceError> {
    let (device, config, info) = open_output(selected)?;
    let device_channels = info.device_channels as usize;

    // The secondary (cue) feed needs channels 3/4 — only a ≥4-channel device (the
    // FLX4) can carry it alongside the primary. Drop it on a narrower device.
    let mut secondary = if device_channels >= 4 { secondary } else { None };
    let secondary_routed = secondary.is_some();

    let mut first_call = true;
    // Per-callback scratch for wide (>2ch) devices: the rings hold interleaved
    // stereo, so on a wider device we drain stereo into these scratches and spread
    // into the device buffer. Sized ONCE here, off the RT path, for a generous
    // worst-case block; the callback never resizes them.
    let mut scratch: Vec<f32> = Vec::new();
    let mut secondary_scratch: Vec<f32> = Vec::new();
    if device_channels != CHANNELS as usize {
        scratch_reserve(&mut scratch, REQUESTED_BUFFER as usize * 4);
        if secondary_routed {
            scratch_reserve(&mut secondary_scratch, REQUESTED_BUFFER as usize * 4);
        }
    }

    let err_fn = |e| eprintln!("lsdj-engine: stream error: {e}");

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
                        primary.drain_into(data);
                    } else {
                        // Wider device: drain stereo into scratch, then spread.
                        let want = (data.len() / dev_ch) * CHANNELS as usize;
                        let usable = scratch.len().min(want);
                        primary.drain_into(&mut scratch[..usable]);
                        if let Some(secondary) = secondary.as_mut() {
                            let su = secondary_scratch.len().min(want);
                            secondary.drain_into(&mut secondary_scratch[..su]);
                            spread_master_cue(
                                data,
                                dev_ch,
                                &scratch[..usable],
                                &secondary_scratch[..su],
                            );
                        } else {
                            spread_stereo(data, dev_ch, &scratch[..usable]);
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

/// Open the MAIN output device (`main`, or the default when `None`) draining the
/// master ring onto channels 1/2. When `cue` is `Some` (combined mode — the FLX4)
/// the cue ring also drains onto channels 3/4, provided the device has ≥4
/// channels; otherwise the stream is master-only and the cue rides its own stream
/// ([`open_cue_stream`]).
pub fn open_main_stream(
    main: Option<&str>,
    master: OutputConsumer,
    cue: Option<OutputConsumer>,
) -> Result<AudioStream, DeviceError> {
    open_spread_stream(main, master, cue)
}

/// Open the CUE output device (`cue_dev`, or the default when `None`) draining the
/// cue ring onto its channels 1/2 — split mode, a second independently chosen
/// device. Independent of the main stream, so opening / replacing it never
/// disturbs the master.
pub fn open_cue_stream(
    cue_dev: Option<&str>,
    cue: OutputConsumer,
) -> Result<AudioStream, DeviceError> {
    open_spread_stream(cue_dev, cue, None)
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

    let err_fn = |e| eprintln!("lsdj-engine: stream error: {e}");

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

#[cfg(test)]
mod tests {
    use super::{spread_master_cue, spread_stereo};

    /// Master-only spread lands the stereo pair on channels 1/2 and zeroes the
    /// rest of each frame (the split main / cue stream on a wide device).
    #[test]
    fn spread_stereo_lands_on_channels_1_2() {
        let src = [0.1, 0.2, 0.3, 0.4]; // two stereo frames
        let dev_ch = 4;
        let mut data = vec![9.0f32; 2 * dev_ch]; // pre-fill to prove zeroing
        spread_stereo(&mut data, dev_ch, &src);
        assert_eq!(data, vec![0.1, 0.2, 0.0, 0.0, 0.3, 0.4, 0.0, 0.0]);
    }

    /// A device block longer than the drained source silences the trailing frames
    /// on channels 1/2 (the overflow guard for an unexpectedly large block).
    #[test]
    fn spread_stereo_zeroes_frames_past_the_source() {
        let src = [0.5, 0.6]; // one stereo frame only
        let dev_ch = 2;
        let mut data = vec![9.0f32; 2 * dev_ch]; // two frames
        spread_stereo(&mut data, dev_ch, &src);
        assert_eq!(data, vec![0.5, 0.6, 0.0, 0.0]);
    }

    /// Combined spread lands master on 1/2, cue on 3/4, and zeroes channels ≥4
    /// (the FLX4 master+phones path on a ≥4-channel device).
    #[test]
    fn spread_master_cue_lands_master_1_2_cue_3_4() {
        let master = [0.1, 0.2]; // one stereo frame
        let cue = [0.7, 0.8];
        let dev_ch = 6;
        let mut data = vec![9.0f32; dev_ch];
        spread_master_cue(&mut data, dev_ch, &master, &cue);
        assert_eq!(data, vec![0.1, 0.2, 0.7, 0.8, 0.0, 0.0]);
    }

    /// The master and cue blocks can run dry independently: a short cue still
    /// silences only channels 3/4, leaving master on 1/2 intact.
    #[test]
    fn spread_master_cue_silences_a_short_cue_only() {
        let master = [0.1, 0.2, 0.3, 0.4]; // two frames
        let cue = [0.7, 0.8]; // one frame — second frame's cue runs dry
        let dev_ch = 4;
        let mut data = vec![9.0f32; 2 * dev_ch];
        spread_master_cue(&mut data, dev_ch, &master, &cue);
        assert_eq!(
            data,
            vec![0.1, 0.2, 0.7, 0.8, 0.3, 0.4, 0.0, 0.0],
            "frame 0 carries master+cue; frame 1 carries master with cue zeroed",
        );
    }
}
