"""DeckEngine.set_style blending logic, with the model stubbed out (the
constructor loads MLX weights, so tests build the instance directly)."""

from types import SimpleNamespace

import numpy as np
import pytest

from magenta_dj.engine import DeckEngine


AUDIO_EMBEDDING = np.array([9.0, -9.0])


def make_engine(embeddings: dict[str, np.ndarray]):
    calls = []

    def embed_style(text_or_audio):
        calls.append(text_or_audio)
        if isinstance(text_or_audio, str):
            return embeddings[text_or_audio]
        return AUDIO_EMBEDDING  # a Waveform (M15 sample path)

    engine = DeckEngine.__new__(DeckEngine)
    engine._embed_cache = {}
    engine._samples = {}
    engine._system = SimpleNamespace(embed_style=embed_style)
    engine._style = None
    return engine, calls


def sample_pcm(seconds: float) -> bytes:
    frames = int(seconds * 48_000)
    return np.zeros(frames * 2, dtype="<f4").tobytes()


def test_blends_weighted_embeddings_normalized():
    engine, _ = make_engine(
        {"funk": np.array([1.0, 0.0]), "techno": np.array([0.0, 1.0])}
    )
    engine.set_style([("funk", 3.0), ("techno", 1.0)])
    np.testing.assert_allclose(engine._style, [0.75, 0.25])


def test_embeddings_are_cached_across_morph_moves():
    engine, calls = make_engine(
        {"funk": np.array([1.0, 0.0]), "techno": np.array([0.0, 1.0])}
    )
    for mix in (0.2, 0.5, 0.8):
        engine.set_style([("funk", 1 - mix), ("techno", mix)])
    assert sorted(calls) == ["funk", "techno"]  # one embed per text, not per move


def test_cache_evicts_least_recently_used_not_oldest(monkeypatch):
    import magenta_dj.engine as engine_module

    monkeypatch.setattr(engine_module, "EMBED_CACHE_SIZE", 2)
    engine, calls = make_engine(
        {
            "funk": np.array([1.0]),
            "techno": np.array([2.0]),
            "dub": np.array([3.0]),
        }
    )
    engine.set_style([("funk", 1.0)])
    engine.set_style([("techno", 1.0)])
    engine.set_style([("funk", 1.0)])  # refresh funk's recency
    engine.set_style([("dub", 1.0)])  # evicts techno, not funk
    engine.set_style([("funk", 1.0)])
    assert calls == ["funk", "techno", "dub"]  # funk never re-embedded


def test_zero_weight_prompts_are_dropped():
    engine, calls = make_engine({"funk": np.array([1.0, 0.0])})
    engine.set_style([("funk", 1.0), ("techno", 0.0)])
    assert calls == ["funk"]
    np.testing.assert_allclose(engine._style, [1.0, 0.0])


def test_all_zero_weights_rejected():
    engine, _ = make_engine({})
    with pytest.raises(ValueError):
        engine.set_style([("funk", 0.0)])


def test_embed_sample_then_blend_with_text():
    engine, _ = make_engine({"funk": np.array([1.0, 1.0])})
    engine.embed_sample("sample:a:1", sample_pcm(4))
    engine.set_style(
        [("funk", 0.5), ("sample:a:1", 0.5)],
        sample_keys=frozenset({"sample:a:1"}),
    )
    np.testing.assert_allclose(engine._style, [5.0, -4.0])  # mean of the two


def test_sample_key_never_hits_the_text_embedder():
    engine, calls = make_engine({})
    engine.embed_sample("sample:a:1", sample_pcm(4))
    engine.set_style([("sample:a:1", 1.0)], sample_keys=frozenset({"sample:a:1"}))
    assert all(not isinstance(call, str) for call in calls)
    np.testing.assert_allclose(engine._style, AUDIO_EMBEDDING)


def test_unknown_sample_id_is_a_clear_error():
    engine, _ = make_engine({})
    with pytest.raises(ValueError, match="re-sample"):
        engine.set_style([("sample:gone", 1.0)], sample_keys=frozenset({"sample:gone"}))


def test_embed_sample_rejects_malformed_pcm():
    engine, _ = make_engine({})
    with pytest.raises(ValueError):
        engine.embed_sample("s", b"\x00" * 6)  # not whole stereo frames
    with pytest.raises(ValueError):
        engine.embed_sample("s", sample_pcm(1))  # under the minimum
    with pytest.raises(ValueError):
        engine.embed_sample("s", sample_pcm(20))  # over the maximum


def test_sample_cache_is_capped(monkeypatch):
    import magenta_dj.engine as engine_module

    monkeypatch.setattr(engine_module, "SAMPLE_CACHE_SIZE", 2)
    engine, _ = make_engine({})
    for index in range(3):
        engine.embed_sample(f"sample:{index}", sample_pcm(4))
    assert list(engine._samples) == ["sample:1", "sample:2"]


def test_sample_cache_evicts_least_recently_used_not_oldest(monkeypatch):
    # A sample still on the pad is touched by every style send, so it
    # must never be the eviction victim while it is live.
    import magenta_dj.engine as engine_module

    monkeypatch.setattr(engine_module, "SAMPLE_CACHE_SIZE", 2)
    engine, _ = make_engine({})
    engine.embed_sample("sample:live", sample_pcm(4))
    engine.embed_sample("sample:old", sample_pcm(4))
    engine.set_style([("sample:live", 1.0)], sample_keys=frozenset({"sample:live"}))
    engine.embed_sample("sample:new", sample_pcm(4))
    assert list(engine._samples) == ["sample:live", "sample:new"]


def test_failed_embed_does_not_evict(monkeypatch):
    import magenta_dj.engine as engine_module

    monkeypatch.setattr(engine_module, "SAMPLE_CACHE_SIZE", 1)
    engine, _ = make_engine({})
    engine.embed_sample("sample:kept", sample_pcm(4))

    def explode(_):
        raise RuntimeError("musiccoca blew up")

    engine._system = SimpleNamespace(embed_style=explode)
    with pytest.raises(RuntimeError):
        engine.embed_sample("sample:new", sample_pcm(4))
    assert list(engine._samples) == ["sample:kept"]


def test_render_clip_leaves_the_stream_untouched():
    engine, _ = make_engine({"air horn": np.array([1.0, 0.0])})
    chunk_calls = []

    def generate(style=None, frames=None, state=None):
        chunk_calls.append((frames, state))
        samples = np.full((48_000, 2), 0.5, dtype=np.float32)
        return SimpleNamespace(samples=samples), "clip-state"

    engine._system.generate = generate
    engine._state = "stream-state"
    engine._style = "stream-style"

    pcm = engine.render_clip("air horn", 1.5)
    # Trimmed to exactly 1.5 s of interleaved stereo float32.
    assert len(pcm) == int(1.5 * 48_000) * 2 * 4
    # ceil(1.5 / CHUNK_SECONDS) = 2 chunks, threaded through a state of
    # their own...
    assert [frames for frames, _ in chunk_calls] == [25, 25]
    assert chunk_calls[1][1] == "clip-state"
    # ...while the live stream's continuity stays untouched.
    assert engine._state == "stream-state"
    assert engine._style == "stream-style"


def test_render_clip_reuses_the_text_embed_cache():
    engine, calls = make_engine({"air horn": np.array([1.0, 0.0])})
    engine._system.generate = lambda style=None, frames=None, state=None: (
        SimpleNamespace(samples=np.zeros((48_000, 2), dtype=np.float32)),
        None,
    )
    engine.render_clip("air horn", 1.0)
    engine.render_clip("air horn", 1.0)
    assert calls == ["air horn"]
