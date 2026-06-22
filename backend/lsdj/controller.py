"""FastAPI generation server: the Stable Audio 3 + Magenta render RPC.

The native shell (src-tauri/) hosts the realtime decks as Rust-spawned Python
sidecars and serves the UI from the Tauri asset host, so this server runs ONLY
the generation RPC: /api/render (the third Magenta engine), /api/generate
(Stable Audio 3), and /api/models. It never touches magenta_rt directly
(ADR-0002) — the render worker is a separate spawned process.
"""

import argparse
import asyncio
import contextlib
import json
import logging
import math
import multiprocessing as mp
import os
import queue
import time

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from . import engine, sa3
from .worker import run_deck_worker

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "mrt2_small"

# Rough whole-process footprints (model + MusicCoCa + MLX runtime), used only
# for the UI's "this combination looks tight" warning — not enforcement.
MODEL_RAM_ESTIMATE_GB = {"mrt2_small": 2.0, "mrt2_base": 6.0}


def _total_ram_gb() -> float:
    return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1024**3


@contextlib.asynccontextmanager
async def _render_lifespan(_: FastAPI):
    """App lifespan: only the render worker has a lifecycle here.

    The decks moved to the Rust sidecars in the native cutover, so the
    controller spawns none — this just tears down the lazily-spawned
    render worker on shutdown.
    """
    yield
    if render_state["worker"] is not None:
        render_state["worker"].shutdown()
        render_state["worker"] = None


app = FastAPI(lifespan=_render_lifespan)


# Worst case: a 32 s clip at a pessimistic ~1× real time, plus a cold
# prompt embed; well past it the worker is wedged, not slow.
RENDER_TIMEOUT_SECONDS = 90
# First use pays the model load; this bounds it.
RENDER_READY_TIMEOUT_SECONDS = 180
# Magenta track ceiling (M19, ADR-0013): at the measured 1.86× real time
# (docs/spike-mrt2.md) a 3-minute render holds the single worker ~97 s —
# the boundary between a visible pending state and an outage.
RENDER_MAX_SECONDS = 180.0


def render_timeout_for(seconds: float) -> float:
    """Deadline for one render, scaled to the requested length.

    Wall is ~0.54× the requested seconds at the measured 1.86× real time,
    so 2× seconds keeps ~3.7× slack; the flat pad deadline stays as the
    floor for short clips' cold-embed margin (ADR-0013)."""
    return max(RENDER_TIMEOUT_SECONDS, seconds * 2)


class RenderProcess:
    """The third Magenta engine (M18): a worker that only renders clips.

    Reuses the deck worker loop — a render worker is a deck worker that
    never receives `play` — but lives apart from the decks, so pads can
    fill while both streams run. Spawned lazily on the first request:
    a resident third model (~2 GB for mrt2_small) is only paid for by
    sessions that use it.
    """

    def __init__(self, model: str = DEFAULT_MODEL):
        self.model = model
        self.render_lock = asyncio.Lock()
        self._spawn()

    def _spawn(self) -> None:
        ctx = mp.get_context("spawn")
        self.cmd_queue = ctx.Queue()
        # Only the "ready" status ever lands here; renders answer on
        # clip_queue like a deck's.
        self.out_queue = ctx.Queue(maxsize=4)
        self.clip_queue = ctx.Queue()
        self.ready = False
        self.process = ctx.Process(
            target=run_deck_worker,
            args=("render", self.model, self.cmd_queue, self.out_queue),
            kwargs={"clip_queue": self.clip_queue},
            name="render-worker",
            daemon=True,
        )
        self.process.start()

    def await_ready(self) -> None:
        """Block until the worker reports the model loaded (first use)."""
        if self.ready:
            return
        kind, payload = self.out_queue.get(timeout=RENDER_READY_TIMEOUT_SECONDS)
        if kind != "status" or payload.get("event") != "ready":
            raise RuntimeError(f"render worker spoke out of turn: {payload!r}")
        self.ready = True

    def send(self, command: dict) -> None:
        self.cmd_queue.put(command)

    def shutdown(self) -> None:
        if self.process.is_alive():
            self.send({"type": "shutdown"})
            self.process.join(timeout=5)
            if self.process.is_alive():
                self.process.terminate()


