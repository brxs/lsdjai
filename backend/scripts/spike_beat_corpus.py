"""Generate or verify the deterministic beat-estimator corpus (M14 / issue 77).

The committed PCM16 WAVs are the contract exercised by the shipping Rust
estimator. Generation is model-loaded and explicit; verification is model-free:

    uv run python scripts/spike_beat_corpus.py --generate
    uv run python scripts/spike_beat_corpus.py --verify

`mrt2_small` generation is deterministic for a fixed prompt and package/model
version (docs/spike-bpm.md, round 3). Derived intro/change scenarios use fixed
PCM slices and hard boundaries, so they are deterministic too.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import tempfile
import wave
from dataclasses import dataclass
from importlib.metadata import version
from pathlib import Path
from typing import Any

CORPUS_SCHEMA_VERSION = 2
GENERATION_SECONDS = 24
FRAME_SECONDS = 0.04
GENERATION_FRAMES = int(GENERATION_SECONDS / FRAME_SECONDS)
SAMPLE_RATE = 48_000
CHANNELS = 2
SAMPLE_WIDTH = 2
OUT_DIR = Path(__file__).resolve().parent.parent / "spike_corpus"
MANIFEST_PATH = OUT_DIR / "manifest.json"

# These are the exact M14 fixtures measured in docs/spike-beat-detection.md.
# Unlike generated manifest hashes, this independent lock prevents a package or
# model change from silently blessing a different legacy regression corpus.
LEGACY_SHA256 = {
    "ambient.wav": "543ab136f625fed5497e63e644dd9d1dbc93556c4bc35245ccb889f8182cd785",
    "dnb.wav": "35e96881cce25e834725c58d2b5c4bd1f8f4e67a2f8edf64fa579fb7f099d611",
    "dub.wav": "6eb5a10124c15fb2c7ead49771e7895503d24fe1a16731e5f9115db509877609",
    "garage.wav": "93c5a8e68b92a685e86b764db533cfcdd4337c189ce736bfc18bb17f138c7993",
    "hiphop.wav": "3280c1d15402e89f6012b317f93e4e70495b0c0087888c30031107f43a40b30a",
    "house.wav": "0bc66663b3f812c00794a6776bdd826d9f383f5531d36c3bb13a56ee35594ae3",
    "piano.wav": "f809db84a13ef9d0ecdac40698c5bc7ae659c9a917e2a47f86c9b9b859249019",
    "soundscape.wav": "09f4d3946046695d404515cd2e44c44f7e51f1ecba391ad67376f44d6285648b",
    "techno.wav": "d28018860c836c56113b1282267f25bd2228d7fc209b3d167beddeb9b14f0013",
    "triphop.wav": "3eb7cf58a12e49c2682cbb0a2f31f002165cfad9a68a3e9b7c5009fdc8858288",
}

# Librosa 0.11.0 references from the original M14 manifest. Beatless values are
# intentionally kept too: they document that a reference tool will happily
# invent a tempo for a drone, while the shipping honesty gate stays blank.
LEGACY_BPM = {
    "techno": 130.8,
    "house": 119.7,
    "dnb": 89.3,
    "hiphop": 95.3,
    "garage": 133.9,
    "dub": 140.6,
    "triphop": 45.0,
    "ambient": 160.7,
    "soundscape": 119.7,
    "piano": 74.0,
}


@dataclass(frozen=True)
class Style:
    slug: str
    prompt: str
    expect: str
    tier: str
    family: str


LEGACY_STYLES = (
    Style(
        "techno", "driving techno, four on the floor", "rhythmic", "legacy", "legacy"
    ),
    Style("house", "deep house groove, steady kick", "rhythmic", "legacy", "legacy"),
    Style("dnb", "drum and bass, fast breakbeats", "rhythmic", "legacy", "legacy"),
    Style("hiphop", "hip hop boom bap, heavy drums", "rhythmic", "legacy", "legacy"),
    Style("garage", "uk garage shuffle, swung drums", "rhythmic", "legacy", "legacy"),
    Style("dub", "dub reggae, slow heavy groove", "rhythmic", "legacy", "legacy"),
    Style(
        "triphop", "downtempo trip hop, dusty drums", "ambiguous", "legacy", "legacy"
    ),
    Style(
        "ambient", "ambient drone, soft pads, no drums", "beatless", "legacy", "legacy"
    ),
    Style(
        "soundscape",
        "generative ambient soundscape, evolving textures",
        "beatless",
        "legacy",
        "legacy",
    ),
    Style(
        "piano", "solo piano ballad, rubato, expressive", "beatless", "legacy", "legacy"
    ),
)

# Owner-approved coverage: exactly two independent clips per named family.
EXPANDED_STYLES = (
    Style(
        "jungle_amen",
        "jungle, chopped amen break, fast syncopated drums",
        "rhythmic",
        "expanded",
        "breakbeat_jungle",
    ),
    Style(
        "jungle_rolling",
        "dark jungle, rolling breakbeats, sub bass",
        "rhythmic",
        "expanded",
        "breakbeat_jungle",
    ),
    Style(
        "swung_house",
        "swung house groove, shuffled drums",
        "rhythmic",
        "expanded",
        "swung_garage",
    ),
    Style(
        "garage_two_step",
        "UK 2-step garage, syncopated kick, swung hi-hats",
        "rhythmic",
        "expanded",
        "swung_garage",
    ),
    Style(
        "minimal_percussion",
        "minimal techno, sparse kick and percussion",
        "rhythmic",
        "expanded",
        "sparse_minimal",
    ),
    Style(
        "sparse_dub",
        "sparse dub percussion, deep bass, lots of space",
        "rhythmic",
        "expanded",
        "sparse_minimal",
    ),
)

REQUIRED_FAMILIES = {
    "breakbeat_jungle": 2,
    "swung_garage": 2,
    "sparse_minimal": 2,
}

SCENARIOS = (
    {
        "slug": "intro_jungle_amen",
        "kind": "short_intro",
        "family": "breakbeat_jungle",
        "parts": (("ambient", 0.0, 4.0), ("jungle_amen", 0.0, 24.0)),
        "rhythm_onset_seconds": 4.0,
    },
    {
        "slug": "intro_minimal_percussion",
        "kind": "short_intro",
        "family": "sparse_minimal",
        "parts": (("soundscape", 0.0, 2.0), ("minimal_percussion", 0.0, 24.0)),
        "rhythm_onset_seconds": 2.0,
    },
    {
        "slug": "tempo_house_to_dub",
        "kind": "tempo_change",
        "family": "tempo_change",
        "parts": (("house", 0.0, 24.0), ("dub", 0.0, 24.0)),
        "change_at_seconds": 24.0,
    },
    {
        "slug": "tempo_dub_to_house",
        "kind": "tempo_change",
        "family": "tempo_change",
        "parts": (("dub", 0.0, 24.0), ("house", 0.0, 24.0)),
        "change_at_seconds": 24.0,
    },
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def wav_metadata(path: Path) -> dict[str, int | float]:
    try:
        with wave.open(str(path), "rb") as source:
            channels = source.getnchannels()
            sample_width = source.getsampwidth()
            sample_rate = source.getframerate()
            frames = source.getnframes()
            compression = source.getcomptype()
    except (EOFError, wave.Error) as exc:
        if path.read_bytes()[:64].startswith(b"version https://git-lfs"):
            raise ValueError(
                f"{path}: Git LFS object is not fetched; run `git lfs pull`"
            ) from exc
        raise ValueError(f"{path}: invalid WAV: {exc}") from exc
    if compression != "NONE":
        raise ValueError(f"{path}: expected uncompressed PCM, got {compression}")
    return {
        "sample_rate": sample_rate,
        "channels": channels,
        "bits_per_sample": sample_width * 8,
        "frames": frames,
        "duration_seconds": frames / sample_rate,
    }


def read_pcm(path: Path) -> tuple[bytes, dict[str, int | float]]:
    metadata = wav_metadata(path)
    with wave.open(str(path), "rb") as source:
        pcm = source.readframes(source.getnframes())
    return pcm, metadata


def write_generated_wav(path: Path, samples: Any, sample_rate: int) -> None:
    import numpy as np

    if samples.ndim != 2 or samples.shape[1] != CHANNELS:
        raise ValueError(
            f"{path.name}: generated shape {samples.shape}, expected stereo"
        )
    clipped = np.clip(samples, -1.0, 1.0)
    pcm = (clipped * 32767).astype("<i2")
    with wave.open(str(path), "wb") as out:
        out.setnchannels(CHANNELS)
        out.setsampwidth(SAMPLE_WIDTH)
        out.setframerate(sample_rate)
        out.writeframes(pcm.tobytes())


def write_composed_wav(
    path: Path, source_dir: Path, parts: tuple[tuple[str, float, float], ...]
) -> None:
    chunks: list[bytes] = []
    for slug, start_seconds, duration_seconds in parts:
        pcm, metadata = read_pcm(source_dir / f"{slug}.wav")
        if (
            metadata["sample_rate"] != SAMPLE_RATE
            or metadata["channels"] != CHANNELS
            or metadata["bits_per_sample"] != SAMPLE_WIDTH * 8
        ):
            raise ValueError(
                f"{slug}.wav: scenario source format differs from corpus format"
            )
        bytes_per_frame = CHANNELS * SAMPLE_WIDTH
        start = round(start_seconds * SAMPLE_RATE) * bytes_per_frame
        end = start + round(duration_seconds * SAMPLE_RATE) * bytes_per_frame
        if end > len(pcm):
            raise ValueError(f"{slug}.wav: scenario slice exceeds source")
        chunks.append(pcm[start:end])
    with wave.open(str(path), "wb") as out:
        out.setnchannels(CHANNELS)
        out.setsampwidth(SAMPLE_WIDTH)
        out.setframerate(SAMPLE_RATE)
        out.writeframes(b"".join(chunks))


def reference_tempo(path: Path) -> float:
    import librosa
    import numpy as np

    pcm, metadata = read_pcm(path)
    samples = np.frombuffer(pcm, dtype="<i2").reshape(-1, CHANNELS)
    mono = samples.astype(np.float32).mean(axis=1) / 32768.0
    tempo, _ = librosa.beat.beat_track(y=mono, sr=int(metadata["sample_rate"]))
    return round(float(np.atleast_1d(tempo)[0]), 1)


def entry_for_style(style: Style, path: Path, bpm: float) -> dict[str, Any]:
    metadata = wav_metadata(path)
    duration = float(metadata["duration_seconds"])
    return {
        "slug": style.slug,
        "file": path.name,
        "tier": style.tier,
        "family": style.family,
        "scenario": "steady",
        "prompt": style.prompt,
        "expect": style.expect,
        **metadata,
        "sha256": sha256(path),
        "segments": [
            {
                "start_seconds": 0.0,
                "end_seconds": duration,
                "expect": style.expect,
                "librosa_bpm": bpm,
            }
        ],
        "targets": None,
        "recipe": {
            "kind": "mrt2_generate",
            "frames": GENERATION_FRAMES,
        },
    }


def entry_for_scenario(
    scenario: dict[str, Any],
    path: Path,
    steady_entries: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    metadata = wav_metadata(path)
    cursor = 0.0
    segments = []
    sources = []
    for slug, start_seconds, duration_seconds in scenario["parts"]:
        source = steady_entries[slug]
        source_segment = source["segments"][0]
        segments.append(
            {
                "start_seconds": cursor,
                "end_seconds": cursor + duration_seconds,
                "expect": source_segment["expect"],
                "librosa_bpm": source_segment["librosa_bpm"],
            }
        )
        sources.append(
            {
                "slug": slug,
                "start_seconds": start_seconds,
                "duration_seconds": duration_seconds,
            }
        )
        cursor += duration_seconds
    entry = {
        "slug": scenario["slug"],
        "file": path.name,
        "tier": "expanded",
        "family": scenario["family"],
        "scenario": scenario["kind"],
        "prompt": None,
        "expect": "rhythmic",
        **metadata,
        "sha256": sha256(path),
        "segments": segments,
        "targets": None,
        "recipe": {
            "kind": "pcm_concatenate",
            "boundary": "hard",
            "sources": sources,
        },
    }
    if scenario["kind"] == "short_intro":
        entry["rhythm_onset_seconds"] = scenario["rhythm_onset_seconds"]
    else:
        entry["change_at_seconds"] = scenario["change_at_seconds"]
    return entry


def load_locked_hashes() -> dict[str, str]:
    if not MANIFEST_PATH.exists():
        return {}
    try:
        manifest = json.loads(MANIFEST_PATH.read_text())
    except json.JSONDecodeError:
        return {}
    if (
        not isinstance(manifest, dict)
        or manifest.get("schema_version") != CORPUS_SCHEMA_VERSION
    ):
        return {}
    return {entry["file"]: entry["sha256"] for entry in manifest.get("entries", [])}


def build_manifest(staging: Path) -> dict[str, Any]:
    from magenta_rt.mlx import system

    print("Loading mrt2_small ...")
    mrt = system.MagentaRT2SystemMlxfn(size="mrt2_small")
    entries: list[dict[str, Any]] = []
    steady_entries: dict[str, dict[str, Any]] = {}
    for style in LEGACY_STYLES + EXPANDED_STYLES:
        print(f"generating {style.slug}: {style.prompt!r} ...")
        embedding = mrt.embed_style(style.prompt)
        wav, _ = mrt.generate(style=embedding, frames=GENERATION_FRAMES, state=None)
        path = staging / f"{style.slug}.wav"
        write_generated_wav(path, wav.samples, wav.sample_rate)
        measured_bpm = reference_tempo(path)
        bpm = LEGACY_BPM.get(style.slug, measured_bpm)
        entry = entry_for_style(style, path, bpm)
        entries.append(entry)
        steady_entries[style.slug] = entry
        suffix = " (locked M14 value)" if style.slug in LEGACY_BPM else ""
        print(f"  -> {path.name}, librosa reference {bpm:.1f} bpm{suffix}")

    for scenario in SCENARIOS:
        path = staging / f"{scenario['slug']}.wav"
        write_composed_wav(path, staging, scenario["parts"])
        entry = entry_for_scenario(scenario, path, steady_entries)
        entries.append(entry)
        print(f"composed {path.name}")

    return {
        "schema_version": CORPUS_SCHEMA_VERSION,
        "provenance": {
            "generator": "backend/scripts/spike_beat_corpus.py",
            "command": "uv run python scripts/spike_beat_corpus.py --generate",
            "model": "mrt2_small",
            "magenta_rt_version": version("magenta-rt"),
            "librosa_version": version("librosa"),
            "generation_seconds": GENERATION_SECONDS,
            "generation_frames": GENERATION_FRAMES,
            "generation_frame_seconds": FRAME_SECONDS,
            "stream_chunk_seconds": FRAME_SECONDS,
            "estimate_interval_seconds": 1.0,
            "sample_rate": SAMPLE_RATE,
            "channels": CHANNELS,
            "bits_per_sample": SAMPLE_WIDTH * 8,
        },
        "required_coverage": {
            "steady_genre_families": REQUIRED_FAMILIES,
            "short_intro_scenarios": 2,
            "tempo_change_scenarios": 2,
        },
        "entries": entries,
    }


def generate() -> None:
    locked_hashes = load_locked_hashes()
    with tempfile.TemporaryDirectory(prefix="beat-corpus-", dir=OUT_DIR.parent) as temp:
        staging = Path(temp)
        manifest = build_manifest(staging)
        generated_hashes = {
            entry["file"]: entry["sha256"] for entry in manifest["entries"]
        }
        for file, expected in LEGACY_SHA256.items():
            actual = generated_hashes.get(file)
            if actual != expected:
                raise RuntimeError(
                    f"legacy corpus drift for {file}: expected {expected}, generated {actual}"
                )
        for file, expected in locked_hashes.items():
            actual = generated_hashes.get(file)
            if actual != expected:
                raise RuntimeError(
                    f"locked corpus drift for {file}: expected {expected}, generated {actual}"
                )

        OUT_DIR.mkdir(exist_ok=True)
        keep = {entry["file"] for entry in manifest["entries"]} | {"manifest.json"}
        for old in OUT_DIR.iterdir():
            if old.is_file() and old.name not in keep:
                old.unlink()
        for source in staging.glob("*.wav"):
            shutil.copyfile(source, OUT_DIR / source.name)
        MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n")

    verify()
    print(f"\n{len(manifest['entries'])} locked clips in {OUT_DIR}")


def validate_manifest(manifest: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if manifest.get("schema_version") != CORPUS_SCHEMA_VERSION:
        errors.append(f"schema_version must be {CORPUS_SCHEMA_VERSION}")
    entries = manifest.get("entries")
    if not isinstance(entries, list) or not entries:
        return errors + ["entries must be a non-empty array"]

    slugs: set[str] = set()
    files: set[str] = set()
    family_counts = {family: 0 for family in REQUIRED_FAMILIES}
    scenario_counts = {"short_intro": 0, "tempo_change": 0}
    legacy_count = 0
    for entry in entries:
        slug = entry.get("slug")
        file = entry.get("file")
        label = slug or file or "<unnamed>"
        if not isinstance(slug, str) or not slug:
            errors.append(f"{label}: missing slug")
        elif slug in slugs:
            errors.append(f"{label}: duplicate slug")
        else:
            slugs.add(slug)
        if not isinstance(file, str) or Path(file).name != file:
            errors.append(f"{label}: invalid file")
            continue
        if file in files:
            errors.append(f"{label}: duplicate file")
        files.add(file)

        path = OUT_DIR / file
        if not path.exists():
            errors.append(f"{label}: missing {file}")
            continue
        try:
            metadata = wav_metadata(path)
        except ValueError as exc:
            errors.append(str(exc))
            continue
        for key in ("sample_rate", "channels", "bits_per_sample", "frames"):
            if entry.get(key) != metadata[key]:
                errors.append(
                    f"{label}: {key} manifest={entry.get(key)} actual={metadata[key]}"
                )
        if abs(
            float(entry.get("duration_seconds", -1))
            - float(metadata["duration_seconds"])
        ) > (1 / SAMPLE_RATE):
            errors.append(f"{label}: duration does not match WAV")
        actual_hash = sha256(path)
        if entry.get("sha256") != actual_hash:
            errors.append(
                f"{label}: sha256 manifest={entry.get('sha256')} actual={actual_hash}"
            )

        expect = entry.get("expect")
        if expect not in {"rhythmic", "beatless", "ambiguous"}:
            errors.append(f"{label}: invalid expect {expect!r}")
        tier = entry.get("tier")
        if tier == "legacy":
            legacy_count += 1
            locked = LEGACY_SHA256.get(file)
            if locked != actual_hash:
                errors.append(f"{label}: legacy hash differs from independent lock")
        elif tier != "expanded":
            errors.append(f"{label}: invalid tier {tier!r}")

        scenario = entry.get("scenario")
        if scenario not in {"steady", "short_intro", "tempo_change"}:
            errors.append(f"{label}: invalid scenario {scenario!r}")
        elif scenario in scenario_counts:
            scenario_counts[scenario] += 1
        family = entry.get("family")
        if tier == "expanded" and scenario == "steady" and family in family_counts:
            family_counts[family] += 1

        segments = entry.get("segments")
        if not isinstance(segments, list) or not segments:
            errors.append(f"{label}: segments must be non-empty")
            continue
        cursor = 0.0
        for index, segment in enumerate(segments):
            start = segment.get("start_seconds")
            end = segment.get("end_seconds")
            if not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
                errors.append(f"{label}: segment {index} has invalid bounds")
                continue
            if abs(float(start) - cursor) > (1 / SAMPLE_RATE) or end <= start:
                errors.append(
                    f"{label}: segment {index} is overlapping, gapped, or empty"
                )
            cursor = float(end)
            segment_expect = segment.get("expect")
            bpm = segment.get("librosa_bpm")
            if segment_expect not in {"rhythmic", "beatless", "ambiguous"}:
                errors.append(f"{label}: segment {index} has invalid expectation")
            if not isinstance(bpm, (int, float)) or bpm <= 0:
                errors.append(f"{label}: segment {index} has invalid librosa_bpm")
        if abs(cursor - float(metadata["duration_seconds"])) > (1 / SAMPLE_RATE):
            errors.append(f"{label}: segments do not cover the WAV")
        if scenario == "steady" and len(segments) != 1:
            errors.append(f"{label}: steady clips require one segment")
        if scenario == "short_intro":
            onset = entry.get("rhythm_onset_seconds")
            if len(segments) != 2 or onset != segments[1].get("start_seconds"):
                errors.append(f"{label}: short intro boundary does not match segment 2")
        if scenario == "tempo_change":
            change = entry.get("change_at_seconds")
            if len(segments) != 2 or change != segments[1].get("start_seconds"):
                errors.append(
                    f"{label}: tempo change boundary does not match segment 2"
                )

    if legacy_count != len(LEGACY_STYLES):
        errors.append(
            f"legacy tier has {legacy_count} entries, expected {len(LEGACY_STYLES)}"
        )
    for family, expected in REQUIRED_FAMILIES.items():
        if family_counts[family] != expected:
            errors.append(
                f"{family} has {family_counts[family]} steady clips, expected {expected}"
            )
    for scenario, expected in scenario_counts.items():
        if expected != 2:
            errors.append(f"{scenario} has {expected} clips, expected 2")
    return errors


def verify() -> None:
    if not MANIFEST_PATH.exists():
        raise SystemExit(f"missing {MANIFEST_PATH}; run with --generate")
    try:
        manifest = json.loads(MANIFEST_PATH.read_text())
    except json.JSONDecodeError as exc:
        raise SystemExit(f"invalid {MANIFEST_PATH}: {exc}") from exc
    if not isinstance(manifest, dict):
        raise SystemExit(f"{MANIFEST_PATH}: expected a JSON object")
    errors = validate_manifest(manifest)
    if errors:
        raise SystemExit("corpus verification failed:\n- " + "\n- ".join(errors))
    total_bytes = sum(
        (OUT_DIR / entry["file"]).stat().st_size for entry in manifest["entries"]
    )
    print(
        f"verified {len(manifest['entries'])} clips ({total_bytes / 1024 / 1024:.1f} MiB)"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--generate", action="store_true", help="regenerate with installed MRT2"
    )
    mode.add_argument(
        "--verify", action="store_true", help="verify committed files without MRT2"
    )
    args = parser.parse_args()
    if args.generate:
        generate()
    else:
        verify()


if __name__ == "__main__":
    main()
