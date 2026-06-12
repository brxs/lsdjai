"""Worker loop tests: the deck must survive engine failures.

The worker runs in a thread with a fake engine (run_deck_worker only needs
the queue interface, so plain queue.Queue works in place of mp.Queue).
"""

import queue
import threading
import time

import pytest

from magenta_dj.worker import run_deck_worker

FAKE_PCM = b"\x00" * 64


class FakeEngine:
    def __init__(self):
        self.styles = []
        self.style_sample_keys = []
        self.samples = []
        self.renders = []
        self.fail_set_style = False
        self.fail_embed_sample = False
        self.fail_generate = False
        self.fail_render = False

    def render_clip(self, prompt, seconds):
        if self.fail_render:
            raise RuntimeError("render blew up")
        self.renders.append((prompt, seconds))
        return FAKE_PCM

    def set_style(self, prompts, sample_keys=frozenset()):
        if self.fail_set_style:
            raise RuntimeError("embed blew up")
        self.styles.append(prompts)
        self.style_sample_keys.append(sample_keys)

    def embed_sample(self, sample_id, pcm):
        if self.fail_embed_sample:
            raise RuntimeError("audio embed blew up")
        self.samples.append((sample_id, len(pcm)))

    def generate_chunk(self):
        if self.fail_generate:
            raise RuntimeError("inference blew up")
        return FAKE_PCM


