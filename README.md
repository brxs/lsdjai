<p align="center">
  <img src="docs/img/slipmate-demo.gif" alt="SlipMate — generative DJ" width="640">
</p>

<p align="center"><strong>Your generative DJ mate</strong> — a DJ instrument for real-time AI music.</p>

<p align="center">
  <a href="https://buymeacoffee.com/brxs"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy me a coffee" height="42"></a>
</p>

Two locally-running model decks, steered by text prompts and mixed like vinyl:
three-band EQ, one-knob Color FX, a crossfader, headphone cue, and full
Pioneer DDJ-FLX4 control. The live decks run on
[Magenta RealTime 2](https://github.com/magenta/magenta-realtime); generated
pads and finished tracks come from Stable Audio 3. See
[`docs/ROADMAP.md`](docs/ROADMAP.md) for how it got here and
[`docs/adr/`](docs/adr/) for the architecture decisions.

## Requirements

- Apple Silicon Mac (MLX backend)
- [uv](https://docs.astral.sh/uv/)
- ~13 GB disk for model weights (downloaded on first setup: Magenta
  ~4.5 GB for both deck models, Stable Audio 3 ~8 GB including the
  medium track model)
- A Chromium-based browser (the app leans on Web Audio worklets and Web MIDI;
  it is developed and verified against Chrome)
- Optional: a Pioneer DDJ-FLX4 for hardware control and its headphone jack

All common tasks live in the [`justfile`](justfile) — run `just` to list them.

## Setup

```sh
just setup   # backend deps, all model weights (~13 GB), frontend deps + build
```

Magenta models land in `~/Documents/Magenta/magenta-rt-v2` (override with
`MAGENTA_HOME`): both deck models, the default `mrt2_small` and the heavier,
higher-quality `mrt2_base`, selectable per deck in the UI — the app warns
when the combined selection looks tight for your RAM. Stable Audio 3 —
generated pads and tracks — is cloned to `~/Repos/stable-audio-3` (override
with `SA3_MLX_HOME`; an existing checkout is reused) and its weights are
pre-warmed so no request ever pays for a download; `just setup-sa3` re-runs
that half alone.

## Run

```sh
just run
```

Then open <http://127.0.0.1:8000> — add style targets to a deck's pad, hit
play, blend targets by dragging the cursor (or the dots themselves, to
cluster them), and ride the crossfader between decks.

- **Mixer** — per-deck volume and Hi/Mid/Low EQ, crossfader, and **Record**,
  which captures the master bus to a downloadable WAV. The health row shows
  the stream buffer, underrun count, and generation speed.
- **Color FX** — one knob per deck over a chosen effect: Filter (bipolar
  LPF/HPF), Dub Echo, Space, Crush, Noise, Sweep. The knob's centre/zero is a
  bit-exact bypass ([ADR-0008](docs/adr/0008-color-fx-as-one-knob-curves-at-a-pre-fader-insert.md)).
- **Freeze loops** — capture the last bars of a deck into one of four
  loop slots and hold the moment on air while you re-steer the model
  underneath; loops are session-only by design
  ([ADR-0009](docs/adr/0009-freeze-pads-loop-played-audio-at-the-channel-head.md)).
- **Beat detection** — each deck shows its detected BPM behind an
  honesty gate (a dash rather than a wrong number); with a confident
  tempo the Dub Echo syncs to the beat and freeze captures quantise to
  whole beats
  ([ADR-0010](docs/adr/0010-beat-detection-on-the-output-behind-an-honesty-gate.md)).
- **Deck-to-deck style sampling** — one press puts "the sound of the
  other deck, right now" on a deck's style pad as a blendable target;
  sampled targets are session-only by design
  ([ADR-0011](docs/adr/0011-deck-to-deck-style-sampling-via-audio-embeddings.md)).
- **Crates** — save a deck's pad + Color FX as a named preset, browse
  the crate from the FLX4's rotary, and load onto either deck mid-set;
  export/import as JSON for backup and sharing.
- **Master housekeeping** — a limiter on the master (the meter, the
  recording, and the phones all hear the limited signal; its gain
  reduction shows in the mixer) and per-channel auto-gain Trim that
  levels decks of different loudness, with a manual override.
- **Headphone cue** — hit a channel's **Cue**, ride the **Cue mix** knob
  between cue and master, and pick a **Phones out**: any output device the
  browser can reach, or the FLX4's own headphone jack, which is fed by the
  backend over USB ([ADR-0007](docs/adr/0007-flx4-phones-jack-via-a-backend-cue-sink.md)).

Settings (pad arrangements, volumes, crossfade) persist across reloads.
Shortcuts: `A`/`B` focus a deck's style-target input, `X` focuses the
crossfader.

For frontend development: `just dev-backend` in one terminal, `just
dev-frontend` in another (the Vite dev server proxies `/ws` to the backend).

## Hardware control (Pioneer DDJ-FLX4)

Plug in the FLX4 and click **Connect MIDI** (Chrome asks for MIDI with SysEx;
plain MIDI works too, minus position sync). Mapped controls:

- Play/pause, channel faders, three-band EQ, crossfader
- Channel **CUE** buttons (headphone cue) and the transport **CUE** button
  (deck prep: prime a stopped deck off-air, stop a playing one)
- **SMART CFX** knob — Color FX amount; hold **SHIFT** to sweep the style pad
  instead
- **PAD FX** pad bank — select the deck's effect (re-press toggles it off);
  **HOT CUE** pads pick style targets; **SAMPLER** pads freeze loops
  (SHIFT + pad clears a slot)
- **HEADPHONES MIX** knob — cue mix
- **Browse rotary + LOAD buttons** — highlight a crate preset, load it
  onto deck 1 or 2

Knob and fader positions sync from the hardware on connect, and the LEDs
mirror app state. The measured byte map lives in
[`docs/midi-ddj-flx4.md`](docs/midi-ddj-flx4.md).

## Verify

- `just test` — backend pytest + frontend vitest
- `just lint` — format check, ruff, eslint, tsc
- `just check` — both of the above; what a PR must pass
- `just verify-stream` / `just verify-ui` — e2e against a running server
  (UI e2e needs Playwright Chromium once: `npx playwright install chromium`
  in `frontend/`)
- `just verify-worklets` — the audio-worklet module graph loads in real
  Chromium (self-contained; jsdom executes none of the worklet code)
- Hardware behaviour is verified by a human against the checklists in
  `docs/` (`m7-`, `m9-m10-`, `m12-hardware-checklist.md`)
