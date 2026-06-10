"""Spike follow-up: clock variants after drums-pulse-with-zeros failed.

Variant A: drums=1 on the tick, drums=-1 (masked) between ticks — assert
only the hits, leave the rest free.
Variant B: notes-channel heartbeat — a low pitch onset (2) on the tick,
masked otherwise, with high cfg_notes.

Run: uv run python scripts/spike_midi_clock2.py
"""

import time

import librosa
import mlx.core as mx
import numpy as np

from magenta_rt.mlx import system

STYLE = "driving techno, four on the floor"
STYLE_WITH_BPM = STYLE + ", {bpm} bpm"
SECONDS = 16
FRAME_SECONDS = 0.04
PERIODS = {15: 100.0, 10: 150.0}
TOLERANCE = 0.08
HEARTBEAT_PITCH = 36  # C2 — kick register


def estimated_tempo(samples, sample_rate):
    # Skip the first 6s so entrainment time doesn't blur the estimate.
    tail = samples[int(6 * sample_rate) :]
    tempo, _ = librosa.beat.beat_track(y=tail.mean(axis=1), sr=sample_rate)
    return float(np.atleast_1d(tempo)[0])


def tracks(requested, estimate):
    return any(
        abs(estimate * factor - requested) / requested <= TOLERANCE
        for factor in (0.5, 1.0, 2.0)
    )


def run_variant(name, mrt, style_tokens, period, bpm, args_on, args_off):
    state = list(mrt._initial_state)
    chunks = []
    t0 = time.time()
    for index in range(int(SECONDS / FRAME_SECONDS)):
        outputs = mrt._fn((args_on if index % period == 0 else args_off) + state)
        mx.eval(outputs)
        chunks.append(np.array(outputs[0]))
        state = list(outputs[1:])
    samples = (np.concatenate(chunks, axis=-1)[0].T).astype(np.float32) / 32768.0
    estimate = estimated_tempo(samples, mrt._sample_rate)
    ok = tracks(bpm, estimate)
    print(
        f"{name}: clock {bpm:6.1f} bpm → estimated {estimate:6.1f} bpm "
        f"({'LOCKS' if ok else 'does not lock'}) [{time.time() - t0:.0f}s]"
    )
    return ok


print("Loading mrt2_small ...")
mrt = system.MagentaRT2SystemMlxfn(size="mrt2_small")
style_tokens = mrt.tokenize_style(mrt.embed_style(STYLE)).tolist()[:12]

results = []
for period, bpm in PERIODS.items():
    # Clock + matching text hint, maximum drum guidance.
    hinted = mrt.tokenize_style(
        mrt.embed_style(STYLE_WITH_BPM.format(bpm=round(bpm)))
    ).tolist()[:12]
    on = mrt._build_mlxfn_args(hinted, drums=[1], cfg_drums=7.0)
    off = mrt._build_mlxfn_args(hinted, drums=[-1], cfg_drums=7.0)
    results.append(run_variant("clock+hint/cfg7", mrt, hinted, period, bpm, on, off))

    # Clock alone at maximum guidance, for comparison.
    on = mrt._build_mlxfn_args(style_tokens, drums=[1], cfg_drums=7.0)
    off = mrt._build_mlxfn_args(style_tokens, drums=[-1], cfg_drums=7.0)
    results.append(
        run_variant("clock/cfg7     ", mrt, style_tokens, period, bpm, on, off)
    )

print(f"\n{sum(results)}/{len(results)} locked")
