"""Controller WebSocket tests: input validation at the trust boundary and
session cleanup. A fake deck stands in for the worker process; the lifespan
(which spawns real model workers) is deliberately not entered.
"""

import queue
import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from magenta_dj import controller
from magenta_dj.controller import validate_command


class FakeProcess:
    def __init__(self):
        self.alive = True

    def is_alive(self):
        return self.alive


class FakeDeck:
    def __init__(self):
        self.deck_id = "a"
        self.model = "mrt2_small"
        self.cmd_queue = queue.Queue()
        self.out_queue = queue.Queue()
        self.process = FakeProcess()
        self.connected = False
        self.restarting = False
        self.stopped = False
        self.restarted_with = []

    def send(self, command):
        self.cmd_queue.put(command)

    def drain(self):
        while not self.out_queue.empty():
            self.out_queue.get_nowait()

    def stop_and_drain(self):
        self.stopped = True
        self.drain()

    def restart(self, model):
        self.model = model
        self.restarted_with.append(model)
        self.process.alive = True
        self.restarting = False


@pytest.fixture
def deck(monkeypatch):
    fake = FakeDeck()
    monkeypatch.setitem(controller.decks, "a", fake)
    # Disk contents must not decide test outcomes.
    monkeypatch.setattr(
        controller.engine, "available_models", lambda: ["mrt2_small", "mrt2_base"]
    )
    return fake


@pytest.fixture
def client():
    return TestClient(controller.app)


def connect(client):
    return client.websocket_connect("/ws/deck/a")


def test_hello_on_connect(client, deck):
    with connect(client) as ws:
        hello = ws.receive_json()
    assert hello["event"] == "hello"
    assert hello["sample_rate"] == 48_000
    assert hello["channels"] == 2


def test_valid_commands_are_forwarded_sanitized(client, deck):
    with connect(client) as ws:
        ws.receive_json()
        ws.send_json({"type": "set_prompt", "prompt": "warm disco funk", "extra": 1})
        ws.send_json({"type": "play"})
    assert deck.cmd_queue.get(timeout=1) == {
        "type": "set_prompt",
        "prompt": "warm disco funk",
    }
    assert deck.cmd_queue.get(timeout=1) == {"type": "play"}


@pytest.mark.parametrize(
    "frame",
    [
        "{not json",
        '"just a string"',
        "[1, 2]",
        '{"type": "shutdown"}',
        '{"type": "set_prompt"}',
        '{"type": "set_prompt", "prompt": 7}',
        '{"type": "set_prompt", "prompt": "  "}',
    ],
)
def test_bad_frames_get_error_and_are_not_forwarded(client, deck, frame):
    with connect(client) as ws:
        ws.receive_json()
        ws.send_text(frame)
        assert ws.receive_json()["event"] == "error"
        # The connection survives and still accepts valid commands.
        ws.send_json({"type": "play"})
    assert deck.cmd_queue.get(timeout=1) == {"type": "play"}
    assert deck.cmd_queue.empty()


def test_binary_frame_gets_error(client, deck):
    with connect(client) as ws:
        ws.receive_json()
        ws.send_bytes(b"\x00\x01")
        assert ws.receive_json()["event"] == "error"


def test_second_connection_is_rejected(client, deck):
    with connect(client) as ws:
        ws.receive_json()
        with pytest.raises(WebSocketDisconnect) as excinfo:
            with connect(client):
                pass
        assert excinfo.value.code == 4409


def test_unknown_deck_is_rejected(client, deck):
    with pytest.raises(WebSocketDisconnect) as excinfo:
        with client.websocket_connect("/ws/deck/nope"):
            pass
    assert excinfo.value.code == 4404


def test_disconnect_releases_deck_and_stops_worker(client, deck):
    with connect(client) as ws:
        ws.receive_json()
        assert deck.connected
    assert deck.stopped
    assert not deck.connected
    # A new session must be accepted after the previous one ends.
    with connect(client) as ws:
        assert ws.receive_json()["event"] == "hello"


def test_pump_failure_still_releases_deck(client, deck):
    # Regression: a pump task that dies with a real exception (not
    # CancelledError) must not skip session cleanup, or the deck stays
    # locked and rejects every reconnect until the server restarts.
    with connect(client) as ws:
        ws.receive_json()
        # An unserializable status payload makes the pump's json.dumps raise,
        # killing the pump task while the session is still open.
        deck.out_queue.put(("status", object()))
        deadline = time.monotonic() + 2
        while not deck.out_queue.empty() and time.monotonic() < deadline:
            time.sleep(0.01)
        time.sleep(0.05)  # let the pump consume it and die
    assert deck.stopped
    assert not deck.connected
    # The deck must accept a fresh session afterwards.
    with connect(client) as ws:
        assert ws.receive_json()["event"] == "hello"


