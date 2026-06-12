"""DeckEngine: the only module that talks to magenta_rt.

The upstream API is young and may shift (see docs/spike-mrt2.md for the
measured facts this wrapper relies on); everything else in the backend
depends on this interface instead of magenta_rt directly.
"""

import math

import numpy as np

SAMPLE_RATE = 48_000
CHANNELS = 2
FRAME_SECONDS = 0.04
FRAMES_PER_CHUNK = 25
CHUNK_SECONDS = FRAMES_PER_CHUNK * FRAME_SECONDS

# Models this app knows how to drive; commands are validated against this.
KNOWN_MODELS = ("mrt2_small", "mrt2_base")


def available_models() -> list[str]:
    """KNOWN_MODELS whose files are actually on disk (mrt2_base is an
    optional download), so the UI only offers models that can load."""
    from magenta_rt import paths

    present = []
    for name in KNOWN_MODELS:
        model_dir = paths.models_dir() / name
        if (model_dir / f"{name}.mlxfn").is_file() and (
            model_dir / f"{name}_state.safetensors"
        ).is_file():
            present.append(name)
    return present


# Embeddings are reused across pad-cursor moves; least-recently-used texts
# are evicted, so active pad targets stay cached through a long session.
EMBED_CACHE_SIZE = 32

# Captured-audio styles (M15, ADR-0011): a pad holds at most
# MAX_STYLE_PROMPTS targets, so this only needs to cover a full pad of
# samples. Embeddings die with the worker — the clip is not retained.
SAMPLE_CACHE_SIZE = 8
MIN_SAMPLE_SECONDS = 3
MAX_SAMPLE_SECONDS = 12


class DeckEngine:
    """One model instance generating a continuous stream in 1-second chunks."""

    def __init__(self, model: str = "mrt2_small"):
        # Deferred import: this module is imported by the controller for the
        # constants above, but the heavy magenta_rt stack must only load in
        # the worker process.
        from magenta_rt.mlx import system

        self._system = system.MagentaRT2SystemMlxfn(size=model)
        self._state = None
        self._style = None
        self._embed_cache: dict[str, np.ndarray] = {}
        self._samples: dict[str, np.ndarray] = {}

    def _embed_cached(self, text: str) -> np.ndarray:
        if text in self._embed_cache:
            # Refresh recency: dict order is the LRU order.
            self._embed_cache[text] = self._embed_cache.pop(text)
        else:
            if len(self._embed_cache) >= EMBED_CACHE_SIZE:
                self._embed_cache.pop(next(iter(self._embed_cache)))
            self._embed_cache[text] = self._system.embed_style(text)
        return self._embed_cache[text]

    def set_prompt(self, prompt: str) -> None:
        """Embed a text prompt; takes effect on the next generate_chunk()."""
        self.set_style([(prompt, 1.0)])

    def embed_sample(self, sample_id: str, pcm: bytes) -> None:
        """Embed captured deck audio as a reusable style (M15, ADR-0011).

        `pcm` is the wire format (interleaved stereo float32 LE at
        SAMPLE_RATE). The embedding is cached under `sample_id`, so the
        clip itself is dropped after this call; the FIFO command queue
        guarantees a set_style referencing the id arrives afterwards.
        """
        samples = np.frombuffer(pcm, dtype="<f4")
        if samples.size == 0 or samples.size % CHANNELS:
            raise ValueError("sample PCM must be whole interleaved stereo frames")
        seconds = samples.size / CHANNELS / SAMPLE_RATE
        if not MIN_SAMPLE_SECONDS <= seconds <= MAX_SAMPLE_SECONDS:
            raise ValueError(
                f"sample must be {MIN_SAMPLE_SECONDS}-{MAX_SAMPLE_SECONDS}s, "
                f"got {seconds:.1f}s"
            )
        from magenta_rt import audio

        waveform = audio.Waveform(
            samples=samples.reshape(-1, CHANNELS).astype(np.float32),
            sample_rate=SAMPLE_RATE,
        )
        # Embed before evicting: a failed embed must not cost an
        # unrelated cached entry.
        embedding = self._system.embed_style(waveform)
        if sample_id not in self._samples and len(self._samples) >= SAMPLE_CACHE_SIZE:
            self._samples.pop(next(iter(self._samples)))
        self._samples[sample_id] = embedding

    def set_style(
        self,
        prompts: list[tuple[str, float]],
        sample_keys: frozenset[str] = frozenset(),
    ) -> None:
        """Blend weighted prompt embeddings into the active style.

        MusicCoCa embeddings are plain 768-dim vectors (docs/spike-mrt2.md),
        so a morph between prompts is their weighted average. Keys in
        `sample_keys` resolve from the captured-audio cache (M15) instead
        of the text embedder. Takes effect on the next generate_chunk().
        Tempo is emergent from style — there is deliberately no tempo
        parameter (docs/spike-bpm.md).
        """
        weighted = [(text, weight) for text, weight in prompts if weight > 0]
        if not weighted:
            raise ValueError("set_style needs at least one prompt with weight > 0")
        total = sum(weight for _, weight in weighted)
        blend = np.zeros(0)
        for key, weight in weighted:
            if key in sample_keys:
                if key not in self._samples:
                    # The embedding died with a previous worker (restart /
                    # model switch); the clip is gone, so re-sampling is
                    # the only recovery.
                    raise ValueError(f"unknown sample {key!r} — re-sample the deck")
                # Refresh recency (dict order is the LRU order, like the
                # text cache): a sample still on the pad is touched by
                # every style send, so it can never be the eviction
                # victim while it is live.
                embedding = self._samples.pop(key)
                self._samples[key] = embedding
            else:
                embedding = self._embed_cached(key).astype(np.float32)
            term = (weight / total) * embedding
            blend = term if blend.size == 0 else blend + term
        self._style = blend

    def generate_chunk(self) -> bytes:
        """Generate CHUNK_SECONDS of audio, continuous with the previous call.

        Returns interleaved stereo float32 little-endian PCM at SAMPLE_RATE
        (the WebSocket wire format). With no prompt set the model runs
        unconditioned.
        """
        waveform, self._state = self._system.generate(
            style=self._style, frames=FRAMES_PER_CHUNK, state=self._state
        )
        return waveform.samples.astype(np.float32).tobytes()

    def render_clip(self, prompt: str, seconds: float) -> bytes:
        """Render a standalone clip from a text prompt (M18, ADR-0012).

        Deliberately independent of the live stream: fresh generation
        state and its own style blend, so `self._state`/`self._style`
        — the stream's continuity — are never touched. The worker only
        runs this while the deck is stopped, so render time cannot
        stall pacing. Returns wire-format PCM trimmed to `seconds`.
        """
        style = self._embed_cached(prompt).astype(np.float32)
        state = None
        pieces = []
        for _ in range(math.ceil(seconds / CHUNK_SECONDS)):
            waveform, state = self._system.generate(
                style=style, frames=FRAMES_PER_CHUNK, state=state
            )
            pieces.append(waveform.samples.astype(np.float32))
        samples = np.concatenate(pieces)[: round(seconds * SAMPLE_RATE)]
        return samples.tobytes()
