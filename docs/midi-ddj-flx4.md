# DDJ-FLX4 MIDI map — reference for M7

Source: the [Mixxx controller mapping](https://github.com/mixxxdj/mixxx/blob/main/res/controllers/Pioneer-DDJ-FLX4.midi.xml)
(281 controls, battle-tested by Mixxx users), cross-referencing Pioneer's
official [MIDI message list](https://www.pioneerdj.com/-/media/pioneerdj/software-info/controller/ddj-flx4/ddj-flx4_midi_message_list_e1.pdf)
(served behind a web viewer). The in-app MIDI monitor (M7 step 1) remains
the verification tool against the physical device/firmware.

Conventions: deck 1 messages use MIDI channel 0 (`0x90`/`0xB0`), deck 2
channel 1 (`0x91`/`0xB1`), mixer channel 6 (`0xB6`), pads channels 7/9
(`0x97`/`0x99`, shift layer `0x98`/`0x9A`). Buttons are Note On with
velocity `0x7F` on press, `0x00` on release. Faders/knobs are 14-bit: MSB
on the listed CC, LSB on CC+`0x20`.

Position sync: knobs and faders are silent until moved. SysEx
`F0 00 40 05 00 00 04 05 00 50 02 F7` (from the Mixxx FLX4 script,
reverse-engineered with Wireshark; doubles as its keep-alive) makes the
controller report every analog control's current position — the app
sends it on every device bind so a fresh connection starts in sync.

## Mapped in M7

| Control | Message | → App intent |
| ------- | ------- | ------------ |
| PLAY/PAUSE deck 1 / 2 | `0x90`/`0x91` note `0x0B` | toggle play/stop |
| Channel fader 1 / 2 | `0xB0`/`0xB1` CC `0x13` (LSB `0x33`) | deck volume |
| Crossfader | `0xB6` CC `0x1F` (LSB `0x3F`) | master crossfade |
| Pads 1–8, HOT CUE mode, deck 1 / 2 | `0x97`/`0x99` notes `0x00`–`0x07` | the pad gesture (`hot_cue_pad`) — meaning decided per deck mode (M21, ADR-0015): realtime **toggles prompt N's net selection** (the jog then reels selected dots in/out — see the jog row; this replaced the older cursor-snap); playback sets/jumps hot cue N |
| SHIFT + HOT CUE pad, deck 1 / 2 | `0x98`/`0x9A` notes `0x00`–`0x07` | clear hot cue N on a playback deck (the shift pad layer, the M13-measured firmware habit); realtime decks ignore it |
| EQ HI deck 1 / 2 | `0xB0`/`0xB1` CC `0x07` (LSB `0x27`) | deck EQ high band (M6) |
| EQ MID deck 1 / 2 | `0xB0`/`0xB1` CC `0x0B` (LSB `0x2B`) | deck EQ mid band (M6) |
| EQ LOW deck 1 / 2 | `0xB0`/`0xB1` CC `0x0F` (LSB `0x2F`) | deck EQ low band (M6) |
| SMART CFX deck 1 / 2 | `0xB6` CC `0x17`/`0x18` (LSB `0x37`/`0x38`) | Color FX amount (M12); with SHIFT held: sweep style-pad cursor |
| Pads 1–6, PAD FX mode, deck 1 / 2 | `0x97`/`0x99` notes `0x10`–`0x15` | select that deck's Color FX; the active pad re-pressed switches off; LED echoes the selection (M12). Bank base interpolated from the 0x10-per-bank scheme — confirm with the monitor |
| SHIFT deck 1 / 2 | `0x90`/`0x91` note `0x3F` | modifier, tracked in software (M12) — press/release only, no intent of its own |
| BEAT FX ON/OFF | `0x94`/`0x95` note `0x47` | record toggle |

## Deliberately unmapped

| Control | Message | Why |
| ------- | ------- | --- |
| TRIM, BEAT SYNC, loop section | various | no app counterpart yet (CUE went in M10, browse/load in M16) |

## Mapped in M10 (headphone cue)

Bytes sourced from the Mixxx mapping like the table above; the monitor
remains the verification tool.

| Control | Message | → App intent |
| ------- | ------- | ------------ |
| CUE (headphone) channel 1 / 2 | `0x90`/`0x91` note `0x54` | toggle channel PFL; LED echoes the state |
| HEADPHONES MIX knob | `0xB6` CC `0x0C` (LSB `0x2C`) | cue↔master blend in the phones — it sends MIDI, unlike a typical analog monitor knob |
| CUE (transport) deck 1 / 2 | `0x90`/`0x91` note `0x0C` | deck prep: prime off air / stop with flush; LED lit while primed |

## Mapped in M13 (freeze loops)

| Control | Message | → App intent |
| ------- | ------- | ------------ |
| Pads 1–4, SAMPLER mode, deck 1 / 2 | `0x97`/`0x99` notes `0x30`–`0x33` | freeze-loop slot: empty captures + freezes, filled swaps in, active returns to live; LED lit while filled. Bank base `0x30` confirmed by the 0x10-per-bank scheme |
| SHIFT + SAMPLER pad, deck 1 / 2 | `0x98`/`0x9A` notes `0x30`–`0x33` | clear the slot. Held SHIFT moves pads onto the shift pad layer — pads are **not** soft-shifted like the CFX knob (found on hardware: the `0x97`/`0x99` soft-shift path never fired). The translator keeps the soft-shift rows as well, in case other firmware keeps the pads put |

## Mapped in M16 (crates), widened in M19 (Media Explorer)

| Control | Message | → App intent |
| ------- | ------- | ------------ |
| Browse rotary (turn) | `0xB6` CC `0x40`, relative (small = CW, >`0x40` = CCW two's complement) | move the visible Media Explorer tab's highlight (`browse_scroll`) — handled before the 14-bit CC pipeline; confirm direction with the monitor |
| LOAD deck 1 / 2 | `0x96` notes `0x46`/`0x47` | load the highlighted item onto that deck (`browse_load`): a crate flips the deck to realtime, a track to playback (ADR-0013) |
| Browse rotary (press) | `0x96` note `0x41` | cycle the Media Explorer's visible tab (`browse_tab`, M19). The Mixxx FLX4 chart defines no press control; the byte is interpolated from the DDJ-400 family — confirm with the monitor |

## Mapped in M19 (playback deck), grown in M20 (beat-matching)

| Control | Message | → App intent |
| ------- | ------- | ------------ |
| Jog wheel (turn) deck 1 / 2 | `0xB0`/`0xB1` CC `0x21` (side) / `0x22` (platter, vinyl on) / `0x23` (platter, vinyl off), relative around `0x40` (`0x41` = +1 CW) | the platter's dual role on a playback deck: paused = fine relative seek, playing = phase nudge. On a **realtime** deck (`track_seek`) it now drives the net: with prompts selected it moves every selected dot radially about the cursor — clockwise reels them in (more weight), counter-clockwise pushes them out; inert when nothing is selected. Still no audio scratch on the stream (ADR-0004 holds — the jog edits the prompt blend, not playback) |
| SHIFT + jog (turn) deck 1 / 2 | `0xB0`/`0xB1` CC `0x29` (`jogSearch` in the Mixxx FLX4 chart, **confirmed on the device** — third run: "Shift+jog works while playing"), relative around `0x40` | fast scrub even mid-play (the CDJ search convention). The firmware moves the shifted jog to its **own CC** — the software soft-shift on `0x21`/`0x22` shipped first and read as "scrubbing does nothing" on the device |
| Tempo slider deck 1 / 2 | `0xB0`/`0xB1` CC `0x00` (LSB `0x20`) | varispeed on a playback deck (`track_rate`, M20, ADR-0014 — playback rate is not generation tempo, so ADR-0004 stands); realtime decks ignore it. Orientation **measured on the device**: low values = slow end (the chart assumption shipped inverted and was caught on hardware) |
| LOOP IN / LOOP OUT deck 1 / 2 | `0x90`/`0x91` notes `0x10` / `0x11` | track loop on a playback deck (M21, ADR-0015): IN arms a quantised start, OUT closes the region; realtime decks ignore them. Bytes per the Mixxx FLX4 chart — confirm with the monitor. (Loop release moved onto the 4 BEAT/EXIT toggle below in M23.) |
| 4 BEAT/EXIT, CUE/LOOP CALL ◄ / ► deck 1 / 2 | `0x90`/`0x91` notes `0x4D`, `0x51` / `0x53` | beat loops on a playback deck (M23, ADR-0016): the **4 BEAT/EXIT** button (`0x4D` — the byte M21 had read as RELOOP/EXIT) toggles set/exit (a 4-beat loop when idle, release when one runs); CUE/LOOP CALL ◄ / ► halve / double the active loop. **All measured on the monitor** — on this device the panel's "4 BEAT" and "EXIT" are the one byte `0x4D` |

Reinterpreted, no new bytes: on a deck in playback mode the existing
transport messages drive the track instead of the worker — PLAY/PAUSE
(`0x90`/`0x91` note `0x0B`) plays/parks the track, transport CUE
(note `0x0C`) returns it to the top, parked. Everything else on the
strip (faders, EQ, CFX, pads, headphone cue) is untouched because the
channel graph is unchanged.

On audio: the FLX4's USB sound card exposes 4 output channels at 48 kHz
(measured via `system_profiler`) — 1/2 feed the MASTER RCA, 3/4 the
headphone jack — but Chromium caps Web Audio output at stereo per sink,
so the phones jack is unreachable from the browser; the cue feed uses a
second output device instead (ADR-0006).

## Useful spares for later

- Pad modes other than HOT CUE, PAD FX, and SAMPLER send distinct note
  ranges (BEAT LOOP `0x60`–`0x67`, BEAT JUMP `0x20`–`0x27`, KEY SHIFT
  `0x70`–`0x77`) — free banks for future intents (preset crates?).
- SAMPLER pads 5–8 (`0x34`–`0x37`) are unmapped; more loop slots if four
  prove tight.

## LED feedback (M7 stretch)

Pioneer pads/buttons light by echoing the same status/note back as MIDI
out with velocity `0x7F` (on) / `0x00` (off) — the scheme Mixxx's FLX4
script uses. Lighting pads 1–N to show which style targets exist is the
natural first use.

The net (live mode) adds a third level: a selected target pad burns bright
(`0x7F`), an available-but-unselected one sits dim (`0x20`), the rest dark.
This assumes velocity drives pad brightness; if the HOT CUE pads only do
on/off the dim/bright distinction collapses to "all lit" with no regression,
and the on-screen net stays the primary cue. **The `0x20` dim level is
provisional — measure it on the device** (see the net hardware checklist) and
adjust `PAD_LED_DIM` in `flx4.ts` if the pads need a different value to read
as clearly dim-but-on.
