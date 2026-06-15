"""Spike B entry point: prove the MLX inference path works when frozen.

Loads mrt2_small via the real backend DeckEngine, generates one ~1 s PCM
chunk, validates it as interleaved-stereo-float32, and prints timings.

Run frozen with MAGENTA_HOME pointing at the dir that contains
magenta-rt-v2/ (weights stay external, never bundled). On success prints:

    OK <bytes> <chunk_secs>

plus a TIMING and PCM line. Any non-zero exit means the frozen path failed.
"""

import os
import struct
import sys
import time


def _eprint(*args):
    print(*args, file=sys.stderr, flush=True)


def main() -> int:
    # numba (pulled in transitively via librosa) needs a writable cache dir;
    # the frozen bundle dir is read-only / signed, so redirect it to temp.
    os.environ.setdefault("NUMBA_CACHE_DIR", "/tmp/slipmate_numba_cache")

    # The backend source is NOT bundled into this spike (we must not touch
    # backend/). When frozen, slipmate.engine is collected as a hidden import;
    # when run from source, fall back to the repo's backend dir on sys.path.
    if not getattr(sys, "frozen", False):
        repo_backend = os.path.abspath(
            os.path.join(os.path.dirname(__file__), "..", "..", "backend")
        )
        if repo_backend not in sys.path:
            sys.path.insert(0, repo_backend)

    _eprint(f"[freeze_test] frozen={getattr(sys, 'frozen', False)}")
    _eprint(f"[freeze_test] MAGENTA_HOME={os.environ.get('MAGENTA_HOME')}")
    _eprint(f"[freeze_test] sys.executable={sys.executable}")

    from slipmate.engine import (
        CHANNELS,
        CHUNK_SECONDS,
        SAMPLE_RATE,
        DeckEngine,
    )

    model = os.environ.get("SLIPMATE_MODEL", "mrt2_small")

    t0 = time.perf_counter()
    engine = DeckEngine(model=model)
    t_load = time.perf_counter() - t0
    _eprint(f"[freeze_test] model loaded in {t_load:.2f}s")

    t1 = time.perf_counter()
    pcm = engine.generate_chunk()
    t_gen = time.perf_counter() - t1
    _eprint(f"[freeze_test] chunk generated in {t_gen:.2f}s")

    # Validate: whole interleaved-stereo float32 frames, finite, plausible len.
    nbytes = len(pcm)
    if nbytes == 0 or nbytes % (4 * CHANNELS):
        _eprint(f"[freeze_test] INVALID: {nbytes} bytes not whole stereo f32 frames")
        return 2
    nframes = nbytes // (4 * CHANNELS)
    chunk_secs = nframes / SAMPLE_RATE
    expected_frames = int(round(CHUNK_SECONDS * SAMPLE_RATE))
    # Validate the whole chunk: every sample finite and in a sane audio range,
    # and the chunk actually carries signal (the cold-start lead-in is near
    # silent, so a first-few-samples probe would be misleadingly quiet).
    nfloats = nbytes // 4
    floats = struct.unpack(f"<{nfloats}f", pcm)
    finite = all(f == f and abs(f) < 1000.0 for f in floats)  # f==f rejects NaN
    peak = max((abs(f) for f in floats), default=0.0)
    sumsq = 0.0
    for f in floats:
        sumsq += f * f
    rms = (sumsq / nfloats) ** 0.5 if nfloats else 0.0
    has_signal = peak > 1e-4

    rtf = t_gen / chunk_secs if chunk_secs else float("inf")

    print(f"OK {nbytes} {chunk_secs:.3f}", flush=True)
    print(
        f"TIMING load={t_load:.2f}s gen={t_gen:.2f}s rtf={rtf:.3f} "
        f"(frames={nframes} expected~{expected_frames})",
        flush=True,
    )
    print(
        f"PCM bytes={nbytes} frames={nframes} sr={SAMPLE_RATE} ch={CHANNELS} "
        f"finite={finite} has_signal={has_signal} peak={peak:.4f} rms={rms:.4f}",
        flush=True,
    )

    if not finite:
        _eprint("[freeze_test] INVALID: non-finite / out-of-range samples")
        return 3
    if not has_signal:
        _eprint("[freeze_test] INVALID: chunk carries no signal (all near-zero)")
        return 4
    return 0


if __name__ == "__main__":
    sys.exit(main())
