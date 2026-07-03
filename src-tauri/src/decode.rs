//! Shell-side track decode (ADR-0030): compressed/container audio bytes in,
//! stereo f32 at the engine's 48 kHz out. Replaces the webview's
//! `OfflineAudioContext.decodeAudioData` for deck-track loading, so decoded
//! PCM never crosses the IPC boundary in either direction.
//!
//! Allocating and CPU-heavy by design — a load, not a callback. Runs on the
//! async-command pool; the RT path never appears here.

use std::io::Cursor;

use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{FixedSync, Resampler};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// The engine sample rate (mirrors `lsdj_engine::SAMPLE_RATE`).
const TARGET_RATE: u32 = lsdj_engine::SAMPLE_RATE;

/// Frames per rubato input block for the offline resample. Any reasonable
/// power of two works; fixed so the FFT plans build once.
const RESAMPLE_CHUNK_FRAMES: usize = 4096;

/// A decoded track at 48 kHz — split channels for the analyses (tempo pass,
/// beatgrid, bands), interleaved on demand for the engine.
pub struct DecodedTrack {
    pub left: Vec<f32>,
    pub right: Vec<f32>,
}

impl DecodedTrack {
    pub fn frames(&self) -> usize {
        self.left.len()
    }

    pub fn duration_seconds(&self) -> f64 {
        self.frames() as f64 / TARGET_RATE as f64
    }

    /// The engine wire layout (`Host::load_track` takes interleaved stereo).
    pub fn interleaved(&self) -> Vec<f32> {
        let mut out = Vec::with_capacity(self.left.len() * 2);
        for (l, r) in self.left.iter().zip(&self.right) {
            out.push(*l);
            out.push(*r);
        }
        out
    }
}

