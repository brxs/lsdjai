//! Issue 77's corpus measurement: replay the shipping tracker/gate at the live
//! cadence and report correctness, acquisition, and tempo-change recovery.
//!
//! This stays test-only so `hound` remains a dev dependency. The runner uses
//! the real [`BeatTracker`] and [`BeatGate`], never a measurement-only clone.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::beat::{BeatEstimate, BeatGate, BeatTracker, GATE_MIN_CONFIDENCE};

const CORPUS_SCHEMA_VERSION: u32 = 2;
const STREAM_CHUNK_SECONDS: f64 = 0.04;
const METRICAL_TOLERANCE: f64 = 0.08;
const METRICAL_LEVELS: [f64; 7] = [0.5, 2.0 / 3.0, 0.75, 1.0, 4.0 / 3.0, 1.5, 2.0];

#[derive(Deserialize)]
struct Manifest {
    schema_version: u32,
    required_coverage: RequiredCoverage,
    entries: Vec<Entry>,
}

#[derive(Deserialize)]
struct RequiredCoverage {
    steady_genre_families: HashMap<String, usize>,
    short_intro_scenarios: usize,
    tempo_change_scenarios: usize,
}

#[derive(Debug, Deserialize)]
struct Entry {
    slug: String,
    file: String,
    tier: String,
    family: String,
    scenario: String,
    expect: String,
    duration_seconds: f64,
    segments: Vec<Segment>,
    rhythm_onset_seconds: Option<f64>,
    change_at_seconds: Option<f64>,
    targets: Option<Targets>,
}

#[derive(Debug, Deserialize)]
struct Segment {
    start_seconds: f64,
    end_seconds: f64,
    expect: String,
    librosa_bpm: f64,
}

#[derive(Debug, Deserialize)]
struct Targets {
    status: String,
    max_first_correct_display_seconds: Option<f64>,
    max_recovery_seconds: Option<f64>,
    max_wrong_display_seconds: Option<u32>,
}

#[derive(Debug, Clone, Copy)]
struct Observation {
    elapsed_seconds: f64,
    estimate: Option<BeatEstimate>,
    displayed: Option<f64>,
}

#[derive(Debug, PartialEq)]
struct Summary {
    total_seconds: u32,
    displayed_seconds: u32,
    correct_display_seconds: u32,
    wrong_display_seconds: u32,
    blank_seconds: u32,
    first_correct_display_seconds: Option<f64>,
    time_to_first_correct_display_seconds: Option<f64>,
    time_to_first_correct_confident_estimate_seconds: Option<f64>,
    raw_recovery_seconds: Option<f64>,
    recovery_seconds: Option<f64>,
    confidence_min: Option<f64>,
    confidence_max: Option<f64>,
    final_bpm: Option<f64>,
}

fn corpus_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../backend/spike_corpus")
}

/// Interleaved stereo f32 from a PCM16 WAV — the live deck wire shape. Mono is
/// accepted defensively and duplicated; the Python verifier requires corpus
/// fixtures themselves to be stereo.
fn read_wav(path: &Path) -> (f64, Vec<f32>) {
    let mut reader = hound::WavReader::open(path).unwrap_or_else(|error| {
        let lfs_hint = std::fs::read(path)
            .ok()
            .filter(|bytes| bytes.starts_with(b"version https://git-lfs"))
            .map_or("", |_| "; Git LFS pointer found, run `git lfs pull`");
        panic!("{}: {error}{lfs_hint}", path.display())
    });
    let spec = reader.spec();
    assert_eq!(spec.bits_per_sample, 16, "{}: not 16-bit", path.display());
    assert_eq!(
        spec.sample_format,
        hound::SampleFormat::Int,
        "{}: not PCM",
        path.display()
    );
    let raw: Vec<i16> = reader
        .samples::<i16>()
        .collect::<Result<_, _>>()
        .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    let channels = spec.channels as usize;
    let frames = raw.len() / channels;
    let mut samples = vec![0.0f32; frames * 2];
    for frame in 0..frames {
        let left = (raw[frame * channels] as f64 / 32768.0) as f32;
        let right = if channels > 1 {
            (raw[frame * channels + 1] as f64 / 32768.0) as f32
        } else {
            left
        };
        samples[2 * frame] = left;
        samples[2 * frame + 1] = right;
    }
    (spec.sample_rate as f64, samples)
}

