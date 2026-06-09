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

DECK_IDS = ("a",)  # M1: single deck; "b" arrives in M3.
DEFAULT_MODEL = "mrt2_small"

STATIC_DIR = pathlib.Path(__file__).parent / "static"


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

    def stop_and_drain(self) -> None:
        """Pause generation and empty the output queue.

        Called when the client goes away: the worker may be blocked on a full
        out_queue, so draining is what lets it see the stop command.
        """
        self.send({"type": "stop"})
        with contextlib.suppress(queue.Empty):
            while True:
                self.out_queue.get_nowait()

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


@app.websocket("/ws/deck/{deck_id}")
async def deck_socket(websocket: WebSocket, deck_id: str) -> None:
    deck = decks.get(deck_id)
    if deck is None:
        await websocket.close(code=4404, reason=f"unknown deck {deck_id!r}")
        return
    if deck.connected:
        await websocket.close(code=4409, reason="deck already has a client")
        return

    await websocket.accept()
    deck.connected = True
    websocket_info = json.dumps({
        "event": "hello",
        "deck": deck_id,
        "model": deck.model,
        "sample_rate": engine.SAMPLE_RATE,
        "channels": engine.CHANNELS,
        "chunk_seconds": engine.CHUNK_SECONDS,
    })
    await websocket.send_text(websocket_info)

    pump = asyncio.create_task(_pump_worker_output(deck, websocket))
    try:
        while True:
            message = await websocket.receive_text()
            command = json.loads(message)
            if command.get("type") in ("play", "stop", "set_prompt"):
                deck.send(command)
            else:
                await websocket.send_text(json.dumps({
                    "event": "error",
                    "error": f"unknown command {command.get('type')!r}",
                }))
    except WebSocketDisconnect:
        pass
    finally:
        pump.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await pump
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
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host="127.0.0.1", port=8000)


if __name__ == "__main__":
    main()
