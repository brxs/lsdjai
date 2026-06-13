"""FastAPI controller: supervises deck workers and bridges them to WebSockets.

One WebSocket per deck at /ws/deck/{deck_id}: binary frames carry PCM chunks
(interleaved stereo float32 LE, 48 kHz — see docs/spike-mrt2.md), JSON text
frames carry control in both directions. The controller never touches
magenta_rt (ADR-0002); it only forwards between the worker queues and the
socket.
"""

import asyncio
import contextlib
import json
import logging
import math
import multiprocessing as mp
import os
import pathlib
import queue
import time

import uvicorn
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

from . import cue, engine, sa3
from .worker import run_deck_worker

logger = logging.getLogger(__name__)

# Safety net for a stalled client: the worker paces itself (see worker.py),
# so this only fills if nobody is consuming. Status messages share the queue,
# hence the factor of 2.
OUT_QUEUE_CHUNKS = 6
# Idle sleep between non-blocking queue polls; bounds added forwarding
# latency (chunks are 1s, clients prebuffer 1.5s).
PUMP_POLL_SECONDS = 0.05

DECK_IDS = ("a", "b")
DEFAULT_MODEL = "mrt2_small"
# Each distinct prompt costs one MusicCoCa embed in the worker (cached, but
# the cache is finite — see engine.EMBED_CACHE_SIZE).
MAX_STYLE_PROMPTS = 8
MAX_SAMPLE_ID_LENGTH = 64

# Rough whole-process footprints (model + MusicCoCa + MLX runtime), used only
# for the UI's "this combination looks tight" warning — not enforcement.
MODEL_RAM_ESTIMATE_GB = {"mrt2_small": 2.0, "mrt2_base": 6.0}


def _total_ram_gb() -> float:
    return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1024**3


# The React app (frontend/, built with `npm run build`). During development
# the Vite dev server serves it instead and proxies /ws here.
FRONTEND_DIST = pathlib.Path(__file__).resolve().parents[2] / "frontend" / "dist"


class DeckProcess:
    """A supervised worker process plus its command/output queues."""

    def __init__(self, deck_id: str, model: str):
        self.deck_id = deck_id
        self.model = model
        self.connected = False
        # True while a restart is tearing down/spawning the worker, so the
        # pump doesn't misread the gap as a crash.
        self.restarting = False
        self._spawn()

    def _spawn(self) -> None:
        ctx = mp.get_context("spawn")
        self.cmd_queue = ctx.Queue()
        self.out_queue = ctx.Queue(maxsize=OUT_QUEUE_CHUNKS * 2)
        self.process = ctx.Process(
            target=run_deck_worker,
            args=(self.deck_id, self.model, self.cmd_queue, self.out_queue),
            name=f"deck-{self.deck_id}",
            daemon=True,
        )

    def start(self) -> None:
        self.process.start()

    def restart(self, model: str) -> None:
        """Tear down the worker and spawn a fresh one with `model`.

        Blocking (joins the old process) — run via asyncio.to_thread. The
        caller sets `restarting` before scheduling; this clears it. Only this
        deck is touched: the other deck's worker keeps generating.
        """
        try:
            self.shutdown()
            # The old worker's backlog must not reach the client as if it
            # came from the new model.
            self.drain()
            self.model = model
            self._spawn()
            self.start()
        finally:
            self.restarting = False

    def send(self, command: dict) -> None:
        self.cmd_queue.put(command)

    def drain(self) -> None:
        """Discard everything currently in the output queue."""
        with contextlib.suppress(queue.Empty):
            while True:
                self.out_queue.get_nowait()

    def stop_and_drain(self) -> None:
        """Pause generation and empty the output queue.

        Called when the client goes away: the worker may be blocked on a full
        out_queue, so draining is what lets it see the stop command. A worker
        that unblocks mid-drain can still emit one last chunk, which is why
        the next session drains again on connect.
        """
        self.send({"type": "stop"})
        self.drain()

    def shutdown(self) -> None:
        if self.process.is_alive():
            self.send({"type": "shutdown"})
            self.process.join(timeout=5)
            if self.process.is_alive():
                self.process.terminate()


