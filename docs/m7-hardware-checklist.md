# M7 hardware checklist — DDJ-FLX4

Manual verification of the M7 exit criteria with the physical device.
Hardware cannot be e2e-automated (ADR-0005): the mapping table and the
ControlBus wiring are unit-tested, this checklist covers the last hop —
real firmware bytes through a real browser permission into real audio.

## Setup

- [ ] DDJ-FLX4 connected over USB and powered on.
- [ ] `just run`, app open in a Chromium browser (Chrome/Edge/Arc — Web
      MIDI is Chromium-only; the on-screen UI works everywhere else).
- [ ] Both decks connected with a model loaded; give each deck two or
      more style targets (e.g. `warm disco funk`, `dark techno`) — the
      pads and CFX knob act on targets.

## Connect + firmware verification

- [ ] Click **Connect MIDI** in the statusbar → the browser asks for MIDI
      permission → after allowing, the LED turns green and the device
      name (`DDJ-FLX4…`) appears.
- [ ] Move any knob: raw hex messages tick through the statusbar monitor.
- [ ] Spot-check the byte map against the firmware (the reason the
      monitor exists — charts drift). Expected per
      [`midi-ddj-flx4.md`](midi-ddj-flx4.md):
  - PLAY/PAUSE deck 1 → `90 0B 7F` (release `90 0B 00`); deck 2 → `91 0B …`
  - Channel fader 1 → `B0 13 ..` + `B0 33 ..` pairs (MSB+LSB)
  - Crossfader → `B6 1F ..` + `B6 3F ..` pairs
  - Pad 1, HOT CUE mode, deck 1 → `97 00 7F`; deck 2 pads → `99 ..`
  - SMART CFX deck 1 → `B6 17 ..`; deck 2 → `B6 18 ..`

  If any byte differs, stop here and record the actual bytes in
  `midi-ddj-flx4.md`; the translator table must follow the device.

## Transport

- [ ] PLAY/PAUSE on hardware deck 1 starts deck A; the on-screen
      transport lights. Press again: deck A stops immediately.
- [ ] Same for hardware deck 2 / deck B.
- [ ] With a deck disconnected or loading a model, PLAY/PAUSE does
      nothing (hardware obeys the same gating as the on-screen button).

## Mixer

- [ ] Channel fader 1 rides deck A's volume; the on-screen fader follows
      live; bottom is silent; the ride is smooth (14-bit — no stepping).
- [ ] Channel fader 2 ditto for deck B.
- [ ] EQ HI / MID / LOW on deck 1 audibly boost and kill their bands;
      the on-screen knobs follow. Ditto deck 2.
- [ ] Crossfader sweeps A↔B with the on-screen slider following; each
      end fully isolates its deck.
- [ ] BEAT FX ON/OFF starts recording (REC timer appears); pressing it
      again stops and downloads the WAV.

## Style pads + CFX

- [ ] In HOT CUE mode, pads 1–N are lit where N is the deck's target
      count; the remaining pads are dark (LED echo).
- [ ] Pad 1 on deck 1 snaps deck A's cursor onto target 1 — the cursor
      jumps on screen and "Playing:" shows 100% that prompt; the style
      change is audible at the next chunk boundary.
- [ ] Pad 2 → target 2. Pads on hardware deck 2 drive deck B only.
- [ ] Pressing a pad beyond the target count does nothing.
- [ ] SMART CFX deck 1 sweeps deck A's cursor around the target circle —
      smooth on-screen glide, blend percentages shifting live. Ditto
      deck 2 / deck B.
- [ ] Add a target while connected → one more pad LED lights up; remove
      one → its LED goes dark.

## Hot-plug

- [ ] Unplug the USB cable: status flips to "No DDJ-FLX4 found".
- [ ] Replug: it reconnects by itself (no Connect click) and the pad
      LEDs are restored.

## Hands-off run (the exit criterion)

- [ ] A 2–3 minute mini-set without touching the mouse: start both
      decks, ride faders and EQs, jump styles from the pads, morph with
      the CFX knob, crossfade between decks — every hardware move
      reflected live in the UI.

When every box ticks, flip M7's status in [`ROADMAP.md`](ROADMAP.md) to
✅ done.
