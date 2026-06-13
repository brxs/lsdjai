# SlipMate Roadmap

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

### M20 — Beatgrids and sync: the track follows the booth ✅ (2026-06-13)

[ADR-0014](adr/0014-beat-matching-via-varispeed-tracks-against-the-measured-stream.md):
real beat-matching, one-directional by design — **the track follows the
booth** (ADR-0004 still bars generation tempo). Offline beatgrid at
load (period refined by fold-resultant search; both folds ride the LOW
band's linear energy rise; floors calibrated on real renders; a spliced
tempo refuses), varispeed ±8% with the FLX4 tempo sliders mapped at
last, SYNC from gated BPMs alone, dual-role jog (paused = fine seek,
playing = backlog-adaptive phase bend, SHIFT = scrub on its own CC
`0x29`), and a phase meter that compares clocks **at the speakers** via
worklet-reported consumed frames. Measured (`verify_m20.mjs`): SYNC
landed the gated BPM to the decimal; a track-to-track lock held a
minute at **0.000 beats/min** drift. Three FLX4 runs fed fixes back
([checklist](m20-hardware-checklist.md)); verdict: "a truly novel take
on beat matching."

### M22 — Dual zoomed waveforms: visual beatmatching ✅ (2026-06-13)

Pulled forward into M20's verification — judging an audible lock with
only a needle proved too hard. Hop-indexed band envelopes for both
decks (offline at load; a rolling live scroller verified identical on
the same audio), drawn as colour at 60 Hz with grid-red beat marks from
each deck's M20 clock; stacked BeatView with a persisted four-way
layout switcher (centre / vertical / top bar / off). Replaced the
decorative per-deck analyser strip. A true spectrogram renderer stays a
Later idea. Verified by eye alongside the M20 device runs.

## M21 — Hot cues and track loops

**Status: 🔶 built (2026-06-13), pending hardware verification.** All
three scope items shipped on
[ADR-0015](adr/0015-hot-cues-in-deck-state-loops-on-the-buffer-source.md)
(architecture-reviewed before building): hot cues as session-only deck
state with jump-as-seek; the loop on the buffer source's native
`loopStart`/`loopEnd` with the transport folding through the region in
one pure function; any seek exits the loop (one rule — the two
playhead-outside-the-region moments get deterministic restarts instead
of the wrap-on-reach spec edge); quantise per the consumer rule (whole
beats with a grid, free-but-minimum-length without). The pad intent is
renamed for the physical gesture (`hot_cue_pad`) since its meaning now
diverges per deck mode — which also retired a latent bug (playback
pads still drove the parked worker's style cursor). Measured
(`verify_m21.mjs`, real generated audio): cue jump landed on the cue
to the second while playing; a 9-beat IN→OUT loop folded the playhead
3× with seam and position agreeing; EXIT released past the boundary.
The device half awaits [`m21-hardware-checklist.md`](m21-hardware-checklist.md)
(pad LEDs, the audible seam, the chart-interpolated LOOP bytes).
A follow-up moved the cue markers and the beat ticks off the
TrackOverview onto the M22 beat-view close-up — easier to read while
working a deck; the overview keeps its loop-region shading and the
playhead, and the close-up gained the loop region too — washed, with
entry/exit caps — so it's clear up close what a loop wraps on.

**Goal:** on a playback deck, pads mean *position*. The HOT CUE bank —
style-target snaps on a realtime deck — becomes what its label says, and
the track gains beat-quantised loops.

Scope, ordered by risk:

1. **Hot cues.** HOT CUE pads on a playback deck: an empty pad sets a
   cue at the playhead, a filled pad jumps to it, SHIFT+pad clears —
   LEDs truthful, markers drawn on the beat-view close-up. Quantised to
   the M20 grid when confident, free when not (the M14 consumer rule).
   Session-only like every captured artefact.
2. **In/out loops.** A beat-quantised loop on the track via the buffer
   source's native `loopStart`/`loopEnd`; in/out/exit controls on screen
   and on the FLX4 **LOOP section** (unmapped since M7 — bytes from the
   Mixxx chart, monitor-verified like every bank).
3. **UI.** The loop region shaded on the TrackOverview and washed on
   the beat-view close-up (with entry/exit caps); the cue markers and
   beat ticks on the close-up too (moved there in a follow-up for a
   tighter working view).

**Exit criteria:** set and jump cues from the pads with truthful LEDs
while the track plays; a 4-beat loop locks seamlessly on the grid and
releases cleanly; quantise degrades honestly without a grid; new intents
and mapping rows unit-tested; verified on the device against a
checklist.

## M23 — Beat loops: one-press lengths, halve and double

**Status: 🔶 built (2026-06-13), pending verification.** A thin control
layer over M21's loop engine ([ADR-0016](adr/0016-beat-loops-length-scaling-over-the-loop-region.md),
architecture-reviewed before building): two pure functions —
`beatLoopRegion` (grid-required, N beats from the snapped playhead) and
`resizeLoop` (length-scaled ×½/×2 anchored on the IN, no re-snap so clean
fractions stay exact) — feed the existing `setTrackLoop`→`planLoopSet`
path, so a resize that leaves the playhead outside the region gets M21's
restart for free. Three deck controls (`beatLoop` set-only, `halveLoop`,
`doubleLoop`), the `track_beat_loop`/`track_loop_halve`/`track_loop_double`
intents, and an on-screen 4-beat + ½×/2× row whose readout now names
clean fractions (½, ¼). The FLX4 maps at last, **bytes measured on the
device**: the 4 BEAT/EXIT button (`0x4D` — the byte M21 had read as
RELOOP/EXIT) toggles set/exit in dispatch, and CUE/LOOP CALL ◄/►
(`0x51`/`0x53`) halve/double. Gate green and the
beat-loop math, the resize-past-playhead restart, the toggle, and the
translator bytes unit-tested. The scripted real-audio check is
`verify_m23.mjs`; the device half awaits
[`m23-hardware-checklist.md`](m23-hardware-checklist.md).

