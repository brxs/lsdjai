"""Spike corpus for M14: is generative output beat-trackable?

Generates a style matrix from clearly rhythmic to deliberately
beatless, writes each as a WAV plus a manifest with a librosa
reference tempo. The frontend's SHIPPING estimator is then run over
exactly these files by `frontend/src/audio/beatCorpus.test.js` — the
measurement that sets (or kills) the M14 confidence gate, recorded in
docs/spike-beat-detection.md.

Generation from the exported .mlxfn is deterministic (spike-bpm.md
round 3), so the corpus is reproducible.

Run: uv run python scripts/spike_beat_corpus.py
"""

import json
import wave
from pathlib import Path

import librosa
import numpy as np

from magenta_rt.mlx import system

SECONDS = 24
OUT_DIR = Path(__file__).resolve().parent.parent / "spike_corpus"

# (slug, prompt, expectation) — "rhythmic" entries must yield a stable
# estimate for M14 to ship, "beatless" must yield none, "ambiguous"
# may yield either (the generated triphop clip's own librosa tempogram
# has no candidate above ~0.43 — weakly rhythmic source material).
STYLES = [
    ("techno", "driving techno, four on the floor", "rhythmic"),
    ("house", "deep house groove, steady kick", "rhythmic"),
    ("dnb", "drum and bass, fast breakbeats", "rhythmic"),
    ("hiphop", "hip hop boom bap, heavy drums", "rhythmic"),
    ("garage", "uk garage shuffle, swung drums", "rhythmic"),
    ("dub", "dub reggae, slow heavy groove", "rhythmic"),
    ("triphop", "downtempo trip hop, dusty drums", "ambiguous"),
    ("ambient", "ambient drone, soft pads, no drums", "beatless"),
    ("soundscape", "generative ambient soundscape, evolving textures", "beatless"),
    ("piano", "solo piano ballad, rubato, expressive", "beatless"),
]


def write_wav(path: Path, samples: np.ndarray, sample_rate: int) -> None:
    clipped = np.clip(samples, -1.0, 1.0)
    pcm = (clipped * 32767).astype("<i2")
    with wave.open(str(path), "wb") as out:
        out.setnchannels(samples.shape[1])
        out.setsampwidth(2)
        out.setframerate(sample_rate)
        out.writeframes(pcm.tobytes())


def reference_tempo(samples: np.ndarray, sample_rate: int) -> float:
    mono = samples.mean(axis=1)
    tempo, _ = librosa.beat.beat_track(y=mono, sr=sample_rate)
    return float(np.atleast_1d(tempo)[0])


def main() -> None:
    OUT_DIR.mkdir(exist_ok=True)
    print("Loading mrt2_small ...")
    mrt = system.MagentaRT2SystemMlxfn(size="mrt2_small")

    manifest = []
    for slug, prompt, expect in STYLES:
        print(f"generating {slug}: {prompt!r} ...")
        embedding = mrt.embed_style(prompt)
        wav, _ = mrt.generate(style=embedding, frames=int(SECONDS / 0.04), state=None)
        path = OUT_DIR / f"{slug}.wav"
        write_wav(path, wav.samples, wav.sample_rate)
        reference = reference_tempo(wav.samples, wav.sample_rate)
        manifest.append(
            {
                "file": path.name,
                "prompt": prompt,
                "expect": expect,
                "librosa_bpm": round(reference, 1),
                "sample_rate": wav.sample_rate,
            }
        )
        print(f"  → {path.name}, librosa reference {reference:.1f} bpm")

    (OUT_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\n{len(manifest)} files in {OUT_DIR}; now run the estimator over")
    print("them:  cd frontend && npx vitest run src/audio/beatCorpus.test.js")


if __name__ == "__main__":
    main()
