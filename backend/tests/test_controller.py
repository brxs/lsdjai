"""Controller WebSocket tests: input validation at the trust boundary and
session cleanup. A fake deck stands in for the worker process; the lifespan
(which spawns real model workers) is deliberately not entered.
"""

import asyncio
import queue
import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from slipmate import controller
from slipmate.controller import validate_command


class FakeProcess:
    def __init__(self):
        self.alive = True

    def is_alive(self):
        return self.alive

    def terminate(self):
        self.alive = False

    def join(self, timeout=None):
        pass


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


class FakeRenderWorker:
    """The third-engine worker, answering render commands immediately."""

    def __init__(self):
        self.cmd_queue = queue.Queue()
        self.clip_queue = queue.Queue()
        self.render_lock = asyncio.Lock()
        self.process = FakeProcess()
        self.ready = False
        self.ready_waits = 0
        # The worker half of the round-trip: a configured response
        # answers any render_clip command.
        self.render_response = None

    def await_ready(self):
        self.ready_waits += 1
        self.ready = True

    def send(self, command):
        self.cmd_queue.put(command)
        if command.get("type") == "render_clip" and self.render_response is not None:
            self.clip_queue.put((command["id"], self.render_response))


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
        # The pump may report the dead worker before the restart ack lands;
        # only the ack's content and the respawn matter here. Bounded so a
        # regression fails instead of hanging.
        for _ in range(5):
            event = ws.receive_json()
            if event["event"] != "worker_died":
                break
        assert event == {"event": "model_loading", "model": "mrt2_small"}
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
        ({"type": "set_style", "prompts": [{"text": "funk"}]}, True),
        (
            {
                "type": "set_style",
                "prompts": [
                    {"text": "funk", "weight": 0.5},
                    {"text": "techno", "weight": 0.3},
                    {"text": "dub", "weight": 0.2},
                ],
            },
            True,
        ),
        ({"type": "set_style", "prompts": []}, False),
        ({"type": "set_style", "prompts": [{"text": "x"}] * 9}, False),
        ({"type": "set_style", "prompts": [{"text": ""}]}, False),
        ({"type": "set_style", "prompts": ["funk"]}, False),
        (
            {
                "type": "set_style",
                "prompts": [{"text": "⏺ A·1", "weight": 1, "sample": "sample:a:1"}],
            },
            True,
        ),
        (
            {"type": "set_style", "prompts": [{"text": "x", "weight": 1, "sample": 7}]},
            False,
        ),
        (
            {
                "type": "set_style",
                "prompts": [{"text": "x", "weight": 1, "sample": "s" * 65}],
            },
            False,
        ),
        ({"type": "set_style", "prompts": [{"text": "funk", "weight": -1}]}, False),
        ({"type": "set_style", "prompts": [{"text": "funk", "weight": 0}]}, False),
        (
            {"type": "set_style", "prompts": [{"text": "funk", "weight": "heavy"}]},
            False,
        ),
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


SAMPLE_FRAME_BYTES = 8  # stereo float32


def sample_body(seconds: float) -> bytes:
    return b"\x00" * int(seconds * 48_000) * SAMPLE_FRAME_BYTES


def test_style_sample_queues_embed_for_the_worker(client, deck):
    response = client.post(
        "/api/deck/a/style-sample?id=sample:a:1", content=sample_body(4)
    )
    assert response.status_code == 200
    assert response.json() == {"id": "sample:a:1", "seconds": 4.0}
    command = deck.cmd_queue.get_nowait()
    assert command["type"] == "embed_sample"
    assert command["id"] == "sample:a:1"
    assert len(command["pcm"]) == len(sample_body(4))


def test_style_sample_rejects_unknown_deck(client, deck):
    response = client.post("/api/deck/zz/style-sample?id=s", content=sample_body(4))
    assert response.status_code == 404


def test_style_sample_rejected_while_restarting(client, deck):
    deck.restarting = True
    response = client.post("/api/deck/a/style-sample?id=s", content=sample_body(4))
    assert response.status_code == 409


def test_style_sample_validates_id_and_body(client, deck):
    no_id = client.post("/api/deck/a/style-sample", content=sample_body(4))
    assert no_id.status_code == 422
    huge_id = client.post(
        f"/api/deck/a/style-sample?id={'s' * 65}", content=sample_body(4)
    )
    assert huge_id.status_code == 422
    ragged = client.post("/api/deck/a/style-sample?id=s", content=b"\x00" * 10)
    assert ragged.status_code == 422
    short = client.post("/api/deck/a/style-sample?id=s", content=sample_body(1))
    assert short.status_code == 422
    # Oversized uploads are refused from the declared length, before the
    # body is buffered — hence 413, not the post-buffering 422.
    long = client.post("/api/deck/a/style-sample?id=s", content=sample_body(20))
    assert long.status_code == 413
    assert deck.cmd_queue.empty()


