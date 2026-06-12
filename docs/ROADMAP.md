# magenta-dj Roadmap

A DJ interface over [Magenta RealTime 2](https://github.com/magenta/magenta-realtime):
two locally-running model "decks" steered by text prompts, blended with a
crossfader. Architecture decisions are recorded in [`adr/`](adr/) — notably
[ADR-0002](adr/0002-browser-app-with-python-model-workers.md) (browser app,
Python model workers) and
[ADR-0003](adr/0003-frontend-audio-mixing-via-web-audio.md) (frontend mixing
via Web Audio).

Milestones are ordered by risk: each one retires the biggest remaining unknown
before building on top of it. No dates — exit criteria gate progression.

Standing assumption: the app runs on Apple Silicon machines with enough
headroom for two concurrent model instances (Pro/Max-class for two
`mrt2_base` decks). Feasibility is taken as given; buffer-health surfacing
(M2) is how a machine that falls short shows it.

## M1 — One deck, audible

**Status: ✅ done (2026-06-09).** Exit criteria verified with
`backend/scripts/verify_m1.py` (full soak run waived); MRT2 API facts
recorded in [`spike-mrt2.md`](spike-mrt2.md).

**Goal:** end-to-end skeleton — model worker → WebSocket → browser playback.

Scope:

- Install `magenta-rt[mlx]` (uv), `mrt models init`; map the streaming API
  from the installed package (class/method names, chunk duration, sample
  rate, state between chunks — it is undocumented online).
- `backend/` (uv project): FastAPI controller; one deck worker process
  (`magenta_rt` MLX) supervised by the controller.
- WebSocket protocol v0: binary frames = PCM chunks; JSON frames = control
  (`play`, `stop`, `set_prompt`).
- Throwaway test page (no React yet) with an AudioWorklet ring buffer
  (retired in M2 as planned).

**Exit criteria:** continuous audio in the browser for 10+ minutes with no
underruns; a prompt change audibly takes effect at the next chunk boundary.

## M2 — Real frontend

**Status: ✅ done (2026-06-09).** Exit criteria verified end-to-end in
headless Chromium (`frontend/scripts/verify_m2.mjs`): deck driven entirely
from the React UI, health row (buffer meter, underrun counter, generation
speed) live in the UI; component tests pin the underrun visibility.

**Goal:** the React app replaces the test page.

Scope:

- `frontend/` (Vite + React + TS), served by the controller in production
  mode, Vite dev server with WS proxy during development.
- Deck component: prompt input, play/stop, volume fader (GainNode).
- Buffer-health indicator per deck (fed by worker status messages + client
  ring-buffer level) — this is how generation-too-slow shows up honestly.

**Exit criteria:** one deck fully usable from the React UI; underruns are
visible in the UI rather than silent glitches.

## M3 — Two decks, crossfader, model picker

**Status: ✅ done (2026-06-09).** Exit criteria verified end-to-end in
headless Chromium (`frontend/scripts/verify_m3.mjs`): both decks on
different prompts, live equal-power crossfade, deck b switched
`mrt2_small` → `mrt2_base` while deck a kept playing with zero underruns.
Worker-death recovery ships with it (worker_died event + restart button).

**Goal:** the actual DJ instrument.

Scope:

- Second deck worker; independent WebSocket per deck.
- Equal-power crossfader on the master bus.
- Per-deck model selection (`mrt2_small` / `mrt2_base`): switching restarts
  that worker only; UI warns when the combined choice looks tight for the
  machine's available RAM.
- Worker-death recovery: deck shows an error state and offers restart instead
  of taking the app down.

**Exit criteria:** start both decks on different prompts, blend between them
live; switch one deck's model while the other keeps playing.

## M4 — Performance features

**Status: ✅ done (2026-06-10).** Exit criteria verified end-to-end
(`frontend/scripts/verify_m4.mjs`). Shipped beyond the original two-slot
scope: each deck has a **2D style pad** with up to 8 prompt targets —
inverse-distance weighting blends the cursor position over all of them
(exact at a target, smooth everywhere else), applied at chunk boundaries
via cached-embedding averaging. Verified with a three-target glide on an
unbroken stream (zero underruns). Tempo proved emergent from style — text
hints are unreliable and injected clock conditioning is not read as a rate
([`spike-bpm.md`](spike-bpm.md), three rounds) — so **no tempo control
ships**; a bpm phrase typed into a style prompt is the honest interface.

**Goal:** smoother, more musical transitions.

Scope:

- Prompt morph within a deck: two prompt slots + morph slider, worker
  re-blends the style embedding per chunk.
- BPM control, best-effort: start with a tempo hint in the prompt; promote to
  per-deck nudge/sync only if steering proves reliable in practice.

**Exit criteria:** a deck can glide between two prompts without a hard style
jump; the UI only exposes the tempo control that actually works (no
overpromising).

## M5 — Recording and polish

**Status: ✅ done (2026-06-10).** Exit criteria verified end-to-end
(`frontend/scripts/verify_m5.mjs`): a 5-minute mix recorded off the master
bus to a valid stereo 48 kHz WAV (300.0 s, non-silent), and a reload
restoring pad arrangements, active style, volumes, and crossfade. Focus
shortcuts (A/B/X) ship with it. The verification also flushed out and
fixed a real reconnect race (a cancelled pump thread could eat the next
session's first event — `backend/scripts/repro_reconnect_echo.py`).

**Goal:** a jam is worth keeping; the app survives a session.

Scope:

- Session recording: tap the master bus, encode WAV client-side, download.
- Polish: keyboard shortcuts for fader/prompt focus, persisted last-used
  prompts/settings, graceful shutdown of workers.

**Exit criteria:** record a 5-minute mix to WAV that matches what was heard;
close/reopen the app and pick up previous settings.

## M6 — Deck EQ: Hi / Mid / Low

**Status: ✅ done (2026-06-10).** Exit criteria verified spectrally
(`frontend/scripts/verify_m6.mjs`): killing deck A's low band measured
**−39.6 dB** in the recorded master (Goertzel filter bank over the WAV)
with the high band untouched, deck B streaming cleanly with isolated
controls throughout, and the kill restored after reload. Known limit: the
mid band is a 1 kHz bell, so its bottom is a deep notch, not a full-band
kill (the shelf+peak trade-off of compact mixer EQs).

**Goal:** cut and boost frequency bands per deck like a DJ mixer — kill the
lows on the incoming deck, swap basslines across the crossfade.

Scope:

- Three BiquadFilterNodes per deck channel in the audio engine
  (ADR-0003's graph grows to: worklet → low shelf (~250 Hz) → mid peaking
  (~1 kHz) → high shelf (~2.5 kHz) → volume → crossfade). Pure, tested
  knob-value → dB curve: centre = flat (0 dB), top = +6 dB boost, bottom =
  full kill (−40 dB).
- Three per-deck EQ controls in the UI (design-system sliders), persisted
  like volume, restored on reload.
- Spectral verification, not vibes: the e2e records the master bus with
  LOW killed vs. flat on a playing deck and asserts the low-band energy
  drop in the WAV (the M5 harness already parses recordings).

**Exit criteria:** killing a band audibly (and measurably, in the recorded
spectrum) removes it while the other deck is unaffected; EQ settings
survive a reload.

## M7 — Hardware control: Pioneer DDJ-FLX4 over Web MIDI

**Status: ✅ done (2026-06-10).** All four scope items shipped (LED stretch
included): ControlBus, the unit-tested FLX4 translation table, Web MIDI
plumbing with the statusbar monitor, and intent wiring through the
existing UI handlers. Exit criteria verified on the physical device
against [`m7-hardware-checklist.md`](m7-hardware-checklist.md) — every
box ticked, including the hands-off mini-set; `verify_m7.mjs` smokes the
provider wiring and connect flow in CI-able form.

**Goal:** perform on physical hardware — the FLX4's surface drives the
decks, mixer, and style pads without touching the mouse. Architecture in
[ADR-0005](adr/0005-hardware-control-via-web-midi-in-the-frontend.md):
Web MIDI in the frontend, dispatching into the existing UI handlers.

Scope, ordered by risk:

1. **MIDI plumbing + monitor.** "Connect MIDI" button (user-gesture
   permission), device detection by name with a status indicator, and a
   debug monitor showing incoming messages. The byte map is already
   documented ([`midi-ddj-flx4.md`](midi-ddj-flx4.md), sourced from the
   Mixxx community mapping + Pioneer's official list); the monitor is the
   verification tool against the physical device's firmware.
2. **ControlBus.** Typed control intents (`{deck, action, value}`) as a
   small pub/sub: Deck and Mixer subscribe with their existing handlers,
   sources (MIDI now, anything later) publish. Keyboard/mouse unchanged.
3. **FLX4 mapping table** — pure and unit-tested, from
   [`midi-ddj-flx4.md`](midi-ddj-flx4.md):
   - channel faders → deck volumes; crossfader → master crossfade
     (14-bit MSB/LSB pairs)
   - PLAY/PAUSE per deck → play/stop
   - EQ HI/MID/LOW knobs → the M6 deck EQ bands (what a DJ expects)
   - performance pads 1–8 → snap the style-pad cursor to target N
     (cue points for prompts)
   - SMART CFX knob → sweep the style-pad cursor around the target
     circle (continuous morph; pads snap, the knob glides)
   - BEAT FX ON/OFF → record toggle
   - tempo sliders deliberately unmapped (ADR-0004); jog wheels unmapped
     in v1
4. **(Stretch) LED feedback** — light pads that have a style target, via
   MIDI out through the same module.

**Exit criteria:** with a DDJ-FLX4 connected, start/stop both decks, ride
the channel faders, EQs, and crossfader, jump styles from the pads and
morph with the CFX knob — hands off the mouse, with every hardware move
reflected live in the UI. Verified with the physical device against a written checklist
(hardware cannot be e2e-automated), plus unit tests for the full mapping
table.

## M8 — UI overhaul: from web page to instrument

**Status: ✅ done (2026-06-10).** Booth topology shipped — deck columns
flanking a centre mixer strip (EQ knob columns, LED channel meters,
vertical faders, crossfader, master/record) with live per-deck waveform
strips, tokens v2, and the full component kit (Knob, VerticalFader,
LevelMeter, TransportButton, Panel). All five e2e suites pass unchanged
in behaviour on the new surface; component CSS is token-only. Before /
after: [`docs/img/ui-before-m8.png`](img/ui-before-m8.png) →
[`docs/img/ui-after-m8.png`](img/ui-after-m8.png).

**Goal:** the app reads as DJ software — booth topology, hardware-style
controls, living signal displays — while behavior, hooks, and the audio
graph stay untouched (purely presentational; no ADR needed, ADR-0003's
architecture is unchanged). Aesthetic direction: rekordbox/Serato-class
dark instrument panels, no vendor trade dress.

Recommended execution order: **M6 (EQ function) → M8 (the face) → M7
(hardware)** — M8 ships the Knob component the EQ wants to live in, and
M7's LED/status work then lands on a stable surface. M8 has no hard
dependency either way.

Scope:

1. **Tokens v2.** Same token-only discipline, new vocabulary: near-black
   panel palette with inset borders (no floating-card shadows), per-deck
   accent colours (deck A ≠ deck B), LED state colours, condensed
   uppercase micro-labels, monospace numeric readouts, tighter spacing,
   small hardware radii. Light-touch motion (LED blink for REC, meter
   decay) — no decorative animation.
2. **Design-system components**, each specced before building (purpose /
   variants / states / API, per the design-system rule):
   - `Knob` — rotary with arc indicator; vertical-drag + arrow keys +
     double-click-to-centre; sizes S/M; used by EQ (M6) and morph sweep.
   - `VerticalFader` — channel volume; the crossfader stays horizontal.
   - `LevelMeter` — segmented LED column from an AnalyserNode, peak hold;
     per channel and master.
   - `TransportButton` — large square, lit state, icon glyphs.
   - `Panel` / `PanelLabel` — the structural chrome with silkscreen
     labels, replacing cards.
3. **Booth layout.** Full-viewport CSS grid, no page scroll:

   ```
   ┌────────────────────────┬──────────┬────────────────────────┐
   │ DECK A waveform strip  │  MASTER  │ DECK B waveform strip  │
   ├────────────────────────┤ meter ·  ├────────────────────────┤
   │ style pad   │ targets  │ REC ·    │ targets    │ style pad │
   │             │ model    │ status   │ model      │           │
   │ transport · readouts   ├──────────┤ transport · readouts   │
   │                        │ EQ knobs │                        │
   │                        │ ch faders│                        │
   │                        │ ─ xfade ─│                        │
   └────────────────────────┴──────────┴────────────────────────┘
   ```

   Connection/model/MIDI state moves into a thin status strip instead of
   prose inside cards.
4. **Per-deck waveform/spectrum strip** (pulled in from "Later"): an
   AnalyserNode tap per deck channel rendering a scrolling waveform or
   spectrum — the buffer-health meter stays, the strip makes the signal
   visible.
5. **Behaviour freeze.** Containers, hooks, reducers, engine, wire
   protocol: untouched. DeckPanel decomposes into presentational pieces;
   i18n keys and accessibility names survive so component tests and the
   e2e suites keep their selectors (updated only where labels genuinely
   change).

**Exit criteria:** the booth layout above at full viewport with the centre
mixer strip; every control rendered from the new design-system components
(no hardcoded colours/spacing outside tokens); live per-deck waveform
strips and channel meters; all existing e2e suites green on the new
surface; before/after screenshots in the PR.

## M9 — Split cue: pre-listen in headphones (PFL)

**Status: 🔶 built (2026-06-10), pending hardware verification.** Cue bus,
per-channel PFL taps, cue/master blend, device picker with the one-off
permission flow — all shipped and unit-tested; ADR-0006 records the
spike-settled routing. Exit criteria await a run of
[`m9-m10-hardware-checklist.md`](m9-m10-hardware-checklist.md).

**Goal:** audition a deck privately before the audience hears it — the
half of DJing the booth still lacks. With deck A on air, prime deck B,
listen to it in headphones, and only then fade it in.

Architecture
([ADR-0006](adr/0006-cue-output-via-a-second-audio-sink.md), settled by
spike): Chromium's Web Audio output is stereo per sink — after
`setSinkId(flx4)`, `maxChannelCount` reports 2, so the FLX4's 4-channel
USB path (phones on 3/4) is unreachable despite the hardware supporting
it (measured in `frontend/scripts/spike_cue_routing.mjs`). The cue feed
therefore goes out a **second sink**: master bus stays on
`context.destination`, cue bus → `MediaStreamAudioDestinationNode` → an
`<audio>` element `setSinkId`-routed to a user-chosen second device
(laptop jack, Bluetooth, built-ins). Intended FLX4 setup: system default
output = FLX4 (master RCA → speakers), headphones on the second device.

Scope, ordered by risk:

1. **Output-routing spike.** Done — see ADR-0006 and the spike script;
   the single-context 4-channel path is rejected on measurement, the
   dual-sink path verified working. Includes the `enumerateDevices`
   permission flow needed to obtain device IDs (one-off mic grant).
2. **Cue bus in the engine.** Per-deck post-EQ, pre-fader tap → per-channel
   cue toggle gain → cue bus, plus a cue/master blend ("MIXING") gain pair
   for the headphone feed. Master bus, meters, and the recorder are
   untouched — the audience and the WAV never hear the cue.
3. **UI.** CUE toggle per channel strip (lit, LED-style), a cue-mix knob,
   and an output-device picker — all persisted like every other setting.

**Exit criteria:** with deck A on the master, toggling deck B's CUE makes
B audible in the headphones only; the mix knob blends cue↔master in the
phones; the audience feed never glitches while cueing; settings survive
a reload. Routing math unit-tested; the full flow verified on hardware
via an extended manual checklist (audio routing cannot be e2e-heard).

## M10 — Hardware cue: prep decks from the FLX4

**Status: 🔶 built (2026-06-10), pending hardware verification.** Channel
CUE buttons, the HEADPHONES MIX knob, and transport-CUE deck prep are
translated, wired, LED-echoed, and unit-tested; verification rides the
same checklist as M9.

**Goal:** the full pre-listen workflow with hands off the mouse,
completing the two-decks-and-headphones instrument.

Scope — bytes sourced from the Mixxx FLX4 mapping like M7's table, to be
verified with the in-app monitor:

1. **Channel CUE buttons** (`0x90`/`0x91` note `0x54`) → toggle each
   channel's headphone cue, with LED echo lighting the active cues.
2. **HEADPHONES MIX knob** (`0xB6` CC `0x0C`, LSB `0x2C` — it does send
   MIDI, unlike a typical analog monitor knob) → the M9 cue/master blend.
3. **Transport CUE buttons** (`0x90`/`0x91` note `0x0C`, the spare
   reserved since M7) → deck prep: CUE on a stopped deck starts
   generation silently (buffer filling, audible only over PFL), PLAY
   then drops it on air instantly; CUE while playing stops with flush.
   The generative analog of cueing a record.
4. New ControlBus intents + translator rows, unit-tested like the M7
   table; checklist addendum for the hardware run.

**Exit criteria:** hands off the mouse: prime deck B with CUE, audition
it via the channel-cue button and mix knob, drop it with PLAY, kill
deck A — cue LEDs mirroring state throughout. Unit tests cover every new
mapping row; verified on the physical device against the checklist.

## M11 — FLX4 phones jack: backend cue sink

**Status: 🔶 built (2026-06-10), pending hardware verification.** Backend
sink (sounddevice, drift-bounded FIFO, one-client socket), browser
capture + stream, and the picker integration shipped and unit-tested on
both sides; verification is the M11 section of
[`m9-m10-hardware-checklist.md`](m9-m10-hardware-checklist.md).

**Goal:** cue through the controller's own headphone jack — master on
the FLX4's RCA, phones on its jack, one USB cable, no Bluetooth.
Architecture in
[ADR-0007](adr/0007-flx4-phones-jack-via-a-backend-cue-sink.md): the
browser can't reach USB channels 3/4, but the backend can, and CoreAudio
mixes both clients on one device.

Scope:

1. **Backend sink.** `sounddevice` output stream on a ≥4-channel device:
   cue frames to channels 3/4, silence to 1/2; a drift-bounded FIFO
   between the WebSocket and the audio callback; `GET /api/cue/outputs`
   lists candidate devices; `/ws/cue` carries interleaved stereo float32
   up from the browser (the recorder worklet's native format).
2. **Frontend capture + stream.** A `pcm-recorder` instance taps the
   cue feed (post-blend); a small client owns the WebSocket lifecycle.
   The phones picker lists backend jacks alongside browser sinks and the
   choice persists like any other device.

**Exit criteria:** headphones in the FLX4's jack carry the cue while the
room hears only the RCA master; blend/PFL behaviour identical to the
browser-sink path; survives reload; pure parts (framing, FIFO, device
filtering) unit-tested; verified on hardware via the M9/M10 checklist's
M11 addendum.

## M12 — Color FX: one-knob effects per deck

**Status: ✅ done (2026-06-10).** The canonical six shipped over pure
curves (ADR-0008) at the pre-fader insert, with the branch-pair bypass
making "off" bit-exact; UI selector + knob per deck, persisted; SMART
CFX remapped to the effect amount with the style sweep on SHIFT + knob.
Exit criteria verified on the physical device against
[`m12-hardware-checklist.md`](m12-hardware-checklist.md) — every box
ticked, including the monitor confirmations that shifted CFX keeps its
CC (the soft-shift assumption holds on this firmware) and that the
PAD FX bank sits at the interpolated `0x10` base, so pads 1–6 select
the effects with truthful LEDs.

**Goal:** sound-shape the running streams like a DJ mixer — per-deck
effects on the model of Pioneer's Sound Color FX: one knob per channel,
centre off, the turn shaping both wet amount and character. The SMART
CFX knob drives it from the hardware — the knob's actual purpose.
Deliberately Color FX and not Beat FX: the synced family (rolls,
beat-delays) needs a tempo grid we don't have (ADR-0004); one-knob
effects are tempo-free.

Scope, ordered by risk:

1. **Effect insert + pure curves (ADR).** Per-deck insert point post-EQ,
   *before* the cue tap and fader, so the phones preview the effect on a
   primed deck exactly like a real mixer. Each effect is a pure
   `amount → parameters` curve (the EQ-math pattern, unit-tested) over a
   small node graph; selecting an effect swaps the graph, centre/zero is
   bit-transparent bypass. ADR records the insert point and the
   one-knob-curve convention.
2. **The canonical six** (DJM/rekordbox Sound Color FX vocabulary), in
   build order:
   - **Filter** — bipolar: left sweeps a low-pass, right a high-pass,
     centre flat (one BiquadFilter; the non-negotiable default)
   - **Dub Echo** — DelayNode + feedback gain + darkening filter in the
     loop; knob = feedback/wet
   - **Space** — ConvolverNode reverb with a generated impulse response;
     knob = wet blend
   - **Crush** — bit/sample-rate reduction in a small AudioWorklet;
     knob = intensity
   - **Noise** — filtered white-noise riser mixed in; knob sweeps its
     filter and level
   - **Sweep** — free-running LFO gate/duck (no tempo sync by design)
   - *(stretch)* **Flanger** and **Phaser** — LFO-modulated delay /
     all-pass chain
3. **UI.** Per-deck effect selector (the model-picker pattern) and an
   amount knob on the deck column; selection and amount persist like
   every other setting; active effect named in the deck status area.
4. **Hardware: the CFX handover.** SMART CFX remaps from style sweep to
   a new `fx_amount` intent (the knob's hardware meaning); the style
   sweep moves to **SHIFT + SMART CFX** if the firmware sends distinct
   bytes for the shifted knob — verify with the in-app monitor before
   relying on it — else the sweep stays on-screen-only (pads keep
   jumping styles regardless). Effect selection lives on the PAD FX
   pad bank: pads 1–6 pick the effect (LED-echoed, re-press for off).

**Exit criteria:** on a playing deck, every shipped effect audibly
transforms the stream and returns to bit-transparent at centre/zero;
the CFX knob rides the active effect with the on-screen knob following;
the cue feed previews effects on a primed deck; selection and amount
survive a reload; curves and the mapping rows unit-tested; verified on
the device against a checklist addendum.

## M13 — Freeze pads: capture and loop the moment

**Status: ✅ done (2026-06-11).** All four scope items shipped: ADR-0009
(capture from the player ring's played history — what was heard, not
what was queued — looped at the channel head behind a live/loop gain
pair), the unit-tested seam and capture-bookkeeping math, the four-slot
loop row with a persisted capture length, and the SAMPLER-bank mapping
with truthful LEDs. Exit criteria verified on the physical device
against [`m13-hardware-checklist.md`](m13-hardware-checklist.md) —
every box ticked, including the monitor confirmation that the SAMPLER
bank sits at the scheme's `0x30` base. Post-checklist hardware use
caught one firmware fact the spot-check missed: held SHIFT moves the
pads onto the shift pad layer (`0x98`/`0x9A`) instead of keeping their
status like the soft-shifted CFX knob, so the clear chord listens
there too.

**Goal:** a generative deck never plays the same thing twice — which is
the magic and the problem. When the model lands on something great,
freeze the last bars into a loop, keep it on air, and re-steer the model
underneath. The generative analog of a loop roll.

Scope, ordered by risk:

1. **Capture + playback design (ADR).** Per-deck ring buffer of the most
   recent deck output, tapped raw (pre-EQ, the recorder-worklet pattern
   from M5/M11) so EQ, Color FX, fader, and cue stay live on the loop.
   Freeze swaps the channel source from the live stream to the captured
   loop; the worker keeps generating into the now-silent stream so
   unfreezing returns to fresh material — M10's deck prep already models
   an inaudible running deck. The ADR records the tap point, the loop
   scheduling (boundary crossfade against clicks), and what the live
   stream does while frozen.
2. **Loop engine.** Capture ring in a worklet; loop playback with a short
   boundary crossfade; loop length adjustable in seconds (quantised to
   whole beats once M14 lands). Scheduling math pure and unit-tested.
3. **UI.** Freeze control and loop length per deck; the waveform strip
   shows frozen state. Loops are session-only — captured audio is
   deliberately not persisted.
4. **Hardware.** Loop slots on a spare FLX4 pad bank — the 0x10-per-bank
   scheme puts SAMPLER at a predictable base, but confirm with the
   in-app monitor before mapping, exactly as PAD FX was in M12. Empty
   pad captures, lit pad plays, re-press returns to live; LEDs truthful
   throughout.

**Exit criteria:** while a deck plays, freezing loops the last bars
seamlessly on air with EQ and Color FX still live; unfreezing returns to
the live stream without a glitch or underrun; the style pad can re-steer
the model while frozen and the new material is there on release; pads
capture and trigger from the FLX4 with truthful LEDs; capture and
scheduling math unit-tested; verified on the device against a checklist
addendum.

## M14 — Beat detection: a tempo estimate from the output

**Status: ✅ done (2026-06-11).** The spike came back ship
([`spike-beat-detection.md`](spike-beat-detection.md)): on a ten-style
generated corpus the shipping estimator tracks every solidly rhythmic
style on a defensible metrical level and never once shows a number
for beatless material — the ambient drone peaks a hair under the
rhythmic styles' confidence, and the gate's stability requirement,
not the threshold, holds that line. Detection runs in the frontend on
the wire feed behind an honesty gate (ADR-0010); the dub echo syncs
to the beat fraction nearest its free-running character and freeze
captures quantise to whole beats, both level-tolerant, both reverting
to free-running the moment the gate blanks. Phase was deliberately
dropped from the scope's `{bpm, confidence, phase}` — no shipped
consumer needs it. Exit criteria verified by ear against
[`m14-hardware-checklist.md`](m14-hardware-checklist.md): the readout
held a hand count for a minute, the synced echo landed on the taps,
and the quantised loops never drifted.

**Goal:** ADR-0004 stands — tempo is not a *generation* parameter — but
detecting tempo on the generated stream is a different question. A
confident BPM estimate unlocks the beat-aware features the booth forgoes
today: tempo-synced Dub Echo, beat-trimmed M13 loops, and an honest BPM
readout per deck.

Scope, ordered by risk:

1. **Spike: is generative output beat-trackable?** Onset detection plus
   autocorrelation over recorded WAVs across styles (four-on-the-floor
   techno through ambient), building on [`spike-bpm.md`](spike-bpm.md).
   The deliverable is a measured confidence gate: when the estimator is
   unsure it must show nothing, never a wrong number. Kill criterion: if
   no style family yields a stable estimate, the milestone parks here —
   the spike is the risk, like M9's routing spike.
2. **Live estimator.** Per-deck onset/tempo tracker producing
   `{bpm, confidence, phase}`; the deck status shows BPM only above the
   gate.
3. **Consumers.** Dub Echo gains a synced mode (delay snaps to a beat
   fraction) at high confidence and stays free-running otherwise; M13
   loop lengths quantise to whole beats when available; *(stretch)* a
   beat-pulsing LED on a spare button.

**Exit criteria:** on a steady rhythmic stream the estimate holds within
±2% of a hand-counted reference for a minute; on beatless material the
readout honestly shows nothing; synced Dub Echo audibly locks to the
groove; estimator math unit-tested against synthetic click tracks and
recorded fixtures.

## M15 — Deck-to-deck style transfer: "sound like deck A"

**Status: ✅ done (2026-06-11).** The spike came back ship (judged by
ear: a 10 s audio embedding carries the source's character and blends
with a contrasting text style; embed latency under 0.5 s — inline in
the worker, ADR-0011). All three scope items shipped: capture from
the source deck's player ring (what was heard, pre-EQ/FX), one-shot
upload to the target worker with FIFO ordering instead of a readiness
handshake, and sampled pad targets that blend/re-sample/remove like
text targets but are deliberately mortal — session-only, stripped
when their worker dies, "re-sample the deck" as the explicit
recovery. The file-drop stretch is deliberately not built. Gate green
(87 backend + 322 frontend tests). Exit criteria verified by ear
against [`m15-hardware-checklist.md`](m15-hardware-checklist.md) —
every box ticked: one action lands the target, deck B audibly takes
on deck A's character and blends by weight, lifetimes honest, both
streams clean throughout.

**Goal:** MRT styles can come from reference audio, not just text — and
the most useful reference in a booth is the *other deck*. One action puts
"the sound of deck A, right now" on deck B's style pad as a blendable
target: a harmonic-mixing substitute for a world with no key or tempo
grid.

Scope, ordered by risk:

1. **Spike: style-from-audio quality (ADR).** Embed ~10 s of generated
   output through MRT's audio-style path and apply it to the other deck;
   judge resemblance by ear and measure embedding latency — it must not
   stall either generating stream (the same isolation rule as everything
   in `engine.py`). The ADR records capture length, where the embedding
   runs, and the caching model (audio embeddings cache like text-prompt
   embeddings).
2. **Capture → worker path.** The recorder-worklet + WebSocket pattern
   from M11 ships the last N seconds of a deck upstream; the worker
   embeds once and caches.
3. **UI + pad integration.** The captured style lands on the style pad
   as a target like any text prompt (labelled as sampled from the other
   deck): weight-blendable, re-sampleable, removable. Persistence is an
   ADR decision — embeddings don't survive a worker restart, so the
   honest options are session-only or persisting the captured clip.
4. ***(Stretch)* file-drop styles** — drop an audio file on the pad as a
   style target; subsumes the previously parked "audio-prompt styles"
   idea.

**Exit criteria:** with deck A playing, one action adds an "A, sampled
now" target to deck B's pad; at full weight B audibly shifts toward A's
character; the target blends with text targets by weight like any other;
neither stream glitches during capture or embedding; the spike's
resemblance and latency findings are recorded in the ADR.

## M16 — Crates: a library of saved styles

**Status: ✅ done (2026-06-11).** All three scope items shipped: the
preset model in the persistence layer (name + text targets + cursor +
Color FX; sampled targets excluded — session-only per ADR-0011) with
a versioned JSON export/import; the crate browser in the centre
column with per-deck save rows under the style pads (loading replaces
the pad wholesale and re-embeds exactly like typing); and the FLX4
browse rotary (relative encoder, decoded before the 14-bit CC
pipeline) + LOAD 1/2 from the Mixxx chart, all mapping rows
unit-tested. Exit criteria verified on the device against
[`m16-hardware-checklist.md`](m16-hardware-checklist.md) — every box
ticked: the rotary/LOAD bytes match the chart with the highlight
moving the right way, presets save and survive a reload, loads land
mid-set on either deck without interrupting the playing stream, and
the export file round-trips.

**Goal:** a set shouldn't be retyped. Save a deck's pad arrangement as a
named preset, organise presets into crates, and load them mid-set — from
the FLX4's browse controls, no laptop needed.

Scope:

1. **Preset model + storage.** Name + pad targets and weights (+ the
   deck's Color FX selection), stored like the rest of persistence
   (`persistence.ts`); JSON export/import for backup and sharing.
2. **UI.** Save-as-preset on the deck, a crate browser, load-to-deck;
   loading re-embeds prompts exactly like typing them (cached embeddings
   make repeats cheap).
3. **Hardware.** The FLX4 browse rotary (turn = highlight, press/LOAD =
   load to deck) — bytes from the Mixxx map, verified with the in-app
   monitor before wiring, mapping rows unit-tested like every table
   since M7.

**Exit criteria:** save a preset, reload the app, browse crates from the
rotary, and load onto deck B while deck A keeps playing uninterrupted;
export/import round-trips; mapping rows unit-tested; verified on the
device against a checklist addendum.

## M17 — Master housekeeping: limiter and gain match

**Status: ✅ done (2026-06-11).** All three scope items shipped: the
master runs through a compressor-as-limiter plus a hard clip guard at
a binary-exact ceiling (119/128 — float32 cannot round above it),
with the meter, the recorder, and the phones' master blend all
tapping post-limiter and the gain reduction shown in the mixer; each
channel gains an auto-gain Trim at its chain head (pre-EQ, live
stream and freeze loops alike) that follows a deliberately slow
loudness tracker toward the target, holds over silence, yields to a
manual move, and persists both mode and value. The review loop
surfaced (and the design now cancels) the compressor's spec-mandated
implicit makeup gain (~+3.4 dB on everything), so the limiter is
level-transparent until it works and the clip guard is a backstop
rather than a routine stage. Exit criteria verified by measurement
(`verify_m17.mjs`, the M6 pattern, against a live server, re-measured
after the compensation): the deliberately hot mix (+12 dB trim, full
EQ boosts, Crush at max, fader at the top) recorded with peak 0.708 —
under the 0.9297 ceiling — while the limiter showed −13.1 dB of
reduction; a loud and a quiet deck on AUTO landed **0.52 dB** apart
through matched faders; and the trims survived a reload exactly. One
measured lesson kept in the script: sparse material (solo piano) is
the wrong gain-match probe — its phrase-to-phrase variance outruns
the deliberately slow tracker.

**Goal:** every real mixer protects its output. Stacked EQ boosts plus
Color FX can push the master past full scale, and decks differ in
inherent loudness; both problems are silent until they ruin a recording.

Scope:

1. **Master limiter.** A limiter ahead of both `context.destination` and
   the recorder tap (the WAV captures what was heard). Start with a
   DynamicsCompressorNode configured as a limiter; reach for a lookahead
   worklet only if measurement shows pumping. The master meter shows
   gain reduction.
2. **Per-deck auto-gain.** A slow loudness tracker per deck feeding a
   trim gain so decks land at comparable level through matched faders;
   manual trim override; channel meters read post-trim.
3. **Measured verification, not vibes** (the M6 pattern): an e2e records
   the master under deliberately hot settings (full EQ boost + Crush)
   and asserts the WAV's peak stays under the ceiling; gain match is
   asserted as an RMS delta between two decks of different loudness.

**Exit criteria:** the recorded master never exceeds the ceiling under a
deliberately hot mix; two decks of clearly different loudness land
within ~1 dB through matched faders; trims and levels persist; verified
by level measurement in e2e like M6.

## M18 — Generated pads: text-to-audio into the loop slots

**Status: ✅ done (2026-06-12).** All five scope items shipped on
ADR-0012's architecture, plus one mid-milestone upgrade: Magenta
rendering got promoted from "borrow a stopped deck's worker" to a
dedicated third engine, so pads fill with the booth's own sound world
while both decks stream. Measured on this machine (Apple M5, 16 GB):
sa3_mlx generates a clip in ~1–1.5 s of whole-process wall (model
load included) at ≤1.5 GB transient, and the integration listen
caught sm-music breaking up below ~4 s — generated loops are floored
at 7 s in whole bars (a 3.6 s request was garbled from CLI and API
alike; 7.2 s clean). Exit criteria verified live (`verify_m18.mjs`,
in `just verify-ui`): zero underruns on both decks through all three
engines — including the render worker's lazy spawn and model load —
the intercepted loop request sat at exactly 4 bars of the locked
134 BPM with the tempo stamped into the prompt, pending → ready
honest on every slot, and a one-shot fired over an active loop left
it frozen. The audible half ticked by ear against
[`m18-checklist.md`](m18-checklist.md): floored loops clean, Magenta
clips unmistakably the booth's engine, one-shots overlaying with EQ
live, SAMPLER LEDs truthful throughout.

**Goal:** the freeze pads (M13) can only capture what a deck already
played. Stable Audio 3's open-weight models generate finished audio
from text in seconds on this class of machine — risers, impacts,
spinbacks, bar-quantised loops — which is exactly what a pad slot
holds. Add "generate to pad": type a prompt, a slot fills, the SAMPLER
pads fire it like any captured loop. Magenta RT stays the only live
engine — Stable Audio is generate-then-play, steerable only before the
sound exists, so it complements the decks and never replaces them.

Scope, ordered by risk:

1. **Backend generator (ADR).** Stability's own MLX port —
   `optimized/mlx` in the `stable-audio-3` repo — pure MLX, no torch,
   no `stable-audio-tools` (whose Python `<3.11` pin shuts it out of
   this backend regardless). The checkout lives outside the repo like
   the Magenta weights, pinned to a commit; the backend never imports
   it — one module spawns its `sa3` CLI per generation and reads back
   the WAV, an isolation rule even stronger than ADR-0002's. Each run
   is a short-lived process with progressive model freeing, so peak
   RAM is transient and nothing competes with the deck workers
   between generations — no resident model, no guardrail. Weights
   (sm-sfx + sm-music + shared codec, ~2.3 GB) auto-download from HF
   under the Community License. Stability's published M4-Pro numbers
   (sm-music: a 5 s clip in 0.8 s wall, ~1.9 GB peak) need confirming
   on this machine and quality is judged by ear; if quality
   disappoints, the milestone parks there.
2. **Pad integration.** The WAV decodes (`decodeAudioData` resamples
   to the engine's 48 kHz) into one of the four M13 slots — same
   playback path, same live/loop gain pair, same SAMPLER pads and
   LEDs; a slot holds a capture or a generation, indistinguishable
   downstream, except a slot now knows its kind: loops loop, SFX
   one-shots fire once and fall silent. Session-only like captures
   (ADR-0009). Generation is async: the slot shows a pending state
   and lights when ready — the M15 sampled-target lifecycle pattern.
3. **UI.** A generate row per deck: prompt field, an engine picker,
   a one-shot/loop toggle, length. For music-model loops, the deck's
   locked BPM (M14) feeds the prompt text and the length quantises to
   whole bars through the existing beat math — free-length the moment
   the gate blanks, honest like every M14 consumer — plus a measured
   quality floor (sm-music breaks up under ~4 s).
4. **Magenta as the third engine.** A dedicated render worker — the
   deck worker loop reused, never told to play — fills pads with the
   booth's own sound world while both decks stream. Spawned lazily on
   first use (~2 GB resident after; the first request carries the
   model load in its pending state), fresh generation state per clip,
   results on a dedicated queue.
5. **Hardware.** Nothing new to map: the M13 SAMPLER bank already
   fires the slots. Generation itself needs text — on-screen by
   design.

**Exit criteria:** typing a prompt fills a chosen pad slot while both
decks keep streaming with zero underruns; an SFX one-shot and a
BPM-quantised musical loop each play through the existing loop path
with EQ and Color FX live; a Magenta-rendered clip fills a pad the
same way while both decks keep playing; pending → ready states are
honest throughout; measured latency and model-choice findings
recorded in the ADR; the decode, quantisation, render, and endpoint
seams unit-tested.

## M19 — Track deck: trade the stream for a composed track

**Status: ⬜ planned.**

**Goal:** a deck can trade its live stream for a finished track.
Stable Audio 3 Medium (1.4B, open weights) composes up to 6:20 from a
prompt; played through an existing deck channel it gives the booth
composed drops and breathers against the other deck's live generative
stream — and every strip control (EQ, Color FX, trim, fader, cue,
crossfader, the FLX4 deck surface) works unchanged because the
channel is unchanged.

Scope, ordered by risk:

1. **Deck source mode (ADR).** A deck's source becomes Magenta stream
   *or* track buffer. The natural feed is the existing player ring —
   decoded track PCM pushed where wire chunks go today, so the
   waveform strip, beat tracker (M14), freeze capture (M13), and
   style sampling (M15) all keep working unexamined — but the ADR
   decides that against a separate buffer-source path, and what
   happens to the model worker in track mode (idle-but-warm for an
   instant return, or released to cut footprint with restart-on-return
   as M3's recovery machinery; generation itself is a transient
   subprocess either way).
2. **Generation pane.** In track mode the style pad pane swaps for a
   generation pane: prompt, length, generate (the M18 endpoint with a
   longer duration, the medium DiT — ~15 s wall for a 2-minute track
   on M4-Pro-class hardware, ~5 GB transient), then a track overview
   with position. Regenerate replaces; the prompt persists, the audio
   is session-only like every captured artefact.
3. **Transport.** PLAY/PAUSE drives track playback through the
   existing intent; CUE returns to the top (deck-prep semantics,
   adapted); seek on the waveform strip; position readout in the deck
   status. End-of-track behaviour is explicit — silence and a clear
   state, not a surprise loop.
4. **Mode switching.** Entering track mode parks the live stream;
   leaving restores the style pad and stream without a reload. The
   switch is deliberate and per-deck — one deck on a track, the other
   live, is the headline use.

**Exit criteria:** generate a track on deck B while deck A streams
uninterrupted; mix it in with fader, EQ, and Color FX exactly like a
live deck, with the BPM readout and synced echo working on the track;
switch the deck back to its live stream without a reload; new intents
and mapping rows unit-tested; verified on the device against a
checklist addendum.

## Later (not committed)

Ideas parked deliberately — each would get its own ADR if picked up:

- **Tauri desktop wrap** — webview + Python sidecars; revisit trigger in
  ADR-0002.
- **C++ engine (`magentart::core`) backend** — single distributable binary,
  supersedes ADR-0002 if pursued.
- **Controller LED/display feedback beyond M7's stretch and M10's cue
  LEDs** — full bidirectional surface state (requires the FLX4 output
  map).
- **Style motion** — automate the style-pad cursor (LFO between targets,
  or record a pad gesture and loop it) so a deck evolves hands-free.

## Standing risks

| Risk | Impact | Mitigation |
| ---- | ------ | ---------- |
| Machine falls short of two real-time instances | Glitchy decks | Run on Pro/Max-class hardware; `mrt2_small` as default; buffer-health UI (M2) makes shortfall visible |
| BPM not reliably steerable by prompt | M4 scope shrinks | Treated as best-effort from the start; UI follows what works |
| MRT2 streaming API shifts under us (young project) | Rework in workers | Worker isolates all `magenta_rt` calls behind one small interface |
| Memory pressure with `mrt2_base` decks | Crashes mid-session | RAM guardrails in model picker (M3); worker-death recovery |
| FLX4 MIDI map differs from docs / firmware | Dead or wrong controls | Map sourced from the proven Mixxx mapping (docs/midi-ddj-flx4.md); in-app monitor verifies against the device |
| Web MIDI is Chromium-only | No hardware control elsewhere | Accepted (ADR-0005); on-screen UI unaffected |
| Stable Audio quality on this machine unjudged (M18/M19) | Generated pads underwhelm or stall adoption | Generation is async and off the audio path; Stability publishes M4-Pro-class benchmarks and the first build re-measures locally, with a park-here kill criterion |
| `sa3_mlx` is a checkout + CLI, not a pinned package | Upstream drift breaks generation | Checkout pinned to a commit; one backend module owns the spawn contract; a missing or failing CLI degrades to a clear error with the decks unaffected |
