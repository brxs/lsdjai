"""Deck worker process: runs the generation loop around a DeckEngine.

Commands arrive on cmd_queue as dicts ({"type": "play" | "stop" |
"set_prompt" | "shutdown", ...}). Output goes to out_queue as
("audio", bytes) and ("status", dict) tuples. Clip renders (M18) answer
on the dedicated clip_queue as (id, {"pcm": ...} | {"error": ...}) so
multi-second results never sit behind the audio stream.

Pacing: the model generates faster than real time, so the worker throttles
itself to stay TARGET_AHEAD_SECONDS ahead of wall-clock playback — enough
cushion to absorb a slow chunk, small enough that a prompt change is heard
within a few seconds. The bounded out_queue is only a safety net for a
stalled client.
"""

import logging
import queue
import time

from .engine import CHUNK_SECONDS, DeckEngine

logger = logging.getLogger(__name__)

IDLE_POLL_SECONDS = 0.2
TARGET_AHEAD_SECONDS = 3.0


def run_deck_worker(
    deck_id: str,
    model: str,
    cmd_queue,
    out_queue,
    engine_factory=DeckEngine,
    clip_queue=None,
) -> None:
    logging.basicConfig(level=logging.INFO)
    logger.info("deck %s: loading %s", deck_id, model)
    engine = engine_factory(model=model)
    out_queue.put(("status", {"event": "ready", "deck": deck_id, "model": model}))

    playing = False
    style: dict | None = None
    chunk_index = 0
    # Pacing clock: seconds of audio emitted since play, vs. wall time since
    # play. Reset on every stop→play transition.
    pace_epoch = 0.0
    pace_seconds = 0.0

    while True:
        # Apply every pending command. Blocks while idle, and while playing
        # blocks for exactly the throttle wait, so commands are handled
        # immediately either way.
        while True:
            try:
                if playing:
                    ahead = pace_seconds - (time.monotonic() - pace_epoch)
                    wait = ahead - TARGET_AHEAD_SECONDS
                    if wait > 0:
                        cmd = cmd_queue.get(timeout=wait)
                    else:
                        cmd = cmd_queue.get_nowait()
                else:
                    cmd = cmd_queue.get(timeout=IDLE_POLL_SECONDS)
            except queue.Empty:
                if playing:
                    break  # the next chunk is due
                continue
            kind = cmd["type"]
            if kind == "shutdown":
                logger.info("deck %s: shutting down", deck_id)
                return
            if kind == "play":
                if not playing:
                    playing = True
                    pace_epoch = time.monotonic()
                    pace_seconds = 0.0
            elif kind == "stop":
                playing = False
            elif kind == "render_clip":
                # Worker-side gate, where the truth lives: rendering on a
                # playing deck would stall the pacing loop for seconds.
                if clip_queue is None:
                    # Deck workers ship without a clip queue — only the
                    # render worker gets one. A misrouted render has nowhere
                    # to answer; drop it rather than crash the stream.
                    logger.warning(
                        "deck %s: render_clip with no clip queue; dropped", deck_id
                    )
                elif playing:
                    clip_queue.put((cmd["id"], {"error": "deck is playing"}))
                else:
                    try:
                        pcm = engine.render_clip(cmd["prompt"], cmd["seconds"])
                    except Exception:
                        logger.exception("deck %s: render_clip failed", deck_id)
                        clip_queue.put((cmd["id"], {"error": "render failed"}))
                    else:
                        clip_queue.put((cmd["id"], {"pcm": pcm}))
            elif kind == "embed_sample":
                started = time.monotonic()
                try:
                    engine.embed_sample(cmd["id"], cmd["pcm"])
                except Exception:
                    logger.exception("deck %s: embed_sample failed", deck_id)
                    out_queue.put(
                        (
                            "status",
                            {"event": "error", "error": "sample embed failed"},
                        )
                    )
                else:
                    out_queue.put(
                        (
                            "status",
                            {
                                "event": "sample_embedded",
                                "id": cmd["id"],
                                "embed_seconds": round(time.monotonic() - started, 3),
                            },
                        )
                    )
            elif kind in ("set_prompt", "set_style"):
                started = time.monotonic()
                if kind == "set_prompt":
                    entries = [{"text": cmd["prompt"], "weight": 1.0}]
                else:
                    entries = cmd["prompts"]
                try:
                    # Sampled entries (M15) carry their cache id alongside
                    # the display label; the id is the blend key. Keys
                    # share one namespace: a TEXT prompt typed to exactly
                    # match a live sample id would resolve as that sample.
                    # Accepted — ids are machine-shaped ("sample:a:1") and
                    # the collision needs another entry holding the id in
                    # the same style.
                    engine.set_style(
                        [
                            (entry.get("sample") or entry["text"], entry["weight"])
                            for entry in entries
                        ],
                        sample_keys=frozenset(
                            entry["sample"] for entry in entries if entry.get("sample")
                        ),
                    )
                except Exception:
                    # The deck must survive a bad prompt; the controller
                    # validates shape, but embedding can still fail.
                    logger.exception("deck %s: set_style failed", deck_id)
                    out_queue.put(
                        (
                            "status",
                            {
                                "event": "error",
                                "error": "set_style failed; style unchanged",
                            },
                        )
                    )
                else:
                    style = {"prompts": entries}
                    out_queue.put(
                        (
                            "status",
                            {
                                "event": "style_applied",
                                **style,
                                "effective_from_chunk": chunk_index,
                                "embed_seconds": round(time.monotonic() - started, 3),
                            },
                        )
                    )

        started = time.monotonic()
        try:
            pcm = engine.generate_chunk()
        except Exception:
            logger.exception("deck %s: generation failed; deck stopped", deck_id)
            playing = False
            out_queue.put(
                (
                    "status",
                    {"event": "error", "error": "generation failed; deck stopped"},
                )
            )
            continue
        elapsed = time.monotonic() - started
        out_queue.put(("audio", pcm))
        out_queue.put(
            (
                "status",
                {
                    "event": "chunk",
                    "index": chunk_index,
                    "rtf": round(1.0 / elapsed, 2) if elapsed > 0 else None,
                    "style": style,
                },
            )
        )
        chunk_index += 1
        pace_seconds += CHUNK_SECONDS
