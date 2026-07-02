"""Sidecar transport tests: the loopback-TCP framing + the queue adapters that
bridge the socket to run_deck_worker, exercised against a socketpair with a fake
engine — no model, no Rust process."""

import io
import json
import socket
import struct
import threading
import time

from lsdj.sidecar import (
    FRAME_CONTROL,
    FRAME_EMBED,
    FRAME_PCM,
    FRAME_STATUS,
    SocketCmdQueue,
    SocketOutQueue,
    read_frame,
    run_sidecar,
    write_frame,
)

FAKE_PCM = b"\x01\x02\x03\x04" * 8


class FakeEngine:
    """The run_deck_worker engine contract, enough for the transport test."""

    def __init__(self, model="fake"):
        self.styles = []

    def set_style(self, prompts, sample_keys=frozenset()):
        self.styles.append(prompts)

    def set_notes(self, notes):
        pass

    def set_drums(self, flag):
        pass

    def generate_chunk(self):
        return FAKE_PCM


class RecordingSock:
    """A stand-in socket that records framed sends (SocketOutQueue only calls
    sendall)."""

    def __init__(self):
        self.buffer = bytearray()

    def sendall(self, data):
        self.buffer.extend(data)


def test_frame_round_trips_through_a_buffer():
    sock = RecordingSock()
    write_frame(sock, FRAME_STATUS, b'{"event":"ready"}')
    write_frame(sock, FRAME_PCM, b"\x00\x01\x02\x03")

    reader = io.BytesIO(bytes(sock.buffer))
    assert read_frame(reader) == (FRAME_STATUS, b'{"event":"ready"}')
    assert read_frame(reader) == (FRAME_PCM, b"\x00\x01\x02\x03")
    # Clean EOF at a boundary → None.
    assert read_frame(reader) is None


def test_read_frame_returns_none_on_truncated_payload():
    # A header promising 16 bytes but only 4 present → truncation → None.
    head = struct.pack("<BI", FRAME_PCM, 16)
    reader = io.BytesIO(head + b"\x00\x00\x00\x00")
    assert read_frame(reader) is None


def test_out_queue_maps_audio_and_status_to_frames():
    sock = RecordingSock()
    out = SocketOutQueue(sock)
    out.put(("audio", b"\xaa\xbb\xcc\xdd"))
    out.put(("status", {"event": "chunk", "index": 3}))

    reader = io.BytesIO(bytes(sock.buffer))
    ftype, payload = read_frame(reader)
    assert ftype == FRAME_PCM
    assert payload == b"\xaa\xbb\xcc\xdd"
    ftype, payload = read_frame(reader)
    assert ftype == FRAME_STATUS
    assert json.loads(payload) == {"event": "chunk", "index": 3}


def test_cmd_queue_parses_control_frames_and_shutdown_on_eof():
    # Two control frames then EOF; the adapter yields the parsed dicts, then a
    # synthetic shutdown so the worker loop exits.
    wire = bytearray()
    rec = RecordingSock()
    rec.buffer = wire
    write_frame(rec, FRAME_CONTROL, b'{"type":"play"}')
    write_frame(rec, FRAME_CONTROL, b'{"type":"stop"}')
    # A non-control frame must be ignored.
    write_frame(rec, FRAME_PCM, b"\x00\x00\x00\x00")

    cmd = SocketCmdQueue(io.BytesIO(bytes(wire)))
    assert cmd.get(timeout=1.0) == {"type": "play"}
    assert cmd.get(timeout=1.0) == {"type": "stop"}
    assert cmd.get(timeout=1.0) == {"type": "shutdown"}