decks: dict[str, DeckProcess] = {}


@contextlib.asynccontextmanager
async def _deck_lifespan(_: FastAPI):
    for deck_id in DECK_IDS:
        deck = DeckProcess(deck_id, DEFAULT_MODEL)
        deck.start()
        decks[deck_id] = deck
    yield
    for deck in decks.values():
        deck.shutdown()
    decks.clear()
    if render_state["worker"] is not None:
        render_state["worker"].shutdown()
        render_state["worker"] = None


app = FastAPI(lifespan=_deck_lifespan)


def validate_command(parsed: object) -> tuple[dict | None, str | None]:
    """Validate a client control message; returns (sanitized command, error)."""
    if not isinstance(parsed, dict):
        return None, "command must be a JSON object"
    kind = parsed.get("type")
    if kind in ("play", "stop", "restart"):
        return {"type": kind}, None
    if kind == "set_prompt":
        prompt = parsed.get("prompt")
        if isinstance(prompt, str) and prompt.strip():
            return {"type": "set_prompt", "prompt": prompt}, None
        return None, "set_prompt requires a non-empty string 'prompt'"
    if kind == "set_style":
        prompts = parsed.get("prompts")
        if not isinstance(prompts, list) or not 1 <= len(prompts) <= MAX_STYLE_PROMPTS:
            return None, f"set_style requires 1..{MAX_STYLE_PROMPTS} 'prompts'"
        clean_prompts = []
        for entry in prompts:
            text = entry.get("text") if isinstance(entry, dict) else None
            weight = entry.get("weight", 1.0) if isinstance(entry, dict) else None
            sample = entry.get("sample") if isinstance(entry, dict) else None
            if not (isinstance(text, str) and text.strip()):
                return None, "each style prompt needs a non-empty string 'text'"
            if (
                isinstance(weight, bool)
                or not isinstance(weight, (int, float))
                or not math.isfinite(weight)
                or weight < 0
            ):
                return None, "each style prompt 'weight' must be a finite number >= 0"
            clean = {"text": text, "weight": float(weight)}
            # Sampled targets (M15): 'sample' carries the embedding id the
            # client registered via /api/deck/{deck}/style-sample.
            if sample is not None:
                if not (
                    isinstance(sample, str) and 0 < len(sample) <= MAX_SAMPLE_ID_LENGTH
                ):
                    return None, "style prompt 'sample' must be a short string id"
                clean["sample"] = sample
            clean_prompts.append(clean)
        if not any(entry["weight"] > 0 for entry in clean_prompts):
            return None, "set_style needs at least one prompt with weight > 0"
        return {"type": "set_style", "prompts": clean_prompts}, None
    if kind == "set_model":
        model = parsed.get("model")
        if model in engine.KNOWN_MODELS:
            return {"type": "set_model", "model": model}, None
        return None, f"set_model requires 'model' in {list(engine.KNOWN_MODELS)}"
    return None, f"unknown command {kind!r}"


async def _send_error(websocket: WebSocket, error: str) -> None:
    await websocket.send_text(json.dumps({"event": "error", "error": error}))


