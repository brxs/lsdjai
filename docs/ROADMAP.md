# magenta-dj Roadmap

A DJ interface over [Magenta RealTime 2](https://github.com/magenta/magenta-realtime):
two locally-running model "decks" steered by text prompts, blended with a
crossfader — grown by M19 into a hybrid booth where a deck can also play a
composed track. Architecture decisions are recorded in [`adr/`](adr/) —
notably [ADR-0002](adr/0002-browser-app-with-python-model-workers.md)
(browser app, Python model workers) and
[ADR-0003](adr/0003-frontend-audio-mixing-via-web-audio.md) (frontend
mixing via Web Audio).

Milestones are ordered by risk: each one retires the biggest remaining
unknown before building on top of it. No dates — exit criteria gate
progression. Done milestones below are deliberately terse; the full
scope, exit criteria, and measured records live in this file's git
history and the linked ADRs/checklists.

Standing assumption: Apple Silicon with headroom for two concurrent
model instances (Pro/Max-class for two `mrt2_base` decks); buffer-health
surfacing (M2) is how a machine that falls short shows it.

## Done

### M1 — One deck, audible ✅ (2026-06-09)

Worker → WebSocket → browser playback skeleton; protocol v0 (binary PCM
+ JSON control). MRT2 API facts measured into
[`spike-mrt2.md`](spike-mrt2.md); verified by `verify_m1.py`.

### M2 — Real frontend ✅ (2026-06-09)

React app replaces the test page; per-deck health row (buffer meter,
underrun counter, generation speed) makes generation-too-slow honest.
Verified by `verify_m2.mjs`.

### M3 — Two decks, crossfader, model picker ✅ (2026-06-09)

Independent deck workers, equal-power crossfade, per-deck
`mrt2_small`/`mrt2_base` picker with a RAM warning, worker-death
recovery (error state + restart). Verified by `verify_m3.mjs`.

### M4 — Performance features ✅ (2026-06-10)

The 2D style pad: up to 8 prompt targets, inverse-distance blending
applied at chunk boundaries via cached embeddings. Tempo proved emergent
from style — not steerable by hint or clock conditioning
([`spike-bpm.md`](spike-bpm.md)) — so no tempo control ships
([ADR-0004](adr/0004-style-is-a-weighted-prompt-blend-tempo-is-not-a-parameter.md)).
Verified by `verify_m4.mjs`.

### M5 — Recording and polish ✅ (2026-06-10)

Master-bus recording to WAV, persisted settings, focus shortcuts; fixed
a real reconnect race (`backend/scripts/repro_reconnect_echo.py`).
Verified by `verify_m5.mjs`.

### M6 — Deck EQ: Hi / Mid / Low ✅ (2026-06-10)

Three-band EQ per deck with kill (low-kill measured **−39.6 dB** in the
recorded master); known limit: the mid is a 1 kHz bell, so its bottom is
a deep notch, not a full-band kill. Verified spectrally by
`verify_m6.mjs`.

### M7 — Hardware control: DDJ-FLX4 over Web MIDI ✅ (2026-06-10)

[ADR-0005](adr/0005-hardware-control-via-web-midi-in-the-frontend.md):
ControlBus intents, the unit-tested FLX4 translation table from
[`midi-ddj-flx4.md`](midi-ddj-flx4.md), the statusbar monitor as the
firmware arbiter, pad LED echo. Verified on the device against
[`m7-hardware-checklist.md`](m7-hardware-checklist.md).

### M8 — UI overhaul: from web page to instrument ✅ (2026-06-10)

Booth topology (deck columns flanking the mixer strip), tokens v2, the
component kit (Knob, VerticalFader, LevelMeter, TransportButton, Panel),
live waveform strips. Purely presentational; before/after in
[`img/`](img/).

### M9 — Split cue: pre-listen in headphones 🔶 built (2026-06-10)

Cue bus with per-channel PFL taps and a cue/master blend out a **second
sink** ([ADR-0006](adr/0006-cue-output-via-a-second-audio-sink.md) —
Chromium caps Web Audio at stereo per sink, measured). Pending a formal
run of [`m9-m10-hardware-checklist.md`](m9-m10-hardware-checklist.md).

### M10 — Hardware cue from the FLX4 🔶 built (2026-06-10)

Channel CUE buttons, HEADPHONES MIX knob, and transport-CUE deck prep
(generate off air, drop with PLAY), LED-echoed; same checklist as M9.

### M11 — FLX4 phones jack: backend cue sink 🔶 built (2026-06-10)

The browser can't reach USB channels 3/4; the backend can
([ADR-0007](adr/0007-flx4-phones-jack-via-a-backend-cue-sink.md)):
sounddevice sink, drift-bounded FIFO, `/ws/cue` carrying the cue feed
up. Same checklist, M11 addendum.

### M12 — Color FX: one-knob effects per deck ✅ (2026-06-10)

The canonical six (Filter, Dub Echo, Space, Crush, Noise, Sweep) as pure
amount→parameter curves at a pre-fader insert with bit-exact bypass
([ADR-0008](adr/0008-color-fx-as-one-knob-curves-at-a-pre-fader-insert.md));
SMART CFX drives the amount, style sweep on SHIFT, PAD FX bank selects.
Verified against [`m12-hardware-checklist.md`](m12-hardware-checklist.md).

### M13 — Freeze pads: capture and loop the moment ✅ (2026-06-11)

Capture the player ring's played history into four loop slots, looped at
the channel head behind a live/loop gain pair
([ADR-0009](adr/0009-freeze-pads-loop-played-audio-at-the-channel-head.md));
SAMPLER bank with truthful LEDs. Firmware fact: held SHIFT moves pads to
the shift pad layer (`0x98`/`0x9A`). Verified against
[`m13-hardware-checklist.md`](m13-hardware-checklist.md).

### M14 — Beat detection behind an honesty gate ✅ (2026-06-11)

Frontend onset/tempo estimator on the wire feed
([ADR-0010](adr/0010-beat-detection-on-the-output-behind-an-honesty-gate.md),
[`spike-beat-detection.md`](spike-beat-detection.md)): shows a BPM only
after stable confident agreement, never a wrong number. Consumers:
synced Dub Echo, beat-quantised loop captures. Phase deliberately
dropped (no consumer needed it — until M20). Verified against
[`m14-hardware-checklist.md`](m14-hardware-checklist.md).

### M15 — Deck-to-deck style transfer ✅ (2026-06-11)

"Sound like deck A": ~10 s of the other deck's played audio embedded as
a blendable pad target
([ADR-0011](adr/0011-deck-to-deck-style-sampling-via-audio-embeddings.md));
sampled targets are deliberately mortal (session-only, die with their
worker). Verified against
[`m15-hardware-checklist.md`](m15-hardware-checklist.md).

### M16 — Crates: a library of saved styles ✅ (2026-06-11)

Named presets (text targets + cursor + Color FX) with versioned JSON
export/import; browse + load from the FLX4 rotary and LOAD buttons.
Verified against [`m16-hardware-checklist.md`](m16-hardware-checklist.md).

### M17 — Master housekeeping: limiter and gain match ✅ (2026-06-11)

Compressor-as-limiter (implicit makeup gain measured and cancelled) plus
a hard clip guard at a binary-exact ceiling; per-channel auto-trim
toward a loudness target. Measured: a deliberately hot mix peaked 0.708
under the 0.9297 ceiling; two unlike decks landed **0.52 dB** apart on
AUTO. Verified by measurement in `verify_m17.mjs`.

### M18 — Generated pads: text-to-audio into the loop slots ✅ (2026-06-12)

Stable Audio 3 small models via a spawned `sa3_mlx` subprocess
([ADR-0012](adr/0012-generated-pads-via-a-spawned-sa3-mlx-subprocess.md))
plus Magenta as a dedicated third render engine. Measured: ~1–1.5 s
whole-process wall per clip, ≤1.5 GB transient; sm-music loops floored
at 7 s (breaks up under ~4 s). Verified by `verify_m18.mjs` +
[`m18-checklist.md`](m18-checklist.md).

### M19 — Track deck: trade the stream for a composed track ✅ (2026-06-12)

[ADR-0013](adr/0013-playback-decks-play-decoded-tracks-loading-decides-the-mode.md):
a deck's mode is realtime or playback, and **loading decides it** — the
Media Explorer below the booth owns all loading (crates folded in,
Generate with all four models, a session-only folder browser, the live
stream itself loadable). Playback is a buffer source through the live
gain: transport, overview + jog seeking, offline BPM at load, a rolling
deck keeps rolling across mode switches. Measured: SA3 medium composes
2:00 in **14.9 s wall at 4.9 GB peak**; all weights moved into
`just setup`. Verified by `verify_m19.mjs` +
[`m19-hardware-checklist.md`](m19-hardware-checklist.md).

## M20 — Beatgrids and sync: the track follows the booth

**Status: 🔶 built (2026-06-12), pending hardware verification.** All
four scope items shipped on ADR-0014: the offline grid pass (period
refined by fold-resultant search, drift refused by half-split
agreement — a 120→126 splice yields no grid), varispeed with the
tempo sliders mapped at last, SYNC from gated BPMs alone (the grid
cannot take tempo-matching down with it), the dual-role jog
(paused = seek, playing = stepped-bend phase nudge), grid ticks on
the overview, and a phase meter comparing the track's grid clock
against the live deck's beat **at the speakers** — the worklet now
reports consumed frames in its own clock, because the wire feed
leads the room by the buffer. Hardened against real material: both
folds ride the LOW band's linear energy rise (full-band and even
log-domain folds cancel against offbeat hats), the grid floor is
calibrated on real renders (rolling techno folds at 0.50–0.65;
each half owes its own coherence so a spliced tempo still refuses),
and a single breathing estimate rides out on the gate's grace.
Measured live (`verify_m20.mjs`): SYNC landed the gated stream BPM
to the decimal, and a track-to-track lock held a full minute at
**0.000 beats/min drift**. The audible half awaits
[`m20-hardware-checklist.md`](m20-hardware-checklist.md).

