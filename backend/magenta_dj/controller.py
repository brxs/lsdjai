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
import multiprocessing as mp
import os
import pathlib
import queue

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

from . import engine
from .worker import run_deck_worker

logger = logging.getLogger(__name__)

# Safety net for a stalled client: the worker paces itself (see worker.py),
# so this only fills if nobody is consuming. Status messages share the queue,
# hence the factor of 2.
OUT_QUEUE_CHUNKS = 6
PUMP_POLL_SECONDS = 0.2

DECK_IDS = ("a", "b")
DEFAULT_MODEL = "mrt2_small"

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
            kind, payload = await asyncio.to_thread(
                deck.out_queue.get, True, PUMP_POLL_SECONDS
            )
        except queue.Empty:
            alive = deck.restarting or deck.process.is_alive()
            if alive:
                death_reported = False
            elif not death_reported:
                death_reported = True
                await websocket.send_text(
                    json.dumps({"event": "worker_died", "model": deck.model})
                )
            continue
        if kind == "audio":
            await websocket.send_bytes(payload)
        else:
            await websocket.send_text(json.dumps(payload))


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