def wait_until(condition, timeout=2.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(0.02)
    return False


def test_set_model_restarts_worker_and_reports_loading(client, deck):
    with connect(client) as ws:
        assert ws.receive_json()["models"] == ["mrt2_small", "mrt2_base"]
        ws.send_json({"type": "set_model", "model": "mrt2_base"})
        assert ws.receive_json() == {"event": "model_loading", "model": "mrt2_base"}
        assert wait_until(lambda: deck.restarted_with == ["mrt2_base"])
    assert deck.model == "mrt2_base"
    # Worker commands must not see controller-level commands.
    assert deck.cmd_queue.empty()


def test_set_model_rejected_while_already_restarting(client, deck):
    deck.restarting = True
    with connect(client) as ws:
        ws.receive_json()
        ws.send_json({"type": "set_model", "model": "mrt2_base"})
        assert ws.receive_json()["event"] == "error"
    assert deck.restarted_with == []


def test_worker_commands_rejected_while_restarting(client, deck):
    deck.restarting = True
    with connect(client) as ws:
        assert ws.receive_json()["restarting"] is True
        ws.send_json({"type": "play"})
        assert ws.receive_json()["event"] == "error"
    assert deck.cmd_queue.empty()


def test_dead_worker_not_reported_during_restart(client, deck):
    deck.process.alive = False
    deck.restarting = True
    with connect(client) as ws:
        ws.receive_json()
        # Give the pump a few poll intervals; the only thing through must be
        # our sentinel, never worker_died.
        time.sleep(0.5)
        deck.out_queue.put(("status", {"event": "sentinel"}))
        assert ws.receive_json()["event"] == "sentinel"


def test_set_model_rejected_for_model_not_on_disk(client, deck, monkeypatch):
    monkeypatch.setattr(controller.engine, "available_models", lambda: ["mrt2_small"])
    with connect(client) as ws:
        ws.receive_json()
        ws.send_json({"type": "set_model", "model": "mrt2_base"})
        error = ws.receive_json()
        assert error["event"] == "error"
        assert "not downloaded" in error["error"]
    assert deck.restarted_with == []


def test_restart_command_respawns_with_current_model(client, deck):
    deck.process.alive = False
    with connect(client) as ws:
        ws.receive_json()
        ws.send_json({"type": "restart"})
        assert ws.receive_json() == {"event": "model_loading", "model": "mrt2_small"}
        assert wait_until(lambda: deck.restarted_with == ["mrt2_small"])


def test_dead_worker_is_reported_once(client, deck):
    deck.process.alive = False
    with connect(client) as ws:
        ws.receive_json()
        event = ws.receive_json()
        assert event == {"event": "worker_died", "model": "mrt2_small"}
        # Only reported once: the next thing through must not be a repeat.
        deck.out_queue.put(("status", {"event": "sentinel"}))
        assert ws.receive_json()["event"] == "sentinel"


def test_stale_audio_is_drained_on_connect(client, deck):
    deck.out_queue.put(("audio", b"stale"))
    with connect(client) as ws:
        hello = ws.receive_json()
        assert hello["event"] == "hello"
        # Nothing from before the session may reach the client; the first
        # message after hello must be the post-connect one we enqueue now.
        deck.out_queue.put(("status", {"event": "fresh"}))
        assert ws.receive_json()["event"] == "fresh"


@pytest.mark.parametrize(
    ("parsed", "ok"),
    [
        ({"type": "play"}, True),
        ({"type": "stop"}, True),
        ({"type": "restart"}, True),
        ({"type": "set_prompt", "prompt": "x"}, True),
        ({"type": "set_prompt", "prompt": ""}, False),
        ({"type": "set_prompt", "prompt": None}, False),
        ({"type": "set_model", "model": "mrt2_base"}, True),
        ({"type": "set_model", "model": "mrt2_small"}, True),
        ({"type": "set_model", "model": "gpt-5"}, False),
        ({"type": "set_model"}, False),
        ({"type": "shutdown"}, False),
        ({}, False),
        ("play", False),
        (None, False),
    ],
)
def test_validate_command(parsed, ok):
    command, error = validate_command(parsed)
    assert (command is not None) == ok
    assert (error is None) == ok