# Created on the first /api/render call, never at startup.
render_state: dict = {"worker": None}


def ensure_render_worker() -> RenderProcess:
    worker = render_state["worker"]
    if worker is None or not worker.process.is_alive():
        worker = RenderProcess()
        render_state["worker"] = worker
    return worker


def discard_render_worker(worker: RenderProcess) -> None:
    """Kill a worker that missed its deadline. Past the timeout it is wedged,
    not slow (see RENDER_TIMEOUT_SECONDS) — and even a merely-slow one must
    die, or its late answer would land in the next request's queue. The next
    call respawns clean via ensure_render_worker."""
    if worker.process.is_alive():
        worker.process.terminate()
        worker.process.join(timeout=5)
    if render_state["worker"] is worker:
        render_state["worker"] = None


def float32_wav(pcm: bytes, sample_rate: int, channels: int) -> bytes:
    """Wrap wire-format PCM in a WAVE_FORMAT_IEEE_FLOAT header — what
    decodeAudioData expects, with no quantisation on the way."""
    byte_rate = sample_rate * channels * 4
    header = b"RIFF" + (36 + len(pcm)).to_bytes(4, "little") + b"WAVEfmt "
    header += (16).to_bytes(4, "little")
    header += (3).to_bytes(2, "little")  # IEEE float
    header += channels.to_bytes(2, "little")
    header += sample_rate.to_bytes(4, "little")
    header += byte_rate.to_bytes(4, "little")
    header += (channels * 4).to_bytes(2, "little")  # block align
    header += (32).to_bytes(2, "little")  # bits per sample
    header += b"data" + len(pcm).to_bytes(4, "little")
    return header + pcm


@app.post("/api/render")
async def render_clip(request: Request) -> Response:
    """Render a pad clip with the third Magenta engine (M18).

    Body: JSON {prompt, seconds}. The render worker spawns on the
    first call (the model load happens inside that request's pending
    state) and stays warm after; both decks keep streaming untouched.
    Returns the clip as a float32 WAV.
    """
    try:
        parsed = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=422, detail="body must be JSON") from None
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=422, detail="body must be a JSON object")
    prompt = parsed.get("prompt")
    if not (isinstance(prompt, str) and prompt.strip()):
        raise HTTPException(
            status_code=422, detail="'prompt' must be a non-empty string"
        )
    prompt = prompt.strip()
    if len(prompt) > sa3.MAX_PROMPT_LENGTH:
        raise HTTPException(
            status_code=422,
            detail=f"'prompt' must be at most {sa3.MAX_PROMPT_LENGTH} characters",
        )
    seconds = parsed.get("seconds")
    if (
        isinstance(seconds, bool)
        or not isinstance(seconds, (int, float))
        or not math.isfinite(seconds)
        or not sa3.MIN_SECONDS <= seconds <= RENDER_MAX_SECONDS
    ):
        raise HTTPException(
            status_code=422,
            detail=f"'seconds' must be {sa3.MIN_SECONDS}-{RENDER_MAX_SECONDS:g}",
        )
    worker = ensure_render_worker()
    async with worker.render_lock:
        # A request that queued on the lock may hold a worker another
        # request just killed; fail fast rather than burn the timeout
        # against the corpse.
        if not worker.process.is_alive():
            discard_render_worker(worker)
            raise HTTPException(status_code=502, detail="render engine died")
        try:
            await asyncio.to_thread(worker.await_ready)
        except (queue.Empty, RuntimeError):
            discard_render_worker(worker)
            raise HTTPException(
                status_code=502, detail="render engine failed to start"
            ) from None
        # A previous timed-out render may have answered late; whatever
        # sits in the queue belongs to nobody now.
        with contextlib.suppress(queue.Empty):
            while True:
                worker.clip_queue.get_nowait()
        request_id = f"clip-{time.monotonic_ns()}"
        worker.send(
            {
                "type": "render_clip",
                "id": request_id,
                "prompt": prompt,
                "seconds": float(seconds),
            }
        )
        try:
            result_id, result = await asyncio.to_thread(
                worker.clip_queue.get, True, render_timeout_for(float(seconds))
            )
        except queue.Empty:
            discard_render_worker(worker)
            raise HTTPException(status_code=502, detail="render timed out") from None
    if result_id != request_id:
        raise HTTPException(status_code=502, detail="render answered out of turn")
    if "error" in result:
        raise HTTPException(status_code=502, detail=result["error"])
    return Response(
        content=float32_wav(result["pcm"], engine.SAMPLE_RATE, engine.CHANNELS),
        media_type="audio/wav",
    )


