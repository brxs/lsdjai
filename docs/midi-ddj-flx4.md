# DDJ-FLX4 MIDI map — reference for M6

Source: the [Mixxx controller mapping](https://github.com/mixxxdj/mixxx/blob/main/res/controllers/Pioneer-DDJ-FLX4.midi.xml)
(281 controls, battle-tested by Mixxx users), cross-referencing Pioneer's
official [MIDI message list](https://www.pioneerdj.com/-/media/pioneerdj/software-info/controller/ddj-flx4/ddj-flx4_midi_message_list_e1.pdf)
(served behind a web viewer). The in-app MIDI monitor (M6 step 1) remains
the verification tool against the physical device/firmware.

Conventions: deck 1 messages use MIDI channel 0 (`0x90`/`0xB0`), deck 2
channel 1 (`0x91`/`0xB1`), mixer channel 6 (`0xB6`), pads channels 7/9
(`0x97`/`0x99`, shift layer `0x98`/`0x9A`). Buttons are Note On with
velocity `0x7F` on press, `0x00` on release. Faders/knobs are 14-bit: MSB
on the listed CC, LSB on CC+`0x20`.

## Mapped in M6

| Control | Message | → App intent |
| ------- | ------- | ------------ |
| PLAY/PAUSE deck 1 / 2 | `0x90`/`0x91` note `0x0B` | toggle play/stop |
| Channel fader 1 / 2 | `0xB0`/`0xB1` CC `0x13` (LSB `0x33`) | deck volume |
| Crossfader | `0xB6` CC `0x1F` (LSB `0x3F`) | master crossfade |
| Pads 1–8, HOT CUE mode, deck 1 / 2 | `0x97`/`0x99` notes `0x00`–`0x07` | snap style-pad cursor to target N |
| EQ HI deck 1 / 2 | `0xB0`/`0xB1` CC `0x07` (LSB `0x27`) | style-pad cursor X |
| EQ LOW deck 1 / 2 | `0xB0`/`0xB1` CC `0x0F` (LSB `0x2F`) | style-pad cursor Y |
| BEAT FX ON/OFF | `0x94`/`0x95` note `0x47` | record toggle |

## Deliberately unmapped

| Control | Message | Why |
| ------- | ------- | --- |
| Tempo sliders | `0xB0`/`0xB1` CC `0x00` range | no tempo parameter (ADR-0004) |
| Jog wheels | `0xB0`/`0xB1` CC `0x21`/`0x22` etc. | no scratch concept in v1; cursor-nudge candidate later |
| EQ MID | `0xB0`/`0xB1` CC `0x0B` | reserved (third pad axis has no meaning) |
| TRIM, CUE (headphone), browse/load, BEAT SYNC, loop section | various | no app counterpart yet |

## Useful spares for later

- CUE deck 1/2 (`0x90`/`0x91` note `0x0C`) — e.g. "stop with flush".
- SHIFT (`0x90`/`0x91` note `0x3F`) — modifier for a second layer.
- Pad modes other than HOT CUE send distinct note ranges (BEAT LOOP
  `0x60`–`0x67`, BEAT JUMP `0x20`–`0x27`, KEY SHIFT `0x70`–`0x77`) — free
  banks for future intents (preset crates?).

## LED feedback (M6 stretch)

Pioneer pads/buttons light by echoing the same status/note back as MIDI
out with velocity `0x7F` (on) / `0x00` (off) — the scheme Mixxx's FLX4
script uses. Lighting pads 1–N to show which style targets exist is the
natural first use.
