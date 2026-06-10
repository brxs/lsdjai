# M12 hardware checklist — Color FX on the DDJ-FLX4

Manual verification of the M12 exit criteria with the physical device.
The curves, routing, and mapping rows are unit-tested; this covers ears
and firmware: every effect audibly transforming a real stream, the
bit-transparent off, and the SHIFT chord behaving as the Mixxx chart
promised.

## Setup

- [ ] App open in Chromium, **Connect MIDI** green, deck A playing with
      a style it can hold for a few minutes.

## Firmware spot-check (the SHIFT assumption)

The design assumes the firmware keeps the CFX knob's CC unchanged while
SHIFT is held (shift is tracked in software from `90/91 3F` press and
release). Verify in the monitor:

- [ ] Turn SMART CFX deck 1 bare: `B6 17 ..` (+ `B6 37 ..` LSB) ticks.
- [ ] Hold SHIFT (deck 1): monitor shows `90 3F 7F`; release `90 3F 00`.
- [ ] Turn SMART CFX deck 1 **with SHIFT held**: the bytes are still
      `B6 17 ..` — no new CC appears. If a different CC shows up,
      stop and record it; the table needs a row instead of the
      soft-shift assumption.

## Each effect, on a playing deck

Pick each effect in the deck's Color FX selector and ride the SMART CFX
knob through its range; in every case parking the knob back at the rest
position must return the stream to exactly its dry self:

- [ ] **Filter** — left of centre darkens to a rumble (low-pass), right
      of centre thins to a hiss (high-pass), centre indistinguishable
      from Off.
- [ ] **Dub Echo** — repeats build with the knob and darken as they
      regenerate; parked at zero the tail dies on its own.
- [ ] **Space** — the hall grows behind the dry signal; zero is dry.
- [ ] **Crush** — clean → gritty → mangled, knob down restores clean.
- [ ] **Noise** — a filtered noise bed rises in pitch and level — a
      riser over the stream; zero removes it entirely.
- [ ] **Sweep** — pumping starts slow and shallow, gets faster and
      deeper; zero stops the motion completely.

## PAD FX mode: effect selection from the pads

The bank base (`0x97`/`0x99` notes `0x10`–`0x17`) is interpolated from
the firmware's 0x10-per-bank scheme, not read from a chart — verify it
first:

- [ ] Switch the pads to **PAD FX** mode and press pad 1: the monitor
      shows `97 10 7F` (deck 1) / `99 10 7F` (deck 2). If a different
      note range appears, stop and record it.
- [ ] Pads 1–6 select Filter, Dub Echo, Space, Crush, Noise, Sweep in
      order; the on-screen Effect picker follows.
- [ ] The selected effect's pad is lit; selecting another moves the
      light; pads 7–8 do nothing.
- [ ] Pressing the lit pad switches the effect off (pad goes dark, the
      picker shows Off).
- [ ] Mode round-trip keeps LEDs truthful: PAD FX → HOT CUE → PAD FX —
      after every switch the bank shows its own state again (style pads
      lit 1–N, the active effect's pad lit), repainted on the mode
      button press.
- [ ] Selecting an effect parks the knob at its rest position — never
      mid-effect.
- [ ] Each deck's pads drive only their own deck.

## Integration

- [ ] **Position sync on connect**: park EQ MID deck 1 fully left and
      the channel fader low, reload the page, Connect MIDI — the
      on-screen EQ knob, fader, and CFX positions snap to the hardware
      without touching anything (the status-query SysEx).
- [ ] The on-screen FX amount knob follows the hardware knob live.
- [ ] SHIFT + SMART CFX sweeps the style cursor around the circle (the
      M7 behaviour, now on the chord) and never touches the FX amount;
      releasing SHIFT hands the knob back to the effect.
- [ ] Each deck's knob and SHIFT drive only their own deck.
- [ ] With deck B primed (transport CUE) and channel B's headphone cue
      on: deck B's effect is audible in the phones while the room
      hears none of it — the insert sits above the cue tap.
- [ ] Recording while an effect runs: the WAV contains the effected
      master.
- [ ] Reload: each deck's effect selection and knob position come back.

When every box ticks, flip M12 in [`ROADMAP.md`](ROADMAP.md) to ✅ done.
