# M9/M10 hardware checklist — headphone cue on the DDJ-FLX4

Manual verification of the M9 and M10 exit criteria. Audio routing and
hardware can't be e2e-heard (ADR-0005/0006): the graph math, mapping
table, and wiring are unit-tested; this covers real devices, real ears.

## Setup

- [ ] DDJ-FLX4 over USB; app open in Chromium; **Connect MIDI** green
      (see [`m7-hardware-checklist.md`](m7-hardware-checklist.md)).
- [ ] Speakers on the **system default output** (e.g. set the FLX4 as
      default so its MASTER RCA feeds them — the rekordbox-style setup).
- [ ] Headphones on a **second device**: the Mac's 3.5mm jack, Bluetooth,
      or the built-in speakers as a stand-in. (The FLX4's own phones jack
      can't carry the cue — Chromium is stereo-per-sink, ADR-0006.)
- [ ] Both decks with 2+ style targets; deck A playing on the master.

## M9 — split cue from the UI

- [ ] In the mixer's **Phones** group, click **Find devices** → the
      one-off microphone permission prompt appears → the device list
      fills in. Pick the headphone device.
- [ ] Toggle channel B's **CUE** (button lights): deck B is audible in
      the headphones while the room keeps hearing only deck A.
- [ ] **Cue mix** knob: full left = cue only, full right = master only,
      centre = both — in the phones; the room feed never changes.
- [ ] Channel B's fader stays down throughout: the cue is pre-fader.
- [ ] Recording while cueing: the WAV contains the master only.
- [ ] Reload: cue mix and device come back; CUE toggles come back **off**
      (deliberate — a reload never blasts the phones).

## M10 — the same workflow from the FLX4

- [ ] Channel CUE button (under the channel fader area) toggles that
      deck's PFL; the button's LED and the on-screen button track it.
      Monitor shows `90 54 7F` / `91 54 7F`.
- [ ] HEADPHONES MIX knob rides the on-screen cue-mix knob smoothly
      (monitor: `B6 0C ..` + `B6 2C ..` pairs).
- [ ] Transport CUE on a **stopped** deck B: status shows
      "Primed — off air", the CUE LED lights, the buffer fills, the room
      hears nothing — but with channel B's PFL on, the phones hear it.
      Monitor: `90 0C 7F` / `91 0C 7F`.
- [ ] PLAY on the primed deck: it drops on air instantly with the audio
      that was auditioned (no flush, no restart); the CUE LED goes dark.
- [ ] Transport CUE on a **rolling** deck stops it immediately (flush).
- [ ] Hands-off cue pass: prime B with CUE, audition it via channel CUE
      + MIX knob, drop it with PLAY, swing the crossfader to B, stop A —
      mouse untouched, LEDs truthful throughout.

When every box ticks, flip M9 and M10 in [`ROADMAP.md`](ROADMAP.md) to
✅ done.
