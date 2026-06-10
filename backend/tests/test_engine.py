"""DeckEngine.set_style blending logic, with the model stubbed out (the
constructor loads MLX weights, so tests build the instance directly)."""

from types import SimpleNamespace

import numpy as np
import pytest

from magenta_dj.engine import DeckEngine


def make_engine(embeddings: dict[str, np.ndarray]):
    calls = []

    def embed_style(text):
        calls.append(text)
        return embeddings[text]

    engine = DeckEngine.__new__(DeckEngine)
    engine._embed_cache = {}
    engine._system = SimpleNamespace(embed_style=embed_style)
    engine._style = None
    return engine, calls


def test_blends_weighted_embeddings_normalized():
    engine, _ = make_engine(
        {"funk": np.array([1.0, 0.0]), "techno": np.array([0.0, 1.0])}
    )
    engine.set_style([("funk", 3.0), ("techno", 1.0)])
    np.testing.assert_allclose(engine._style, [0.75, 0.25])


def test_bpm_hint_is_embedded_into_the_prompt_text():
    engine, calls = make_engine({"funk, 124 bpm": np.array([1.0])})
    engine.set_style([("funk", 1.0)], bpm=124)
    assert calls == ["funk, 124 bpm"]


def test_embeddings_are_cached_across_morph_moves():
    engine, calls = make_engine(
        {"funk": np.array([1.0, 0.0]), "techno": np.array([0.0, 1.0])}
    )
    for mix in (0.2, 0.5, 0.8):
        engine.set_style([("funk", 1 - mix), ("techno", mix)])
    assert sorted(calls) == ["funk", "techno"]  # one embed per text, not per move


def test_zero_weight_prompts_are_dropped():
    engine, calls = make_engine({"funk": np.array([1.0, 0.0])})
    engine.set_style([("funk", 1.0), ("techno", 0.0)])
    assert calls == ["funk"]
    np.testing.assert_allclose(engine._style, [1.0, 0.0])


def test_all_zero_weights_rejected():
    engine, _ = make_engine({})
    with pytest.raises(ValueError):
        engine.set_style([("funk", 0.0)])
