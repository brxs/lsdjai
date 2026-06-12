"""sa3 generation tests: checkout resolution and the subprocess contract.

A stub `python` executable stands in for the sa3_mlx venv so the real
spawn path — argument passing, --out handling, failure and timeout
mapping — is exercised without MLX or weights.
"""

import asyncio
import pathlib

import pytest

from magenta_dj import sa3

FAKE_WAV = b"RIFFfakewavdata"

# Writes the fake WAV to whatever follows --out and records argv beside
# itself (.venv/bin/argv.txt) so tests can assert the CLI contract.
SUCCESS_STUB = """#!/bin/sh
out=""
prev=""
for arg in "$@"; do
    if [ "$prev" = "--out" ]; then out="$arg"; fi
    prev="$arg"
done
printf 'RIFFfakewavdata' > "$out"
echo "$@" > "$(dirname "$0")/argv.txt"
"""

FAILURE_STUB = """#!/bin/sh
echo "error: no DiT weights found"
exit 3
"""

# Exits cleanly without writing the WAV.
SILENT_STUB = """#!/bin/sh
exit 0
"""


def make_checkout(root: pathlib.Path, stub_body: str) -> pathlib.Path:
    """Lay out <root>/optimized/mlx with an executable python stub."""
    mlx_dir = root / "optimized" / "mlx"
    (mlx_dir / ".venv" / "bin").mkdir(parents=True)
    (mlx_dir / "scripts").mkdir()
    (mlx_dir / "scripts" / "sa3_mlx.py").write_text("# stub CLI\n")
    python = mlx_dir / ".venv" / "bin" / "python"
    python.write_text(stub_body)
    python.chmod(0o755)
    return mlx_dir


class TestResolveMlxDir:
    def test_env_override_wins(self, tmp_path):
        mlx_dir = make_checkout(tmp_path / "elsewhere", SUCCESS_STUB)
        resolved = sa3.resolve_mlx_dir(
            env={"SA3_MLX_HOME": str(tmp_path / "elsewhere")}, home=tmp_path / "home"
        )
        assert resolved == mlx_dir

    def test_falls_back_to_conventional_homes(self, tmp_path):
        mlx_dir = make_checkout(tmp_path / "Repos" / "stable-audio-3", SUCCESS_STUB)
        assert sa3.resolve_mlx_dir(env={}, home=tmp_path) == mlx_dir

    def test_documents_home_beats_repos(self, tmp_path):
        make_checkout(tmp_path / "Repos" / "stable-audio-3", SUCCESS_STUB)
        documents = make_checkout(
            tmp_path / "Documents" / "Magenta" / "stable-audio-3", SUCCESS_STUB
        )
        assert sa3.resolve_mlx_dir(env={}, home=tmp_path) == documents

    def test_checkout_without_venv_is_skipped(self, tmp_path):
        checkout = tmp_path / "Repos" / "stable-audio-3"
        (checkout / "optimized" / "mlx" / "scripts").mkdir(parents=True)
        (checkout / "optimized" / "mlx" / "scripts" / "sa3_mlx.py").write_text("#")
        assert sa3.resolve_mlx_dir(env={}, home=tmp_path) is None

    def test_nothing_resolves_to_none(self, tmp_path):
        assert sa3.resolve_mlx_dir(env={}, home=tmp_path) is None


@pytest.fixture
def checkout(tmp_path, monkeypatch):
    """Install a stub checkout, point SA3_MLX_HOME at it, return mlx dir."""

    def install(stub_body):
        mlx_dir = make_checkout(tmp_path / "sa3", stub_body)
        monkeypatch.setenv("SA3_MLX_HOME", str(tmp_path / "sa3"))
        return mlx_dir

    return install


class TestGenerate:
    def test_returns_wav_bytes(self, checkout):
        checkout(SUCCESS_STUB)
        wav = asyncio.run(sa3.generate("vinyl spinback", 3.0, "sfx"))
        assert wav == FAKE_WAV

    def test_passes_the_cli_contract(self, checkout):
        mlx_dir = checkout(SUCCESS_STUB)
        asyncio.run(sa3.generate("deep house loop", 7.74, "music"))
        argv = (mlx_dir / ".venv" / "bin" / "argv.txt").read_text()
        assert "--prompt deep house loop" in argv
        assert "--dit sm-music" in argv
        assert "--decoder same-s" in argv
        assert "--seconds 7.74" in argv
        assert "--steps 8" in argv

    def test_no_checkout_raises_unavailable(self, monkeypatch, tmp_path):
        monkeypatch.delenv("SA3_MLX_HOME", raising=False)
        monkeypatch.setattr(sa3.pathlib.Path, "home", staticmethod(lambda: tmp_path))
        with pytest.raises(sa3.GenerationUnavailable):
            asyncio.run(sa3.generate("anything", 3.0, "sfx"))

    def test_cli_failure_raises_with_output_tail(self, checkout):
        checkout(FAILURE_STUB)
        with pytest.raises(sa3.GenerationFailed, match="no DiT weights"):
            asyncio.run(sa3.generate("anything", 3.0, "sfx"))

    def test_clean_exit_without_wav_is_a_failure(self, checkout):
        checkout(SILENT_STUB)
        with pytest.raises(sa3.GenerationFailed):
            asyncio.run(sa3.generate("anything", 3.0, "sfx"))

    def test_timeout_kills_and_raises(self, checkout, monkeypatch):
        checkout("#!/bin/sh\nsleep 30\n")
        monkeypatch.setattr(sa3, "TIMEOUT_SECONDS", 0.2)
        with pytest.raises(sa3.GenerationFailed, match="timed out"):
            asyncio.run(sa3.generate("anything", 3.0, "sfx"))
