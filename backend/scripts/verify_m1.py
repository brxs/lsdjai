"""M1 exit-criteria verification client.

Connects to the deck WebSocket like the browser does, plays for DURATION
seconds, and checks: (1) audio keeps pace with real time after the prebuffer
— a simulated client buffer must never run dry; (2) a prompt change
mid-stream is acknowledged and lands at a chunk boundary. Audio around the
transition is written to a WAV as listening evidence.

Run while the server is up: uv run python scripts/verify_m1.py [duration_s]
"""

import asyncio
import json
import sys
import time
import wave

import numpy as np
from websockets.asyncio.client import connect

URL = "ws://127.0.0.1:8000/ws/deck/a"
SAMPLE_RATE = 48_000
PREBUFFER_SECONDS = 1.5  # mirror the worklet
PROMPT_A = "warm disco funk"
PROMPT_B = "dark minimal techno"


async def main(duration: float) -> None:
    switch_at = duration / 2
    audio_seconds = 0.0
    playback_started_at = None
    min_buffer = float("inf")
    underruns = 0
    chunk_events = []
    prompt_applied = []
    transition_chunks: list[tuple[int, bytes]] = []
    chunks_received = 0
    switched = False

    async with connect(URL, max_size=None) as ws:
        hello = json.loads(await ws.recv())
        print("hello:", hello)
        chunk_seconds = hello["chunk_seconds"]
        switch_chunk_estimate = int(switch_at / chunk_seconds)

        await ws.send(json.dumps({"type": "set_prompt", "prompt": PROMPT_A}))
        await ws.send(json.dumps({"type": "play"}))
        started = time.monotonic()

        while time.monotonic() - started < duration:
            message = await asyncio.wait_for(ws.recv(), timeout=30)
            now = time.monotonic()

            if isinstance(message, bytes):
                chunks_received += 1
                audio_seconds += len(message) / (4 * 2 * SAMPLE_RATE)
                if playback_started_at is None and audio_seconds >= PREBUFFER_SECONDS:
                    playback_started_at = now
                if abs(chunks_received - switch_chunk_estimate) <= 3:
                    transition_chunks.append((chunks_received, message))
            else:
                event = json.loads(message)
                if event.get("event") == "chunk":
                    chunk_events.append(event)
                elif event.get("event") == "style_applied":
                    prompt_applied.append(event)
                    print("style_applied:", event)

            if playback_started_at is not None:
                played = (now - playback_started_at) + PREBUFFER_SECONDS
                buffer = audio_seconds - played
                if buffer < min_buffer:
                    min_buffer = buffer
                if buffer < 0:
                    underruns += 1
                    playback_started_at = None  # re-arm like the worklet

            if not switched and now - started >= switch_at:
                switched = True
                await ws.send(json.dumps({"type": "set_prompt", "prompt": PROMPT_B}))

        await ws.send(json.dumps({"type": "stop"}))

    rtfs = [e["rtf"] for e in chunk_events if e.get("rtf")]
    print(f"\n--- results after {duration:.0f}s ---")
    print(f"chunks received:      {chunks_received} ({audio_seconds:.1f}s audio)")
    print(f"underruns:            {underruns}")
    print(f"min buffer level:     {min_buffer:.2f}s")
    if rtfs:
        print(f"worker RTF min/avg:   {min(rtfs):.2f}x / {sum(rtfs) / len(rtfs):.2f}x")
    second_prompt = [e for e in prompt_applied if e["prompts"][0]["text"] == PROMPT_B]
    boundary = second_prompt[0]["effective_from_chunk"] if second_prompt else None
    print(
        f"prompt switch:        acknowledged={bool(second_prompt)}, effective_from_chunk={boundary}"
    )

    if transition_chunks:
        samples = np.concatenate(
            [
                np.frombuffer(pcm, dtype=np.float32).reshape(-1, 2)
                for _, pcm in transition_chunks
            ]
        )
        with wave.open("m1_transition.wav", "wb") as f:
            f.setnchannels(2)
            f.setsampwidth(2)
            f.setframerate(SAMPLE_RATE)
            f.writeframes((np.clip(samples, -1, 1) * 32767).astype(np.int16).tobytes())
        first = transition_chunks[0][0]
        print(
            f"transition evidence:  m1_transition.wav (chunks {first}..{transition_chunks[-1][0]})"
        )

    passed = underruns == 0 and bool(second_prompt)
    print("VERDICT:", "PASS" if passed else "FAIL")
    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    asyncio.run(main(float(sys.argv[1]) if len(sys.argv) > 1 else 660.0))
