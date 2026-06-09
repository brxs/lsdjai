"""Spike: verify MRT2 chunked streaming on this machine.

Generates a few seconds of mrt2_small audio in 2-second chunks with state
carried across chunks, switches the style prompt mid-stream, and reports the
real-time factor per chunk. Writes the result to a WAV so the transition can
be heard. Findings are recorded in docs/spike-mrt2.md.

Run: uv run python scripts/spike_generate.py
"""

import logging
import time
import wave

import numpy as np

logging.basicConfig(level=logging.INFO)

from magenta_rt.mlx import system  # noqa: E402  (import after logging config)

FRAMES_PER_CHUNK = 50  # 50 frames x 40 ms = 2 s per chunk
SAMPLE_RATE = 48_000

print("Loading mrt2_small ...")
t0 = time.time()
mrt = system.MagentaRT2SystemMlxfn(size="mrt2_small")
print(f"Loaded + warmed up in {time.time() - t0:.1f}s")

prompts = ["warm disco funk", "warm disco funk", "dark minimal techno", "dark minimal techno"]
style_cache = {p: mrt.embed_style(p) for p in set(prompts)}
print(f"Style embedding shape: {style_cache[prompts[0]].shape}, dtype {style_cache[prompts[0]].dtype}")

state = None
chunks = []
for i, prompt in enumerate(prompts):
    t0 = time.time()
    wav, state = mrt.generate(style=style_cache[prompt], frames=FRAMES_PER_CHUNK, state=state)
    dt = time.time() - t0
    rtf = wav.seconds / dt
    chunks.append(wav.samples)
    print(
        f"chunk {i} ({prompt!r}): {wav.seconds:.2f}s audio in {dt:.2f}s "
        f"(RTF {rtf:.2f}x), samples {wav.samples.shape} {wav.samples.dtype}, "
        f"peak {np.abs(wav.samples).max():.3f}"
    )

samples = np.concatenate(chunks, axis=0)
out_path = "spike_transition.wav"
with wave.open(out_path, "wb") as f:
    f.setnchannels(2)
    f.setsampwidth(2)
    f.setframerate(SAMPLE_RATE)
    f.writeframes((np.clip(samples, -1, 1) * 32767).astype(np.int16).tobytes())
print(f"Wrote {out_path} ({samples.shape[0] / SAMPLE_RATE:.1f}s) — transition at 4.0s")
