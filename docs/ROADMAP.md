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

## Later (not committed)

Ideas parked deliberately — each would get its own ADR if picked up:

- **Tauri desktop wrap** — webview + Python sidecars; revisit trigger in
  ADR-0002.
- **C++ engine (`magentart::core`) backend** — single distributable binary,
  supersedes ADR-0002 if pursued.
- **Controller LED/display feedback beyond M7's stretch** — full
  bidirectional surface state (requires the FLX4 output map).
- **Audio-prompt styles** — MRT styles can come from reference audio, not just
  text: "make deck B sound like this track".
- **Output device picker** (`setSinkId`) / external interface routing.
- **Prompt/preset library** with crates of saved styles.

## Standing risks

| Risk | Impact | Mitigation |
| ---- | ------ | ---------- |
| Machine falls short of two real-time instances | Glitchy decks | Run on Pro/Max-class hardware; `mrt2_small` as default; buffer-health UI (M2) makes shortfall visible |
| BPM not reliably steerable by prompt | M4 scope shrinks | Treated as best-effort from the start; UI follows what works |
| MRT2 streaming API shifts under us (young project) | Rework in workers | Worker isolates all `magenta_rt` calls behind one small interface |
| Memory pressure with `mrt2_base` decks | Crashes mid-session | RAM guardrails in model picker (M3); worker-death recovery |
| FLX4 MIDI map differs from docs / firmware | Dead or wrong controls | Map sourced from the proven Mixxx mapping (docs/midi-ddj-flx4.md); in-app monitor verifies against the device |
| Web MIDI is Chromium-only | No hardware control elsewhere | Accepted (ADR-0005); on-screen UI unaffected |
