"""Spike: does MRT2 lock to an injected beat clock ("MIDI heartbeat")?

The exported model takes per-frame drums conditioning (1 = a drum hits in
this 40 ms frame) with its own CFG scale. We drive it with a pulse train at
the target tempo — a click track in conditioning space — and beat-track the
output. Compare with docs/spike-bpm.md, where text hints only partially
steered tempo.

Frames are 40 ms, so representable tempos are 1500/k bpm for an integer
frame period k. Uses the exported-function args directly (same pattern as
the upstream AU plugin) so per-frame conditioning doesn't re-tokenize the
style every frame.

Run: uv run python scripts/spike_midi_clock.py
"""

import time

import librosa
import mlx.core as mx
import numpy as np

from magenta_rt.mlx import system

STYLE = "driving techno, four on the floor"
SECONDS = 16
FRAME_SECONDS = 0.04
CFG_DRUMS = 4.0
# Frame periods and the tempos they encode (1500/k); includes ~88 bpm where
# the text hint failed.
PERIODS = {10: 150.0, 12: 125.0, 15: 100.0, 17: 88.2}
TOLERANCE = 0.08


def estimated_tempo(samples: np.ndarray, sample_rate: int) -> float:
    mono = samples.mean(axis=1)
    tempo, _ = librosa.beat.beat_track(y=mono, sr=sample_rate)
    return float(np.atleast_1d(tempo)[0])


def clock_alignment(samples: np.ndarray, sample_rate: int, period_s: float) -> float:
    """Mean onset strength at clock ticks over the global mean (>1 means
    onsets concentrate on the injected beat)."""
    mono = samples.mean(axis=1)
    onset = librosa.onset.onset_strength(y=mono, sr=sample_rate)
    times = librosa.times_like(onset, sr=sample_rate)
    tick_strengths = []
    tick = 0.0
    while tick < times[-1]:
        tick_strengths.append(onset[np.argmin(np.abs(times - tick))])
        tick += period_s
    return float(np.mean(tick_strengths) / (np.mean(onset) + 1e-9))


def tracks(requested: float, estimate: float) -> bool:
    return any(
        abs(estimate * factor - requested) / requested <= TOLERANCE
        for factor in (0.5, 1.0, 2.0)
    )


print("Loading mrt2_small ...")
mrt = system.MagentaRT2SystemMlxfn(size="mrt2_small")
embedding = mrt.embed_style(STYLE)
style_tokens = mrt.tokenize_style(embedding).tolist()[:12]

total_frames = int(SECONDS / FRAME_SECONDS)
results = []
for period, bpm in PERIODS.items():
    args_on = mrt._build_mlxfn_args(style_tokens, drums=[1], cfg_drums=CFG_DRUMS)
    args_off = mrt._build_mlxfn_args(style_tokens, drums=[0], cfg_drums=CFG_DRUMS)
    state = list(mrt._initial_state)
    chunks = []
    t0 = time.time()
    for index in range(total_frames):
        args = args_on if index % period == 0 else args_off
        outputs = mrt._fn(args + state)
        mx.eval(outputs)
        chunks.append(np.array(outputs[0]))
        state = list(outputs[1:])
    samples = (np.concatenate(chunks, axis=-1)[0].T).astype(np.float32) / 32768.0

    estimate = estimated_tempo(samples, mrt._sample_rate)
    alignment = clock_alignment(samples, mrt._sample_rate, period * FRAME_SECONDS)
    ok = tracks(bpm, estimate)
    results.append(ok)
    print(
        f"clock {bpm:6.1f} bpm (k={period:>2}) → estimated {estimate:6.1f} bpm "
        f"({'LOCKS' if ok else 'does not lock'}), "
        f"beat alignment {alignment:.2f}x [{time.time() - t0:.0f}s gen]"
    )

passed = sum(results)
print(
    f"\n{passed}/{len(results)} clock tempos locked (±{TOLERANCE:.0%}, octave-tolerant)"
)
print(
    "VERDICT:",
    "CLOCK STEERING WORKS — wire it into the decks"
    if passed == len(results)
    else "PARTIAL — better than text hints?"
    if passed > 2
    else "clock conditioning does not steer tempo",
)