@app.websocket("/ws/deck/{deck_id}")
async def deck_socket(websocket: WebSocket, deck_id: str) -> None:
    deck = decks.get(deck_id)
    if deck is None:
        await websocket.close(code=4404, reason=f"unknown deck {deck_id!r}")
        return
    if deck.connected:
        await websocket.close(code=4409, reason="deck already has a client")
        return

    # Claim the deck before the first await so a concurrent connection can't
    # also pass the check above.
    deck.connected = True
    try:
        await websocket.accept()
        # Discard output a previous session left behind. A worker unblocking
        # from a full-queue put can still slip one late chunk past this
        # drain; if that ever matters, tag queue messages per session.
        deck.drain()
        hello = json.dumps(
            {
                "event": "hello",
                "deck": deck_id,
                "model": deck.model,
                "sample_rate": engine.SAMPLE_RATE,
                "channels": engine.CHANNELS,
                "chunk_seconds": engine.CHUNK_SECONDS,
                # Only models present on disk: picking one that can't load
                # would just crash the worker (mrt2_base is optional).
                "models": engine.available_models(),
                "restarting": deck.restarting,
                "total_ram_gb": round(_total_ram_gb(), 1),
                "model_ram_estimate_gb": MODEL_RAM_ESTIMATE_GB,
            }
        )
        await websocket.send_text(hello)

        pump = asyncio.create_task(_pump_worker_output(deck, websocket))
        try:
            while True:
                try:
                    message = await websocket.receive_text()
                except KeyError:
                    # A binary frame; clients have nothing binary to tell us.
                    await _send_error(websocket, "expected a JSON text frame")
                    continue
                try:
                    parsed = json.loads(message)
                except json.JSONDecodeError:
                    await _send_error(websocket, "invalid JSON")
                    continue
                command, error = validate_command(parsed)
                if command is None:
                    await _send_error(websocket, error)
                elif command["type"] in ("set_model", "restart"):
                    # Controller-level: a model switch (or crash recovery) is
                    # a worker restart, which the worker can't do to itself.
                    target_model = command.get("model", deck.model)
                    if deck.restarting:
                        await _send_error(websocket, "model switch already in progress")
                    elif (
                        command["type"] == "set_model"
                        and target_model not in engine.available_models()
                    ):
                        # The UI only offers downloaded models, but the
                        # server is the trust boundary: loading a missing
                        # model just crashes the fresh worker.
                        await _send_error(
                            websocket, f"model {target_model!r} is not downloaded"
                        )
                    else:
                        deck.restarting = True
                        await websocket.send_text(
                            json.dumps(
                                {"event": "model_loading", "model": target_model}
                            )
                        )
                        restart_task = asyncio.create_task(
                            asyncio.to_thread(deck.restart, target_model)
                        )
                        restart_task.add_done_callback(_log_restart_failure)
                elif deck.restarting:
                    # The worker (and its command queue) is being replaced;
                    # the server is the trust boundary, not the disabled UI.
                    await _send_error(websocket, "deck is loading a model")
                else:
                    deck.send(command)
        except WebSocketDisconnect:
            pass
        finally:
            pump.cancel()
            try:
                await pump
            except asyncio.CancelledError:
                pass
            except Exception:
                # A pump that died on a closing socket must not skip the
                # cleanup below, or the deck stays locked and the worker
                # jams on a full queue.
                logger.exception("deck %s: output pump failed", deck.deck_id)
    finally:
        deck.stop_and_drain()
        deck.connected = False


def _log_restart_failure(task: asyncio.Task) -> None:
    if not task.cancelled() and task.exception() is not None:
        logger.error("deck restart failed", exc_info=task.exception())


async def _pump_worker_output(deck: DeckProcess, websocket: WebSocket) -> None:
    """Forward worker output to the socket without blocking the event loop.

    Also watches worker liveness: a dead process (outside a deliberate
    restart) is reported once as a `worker_died` event so the client can
    offer recovery instead of waiting on a deck that will never speak again.
    """
    death_reported = False
    while True:
        try:
            # Non-blocking read + async sleep, NOT a blocking get() in a
            # thread: a cancelled to_thread leaves its thread blocked on the
            # queue for the rest of the timeout, and that zombie consumes —
            # and discards — whatever the worker emits next. With a fast
            # reconnect (page reload) it ate the fresh session's first
            # style_applied echo.
            kind, payload = deck.out_queue.get_nowait()
        except queue.Empty:
            alive = deck.restarting or deck.process.is_alive()
            if alive:
                death_reported = False
            elif not death_reported:
                death_reported = True
                await websocket.send_text(
                    json.dumps({"event": "worker_died", "model": deck.model})
                )
            await asyncio.sleep(PUMP_POLL_SECONDS)
            continue
        if kind == "audio":
            await websocket.send_bytes(payload)
        else:
            await websocket.send_text(json.dumps(payload))