# --- /api/generate (M18, ADR-0012) ---------------------------------------


def generate_request(**overrides):
    body = {"prompt": "vinyl spinback", "seconds": 3.0, "kind": "sfx"}
    body.update(overrides)
    return body


def test_generate_returns_wav_and_strips_the_prompt(client, monkeypatch):
    calls = []

    async def fake_generate(prompt, seconds, kind):
        calls.append((prompt, seconds, kind))
        return b"RIFFwav"

    monkeypatch.setattr(controller.sa3, "generate", fake_generate)
    response = client.post(
        "/api/generate", json=generate_request(prompt="  deep house loop  ")
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    assert response.content == b"RIFFwav"
    assert calls == [("deep house loop", 3.0, "sfx")]


@pytest.mark.parametrize(
    "body",
    [
        generate_request(prompt=""),
        generate_request(prompt="   "),
        generate_request(prompt=7),
        generate_request(prompt="x" * 501),
        generate_request(kind="banger"),
        generate_request(kind=None),
        generate_request(seconds=0.1),
        generate_request(seconds=33.0),
        generate_request(kind="track", seconds=381.0),
        generate_request(seconds=True),
        generate_request(seconds="3"),
        "not an object",
    ],
)
def test_generate_validates_the_trust_boundary(client, monkeypatch, body):
    async def fake_generate(prompt, seconds, kind):  # pragma: no cover
        raise AssertionError("invalid input must not reach generation")

    monkeypatch.setattr(controller.sa3, "generate", fake_generate)
    response = client.post("/api/generate", json=body)
    assert response.status_code == 422


def test_generate_accepts_a_track_at_track_length(client, monkeypatch):
    # M19 (ADR-0013): 'track' runs the medium DiT with the 6:20 ceiling,
    # while pad kinds keep the small-model 32 s bound.
    calls = []

    async def fake_generate(prompt, seconds, kind):
        calls.append((prompt, seconds, kind))
        return b"RIFFwav"

    monkeypatch.setattr(controller.sa3, "generate", fake_generate)
    response = client.post(
        "/api/generate", json=generate_request(kind="track", seconds=380.0)
    )
    assert response.status_code == 200
    assert calls == [("vinyl spinback", 380.0, "track")]


def test_generate_rejects_nan_seconds(client, monkeypatch):
    # httpx's json= encoder refuses NaN, but Python's json.loads parses it —
    # so it can reach the server, and the boundary must catch it.
    async def fake_generate(prompt, seconds, kind):  # pragma: no cover
        raise AssertionError("invalid input must not reach generation")

    monkeypatch.setattr(controller.sa3, "generate", fake_generate)
    response = client.post(
        "/api/generate",
        content='{"prompt": "x", "seconds": NaN, "kind": "sfx"}',
        headers={"content-type": "application/json"},
    )
    assert response.status_code == 422


def test_generate_maps_missing_checkout_to_503(client, monkeypatch):
    async def fake_generate(prompt, seconds, kind):
        raise controller.sa3.GenerationUnavailable("setup hint")

    monkeypatch.setattr(controller.sa3, "generate", fake_generate)
    response = client.post("/api/generate", json=generate_request())
    assert response.status_code == 503
    assert "setup hint" in response.json()["detail"]


def test_generate_maps_cli_failure_to_502(client, monkeypatch):
    async def fake_generate(prompt, seconds, kind):
        raise controller.sa3.GenerationFailed("error: no DiT weights found")

    monkeypatch.setattr(controller.sa3, "generate", fake_generate)
    response = client.post("/api/generate", json=generate_request())
    assert response.status_code == 502
    assert "no DiT weights" in response.json()["detail"]


# --- /api/render (M18, the third Magenta engine) --------------------------


@pytest.fixture
def render_worker(monkeypatch):
    fake = FakeRenderWorker()
    monkeypatch.setitem(controller.render_state, "worker", fake)
    return fake


def test_float32_wav_wraps_the_pcm_exactly():
    pcm = b"\x00\x00\x80\x3f" * 4  # four float32 ones
    wav = controller.float32_wav(pcm, 48_000, 2)
    assert wav[:4] == b"RIFF"
    assert wav[8:16] == b"WAVEfmt "
    assert int.from_bytes(wav[20:22], "little") == 3  # IEEE float
    assert int.from_bytes(wav[22:24], "little") == 2
    assert int.from_bytes(wav[24:28], "little") == 48_000
    assert int.from_bytes(wav[40:44], "little") == len(pcm)
    assert wav[44:] == pcm


def test_render_returns_the_worker_clip_as_wav(client, render_worker):
    render_worker.render_response = {"pcm": b"\x00" * 16}
    response = client.post("/api/render", json={"prompt": " air horn ", "seconds": 2.0})
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    assert response.content[44:] == b"\x00" * 16
    assert render_worker.ready_waits == 1  # first use waits for the model
    command = render_worker.cmd_queue.get_nowait()
    assert command["type"] == "render_clip"
    assert command["prompt"] == "air horn"
    assert command["seconds"] == 2.0


def test_render_maps_worker_failure_to_502(client, render_worker):
    render_worker.render_response = {"error": "render failed"}
    response = client.post("/api/render", json={"prompt": "air horn", "seconds": 2.0})
    assert response.status_code == 502


def test_render_discards_a_stale_answer_in_the_queue(client, render_worker):
    # A timed-out render answered late; the next request must not be
    # served someone else's clip.
    render_worker.clip_queue.put(("clip-old", {"pcm": b"\xff" * 8}))
    render_worker.render_response = {"pcm": b"\x00" * 8}
    response = client.post("/api/render", json={"prompt": "air horn", "seconds": 2.0})
    assert response.status_code == 200
    assert response.content[44:] == b"\x00" * 8


def test_render_respawns_a_dead_worker(client, render_worker, monkeypatch):
    render_worker.process.alive = False
    spawned = FakeRenderWorker()
    spawned.render_response = {"pcm": b"\x00" * 8}
    # ensure_render_worker sees the dead process and builds a fresh one.
    monkeypatch.setattr(controller, "RenderProcess", lambda: spawned)

    response = client.post("/api/render", json={"prompt": "x", "seconds": 2.0})
    assert response.status_code == 200
    assert spawned.ready_waits == 1


def test_render_timeout_scales_with_length_above_a_floor():
    # M19 (ADR-0013): tracks render for minutes at the measured 1.86×
    # real time; short clips keep the flat pad deadline.
    assert controller.render_timeout_for(2.0) == controller.RENDER_TIMEOUT_SECONDS
    assert controller.render_timeout_for(180.0) == 360.0


def test_render_accepts_a_track_up_to_the_cap(client, render_worker):
    render_worker.render_response = {"pcm": b"\x00" * 8}
    response = client.post("/api/render", json={"prompt": "x", "seconds": 180.0})
    assert response.status_code == 200


def test_render_timeout_kills_the_wedged_worker(client, render_worker, monkeypatch):
    # No configured response: the worker never answers — wedged. The kill
    # plus reset lets the next request respawn clean instead of burning
    # the full timeout against the same wedge (and a late answer from a
    # merely-slow worker can never land in a stranger's request).
    monkeypatch.setattr(controller, "render_timeout_for", lambda seconds: 0.05)
    response = client.post("/api/render", json={"prompt": "air horn", "seconds": 2.0})
    assert response.status_code == 502
    assert not render_worker.process.is_alive()
    assert controller.render_state["worker"] is None


def test_render_fails_fast_when_handed_a_dead_worker(
    client, render_worker, monkeypatch
):
    # A request queued on the lock can hold a worker another request just
    # killed; the in-lock liveness check answers at once instead of
    # burning the render timeout against the corpse.
    def handed_a_corpse():
        render_worker.process.alive = False
        return render_worker

    monkeypatch.setattr(controller, "ensure_render_worker", handed_a_corpse)
    monkeypatch.setattr(controller, "render_timeout_for", lambda seconds: 0.05)
    response = client.post("/api/render", json={"prompt": "air horn", "seconds": 2.0})
    assert response.status_code == 502
    assert response.json()["detail"] == "render engine died"
    assert controller.render_state["worker"] is None


def test_render_start_failure_discards_the_worker(client, render_worker):
    def never_ready():
        raise queue.Empty

    render_worker.await_ready = never_ready
    response = client.post("/api/render", json={"prompt": "air horn", "seconds": 2.0})
    assert response.status_code == 502
    assert not render_worker.process.is_alive()
    assert controller.render_state["worker"] is None


@pytest.mark.parametrize(
    "body",
    [
        {"prompt": "", "seconds": 2.0},
        {"prompt": "x" * 501, "seconds": 2.0},
        {"prompt": "x", "seconds": 0.1},
        {"prompt": "x", "seconds": 181.0},
        {"prompt": "x", "seconds": True},
        "not an object",
    ],
)
def test_render_validates_the_trust_boundary(client, render_worker, body):
    render_worker.render_response = {"pcm": b"\x00" * 8}
    response = client.post("/api/render", json=body)
    assert response.status_code == 422
    assert render_worker.cmd_queue.empty()
