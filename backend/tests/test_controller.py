"""Generation server tests: input validation at the trust boundary for the
render and generate RPC. A fake render worker stands in for the spawned
process; the lifespan (which would shut down a real worker) is harmless to
enter without one.
"""

import asyncio
import queue

import pytest
from fastapi.testclient import TestClient

from slipmate import controller


class FakeProcess:
    def __init__(self):
        self.alive = True

    def is_alive(self):
        return self.alive

    def terminate(self):
        self.alive = False

    def join(self, timeout=None):
        pass


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
def client():
    return TestClient(controller.app)


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


def test_models_endpoint_returns_list_and_ram(client, monkeypatch):
    """The native model picker fetches /api/models (no /ws/deck hello in native)."""
    monkeypatch.setattr(
        controller.engine, "available_models", lambda: ["mrt2_small", "mrt2_base"]
    )
    response = client.get("/api/models")
    assert response.status_code == 200
    body = response.json()
    assert body["models"] == ["mrt2_small", "mrt2_base"]
    assert body["sample_rate"] == 48000
    assert body["total_ram_gb"] > 0
    assert "mrt2_small" in body["model_ram_estimate_gb"]
