# M16 hardware checklist — crates on the DDJ-FLX4

Manual verification of the M16 exit criteria. Storage, the browser,
load semantics, export/import, and the mapping rows are unit-tested;
this covers the firmware bytes and the mid-set flow.

## Setup

- [ ] App open in Chromium, **Connect MIDI** green, deck A playing a
      style it can hold; deck B idle.

## Firmware spot-check (rotary + LOAD bytes)

The bytes come from the Mixxx chart — verify with the monitor:

- [ ] Turn the browse rotary one click clockwise: the monitor shows
      `B6 40 01` (or another small value). Counter-clockwise shows
      `B6 40 7F` (or another value above `0x40`). If a different CC
      appears, stop and record it.
- [ ] Press LOAD on deck 1: `96 46 7F`; LOAD deck 2: `96 47 7F`.
- [ ] Turning the rotary moves the crate highlight in the right
      direction (clockwise = down the list); if inverted, record it —
      the relative decode needs flipping.

## Save and reload

- [ ] On deck A, name and save a preset; it appears in the crate
      browser immediately.
- [ ] Reload the page: the preset is still there (and deck A's pad
      came back as before — presets and pad persistence coexist).

## Load mid-set, hands off the mouse

- [ ] With deck A playing, highlight a preset with the rotary and
      press LOAD 2: deck B's pad, cursor, and Color FX selection
      become the preset's; B's status shows the new style applying at
      the next chunk.
- [ ] Deck A streams uninterrupted through the load (zero new
      underruns on A's health row).
- [ ] Press LOAD 1 with a different preset highlighted: deck A's pad
      swaps live — the stream keeps playing and glides to the new
      style at a chunk boundary, no stop/start.
- [ ] A preset saved with a Color FX selection restores both the
      effect and its knob position on load.

## Export / import

- [ ] Export downloads `slipmate-crates.json`; importing it back
      (after deleting a preset) restores the deleted preset.
- [ ] Importing a non-JSON file shows the inline reason and changes
      nothing.

When every box ticks, flip M16 in [`ROADMAP.md`](ROADMAP.md) to ✅ done.