**Goal:** loops set in one move, not two. A single press drops a
beat-locked loop of a known length at the playhead; halve and double walk
the standard ladder (… 1, 2, 4, 8, 16 …) without re-cueing — the working
DJ's loop, not the manual IN→OUT carpentry M21 shipped.

Scope, ordered by risk:

1. **Beat loop.** One press sets a loop of N whole beats from the playhead
   (snapped to the grid), default 4. Grid-required by nature: no confident
   grid, no beat loop (the M14 consumer rule) — the control sits inert on a
   gridless track (the Jazz case), where M21's free IN→OUT loop stays the
   only way in.
2. **Halve / double.** With a loop active, ×½ / ×2 its length anchored on
   the IN — start fixed, end moves. Pure length-scaling, not a re-snap: a
   beat-aligned loop stays on the grid under ×½/×2 by construction, and
   re-quantising would only corrupt a clean fraction. Clamped to a sane
   range — a beat-fraction floor, the track end as ceiling (a double that
   would overrun refuses rather than truncating). Halving past the playhead
   re-anchors through the same restart rule.
3. **Surface + hardware.** An on-screen 4-beat button with ×½ / ×2 beside
   M21's IN/OUT/EXIT and the live beat count (M21 already labels a
   whole-beat loop); on the FLX4, the **4 BEAT/EXIT** button (one-press
   4-beat loop and release) and the **CUE/LOOP CALL ◄ / ►** buttons (halve
   / double) — bytes from the Mixxx chart, monitor-verified. The close-up's
   loop wash already shows the result.

**Exit criteria:** a one-press 4-beat loop locks on the grid and folds
seamlessly; halve and double resize it on the beat with no click and no
drift, refusing only what can't honestly fit; the control is inert, not
wrong, without a grid; new intents and mapping rows unit-tested; verified
on the device against a checklist.

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
