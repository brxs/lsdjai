# M18 checklist — generated pads, by ear

Manual verification of the M18 exit criteria's audible half. The
request shaping, slot lifecycle, error mapping, and the subprocess
contract are unit-tested; `verify_m18.mjs` asserts stream health,
pending → ready honesty, and the bar-grid request against a live
server. This covers what only ears can: the generated audio itself
behaving like deck material in the booth.

## Setup

- [ ] `just run` with the sa3_mlx checkout installed (the four probe
      clips were already judged GO on 2026-06-12).
- [ ] Deck A playing something rhythmic; the BPM stat showing a number.

## SFX one-shots (overlay)

- [ ] Generate an SFX (e.g. "vinyl spinback") — the pad fills in a few
      seconds and the deck never glitches.
- [ ] Fire the pad: the one-shot sounds **on top of** the running
      stream — the stream never ducks or stops.
- [ ] Re-fire mid-ring: the first instance cuts, the new one plays
      (per-pad mono).
- [ ] Sweep an EQ kill while it rings: the one-shot is shaped too
      (it sits before the EQ like everything else on the channel).
- [ ] From the FLX4 SAMPLER bank: the pad LED stays dark while
      generating, lights when ready, and the hardware press fires the
      same overlay.

## Musical loops (replace)

- [ ] Generate a loop (e.g. "rolling techno percussion") with the BPM
      stat locked: the pad fills; firing it replaces the live stream
      and the deck shows **Frozen — looping**.
- [ ] The loop sits on the deck's grid — count along across several
      wraps; no mid-stride stumble at the seam.
- [ ] Color FX and the channel fader stay live on the loop.
- [ ] Re-press returns to the live stream without a glitch.

## Magenta engine (the booth's own third worker)

- [ ] With **both decks playing**, pick Engine: Magenta and generate
      (e.g. "deep dub chords"). The first use takes longer — the
      render worker loads its model inside the pending state — and
      neither stream glitches.
- [ ] The clip sounds like the booth's own engine, not Stable Audio.
- [ ] A second Magenta generation is fast (the worker stays warm).

## Honesty

- [ ] Stop the backend's sa3 checkout being found (e.g.
      `SA3_MLX_HOME=/nowhere just run` in a spare terminal session) and
      generate: the deck shows the setup hint, the slot returns to
      empty, and the decks keep playing. (Skippable if inconvenient —
      the mapping is unit-tested.)