def test_cmd_queue_passes_note_conditioning_through_intact():
    # The pump is a generic JSON pass-through; pin that ADR-0023's
    # full-state conditioning payloads reach the worker unmodified.
    multihot = [0] * 128
    multihot[60] = 3
    wire = bytearray()
    rec = RecordingSock()
    rec.buffer = wire
    write_frame(
        rec,
        FRAME_CONTROL,
        json.dumps({"type": "set_notes", "notes": multihot}).encode(),
    )
    write_frame(rec, FRAME_CONTROL, b'{"type":"set_drums","drums":null}')

    cmd = SocketCmdQueue(io.BytesIO(bytes(wire)))
    assert cmd.get(timeout=1.0) == {"type": "set_notes", "notes": multihot}
    assert cmd.get(timeout=1.0) == {"type": "set_drums", "drums": None}


def _read_frames_until(sock_file, predicate, timeout=3.0):
    """Read frames until `predicate(ftype, payload)` is true; returns that frame."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        frame = read_frame(sock_file)
        if frame is None:
            raise AssertionError("socket closed before the expected frame")
        if predicate(*frame):
            return frame
    raise AssertionError("timed out waiting for the expected frame")


def test_sidecar_streams_pcm_and_status_over_a_socketpair():
    # The whole sidecar transport end to end: a socketpair stands in for the
    # Rust↔sidecar link; a fake engine stands in for the model.
    shell, side = socket.socketpair()
    try:
        thread = threading.Thread(
            target=run_sidecar,
            args=(side, "a", "fake"),
            kwargs={"engine_factory": lambda model: FakeEngine(model)},
            daemon=True,
        )
        thread.start()

        shell_reader = shell.makefile("rb")
        # The worker announces 'ready' first.
        ftype, payload = _read_frames_until(
            shell_reader, lambda t, p: t == FRAME_STATUS and b"ready" in p
        )
        assert json.loads(payload)["event"] == "ready"

        # Drive a style + play; expect PCM frames to start flowing.
        write_frame(
            shell,
            FRAME_CONTROL,
            json.dumps(
                {"type": "set_style", "prompts": [{"text": "techno", "weight": 1.0}]}
            ).encode(),
        )
        write_frame(shell, FRAME_CONTROL, json.dumps({"type": "play"}).encode())

        ftype, payload = _read_frames_until(shell_reader, lambda t, p: t == FRAME_PCM)
        assert payload == FAKE_PCM
    finally:
        # Closing the shell end → the sidecar's reader hits EOF → shutdown.
        shell.close()
        side.close()


def test_sidecar_main_argument_parsing(monkeypatch):
    # `main` parses --deck/--model/--port and dials the loopback port; stub the
    # connect + run so no real model loads.
    captured = {}

    def fake_create_connection(addr):
        captured["addr"] = addr
        return RecordingSock()

    def fake_run(sock, deck, model, engine_factory=None):
        captured["deck"] = deck
        captured["model"] = model

    import lsdj.sidecar as sidecar_mod

    monkeypatch.setattr(sidecar_mod.socket, "create_connection", fake_create_connection)
    # RecordingSock has no setsockopt; give it a no-op.
    monkeypatch.setattr(
        RecordingSock, "setsockopt", lambda *a, **k: None, raising=False
    )
    monkeypatch.setattr(sidecar_mod, "run_sidecar", fake_run)

    sidecar_mod.main(["--deck", "b", "--model", "mrt2_small", "--port", "5050"])
    assert captured["addr"] == ("127.0.0.1", 5050)
    assert captured["deck"] == "b"
    assert captured["model"] == "mrt2_small"


def test_cmd_queue_decodes_embed_frame_to_embed_sample():
    # A FRAME_EMBED ([u32 id_len][id][pcm]) becomes an embed_sample command the
    # worker handles (M15 style sampling routed to the sidecar in native).
    sample_id = b"sample:a:1"
    pcm = b"\x00\x01\x02\x03\x04\x05\x06\x07"
    payload = len(sample_id).to_bytes(4, "little") + sample_id + pcm
    rec = RecordingSock()
    write_frame(rec, FRAME_EMBED, payload)

    cmd = SocketCmdQueue(io.BytesIO(bytes(rec.buffer)))
    assert cmd.get(timeout=1.0) == {
        "type": "embed_sample",
        "id": "sample:a:1",
        "pcm": pcm,
    }
