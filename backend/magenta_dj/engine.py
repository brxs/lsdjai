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

    def set_prompt(self, prompt: str) -> None:
        """Embed a text prompt; takes effect on the next generate_chunk()."""
        self._style = self._system.embed_style(prompt)

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
