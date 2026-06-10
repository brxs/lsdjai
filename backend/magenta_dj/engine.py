"""DeckEngine: the only module that talks to magenta_rt.

The upstream API is young and may shift (see docs/spike-mrt2.md for the
measured facts this wrapper relies on); everything else in the backend
depends on this interface instead of magenta_rt directly.
"""

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


# Embeddings are reused across morph-slider moves; texts beyond this are
# evicted oldest-first.
EMBED_CACHE_SIZE = 32


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

    def _embed_cached(self, text: str) -> np.ndarray:
        if text not in self._embed_cache:
            if len(self._embed_cache) >= EMBED_CACHE_SIZE:
                self._embed_cache.pop(next(iter(self._embed_cache)))
            self._embed_cache[text] = self._system.embed_style(text)
        return self._embed_cache[text]

    def set_prompt(self, prompt: str) -> None:
        """Embed a text prompt; takes effect on the next generate_chunk()."""
        self.set_style([(prompt, 1.0)])

    def set_style(
        self, prompts: list[tuple[str, float]], bpm: int | None = None
    ) -> None:
        """Blend weighted prompt embeddings into the active style.

        MusicCoCa embeddings are plain 768-dim vectors (docs/spike-mrt2.md),
        so a morph between prompts is their weighted average. An optional
        tempo hint is appended to each prompt text before embedding
        (docs/spike-bpm.md for how steerable that is). Takes effect on the
        next generate_chunk().
        """
        weighted = [(text, weight) for text, weight in prompts if weight > 0]
        if not weighted:
            raise ValueError("set_style needs at least one prompt with weight > 0")
        total = sum(weight for _, weight in weighted)
        blend = np.zeros(0)
        for text, weight in weighted:
            full = f"{text}, {bpm} bpm" if bpm else text
            embedding = self._embed_cached(full).astype(np.float32)
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
