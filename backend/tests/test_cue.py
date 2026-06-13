"""Cue sink tests (ADR-0007): the pure parts — frame decoding, the
drift-bounded FIFO, device filtering/resolution — plus the WebSocket
endpoint with a fake sink. No real PortAudio streams are opened."""

import numpy as np
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from slipmate import controller, cue


def stereo(*pairs: tuple[float, float]) -> np.ndarray:
    return np.array(pairs, dtype=np.float32)


class TestFramesFromBytes:
    def test_decodes_interleaved_stereo_float32(self):
        payload = stereo((0.1, -0.1), (0.5, 0.25)).tobytes()
        frames = cue.frames_from_bytes(payload)
        assert frames.shape == (2, 2)
        assert np.allclose(frames, [[0.1, -0.1], [0.5, 0.25]])

    @pytest.mark.parametrize("payload", [b"", b"\x00" * 7, b"\x00" * 12])
    def test_rejects_partial_frames(self, payload):
        with pytest.raises(ValueError):
            cue.frames_from_bytes(payload)


class TestCueBuffer:
    def test_pull_returns_pushed_frames_in_order(self):
        buffer = cue.CueBuffer()
        buffer.push(stereo((0.1, 0.1)))
        buffer.push(stereo((0.2, 0.2), (0.3, 0.3)))
        assert np.allclose(buffer.pull(3), [[0.1, 0.1], [0.2, 0.2], [0.3, 0.3]])

    def test_underrun_pads_with_silence(self):
        buffer = cue.CueBuffer()
        buffer.push(stereo((0.5, 0.5)))
        pulled = buffer.pull(3)
        assert np.allclose(pulled, [[0.5, 0.5], [0.0, 0.0], [0.0, 0.0]])

    def test_partial_chunk_consumption_keeps_the_remainder(self):
        buffer = cue.CueBuffer()
        buffer.push(stereo((0.1, 0.1), (0.2, 0.2)))
        assert np.allclose(buffer.pull(1), [[0.1, 0.1]])
        assert np.allclose(buffer.pull(1), [[0.2, 0.2]])

    def test_overrun_drops_the_oldest_audio(self):
        buffer = cue.CueBuffer(max_frames=2)
        buffer.push(stereo((0.1, 0.1)))
        buffer.push(stereo((0.2, 0.2)))
        buffer.push(stereo((0.3, 0.3), (0.4, 0.4)))
        pulled = buffer.pull(2)
        assert np.allclose(pulled, [[0.3, 0.3], [0.4, 0.4]])


FAKE_DEVICES = [
    {"name": "MacBook Pro Speakers", "max_output_channels": 2},
    {"name": "DDJ-FLX4", "max_output_channels": 4},
    {"name": "Some Mic", "max_output_channels": 0},
]


class TestDeviceListing:
    def test_lists_only_phones_capable_outputs(self, monkeypatch):
        monkeypatch.setattr(cue.sd, "query_devices", lambda: FAKE_DEVICES)
        assert cue.phones_capable_outputs() == [{"id": 1, "name": "DDJ-FLX4"}]

    def test_resolves_a_device_by_exact_name(self, monkeypatch):
        monkeypatch.setattr(cue.sd, "query_devices", lambda: FAKE_DEVICES)
        assert cue.resolve_output("DDJ-FLX4") == 1

    def test_rejects_unknown_or_stereo_only_names(self, monkeypatch):
        monkeypatch.setattr(cue.sd, "query_devices", lambda: FAKE_DEVICES)
        with pytest.raises(ValueError):
            cue.resolve_output("MacBook Pro Speakers")


class FakeSink:
    instances: list["FakeSink"] = []

    def __init__(self, device_name):
        self.device_name = device_name
        self.pushed = []
        self.closed = False
        if device_name != "DDJ-FLX4":
            raise ValueError(f"no phones-capable output named {device_name!r}")
        FakeSink.instances.append(self)

    def push(self, payload):
        cue.frames_from_bytes(payload)  # same validation as the real sink
        self.pushed.append(payload)

    def close(self):
        self.closed = True


@pytest.fixture
def cue_client(monkeypatch):
    monkeypatch.setattr(controller.cue, "CueSink", FakeSink)
    FakeSink.instances = []
    controller.cue_state["connected"] = False
    return TestClient(controller.app)


class TestCueSocket:
    def test_streams_frames_into_the_sink_and_closes_it(self, cue_client):
        payload = stereo((0.1, 0.2)).tobytes()
        with cue_client.websocket_connect("/ws/cue?device=DDJ-FLX4") as ws:
            assert ws.receive_json() == {"event": "ready"}
            ws.send_bytes(payload)
            ws.send_bytes(payload)
        sink = FakeSink.instances[0]
        assert sink.device_name == "DDJ-FLX4"
        assert sink.pushed == [payload, payload]
        assert sink.closed
        assert controller.cue_state["connected"] is False

    def test_refuses_an_unknown_device_with_a_delivered_reason(self, cue_client):
        # Accept-then-close: the code and reason must survive to the
        # client — they are the user-facing error message.
        with cue_client.websocket_connect("/ws/cue?device=Nope") as ws:
            with pytest.raises(WebSocketDisconnect) as excinfo:
                ws.receive_json()
        assert excinfo.value.code == 4404
        assert "Nope" in excinfo.value.reason

    def test_allows_only_one_client(self, cue_client):
        with cue_client.websocket_connect("/ws/cue?device=DDJ-FLX4") as first:
            assert first.receive_json() == {"event": "ready"}
            with cue_client.websocket_connect("/ws/cue?device=DDJ-FLX4") as second:
                with pytest.raises(WebSocketDisconnect) as excinfo:
                    second.receive_json()
            assert excinfo.value.code == 4409

    def test_reports_malformed_frames_without_dying(self, cue_client):
        with cue_client.websocket_connect("/ws/cue?device=DDJ-FLX4") as ws:
            assert ws.receive_json() == {"event": "ready"}
            ws.send_bytes(b"\x00" * 7)
            error = ws.receive_json()
            assert error["event"] == "error"
            ws.send_bytes(stereo((0.1, 0.1)).tobytes())
        assert len(FakeSink.instances[0].pushed) == 1

    def test_reports_text_frames_without_dying(self, cue_client):
        with cue_client.websocket_connect("/ws/cue?device=DDJ-FLX4") as ws:
            assert ws.receive_json() == {"event": "ready"}
            ws.send_text("not audio")
            error = ws.receive_json()
            assert error["event"] == "error"
            ws.send_bytes(stereo((0.1, 0.1)).tobytes())
        assert len(FakeSink.instances[0].pushed) == 1

    def test_lists_outputs_over_http(self, cue_client, monkeypatch):
        monkeypatch.setattr(cue.sd, "query_devices", lambda: FAKE_DEVICES)
        response = cue_client.get("/api/cue/outputs")
        assert response.status_code == 200
        assert response.json() == [{"id": 1, "name": "DDJ-FLX4"}]
