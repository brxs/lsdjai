"""Stable Audio 3 generation via a spawned sa3_mlx subprocess (ADR-0012).

Nothing here imports sa3_mlx code: the checkout's own venv python runs its
CLI once per generation and the WAV comes back as bytes. The interpreter is
invoked directly — `uv run` would resolve the checkout's repo-root torch
project (measured), and the `./sa3` wrapper exists for humans and may
prompt. Generations are serialised so the transient ~1.5 GB peak never
stacks next to the two deck workers.
"""

import asyncio
import os
import pathlib
import tempfile

# CLI vocabulary of scripts/sa3_mlx.py at the pinned commit (bccf5b7).
# Pads use the small DiTs with the SAME-S decoder; tracks (M19, ADR-0013)
# the medium DiT, which pairs with SAME-L.
KINDS = {"sfx": "sm-sfx", "music": "sm-music", "track": "medium"}
DECODERS = {"sfx": "same-s", "music": "same-s", "track": "same-l"}
SAMPLER_STEPS = 8

MIN_SECONDS = 0.5
MAX_SECONDS = 32.0
# Stability's published ceiling for the medium DiT (6:20).
TRACK_MAX_SECONDS = 380.0
MAX_SECONDS_FOR = {"sfx": MAX_SECONDS, "music": MAX_SECONDS, "track": TRACK_MAX_SECONDS}
MAX_PROMPT_LENGTH = 500

# Measured small-DiT generation is ~1.5 s; the margin covers a cold
# filesystem cache and slower machines, not a first-ever weight download
# (see SETUP_HINT).
TIMEOUT_SECONDS = 120

SETUP_HINT = (
    "sa3_mlx checkout not found - run `just setup-sa3` (clones "
    "https://github.com/Stability-AI/stable-audio-3, installs its MLX venv, "
    "and pre-warms all three DiTs' weights, ~8 GB), or point SA3_MLX_HOME "
    "at an existing checkout"
)


def timeout_for(seconds: float) -> float:
    """Deadline for one generation, scaled to the requested length.

    The published medium benchmark is ~15 s wall for a 2-minute track on
    M4-Pro-class hardware, so a second of deadline per second of audio is
    ~8x slack on top of the flat base — a wedge kill-switch, not a UX
    promise (ADR-0013)."""
    return TIMEOUT_SECONDS + seconds


_generation_lock = asyncio.Semaphore(1)


class GenerationUnavailable(Exception):
    """No usable sa3_mlx checkout on this machine."""


class GenerationFailed(Exception):
    """The CLI ran and did not produce a WAV."""


def resolve_mlx_dir(
    env: dict | None = None, home: pathlib.Path | None = None
) -> pathlib.Path | None:
    """First checkout whose optimized/mlx has a venv and the CLI script.

    $SA3_MLX_HOME wins (pointing at the checkout root); the conventional
    data home and the sibling-repos clone are fallbacks.
    """
    env = os.environ if env is None else env
    home = pathlib.Path.home() if home is None else home
    candidates = []
    override = env.get("SA3_MLX_HOME", "")
    if override:
        candidates.append(pathlib.Path(override).expanduser())
    candidates.append(home / "Documents" / "Magenta" / "stable-audio-3")
    candidates.append(home / "Repos" / "stable-audio-3")
    for checkout in candidates:
        mlx_dir = checkout / "optimized" / "mlx"
        python = mlx_dir / ".venv" / "bin" / "python"
        script = mlx_dir / "scripts" / "sa3_mlx.py"
        if python.is_file() and script.is_file():
            return mlx_dir
    return None


async def generate(prompt: str, seconds: float, kind: str) -> bytes:
    """Run one generation and return the WAV bytes.

    Raises GenerationUnavailable when no checkout resolves and
    GenerationFailed when the CLI errors, times out, or writes nothing.
    Inputs are assumed validated at the trust boundary (controller).
    """
    mlx_dir = resolve_mlx_dir()
    if mlx_dir is None:
        raise GenerationUnavailable(SETUP_HINT)
    async with _generation_lock:
        with tempfile.TemporaryDirectory(prefix="sa3-") as tmp:
            out_path = pathlib.Path(tmp) / "out.wav"
            process = await asyncio.create_subprocess_exec(
                str(mlx_dir / ".venv" / "bin" / "python"),
                str(mlx_dir / "scripts" / "sa3_mlx.py"),
                "--prompt",
                prompt,
                "--dit",
                KINDS[kind],
                "--decoder",
                DECODERS[kind],
                "--seconds",
                f"{seconds:g}",
                "--steps",
                str(SAMPLER_STEPS),
                "--out",
                str(out_path),
                cwd=mlx_dir,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            timeout = timeout_for(seconds)
            try:
                output, _ = await asyncio.wait_for(
                    process.communicate(), timeout=timeout
                )
            except TimeoutError:
                process.kill()
                await process.wait()
                raise GenerationFailed(
                    f"generation timed out after {timeout:g}s"
                ) from None
            if process.returncode != 0 or not out_path.is_file():
                # The CLI's last lines name the problem; progress bars and
                # ANSI noise live further up.
                tail = output.decode(errors="replace").strip()[-500:]
                raise GenerationFailed(tail or "sa3_mlx produced no output")
            return out_path.read_bytes()
