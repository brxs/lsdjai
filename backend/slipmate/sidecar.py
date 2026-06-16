"""Per-deck inference sidecar (Phase 2 part 4, ADR-0019).

The Rust shell (`src-tauri/src/sidecar.rs`) spawns this process per deck and
accepts its loopback-TCP connection. It runs the UNCHANGED `run_deck_worker`
generation loop (`worker.py`) with its `cmd_queue` / `out_queue` bridged to the
socket — so the inference loop is identical to the multiprocessing path; only the
transport differs.

Wire protocol (mirrors `src-tauri/src/sidecar.rs`):

    [u8 type][u32 little-endian length][length bytes payload]

- PCM (sidecar → engine): the worker's ``('audio', bytes)`` — interleaved-stereo
  f32 LE @ 48 kHz.
- STATUS (sidecar → engine): the worker's ``('status', dict)`` as UTF-8 JSON.
- CONTROL (engine → sidecar): a deck command (``play``/``stop``/``set_style``…)
  as UTF-8 JSON.

The transport (framing + the queue adapters) is testable against a socketpair
with a fake engine — no model, no Rust; see `tests/test_sidecar.py`. The
model-loaded round-trip is a native-checklist item.
"""

import argparse
import json
import queue
import socket
import struct
import threading

from .engine import DeckEngine
from .worker import run_deck_worker

FRAME_PCM = 1
FRAME_STATUS = 2
FRAME_CONTROL = 3

# u8 frame type, u32 little-endian payload length.
_HEADER = struct.Struct("<BI")


def write_frame(sock: socket.socket, frame_type: int, payload: bytes) -> None:
    """Send one framed message. `sendall` is atomic enough here: the worker loop
    is the only writer, so frames never interleave."""
    sock.sendall(_HEADER.pack(frame_type, len(payload)) + payload)


def read_frame(reader) -> tuple[int, bytes] | None:
    """Read one framed message from a buffered reader (`sock.makefile('rb')`), or
    None on a clean EOF / truncation at a frame boundary."""
    head = reader.read(_HEADER.size)
    if len(head) < _HEADER.size:
        return None
    frame_type, length = _HEADER.unpack(head)
    payload = reader.read(length)
    if len(payload) < length:
        return None
    return frame_type, payload


class SocketOutQueue:
    """`run_deck_worker`'s `out_queue`, writing to the socket: ``('audio', bytes)``
    → a PCM frame, ``('status', dict)`` → a status frame."""

    def __init__(self, sock: socket.socket) -> None:
        self._sock = sock
        self._lock = threading.Lock()

    def put(self, item: tuple[str, object]) -> None:
        kind, payload = item
        with self._lock:
            if kind == "audio":
                write_frame(self._sock, FRAME_PCM, payload)  # type: ignore[arg-type]
            elif kind == "status":
                write_frame(self._sock, FRAME_STATUS, json.dumps(payload).encode("utf-8"))


class SocketCmdQueue:
    """`run_deck_worker`'s `cmd_queue`, fed from the socket: a daemon thread parses
    CONTROL frames into an internal queue; `get` / `get_nowait` delegate to it (so
    the worker's blocking/throttle semantics are unchanged). A socket close enqueues
    a synthetic ``shutdown`` so the worker exits cleanly."""

    def __init__(self, reader) -> None:
        self._queue: queue.Queue = queue.Queue()
        self._reader = reader
        self._thread = threading.Thread(target=self._pump, daemon=True)
        self._thread.start()

    def _pump(self) -> None:
        while True:
            frame = read_frame(self._reader)
            if frame is None:
                self._queue.put({"type": "shutdown"})
                return
            frame_type, payload = frame
            if frame_type != FRAME_CONTROL:
                continue  # ignore non-control frames (forward-compatible)
            try:
                command = json.loads(payload)
            except json.JSONDecodeError:
                continue
            if isinstance(command, dict) and "type" in command:
                self._queue.put(command)

    def get(self, timeout=None):
        return self._queue.get(timeout=timeout)

    def get_nowait(self):
        return self._queue.get_nowait()


def run_sidecar(sock: socket.socket, deck_id: str, model: str, engine_factory=DeckEngine) -> None:
    """Bridge `sock` to `run_deck_worker` for `deck_id` and run the generation loop
    until the socket closes. `engine_factory` is injectable for tests."""
    reader = sock.makefile("rb")
    cmd_queue = SocketCmdQueue(reader)
    out_queue = SocketOutQueue(sock)
    run_deck_worker(deck_id, model, cmd_queue, out_queue, engine_factory=engine_factory)


def main(argv=None) -> None:
    parser = argparse.ArgumentParser(description="SlipMate per-deck inference sidecar")
    parser.add_argument("--deck", required=True, help="deck id (e.g. a or b)")
    parser.add_argument("--model", required=True, help="model name (e.g. mrt2_small)")
    parser.add_argument("--port", type=int, required=True, help="loopback TCP port the shell is listening on")
    args = parser.parse_args(argv)

    sock = socket.create_connection(("127.0.0.1", args.port))
    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    run_sidecar(sock, args.deck, args.model)


if __name__ == "__main__":
    main()