fn metrically_matches(estimate: f64, reference: f64) -> bool {
    METRICAL_LEVELS
        .iter()
        .any(|factor| (estimate * factor - reference).abs() / reference <= METRICAL_TOLERANCE)
}

/// A tick at exactly a scenario boundary has heard audio only up to that
/// boundary, so it belongs to the segment that just ended. The next tick is
/// the first one that has actually consumed the new segment.
fn segment_at(entry: &Entry, elapsed_seconds: f64) -> &Segment {
    entry
        .segments
        .iter()
        .find(|segment| {
            elapsed_seconds > segment.start_seconds && elapsed_seconds <= segment.end_seconds
        })
        .unwrap_or_else(|| {
            panic!(
                "{}: no reference segment at {elapsed_seconds:.3}s",
                entry.file
            )
        })
}

fn value_matches_segment(value: f64, segment: &Segment) -> bool {
    segment.expect != "beatless" && metrically_matches(value, segment.librosa_bpm)
}

fn summarize(entry: &Entry, observations: &[Observation]) -> Summary {
    let mut displayed_seconds = 0;
    let mut correct_display_seconds = 0;
    let mut wrong_display_seconds = 0;
    let mut first_correct_display_seconds = None;
    let mut first_correct_confident_estimate_seconds = None;
    let mut raw_recovery_seconds = None;
    let mut recovery_seconds = None;
    let mut confidence_min: Option<f64> = None;
    let mut confidence_max: Option<f64> = None;

    let onset = entry.rhythm_onset_seconds.unwrap_or(0.0);
    for observation in observations {
        let segment = segment_at(entry, observation.elapsed_seconds);
        if let Some(estimate) = observation.estimate {
            confidence_min = Some(
                confidence_min.map_or(estimate.confidence, |value| value.min(estimate.confidence)),
            );
            confidence_max = Some(
                confidence_max.map_or(estimate.confidence, |value| value.max(estimate.confidence)),
            );
            if estimate.confidence >= GATE_MIN_CONFIDENCE
                && value_matches_segment(estimate.bpm, segment)
            {
                if observation.elapsed_seconds > onset {
                    first_correct_confident_estimate_seconds
                        .get_or_insert(observation.elapsed_seconds);
                }
                if let Some(change) = entry.change_at_seconds {
                    if observation.elapsed_seconds > change {
                        raw_recovery_seconds
                            .get_or_insert(observation.elapsed_seconds - change);
                    }
                }
            }
        }
        if let Some(displayed) = observation.displayed {
            displayed_seconds += 1;
            if value_matches_segment(displayed, segment) {
                correct_display_seconds += 1;
                if observation.elapsed_seconds > onset {
                    first_correct_display_seconds.get_or_insert(observation.elapsed_seconds);
                }
                if let Some(change) = entry.change_at_seconds {
                    if observation.elapsed_seconds > change {
                        recovery_seconds.get_or_insert(observation.elapsed_seconds - change);
                    }
                }
            } else {
                wrong_display_seconds += 1;
            }
        }
    }

    let total_seconds = observations.len() as u32;
    Summary {
        total_seconds,
        displayed_seconds,
        correct_display_seconds,
        wrong_display_seconds,
        blank_seconds: total_seconds - displayed_seconds,
        first_correct_display_seconds,
        time_to_first_correct_display_seconds: first_correct_display_seconds
            .map(|seconds| seconds - onset),
        time_to_first_correct_confident_estimate_seconds:
            first_correct_confident_estimate_seconds.map(|seconds| seconds - onset),
        raw_recovery_seconds,
        recovery_seconds,
        confidence_min,
        confidence_max,
        final_bpm: observations.last().and_then(|observation| observation.displayed),
    }
}