class DeckHarness:
    def __init__(self, with_clip_queue=True):
        self.engine = FakeEngine()
        self.cmd_queue = queue.Queue()
        self.out_queue = queue.Queue()
        # Production deck workers run without a clip queue — only the
        # render worker gets one (M18).
        self.clip_queue = queue.Queue() if with_clip_queue else None
        self.thread = threading.Thread(
            target=run_deck_worker,
            args=("test", "fake", self.cmd_queue, self.out_queue),
            kwargs={
                "engine_factory": lambda model: self.engine,
                "clip_queue": self.clip_queue,
            },
            daemon=True,
        )

    def send(self, **command):
        self.cmd_queue.put(command)

    def next_event(self, wanted_kind, timeout=3.0):
        """Return the next ('audio' | status-event-name) payload, skipping others."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                kind, payload = self.out_queue.get(timeout=0.1)
            except queue.Empty:
                continue
            if kind == "audio" and wanted_kind == "audio":
                return payload
            if kind == "status" and payload.get("event") == wanted_kind:
                return payload
        raise AssertionError(f"no {wanted_kind!r} event within {timeout}s")


@pytest.fixture
def deck():
    harness = DeckHarness()
    harness.thread.start()
    harness.next_event("ready")
    yield harness
    harness.send(type="shutdown")
    harness.thread.join(timeout=2)
    assert not harness.thread.is_alive()


def test_play_emits_audio(deck):
    deck.send(type="play")
    assert deck.next_event("audio") == FAKE_PCM
    assert deck.next_event("chunk")["index"] == 0


def test_set_prompt_applies_as_single_prompt_style(deck):
    deck.send(type="set_prompt", prompt="warm disco funk")
    applied = deck.next_event("style_applied")
    assert applied["prompts"] == [{"text": "warm disco funk", "weight": 1.0}]
    assert deck.engine.styles[-1] == [("warm disco funk", 1.0)]


def test_set_style_blends_many_prompts(deck):
    prompts = [
        {"text": "warm disco funk", "weight": 0.5},
        {"text": "dark minimal techno", "weight": 0.3},
        {"text": "dub reggae", "weight": 0.2},
    ]
    deck.send(type="set_style", prompts=prompts)
    applied = deck.next_event("style_applied")
    assert applied["prompts"] == prompts
    assert deck.engine.styles[-1] == [
        ("warm disco funk", 0.5),
        ("dark minimal techno", 0.3),
        ("dub reggae", 0.2),
    ]


def test_set_style_failure_keeps_worker_alive(deck):
    deck.engine.fail_set_style = True
    deck.send(type="set_prompt", prompt="boom")
    assert "set_style failed" in deck.next_event("error")["error"]

    # The deck must still take commands and play afterwards.
    deck.engine.fail_set_style = False
    deck.send(type="set_prompt", prompt="recovered")
    assert deck.next_event("style_applied")["prompts"][0]["text"] == "recovered"
    deck.send(type="play")
    assert deck.next_event("audio") == FAKE_PCM


def test_embed_sample_caches_and_reports(deck):
    deck.send(type="embed_sample", id="sample:a:1", pcm=b"\x00" * 32)
    embedded = deck.next_event("sample_embedded")
    assert embedded["id"] == "sample:a:1"
    assert deck.engine.samples == [("sample:a:1", 32)]


def test_embed_sample_failure_keeps_worker_alive(deck):
    deck.engine.fail_embed_sample = True
    deck.send(type="embed_sample", id="sample:a:1", pcm=b"\x00" * 32)
    assert "sample embed failed" in deck.next_event("error")["error"]

    deck.send(type="play")
    assert deck.next_event("audio") == FAKE_PCM


def test_set_style_resolves_sampled_entries_by_id(deck):
    prompts = [
        {"text": "warm disco funk", "weight": 0.5},
        {"text": "⏺ A·1", "weight": 0.5, "sample": "sample:a:1"},
    ]
    deck.send(type="set_style", prompts=prompts)
    applied = deck.next_event("style_applied")
    # The echo keeps the display entries; the engine blends by id.
    assert applied["prompts"] == prompts
    assert deck.engine.styles[-1] == [
        ("warm disco funk", 0.5),
        ("sample:a:1", 0.5),
    ]
    assert deck.engine.style_sample_keys[-1] == frozenset({"sample:a:1"})


def test_generation_failure_stops_deck_but_worker_survives(deck):
    deck.engine.fail_generate = True
    deck.send(type="play")
    assert "generation failed" in deck.next_event("error")["error"]

    # The failure auto-stopped the deck; play must work again once the
    # engine recovers.
    deck.engine.fail_generate = False
    deck.send(type="play")
    assert deck.next_event("audio") == FAKE_PCM


def test_render_clip_answers_on_the_clip_queue(deck):
    deck.send(type="render_clip", id="clip-1", prompt="air horn", seconds=2.0)
    result_id, result = deck.clip_queue.get(timeout=3.0)
    assert result_id == "clip-1"
    assert result == {"pcm": FAKE_PCM}
    assert deck.engine.renders == [("air horn", 2.0)]


def test_render_clip_refuses_while_playing(deck):
    deck.send(type="play")
    deck.next_event("audio")
    deck.send(type="render_clip", id="clip-2", prompt="air horn", seconds=2.0)
    result_id, result = deck.clip_queue.get(timeout=3.0)
    assert result_id == "clip-2"
    assert result == {"error": "deck is playing"}
    assert deck.engine.renders == []


def test_render_failure_answers_an_error_and_worker_survives(deck):
    deck.engine.fail_render = True
    deck.send(type="render_clip", id="clip-3", prompt="air horn", seconds=2.0)
    _, result = deck.clip_queue.get(timeout=3.0)
    assert result == {"error": "render failed"}

    deck.send(type="play")
    assert deck.next_event("audio") == FAKE_PCM


def test_render_clip_with_no_clip_queue_is_dropped_not_fatal():
    # A misrouted render at a queue-less deck worker has nowhere to
    # answer; it must be dropped, not crash the stream (ADR-0012).
    harness = DeckHarness(with_clip_queue=False)
    harness.thread.start()
    harness.next_event("ready")
    harness.send(type="render_clip", id="clip-9", prompt="air horn", seconds=2.0)
    harness.send(type="set_prompt", prompt="proof of life")
    assert harness.next_event("style_applied")["prompts"] == [
        {"text": "proof of life", "weight": 1.0}
    ]
    assert harness.engine.renders == []
    harness.send(type="shutdown")
    harness.thread.join(timeout=2)
    assert not harness.thread.is_alive()
