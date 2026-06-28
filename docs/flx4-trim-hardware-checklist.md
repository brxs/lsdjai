# FLX4 TRIM-knob hardware checklist

Manual verification of the channel TRIM mapping (M17 trim, now on hardware).
The translator row and the trim dispatch are unit-tested; this covers the one
thing tests can't: that the FLX4's TRIM knob really sends CC `0x04` and that the
on-screen trim follows it.

## Setup

- [ ] App open in Chromium, **Connect MIDI** green, deck A playing a style.

## Firmware spot-check (the interpolated CC)

The CC is interpolated from the Pioneer/Mixxx channel-gain layout, not read from
the device. Confirm before trusting the rest:

- [ ] Turn TRIM deck 1: the monitor shows `B0 04 ..` (+ `B0 24 ..` LSB) ticking.
      Deck 2 shows `B1 04 ..` / `B1 24 ..`. If a different CC appears, stop and
      record it — `flx4.ts` needs that byte instead of `0x04`.

## Behaviour

- [ ] Turning the hardware TRIM knob moves the on-screen TRIM knob live, across
      its full ±12 dB travel; the knob centre reads as 0 dB.
- [ ] A turn drops the channel out of **Auto** trim (the Auto button unlights) —
      the hardware knob is a manual gain, like the on-screen one.
- [ ] The gain audibly changes the channel level as the knob rides.
- [ ] Each deck's TRIM knob drives only its own channel.
- [ ] **Position sync on connect**: park TRIM deck 1 hard one way, reload the
      page, Connect MIDI — the on-screen trim snaps to the hardware position
      without touching anything (the status-query SysEx).