fn replay(entry: &Entry, sample_rate: f64, samples: &[f32]) -> Vec<Observation> {
    let mut tracker = BeatTracker::new(sample_rate);
    let mut gate = BeatGate::new();
    let chunk_samples = (STREAM_CHUNK_SECONDS * sample_rate).round() as usize * 2;
    let per_second_samples = sample_rate.round() as usize * 2;
    let mut since_estimate = 0usize;
    let mut elapsed_seconds = 0u32;
    let mut observations = Vec::new();
    let mut start = 0usize;
    while start < samples.len() {
        let end = (start + chunk_samples).min(samples.len());
        tracker.push(&samples[start..end]);
        since_estimate += end - start;
        while since_estimate >= per_second_samples {
            since_estimate -= per_second_samples;
            elapsed_seconds += 1;
            let estimate = tracker.estimate();
            observations.push(Observation {
                elapsed_seconds: f64::from(elapsed_seconds),
                estimate,
                displayed: gate.push(estimate),
            });
        }
        start = end;
    }
    assert_eq!(
        observations.len() as f64,
        entry.duration_seconds.floor(),
        "{}: report cadence does not cover duration",
        entry.file
    );
    observations
}

fn format_optional(value: Option<f64>) -> String {
    value.map_or_else(|| "—".into(), |number| format!("{number:.1}"))
}

fn reference_label(entry: &Entry) -> String {
    entry
        .segments
        .iter()
        .map(|segment| format!("{:.1}", segment.librosa_bpm))
        .collect::<Vec<_>>()
        .join("->")
}

fn assert_legacy(entry: &Entry, observations: &[Observation], summary: &Summary) {
    if entry.tier != "legacy" {
        return;
    }
    for observation in observations {
        if let Some(displayed) = observation.displayed {
            let segment = segment_at(entry, observation.elapsed_seconds);
            assert!(
                value_matches_segment(displayed, segment),
                "{}: legacy clip displayed wrong/beatless BPM {displayed:.1} at {:.0}s",
                entry.file,
                observation.elapsed_seconds
            );
        }
    }
    match entry.expect.as_str() {
        "rhythmic" => assert!(
            summary.final_bpm.is_some(),
            "{}: legacy rhythmic clip stayed blank",
            entry.file
        ),
        "beatless" => assert_eq!(
            summary.displayed_seconds, 0,
            "{}: legacy beatless clip displayed",
            entry.file
        ),
        "ambiguous" => {}
        other => panic!("{}: unknown expectation {other}", entry.file),
    }
}

fn assert_targets(entry: &Entry, summary: &Summary) {
    let Some(targets) = &entry.targets else {
        return;
    };
    assert!(
        matches!(targets.status.as_str(), "proposed" | "approved"),
        "{}: invalid target status {}",
        entry.file,
        targets.status
    );
    if targets.status == "proposed" {
        return;
    }
    if let Some(limit) = targets.max_first_correct_display_seconds {
        let actual = summary
            .time_to_first_correct_display_seconds
            .unwrap_or(f64::INFINITY);
        assert!(
            actual <= limit,
            "{}: acquisition {actual:.1}s exceeds {limit:.1}s",
            entry.file
        );
    }
    if let Some(limit) = targets.max_recovery_seconds {
        let actual = summary.recovery_seconds.unwrap_or(f64::INFINITY);
        assert!(
            actual <= limit,
            "{}: recovery {actual:.1}s exceeds {limit:.1}s",
            entry.file
        );
    }
    if let Some(limit) = targets.max_wrong_display_seconds {
        assert!(
            summary.wrong_display_seconds <= limit,
            "{}: wrong display {}s exceeds {limit}s",
            entry.file,
            summary.wrong_display_seconds
        );
    }
}

