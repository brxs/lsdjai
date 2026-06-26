# Split cue output hardware checklist — independent main & cue devices

Manual verification of the dual-mode output split (ADR-0021): the master plays
out one device and the headphone cue plays out either the same device's channels
3/4 (combined — the FLX4 phones jack) or a separate device (split). Device I/O
cannot be e2e-automated: the ring swap (`host.rs`), the channel spreaders
(`device.rs` — unit-tested), and the pickers (`OutputDevicePicker`,
`MixerStrip` — unit-tested) are covered; this checklist is the last hop —
real devices, real clocks, real ears.

## Setup

- [ ] `just tauri-dev`, app open, audio playing on at least one deck.
- [ ] At least two output devices available (e.g. the FLX4, the built-in
      speakers/headphone jack, or Bluetooth headphones).
- [ ] The mixer's **Phones** group shows two pickers: **Main output** and
      **Cue output**.

## Combined mode (FLX4 one cable) — no regression

- [ ] Main output = **DDJ-FLX4**, Cue output = **Phones on main (ch 3/4)**.
- [ ] Master plays out the FLX4 MASTER RCA (the audience).
- [ ] With a channel CUE on, the cued deck is audible in the FLX4 **phones jack**
      and the cue/master blend follows the **Cue mix** knob.
- [ ] This matches the behaviour from before the split (nothing regressed).

## Split mode (separate cue device)

- [ ] Main output = an interface/speakers, Cue output = **the laptop headphone
      jack** (a different device).
- [ ] Master plays out the main device; the cue plays out the laptop jack.
- [ ] Repeat with **Bluetooth headphones** as the cue device — cue is audible
      there (latency/drift aside, see below).
- [ ] The cue/master **Cue mix** knob still blends master into the cue on the
      separate device.

## The master-is-never-interrupted property

- [ ] While master audio plays, change **only the Cue output** between two
      separate devices: the master does **not** glitch, drop, or re-buffer.
- [ ] Changing the **Main output** device reapplies master to the new device; a
      split cue keeps playing on its own device throughout.

## Mode transitions

- [ ] Combined → split (pick a separate cue device): cue moves to the new device;
      a brief master gap on this transition is acceptable.
- [ ] Split → combined ("Phones on main (ch 3/4)"): cue returns to the FLX4
      phones; the separate cue stream stops.

## Edge cases

- [ ] **Stereo main + "same as main"**: the cue picker shows *"Phones on main —
      needs a 4-ch main"* and the cue is silent (expected) until a separate cue
      device is chosen.
- [ ] **Same device for both** (pick the main device as the cue device): resolves
      to combined — no two streams fight over one device, no error.
- [ ] **Cue device unplugged / fails to open**: an error is surfaced under the
      cue picker and the master is undisturbed.
- [ ] **Persistence**: choices survive an app restart (main under the legacy
      `outputDevice` key, cue under `cueDevice`); a since-removed device stays
      shown by name rather than snapping to the default.

## Drift (two independent clocks)

- [ ] In split mode, listen to the cue for a few minutes: occasional tiny cue
      glitches from clock drift are acceptable (texture cueing, ADR-0004/0006);
      the master must stay clean.
