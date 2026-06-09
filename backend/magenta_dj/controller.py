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

DECK_IDS = ("a",)  # M2: single deck; "b" arrives in M3.
DEFAULT_MODEL = "mrt2_small"

# The React app (frontend/, built with `npm run build`). During development
# the Vite dev server serves it instead and proxies /ws here.
FRONTEND_DIST = pathlib.Path(__file__).resolve().parents[2] / "frontend" / "dist"


class DeckProcess:
    """A supervised worker process plus its command/output queues."""

    def __init__(self, deck_id: str, model: str):
        self.deck_id = deck_id
        self.model = model
        ctx = mp.get_context("spawn")
        self.cmd_queue = ctx.Queue()
        self.out_queue = ctx.Queue(maxsize=OUT_QUEUE_CHUNKS * 2)
        self.process = ctx.Process(
            target=run_deck_worker,
            args=(deck_id, model, self.cmd_queue, self.out_queue),
            name=f"deck-{deck_id}",
            daemon=True,
        )
        self.connected = False

    def start(self) -> None:
        self.process.start()

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
    if kind in ("play", "stop"):
        return {"type": kind}, None
    if kind == "set_prompt":
        prompt = parsed.get("prompt")
        if isinstance(prompt, str) and prompt.strip():
            return {"type": "set_prompt", "prompt": prompt}, None
        return None, "set_prompt requires a non-empty string 'prompt'"
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


async def _pump_worker_output(deck: DeckProcess, websocket: WebSocket) -> None:
    """Forward worker output to the socket without blocking the event loop."""
    while True:
        try:
            kind, payload = await asyncio.to_thread(
                deck.out_queue.get, True, PUMP_POLL_SECONDS
            )
        except queue.Empty:
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