fn validate_coverage(manifest: &Manifest) {
    assert_eq!(
        manifest.schema_version, CORPUS_SCHEMA_VERSION,
        "unsupported corpus schema"
    );
    assert!(!manifest.entries.is_empty(), "manifest is empty");
    let mut family_counts: HashMap<&str, usize> = HashMap::new();
    let mut slugs = HashSet::new();
    let mut short_intros = 0;
    let mut tempo_changes = 0;
    for entry in &manifest.entries {
        assert!(slugs.insert(entry.slug.as_str()), "duplicate slug {}", entry.slug);
        if entry.tier == "expanded" && entry.scenario == "steady" {
            *family_counts.entry(entry.family.as_str()).or_default() += 1;
        }
        if entry.scenario == "short_intro" {
            short_intros += 1;
        } else if entry.scenario == "tempo_change" {
            tempo_changes += 1;
            assert_eq!(entry.segments.len(), 2, "{}: change needs two segments", entry.file);
            let first = entry.segments[0].librosa_bpm;
            let second = entry.segments[1].librosa_bpm;
            assert!(
                !metrically_matches(first, second) && !metrically_matches(second, first),
                "{}: change references are metrically equivalent",
                entry.file
            );
        }
    }
    for (family, expected) in &manifest.required_coverage.steady_genre_families {
        assert_eq!(
            family_counts.get(family.as_str()).copied().unwrap_or(0),
            *expected,
            "{family}: wrong steady coverage"
        );
    }
    assert_eq!(
        short_intros, manifest.required_coverage.short_intro_scenarios,
        "wrong short-intro coverage"
    );
    assert_eq!(
        tempo_changes, manifest.required_coverage.tempo_change_scenarios,
        "wrong tempo-change coverage"
    );
}

#[test]
fn the_expanded_spike_corpus_reports_shipping_metrics() {
    let path = corpus_dir().join("manifest.json");
    let manifest: Manifest = serde_json::from_str(
        &std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("{}: {error}; run `git lfs pull`", path.display())),
    )
    .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    validate_coverage(&manifest);

    println!(
        "{:<30} {:<12} {:<13} {:<7} {:<12} {:<6} {:<7} {:<7} {:<7} {:<7} {:<11}",
        "clip",
        "scenario",
        "reference",
        "final",
        "correct/total",
        "wrong",
        "raw",
        "first",
        "raw-rec",
        "recover",
        "confidence"
    );
    for entry in &manifest.entries {
        let wav_path = corpus_dir().join(&entry.file);
        let (sample_rate, samples) = read_wav(&wav_path);
        let observations = replay(entry, sample_rate, &samples);
        let summary = summarize(entry, &observations);
        let confidence = match (summary.confidence_min, summary.confidence_max) {
            (Some(min), Some(max)) => format!("{min:.2}-{max:.2}"),
            _ => "—".into(),
        };
        println!(
            "{:<30} {:<12} {:<13} {:<7} {:>3}/{:<8} {:<6} {:<7} {:<7} {:<7} {:<7} {:<11}",
            entry.file,
            entry.scenario,
            reference_label(entry),
            format_optional(summary.final_bpm),
            summary.correct_display_seconds,
            summary.total_seconds,
            summary.wrong_display_seconds,
            format_optional(summary.time_to_first_correct_confident_estimate_seconds),
            format_optional(summary.time_to_first_correct_display_seconds),
            format_optional(summary.raw_recovery_seconds),
            format_optional(summary.recovery_seconds),
            confidence,
        );
        assert_legacy(entry, &observations, &summary);
        assert_targets(entry, &summary);
    }
}

#[cfg(test)]
mod metric_tests {
    use super::*;

    fn estimate(bpm: f64, confidence: f64) -> Option<BeatEstimate> {
        Some(BeatEstimate {
            bpm,
            confidence,
            anchor_frame: None,
        })
    }

    fn entry(scenario: &str, segments: Vec<Segment>) -> Entry {
        Entry {
            slug: "fixture".into(),
            file: "fixture.wav".into(),
            tier: "expanded".into(),
            family: "fixture".into(),
            scenario: scenario.into(),
            expect: "rhythmic".into(),
            duration_seconds: segments.last().expect("segments").end_seconds,
            rhythm_onset_seconds: (scenario == "short_intro").then_some(2.0),
            change_at_seconds: (scenario == "tempo_change").then_some(3.0),
            segments,
            targets: None,
        }
    }

