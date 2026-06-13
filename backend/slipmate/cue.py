"""Backend cue sink (ADR-0007): play the browser's cue feed out a
multichannel device's phones pair (channels 3/4 — the DDJ-FLX4's
headphone jack), which Web Audio cannot reach. The browser keeps the
master on channels 1/2 through its own sink; CoreAudio mixes the two
clients. Frames arrive as interleaved stereo float32 LE at 48 kHz —
the recorder worklet's native format.
"""

import collections
import threading

import numpy as np
import sounddevice as sd

SAMPLE_RATE = 48_000
DEVICE_CHANNELS = 4
PHONES_FIRST_CHANNEL = 2  # cue lands on device channels 3/4 (0-indexed 2/3)
STEREO_FRAME_BYTES = 8  # 2 channels x float32
# FIFO cap: a producer outrunning the device trades the excess for a
# bounded ~0.5s of latency instead of unbounded drift.
MAX_BUFFERED_FRAMES = SAMPLE_RATE // 2


def phones_capable_outputs() -> list[dict]:
    """Output devices with enough channels to own a separate phones pair."""
    return [
        {"id": index, "name": device["name"]}
        for index, device in enumerate(sd.query_devices())
        if device["max_output_channels"] >= DEVICE_CHANNELS
    ]


def resolve_output(name: str) -> int:
    """Device index for a phones-capable output matching `name` exactly."""
    for device in phones_capable_outputs():
        if device["name"] == name:
            return device["id"]
    raise ValueError(f"no phones-capable output named {name!r}")


def frames_from_bytes(payload: bytes) -> np.ndarray:
    """Interleaved stereo float32 LE bytes -> (frames, 2) array."""
    if len(payload) == 0 or len(payload) % STEREO_FRAME_BYTES != 0:
        raise ValueError("cue frames must be whole interleaved stereo float32")
    return np.frombuffer(payload, dtype="<f4").reshape(-1, 2)


class CueBuffer:
    """Thread-safe stereo-frame FIFO between the socket and the audio
    callback: underruns pad with silence, overruns drop the oldest audio
    so latency stays bounded."""

    def __init__(self, max_frames: int = MAX_BUFFERED_FRAMES):
        self._max_frames = max_frames
        self._chunks: collections.deque[np.ndarray] = collections.deque()
        self._frames = 0
        self._lock = threading.Lock()

    def push(self, frames: np.ndarray) -> None:
        with self._lock:
            self._chunks.append(frames)
            self._frames += len(frames)
            while self._frames > self._max_frames and self._chunks:
                dropped = self._chunks.popleft()
                self._frames -= len(dropped)

    def pull(self, count: int) -> np.ndarray:
        """Exactly `count` stereo frames, zero-padded on underrun."""
        out = np.zeros((count, 2), dtype=np.float32)
        filled = 0
        with self._lock:
            while filled < count and self._chunks:
                chunk = self._chunks.popleft()
                take = min(len(chunk), count - filled)
                out[filled : filled + take] = chunk[:take]
                if take < len(chunk):
                    self._chunks.appendleft(chunk[take:])
                filled += take
                self._frames -= take
        return out


class CueSink:
    """An open PortAudio stream feeding a device's phones pair."""

    def __init__(self, device_name: str):
        self.buffer = CueBuffer()
        self.stream = sd.OutputStream(
            device=resolve_output(device_name),
            samplerate=SAMPLE_RATE,
            channels=DEVICE_CHANNELS,
            dtype="float32",
            callback=self._callback,
        )
        self.stream.start()

    def _callback(self, outdata, frames, _time, _status) -> None:
        # Channels 1/2 stay silent: the browser owns the master there and
        # CoreAudio sums the clients.
        outdata.fill(0.0)
        outdata[:, PHONES_FIRST_CHANNEL : PHONES_FIRST_CHANNEL + 2] = self.buffer.pull(
            frames
        )

    def push(self, payload: bytes) -> None:
        self.buffer.push(frames_from_bytes(payload))

    def close(self) -> None:
        self.stream.stop()
        self.stream.close()
