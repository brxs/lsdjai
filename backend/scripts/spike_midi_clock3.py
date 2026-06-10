"""Spike round 3: repeated-trials comparison — does clock+text beat either alone?

Single runs in spike_midi_clock2.py hinted the combination might pull tempo
where each signal alone failed. Sampling is stochastic, so this runs each
condition several times and reports per-trial estimates and lock rates.

Conditions at each target tempo:
  text  — bpm hint in the prompt, no conditioning clock
  clock — masked-gap drum pulses (best variant so far), neutral prompt
  both  — bpm hint in the prompt AND the clock

Run: uv run python scripts/spike_midi_clock3.py
"""

import time

import librosa
import mlx.core as mx
import numpy as np

from magenta_rt.mlx import system

STYLE = "driving techno, four on the floor"
SECONDS = 16
FRAME_SECONDS = 0.04
TRIALS = 3
CFG_DRUMS = 4.0
# Frame-exact tempos: 1500/k. 100 bpm is contested; 88.2 is where the text
# hint originally failed outright.
TARGETS = [(15, 100.0), (17, 88.2)]
TOLERANCE = 0.08


def estimated_tempo(samples, sample_rate):
    tail = samples[int(6 * sample_rate) :]  # skip entrainment time
    tempo, _ = librosa.beat.beat_track(y=tail.mean(axis=1), sr=sample_rate)
    return float(np.atleast_1d(tempo)[0])


def tracks(requested, estimate):
    return any(
        abs(estimate * factor - requested) / requested <= TOLERANCE
        for factor in (0.5, 1.0, 2.0)
    )


def generate(mrt, args_on, args_off, period):
    state = list(mrt._initial_state)
    chunks = []
    for index in range(int(SECONDS / FRAME_SECONDS)):
        args = args_on if period and index % period == 0 else args_off
        outputs = mrt._fn(args + state)
        mx.eval(outputs)
        chunks.append(np.array(outputs[0]))
        state = list(outputs[1:])
    return (np.concatenate(chunks, axis=-1)[0].T).astype(np.float32) / 32768.0


print("Loading mrt2_small ...")
mrt = system.MagentaRT2SystemMlxfn(size="mrt2_small")
plain_tokens = mrt.tokenize_style(mrt.embed_style(STYLE)).tolist()[:12]

for period, bpm in TARGETS:
    hinted_tokens = mrt.tokenize_style(
        mrt.embed_style(f"{STYLE}, {round(bpm)} bpm")
    ).tolist()[:12]
    conditions = {
        "text ": (mrt._build_mlxfn_args(hinted_tokens), None, None),
        "clock": (
            mrt._build_mlxfn_args(plain_tokens, drums=[1], cfg_drums=CFG_DRUMS),
            mrt._build_mlxfn_args(plain_tokens, drums=[-1], cfg_drums=CFG_DRUMS),
            period,
        ),
        "both ": (
            mrt._build_mlxfn_args(hinted_tokens, drums=[1], cfg_drums=CFG_DRUMS),
            mrt._build_mlxfn_args(hinted_tokens, drums=[-1], cfg_drums=CFG_DRUMS),
            period,
        ),
    }
    print(f"\n=== target {bpm:.1f} bpm ===")
    for name, (args_on, args_off, clock_period) in conditions.items():
        estimates = []
        t0 = time.time()
        for _ in range(TRIALS):
            samples = generate(mrt, args_on, args_off or args_on, clock_period)
            estimates.append(estimated_tempo(samples, mrt._sample_rate))
        locked = sum(tracks(bpm, estimate) for estimate in estimates)
        formatted = ", ".join(f"{estimate:.0f}" for estimate in estimates)
        print(
            f"{name}: estimates [{formatted}] bpm — {locked}/{TRIALS} lock "
            f"[{time.time() - t0:.0f}s]"
        )