@app.post("/api/deck/{deck_id}/style-sample")
async def style_sample(deck_id: str, request: Request) -> dict:
    """Register captured deck audio as a style sample (M15, ADR-0011).

    The body is wire-format PCM (interleaved stereo float32 LE, 48 kHz);
    `?id=` names the embedding in the target worker's cache. Returns once
    the embed command is queued — the worker's FIFO command queue
    guarantees any set_style referencing the id runs after the embed.
    """
    deck = decks.get(deck_id)
    if deck is None:
        raise HTTPException(status_code=404, detail=f"unknown deck {deck_id!r}")
    if deck.restarting:
        raise HTTPException(status_code=409, detail="deck is loading a model")
    sample_id = request.query_params.get("id", "")
    if not sample_id or len(sample_id) > MAX_SAMPLE_ID_LENGTH:
        raise HTTPException(status_code=422, detail="missing or oversized 'id'")
    frame_bytes = 4 * engine.CHANNELS
    # Reject an oversized upload from its declared length, before
    # buffering megabytes only to refuse them.
    declared = request.headers.get("content-length", "")
    max_bytes = engine.MAX_SAMPLE_SECONDS * engine.SAMPLE_RATE * frame_bytes
    if declared.isdigit() and int(declared) > max_bytes:
        raise HTTPException(status_code=413, detail="sample upload too large")
    body = await request.body()
    if len(body) == 0 or len(body) % frame_bytes:
        raise HTTPException(
            status_code=422, detail="body must be whole interleaved stereo frames"
        )
    seconds = len(body) / frame_bytes / engine.SAMPLE_RATE
    if not engine.MIN_SAMPLE_SECONDS <= seconds <= engine.MAX_SAMPLE_SECONDS:
        raise HTTPException(
            status_code=422,
            detail=(
                f"sample must be {engine.MIN_SAMPLE_SECONDS}-"
                f"{engine.MAX_SAMPLE_SECONDS}s, got {seconds:.1f}s"
            ),
        )
    deck.send({"type": "embed_sample", "id": sample_id, "pcm": body})
    return {"id": sample_id, "seconds": round(seconds, 2)}


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


@app.get("/api/cue/outputs")
def cue_outputs() -> list[dict]:
    """Output devices that can carry the cue on a separate phones pair
    (ADR-0007); the phones picker lists them next to the browser sinks."""
    return cue.phones_capable_outputs()


# Like a deck, the cue sink takes exactly one client.
cue_state = {"connected": False}


@app.websocket("/ws/cue")
async def cue_socket(websocket: WebSocket) -> None:
    """Cue feed up from the browser: binary frames of interleaved stereo
    float32 LE at 48 kHz, played to the phones pair of `?device=`.

    Always accepts before refusing: a close before accept reaches the
    browser as a bare handshake failure with the code and reason — the
    user-facing message — stripped. The client treats the `ready` event,
    not the socket opening, as acceptance.
    """
    if cue_state["connected"]:
        await websocket.accept()
        await websocket.close(code=4409, reason="cue already has a client")
        return
    cue_state["connected"] = True
    sink = None
    try:
        await websocket.accept()
        device = websocket.query_params.get("device", "")
        try:
            # Opening a PortAudio stream blocks briefly; keep the loop free.
            sink = await asyncio.to_thread(cue.CueSink, device)
        except Exception as error:
            logger.warning("cue sink for %r failed: %s", device, error)
            await websocket.close(code=4404, reason=str(error))
            return
        await websocket.send_text(json.dumps({"event": "ready"}))
        while True:
            try:
                payload = await websocket.receive_bytes()
            except KeyError:
                # A text frame; the cue socket is audio-only.
                await _send_error(websocket, "expected a binary PCM frame")
                continue
            try:
                sink.push(payload)
            except ValueError as error:
                await _send_error(websocket, str(error))
    except WebSocketDisconnect:
        pass
    finally:
        if sink is not None:
            sink.close()
        cue_state["connected"] = False


# Registered after the WebSocket route so /ws/deck/* is matched first.
if FRONTEND_DIST.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    if not FRONTEND_DIST.is_dir():
        logger.warning(
            "frontend build not found at %s — run `npm run build` in frontend/ "
            "(the WebSocket API works regardless)",
            FRONTEND_DIST,
        )
    uvicorn.run(app, host="127.0.0.1", port=8000)


if __name__ == "__main__":
    main()