**Goal:** real beat-matching. A playback deck holds its entire decoded
buffer, so a proper **beatgrid** — BPM *and* beat phase — is computable
offline at load, far more accurately than any live estimate; and
`AudioBufferSourceNode.playbackRate` gives varispeed for free. The live
stream cannot change tempo (ADR-0004 stands for generation), so sync is
one-directional by design: **the track follows the booth** — match the
track's rate to the other deck's gated BPM, then ride the phase.

Scope, ordered by risk:

1. **Beatgrid analysis (ADR).** Extend the M14 estimator family with an
   offline grid pass: BPM plus first-beat phase over the decoded buffer,
   constant-tempo assumption recorded (generated tracks are steady;
   folder tracks may drift — measure on a corpus). Same honesty rule as
   M14: no confident grid, no grid shown. Kill criterion: if phase
   proves unstable on the corpus, grid display and quantise park here —
   varispeed and manual beat-matching still ship.
2. **Varispeed.** A tempo slider per playback deck (±8% default range)
   driving `playbackRate`; pitch shifts with rate — the classic
   varispeed trade-off, recorded; time-stretch is a Later idea. The FLX4
   **tempo sliders** map at last (M7 left them deliberately unmapped;
   the ADR records why that reversal doesn't touch ADR-0004 — playback
   rate is not generation tempo). Position math in `audio/track.ts`
   grows a rate term, still pure.