    fn segment(start: f64, end: f64, expect: &str, bpm: f64) -> Segment {
        Segment {
            start_seconds: start,
            end_seconds: end,
            expect: expect.into(),
            librosa_bpm: bpm,
        }
    }

    fn observation(second: u32, raw: Option<BeatEstimate>, displayed: Option<f64>) -> Observation {
        Observation {
            elapsed_seconds: f64::from(second),
            estimate: raw,
            displayed,
        }
    }

    #[test]
    fn immediate_rhythm_acquires_from_stream_start() {
        let entry = entry("steady", vec![segment(0.0, 3.0, "rhythmic", 120.0)]);
        let observations = vec![
            observation(1, estimate(120.0, 0.5), None),
            observation(2, estimate(120.0, 0.6), Some(120.0)),
            observation(3, estimate(120.0, 0.7), Some(120.0)),
        ];
        let summary = summarize(&entry, &observations);
        assert_eq!(summary.first_correct_display_seconds, Some(2.0));
        assert_eq!(summary.time_to_first_correct_display_seconds, Some(2.0));
        assert_eq!(
            summary.time_to_first_correct_confident_estimate_seconds,
            Some(1.0)
        );
    }

    #[test]
    fn delayed_intro_acquisition_is_relative_to_the_rhythmic_onset() {
        let entry = entry(
            "short_intro",
            vec![
                segment(0.0, 2.0, "beatless", 150.0),
                segment(2.0, 5.0, "rhythmic", 120.0),
            ],
        );
        let observations = vec![
            observation(1, None, None),
            observation(2, None, None),
            observation(3, estimate(120.0, 0.5), None),
            observation(4, estimate(120.0, 0.6), Some(120.0)),
            observation(5, estimate(120.0, 0.7), Some(120.0)),
        ];
        let summary = summarize(&entry, &observations);
        assert_eq!(summary.first_correct_display_seconds, Some(4.0));
        assert_eq!(summary.time_to_first_correct_display_seconds, Some(2.0));
    }

    #[test]
    fn tempo_change_recovery_starts_after_the_boundary_and_counts_stale_display() {
        let entry = entry(
            "tempo_change",
            vec![
                segment(0.0, 3.0, "rhythmic", 120.0),
                segment(3.0, 7.0, "rhythmic", 140.0),
            ],
        );
        let observations = vec![
            observation(1, estimate(120.0, 0.5), Some(120.0)),
            observation(2, estimate(120.0, 0.5), Some(120.0)),
            observation(3, estimate(120.0, 0.5), Some(120.0)),
            observation(4, estimate(120.0, 0.5), Some(120.0)),
            observation(5, estimate(140.0, 0.5), None),
            observation(6, estimate(140.0, 0.5), Some(140.0)),
            observation(7, estimate(140.0, 0.5), Some(140.0)),
        ];
        let summary = summarize(&entry, &observations);
        assert_eq!(summary.recovery_seconds, Some(3.0));
        assert_eq!(summary.raw_recovery_seconds, Some(2.0));
        assert_eq!(summary.wrong_display_seconds, 1);
    }

    #[test]
    fn never_acquired_is_reported_as_absent() {
        let entry = entry("steady", vec![segment(0.0, 3.0, "rhythmic", 120.0)]);
        let observations = vec![
            observation(1, estimate(120.0, 0.2), None),
            observation(2, estimate(120.0, 0.3), None),
            observation(3, estimate(120.0, 0.2), None),
        ];
        let summary = summarize(&entry, &observations);
        assert_eq!(summary.time_to_first_correct_display_seconds, None);
        assert_eq!(summary.recovery_seconds, None);
        assert_eq!(summary.blank_seconds, 3);
    }

    #[test]
    fn a_display_on_beatless_material_is_wrong() {
        let entry = entry("steady", vec![segment(0.0, 2.0, "beatless", 150.0)]);
        let observations = vec![
            observation(1, estimate(150.0, 0.5), Some(150.0)),
            observation(2, estimate(150.0, 0.2), None),
        ];
        let summary = summarize(&entry, &observations);
        assert_eq!(summary.wrong_display_seconds, 1);
        assert_eq!(summary.correct_display_seconds, 0);
    }
}