@app.post("/api/generate")
async def generate_audio(request: Request) -> Response:
    """Generate a pad clip with Stable Audio 3 (M18, ADR-0012).

    Body: JSON {prompt, seconds, kind} with kind in {sfx, music}. Returns
    the WAV. Generation runs in a spawned subprocess and is serialised, so
    a busy moment queues (~3 s) rather than stacking memory.
    """
    try:
        parsed = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=422, detail="body must be JSON") from None
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=422, detail="body must be a JSON object")
    prompt = parsed.get("prompt")
    if not (isinstance(prompt, str) and prompt.strip()):
        raise HTTPException(
            status_code=422, detail="'prompt' must be a non-empty string"
        )
    prompt = prompt.strip()
    if len(prompt) > sa3.MAX_PROMPT_LENGTH:
        raise HTTPException(
            status_code=422,
            detail=f"'prompt' must be at most {sa3.MAX_PROMPT_LENGTH} characters",
        )
    kind = parsed.get("kind")
    if kind not in sa3.KINDS:
        raise HTTPException(
            status_code=422, detail=f"'kind' must be one of {sorted(sa3.KINDS)}"
        )
    # Tracks (M19) run the medium DiT and may be minutes long; pads keep
    # the small-model ceiling.
    max_seconds = sa3.MAX_SECONDS_FOR[kind]
    seconds = parsed.get("seconds")
    if (
        isinstance(seconds, bool)
        or not isinstance(seconds, (int, float))
        or not math.isfinite(seconds)
        or not sa3.MIN_SECONDS <= seconds <= max_seconds
    ):
        raise HTTPException(
            status_code=422,
            detail=f"'seconds' must be {sa3.MIN_SECONDS}-{max_seconds:g}",
        )
    try:
        wav = await sa3.generate(prompt, float(seconds), kind)
    except sa3.GenerationUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from None
    except sa3.GenerationFailed as error:
        logger.warning("generation failed: %s", error)
        raise HTTPException(status_code=502, detail=str(error)) from None
    return Response(content=wav, media_type="audio/wav")


@app.get("/api/models")
def list_models() -> dict:
    """The downloaded models + RAM info for the deck UI's model picker and the
    "this combination looks tight" warning. In the native shell the realtime decks
    live in the Rust sidecars, so the webview fetches this from the generation
    server instead."""
    return {
        "models": engine.available_models(),
        "sample_rate": engine.SAMPLE_RATE,
        "channels": engine.CHANNELS,
        "chunk_seconds": engine.CHUNK_SECONDS,
        "total_ram_gb": round(_total_ram_gb(), 1),
        "model_ram_estimate_gb": MODEL_RAM_ESTIMATE_GB,
    }


# The browser cue sink (ADR-0007, `/ws/cue` + `/api/cue/outputs`) was retired at
# the native cutover (Phase 2 part 7): the native shell routes the cue to the FLX4
# phones (channels 3/4) inside the Rust engine (Slice 5), so no backend
# `sounddevice` sink is needed. ADR-0007 is superseded by ADR-0019.


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    parser = argparse.ArgumentParser(description="LSDJai generation server")
    parser.add_argument(
        "--port", type=int, default=8000, help="loopback port to bind (default 8000)"
    )
    args = parser.parse_args()

    # The webview loads from the Tauri asset host and fetches this server
    # cross-origin over loopback, so allow it. Loopback-bound; not exposed.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    uvicorn.run(app, host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