3. **SYNC and phase.** A SYNC control matches the track's BPM to the
   other deck's gated BPM (refusing honestly when the gate is blank); a
   phase meter shows the beat offset between decks; the jog becomes
   mode-aware like a real deck — **playing = phase nudge, paused = seek**
   (today's behaviour).
4. **Grid display.** Beat ticks on the TrackOverview, downbeats heavier,
   only while the grid is confident.

**Exit criteria:** load a steady track against a streaming deck, press
SYNC, and the beats lock audibly for a minute with the phase meter
agreeing; the jog corrects drift while playing; the tempo slider rides
the rate smoothly from screen and hardware; grid math unit-tested
against click tracks and drifting fixtures; verified on the device
against a checklist.

## M21 — Hot cues and track loops

**Status: ⬜ planned.**

**Goal:** on a playback deck, pads mean *position*. The HOT CUE bank —
style-target snaps on a realtime deck — becomes what its label says, and
the track gains beat-quantised loops.

Scope, ordered by risk:

1. **Hot cues.** HOT CUE pads on a playback deck: an empty pad sets a
   cue at the playhead, a filled pad jumps to it, SHIFT+pad clears —
   LEDs truthful, markers drawn on the overview. Quantised to the M20
   grid when confident, free when not (the M14 consumer rule).
   Session-only like every captured artefact.
2. **In/out loops.** A beat-quantised loop on the track via the buffer
   source's native `loopStart`/`loopEnd`; in/out/exit controls on screen
   and on the FLX4 **LOOP section** (unmapped since M7 — bytes from the
   Mixxx chart, monitor-verified like every bank).
3. **UI.** Cue markers and the loop region shaded on the TrackOverview.

**Exit criteria:** set and jump cues from the pads with truthful LEDs
while the track plays; a 4-beat loop locks seamlessly on the grid and
releases cleanly; quantise degrades honestly without a grid; new intents
and mapping rows unit-tested; verified on the device against a
checklist.

## M22 — Dual zoomed waveforms: visual beatmatching

**Status: ⬜ planned.**

**Goal:** the visual half of beat-matching — stacked, beat-aligned,
scrolling close-up waveforms for both decks, rekordbox-style. The
honest catch: today's per-deck strip is decorative (a post-fader
analyser window); this milestone makes the close-up sample-accurate.

