"""Spike: is MRT2 tempo steerable via a bpm hint in the prompt?

Generates audio for the same style at different requested tempos and
estimates the actual tempo with librosa beat tracking. Decides whether the
deck UI ships a BPM control (roadmap M4: "the UI only exposes the tempo
control that actually works").

Run: uv run python scripts/spike_bpm.py
"""

import time

import librosa
import numpy as np

from magenta_rt.mlx import system

REQUESTED_BPMS = [90, 120, 150]
STYLE = "driving techno, four on the floor"
SECONDS = 16
TOLERANCE = 0.12  # accept within ±12%, allowing half/double-time confusion


def estimated_tempo(samples: np.ndarray, sample_rate: int) -> float:
    mono = samples.mean(axis=1)
    tempo, _ = librosa.beat.beat_track(y=mono, sr=sample_rate)
    return float(np.atleast_1d(tempo)[0])


def tracks(requested: float, estimate: float) -> bool:
    for factor in (0.5, 1.0, 2.0):  # beat trackers love octave errors
        if abs(estimate * factor - requested) / requested <= TOLERANCE:
            return True
    return False


print("Loading mrt2_small ...")
mrt = system.MagentaRT2SystemMlxfn(size="mrt2_small")

results = []
for bpm in REQUESTED_BPMS:
    prompt = f"{STYLE}, {bpm} bpm"
    emb = mrt.embed_style(prompt)
    t0 = time.time()
    wav, _ = mrt.generate(style=emb, frames=int(SECONDS / 0.04), state=None)
    estimate = estimated_tempo(wav.samples, wav.sample_rate)
    ok = tracks(bpm, estimate)
    results.append(ok)
    print(
        f"requested {bpm:>3} bpm → estimated {estimate:6.1f} bpm "
        f"({'tracks' if ok else 'DOES NOT track'}) [{time.time() - t0:.0f}s gen]"
    )

passed = sum(results)
print(
    f"\n{passed}/{len(results)} requested tempos tracked (±{TOLERANCE:.0%}, octave-tolerant)"
)
print(
    "VERDICT:",
    "STEERABLE — ship the BPM hint control"
    if passed == len(results)
    else "PARTIAL/UNRELIABLE — "
    + ("ship as best-effort hint" if passed >= 2 else "do not ship a BPM control"),
)
