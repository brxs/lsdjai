"""Deck worker process: runs the generation loop around a DeckEngine.

Commands arrive on cmd_queue as dicts ({"type": "play" | "stop" |
"set_prompt" | "shutdown", ...}). Output goes to out_queue as
("audio", bytes) and ("status", dict) tuples.

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


def run_deck_worker(deck_id: str, model: str, cmd_queue, out_queue) -> None:
    logging.basicConfig(level=logging.INFO)
    logger.info("deck %s: loading %s", deck_id, model)
    engine = DeckEngine(model=model)
    out_queue.put(("status", {"event": "ready", "deck": deck_id, "model": model}))

    playing = False
    prompt: str | None = None
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
            elif kind == "set_prompt":
                prompt = cmd["prompt"]
                started = time.monotonic()
                engine.set_prompt(prompt)
                out_queue.put((
                    "status",
                    {
                        "event": "prompt_applied",
                        "prompt": prompt,
                        "effective_from_chunk": chunk_index,
                        "embed_seconds": round(time.monotonic() - started, 3),
                    },
                ))

        started = time.monotonic()
        pcm = engine.generate_chunk()
        elapsed = time.monotonic() - started
        out_queue.put(("audio", pcm))
        out_queue.put((
            "status",
            {
                "event": "chunk",
                "index": chunk_index,
                "rtf": round(1.0 / elapsed, 2) if elapsed > 0 else None,
                "prompt": prompt,
            },
        ))
        chunk_index += 1
        pace_seconds += CHUNK_SECONDS