Scope, ordered by risk:

1. **Sample-accurate sources.** Track deck: slice the decoded buffer
   around the playhead (cheap, exact). Live deck: a real feed from the
   pushed PCM (the beat tracker's tap), aligned to the played position
   via the ring's clock — the risky half; measure before promising.
2. **The stacked view.** Both decks' zoom strips stacked in the centre,
   playheads fixed mid-screen, M20 beat ticks overlaid where confident;
   canvas-rendered, no per-frame React.
3. **Alignment truth.** When M20 says the decks are in sync, the ticks
   visually coincide — the view must not lie about phase.

**Exit criteria:** both strips scroll in lockstep with what is heard
(no perceptible lag against transients); a synced pair shows coinciding
beat ticks; 60 Hz with both decks running and zero added underruns;
verified by eye against a checklist on the device.

## Later (not committed)

Ideas parked deliberately — each would get its own ADR if picked up:

- **Key detection + camelot matching** — offline per-track key analysis,
  compatibility hints in the Media Explorer.
- **Per-track auto-gain at load** — M17's trim holds in playback mode
  today; a decoded buffer's loudness is knowable up front.
- **Quantised triggers** — pads, FX, and mode switches snapped to the
  M20 grid.
- **Persistent track library** — cached analysis (grid/key/gain) and
  folder handles need an IndexedDB layer; today everything is
  deliberately session-only.
- **Track-buffer slicing** — captures and style sampling from a playback
  deck (the ADR-0013 deferral; ring history can't serve them).
- **Time-stretch** — tempo without pitch (a worklet); varispeed's
  upgrade path.
- **Tauri desktop wrap** — webview + Python sidecars; revisit trigger in
  ADR-0002.
- **C++ engine (`magentart::core`) backend** — single distributable
  binary, supersedes ADR-0002 if pursued.
- **Full controller LED/display feedback** — bidirectional surface state
  beyond the shipped pad/cue echoes (needs the FLX4 output map).
- **Style motion** — automate the style-pad cursor (LFO between targets,
  or record and loop a pad gesture).

## Standing risks

| Risk | Impact | Mitigation |
| ---- | ------ | ---------- |
| Machine falls short of two real-time instances | Glitchy decks | Run on Pro/Max-class hardware; `mrt2_small` as default; buffer-health UI (M2) makes shortfall visible |
| MRT2 streaming API shifts under us (young project) | Rework in workers | Worker isolates all `magenta_rt` calls behind one small interface |
| Memory pressure with `mrt2_base` decks | Crashes mid-session | RAM guardrails in model picker (M3); worker-death recovery |
| FLX4 MIDI map differs from docs / firmware | Dead or wrong controls | Map sourced from the proven Mixxx mapping (docs/midi-ddj-flx4.md); in-app monitor verifies against the device |
| Web MIDI is Chromium-only | No hardware control elsewhere | Accepted (ADR-0005); on-screen UI unaffected |
| `sa3_mlx` is a checkout + CLI, not a pinned package | Upstream drift breaks generation | Checkout pinned to a commit; one backend module owns the spawn contract; a missing or failing CLI degrades to a clear error with the decks unaffected |
| Beat phase on generated/folder tracks may be unstable (M20) | Sync lands off-beat | Offline analysis behind the M14 honesty rule; kill criterion parks grid features while varispeed still ships |
| Varispeed shifts pitch with rate (M20) | Extreme rates sound wrong | ±8% default range (the classic DJ envelope); time-stretch recorded as the Later upgrade |