/// Decode `bytes` (any allowlisted container/codec) and resample to 48 kHz
/// stereo. `extension` is a probe hint — the scoped commands know the real
/// file name; the in-memory compose path passes `None` (WAV probes fine
/// without one). Errors are strings for the command boundary; they surface
/// to the webview as an explicit load failure (ADR-0030: no silent refusal).
pub fn decode_to_48k(bytes: Vec<u8>, extension: Option<&str>) -> Result<DecodedTrack, String> {
    let mut hint = Hint::new();
    if let Some(ext) = extension {
        hint.with_extension(ext);
    }
    let source = MediaSourceStream::new(Box::new(Cursor::new(bytes)), Default::default());
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            source,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("unsupported audio format: {e}"))?;
    let mut format = probed.format;
    let track = format
        .default_track()
        .ok_or_else(|| "no audio track in file".to_string())?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("unsupported audio codec: {e}"))?;

    let mut sample_rate = 0u32;
    let mut channels = 0usize;
    let mut left = Vec::new();
    let mut right = Vec::new();
    let mut scratch: Option<SampleBuffer<f32>> = None;
    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            // A clean end of stream is the normal exit; symphonia surfaces it
            // as an UnexpectedEof I/O error.
            Err(SymphoniaError::IoError(e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(e) => return Err(format!("cannot read audio: {e}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            // Per symphonia's contract a decode error is a corrupt packet,
            // recoverable by continuing; anything else is fatal.
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(e) => return Err(format!("cannot decode audio: {e}")),
        };
        let spec = *decoded.spec();
        if sample_rate == 0 {
            sample_rate = spec.rate;
            channels = spec.channels.count();
            if channels == 0 {
                return Err("no audio channels in file".to_string());
            }
        } else if spec.rate != sample_rate || spec.channels.count() != channels {
            // A chained stream (e.g. concatenated Oggs) can change spec
            // mid-file; reading on would misinterpret every later frame at
            // the first spec. Refuse explicitly — no silent misread.
            return Err("audio format changes mid-file".to_string());
        }
        let buffer = scratch.get_or_insert_with(|| {
            SampleBuffer::<f32>::new(decoded.capacity() as u64, spec)
        });
        if buffer.capacity() < decoded.frames() * channels {
            *buffer = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        }
        buffer.copy_interleaved_ref(decoded);
        let samples = buffer.samples();
        for frame in samples.chunks_exact(channels) {
            left.push(frame[0]);
            right.push(if channels > 1 { frame[1] } else { frame[0] });
        }
    }
    if left.is_empty() {
        return Err("no audio frames decoded".to_string());
    }
    if sample_rate == TARGET_RATE {
        return Ok(DecodedTrack { left, right });
    }
    resample_to_48k(&left, &right, sample_rate)
}

/// Offline stereo resample `source_rate` → 48 kHz (rubato FFT, the ADR-0029
/// crate). Fixed-input blocks; the tail is zero-padded through, and the
/// output is trimmed by the resampler's delay to the expected length so the
/// track neither shifts nor grows.
fn resample_to_48k(left: &[f32], right: &[f32], source_rate: u32) -> Result<DecodedTrack, String> {
    let mut resampler = rubato::Fft::<f32>::new(
        source_rate as usize,
        TARGET_RATE as usize,
        RESAMPLE_CHUNK_FRAMES,
        2,
        2,
        FixedSync::Input,
    )
    .map_err(|e| format!("cannot resample {source_rate} Hz audio: {e}"))?;
    let frames_in = left.len();
    let expected_frames =
        (frames_in as f64 * TARGET_RATE as f64 / source_rate as f64).round() as usize;
    let delay = resampler.output_delay();

    let mut input = vec![0.0f32; RESAMPLE_CHUNK_FRAMES * 2];
    let mut output = vec![0.0f32; resampler.output_frames_max() * 2];
    let mut produced: Vec<f32> = Vec::with_capacity((expected_frames + delay) * 2 + output.len());
    let mut fed = 0usize;
    // Feed real frames, then zeros, until the delay-shifted tail is out.
    while produced.len() / 2 < expected_frames + delay {
        for i in 0..RESAMPLE_CHUNK_FRAMES {
            let frame = fed + i;
            let (l, r) = if frame < frames_in {
                (left[frame], right[frame])
            } else {
                (0.0, 0.0)
            };
            input[2 * i] = l;
            input[2 * i + 1] = r;
        }
        fed += RESAMPLE_CHUNK_FRAMES;
        let block_out = {
            let inp = InterleavedSlice::new(&input, 2, RESAMPLE_CHUNK_FRAMES)
                .map_err(|e| format!("resample input: {e}"))?;
            let mut outp =
                InterleavedSlice::new_mut(&mut output, 2, resampler.output_frames_max())
                    .map_err(|e| format!("resample output: {e}"))?;
            let (_, out_frames) = resampler
                .process_into_buffer(&inp, &mut outp, None)
                .map_err(|e| format!("resample: {e}"))?;
            out_frames
        };
        produced.extend_from_slice(&output[..block_out * 2]);
    }

    let start = delay * 2;
    let end = start + expected_frames * 2;
    let trimmed = &produced[start..end.min(produced.len())];
    let mut out_left = Vec::with_capacity(expected_frames);
    let mut out_right = Vec::with_capacity(expected_frames);
    for frame in trimmed.chunks_exact(2) {
        out_left.push(frame[0]);
        out_right.push(frame[1]);
    }
    Ok(DecodedTrack {
        left: out_left,
        right: out_right,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serialise a 16-bit PCM WAV in memory (hound — the corpus harness dep).
    fn wav_bytes(rate: u32, channels: u16, frames: usize, hz: f64) -> Vec<u8> {
        let spec = hound::WavSpec {
            channels,
            sample_rate: rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut cursor = Cursor::new(Vec::new());
        let mut writer = hound::WavWriter::new(&mut cursor, spec).expect("wav writer");
        for i in 0..frames {
            let sample = ((2.0 * std::f64::consts::PI * hz * i as f64 / rate as f64).sin()
                * 0.5
                * i16::MAX as f64) as i16;
            for _ in 0..channels {
                writer.write_sample(sample).expect("wav sample");
            }
        }
        writer.finalize().expect("wav finalize");
        cursor.into_inner()
    }

    #[test]
    fn decodes_a_48k_wav_without_resampling() {
        let frames = 48_000;
        let bytes = wav_bytes(48_000, 2, frames, 440.0);
        let decoded = decode_to_48k(bytes, Some("wav")).expect("decodes");
        assert_eq!(decoded.frames(), frames);
        assert!((decoded.duration_seconds() - 1.0).abs() < 1e-9);
        // Content survived: a 440 Hz half-scale sine has RMS ≈ 0.35.
        let rms = (decoded.left.iter().map(|s| (*s as f64).powi(2)).sum::<f64>()
            / frames as f64)
            .sqrt();
        assert!((rms - 0.35).abs() < 0.02, "rms {rms}");
    }

    #[test]
    fn resamples_a_44100_wav_to_48k() {
        let frames = 44_100 * 2;
        let bytes = wav_bytes(44_100, 2, frames, 440.0);
        let decoded = decode_to_48k(bytes, Some("wav")).expect("decodes");
        // 2 s of audio at the target rate, to the frame.
        assert_eq!(decoded.frames(), 96_000);
        // The tone survives the resample (same RMS, no silence padding drift).
        let mid = &decoded.left[24_000..72_000];
        let rms =
            (mid.iter().map(|s| (*s as f64).powi(2)).sum::<f64>() / mid.len() as f64).sqrt();
        assert!((rms - 0.35).abs() < 0.02, "rms {rms}");
    }

    #[test]
    fn duplicates_a_mono_source_to_both_channels() {
        let bytes = wav_bytes(48_000, 1, 4_800, 220.0);
        let decoded = decode_to_48k(bytes, Some("wav")).expect("decodes");
        assert_eq!(decoded.left, decoded.right);
    }

    #[test]
    #[ignore = "timing diagnostic — run with --ignored --nocapture"]
    fn timing_full_load_pipeline() {
        use std::time::Instant;
        let samples = crate::analysis::beat::fixtures::click_track(128.0, 300.0, 44_100.0, 1);
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 44_100,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut cursor = Cursor::new(Vec::new());
        let mut writer = hound::WavWriter::new(&mut cursor, spec).expect("wav writer");
        for s in &samples {
            let clamped = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
            writer.write_sample(clamped).expect("wav sample");
        }
        writer.finalize().expect("wav finalize");
        let bytes = cursor.into_inner();

        let t = Instant::now();
        let decoded = decode_to_48k(bytes, Some("wav")).expect("decodes");
        eprintln!("decode+resample (5 min @ 44.1k): {:?}", t.elapsed());
        let t = Instant::now();
        let coarse = crate::analysis::beat::track_bpm(&decoded.left, &decoded.right, 48_000.0);
        eprintln!("track_bpm: {:?} -> {coarse:?}", t.elapsed());
        let t = Instant::now();
        let grid =
            crate::analysis::grid::track_beatgrid(&decoded.left, &decoded.right, 48_000.0, coarse);
        eprintln!("beatgrid: {:?} -> {:?}", t.elapsed(), grid.map(|g| g.bpm));
        let t = Instant::now();
        let bands = crate::analysis::bands::track_bands(&decoded.left, &decoded.right, 48_000.0);
        eprintln!("bands: {:?} ({} hops)", t.elapsed(), bands.hops());
        let t = Instant::now();
        let interleaved = decoded.interleaved();
        eprintln!("interleave: {:?} ({} samples)", t.elapsed(), interleaved.len());
    }

    #[test]
    fn refuses_bytes_that_are_not_audio() {
        let err = match decode_to_48k(b"definitely not audio".to_vec(), None) {
            Err(err) => err,
            Ok(_) => panic!("must refuse non-audio bytes"),
        };
        assert!(err.contains("unsupported"), "{err}");
    }
}
