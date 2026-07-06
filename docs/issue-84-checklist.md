# Issue #84 — generation params (CFG / sampling): by-ear checklist

Issue #84 exposes the rest of the MRT2 operating point — `temperature`,
`top_k`, `cfg_musiccoca` (prompt adherence), `cfg_notes` (note adherence) — as
per-deck **"Sampling & guidance"** sliders in the performance drawer (webview →
`set_deck_generation` → the shell `NoteSteering` service → worker →
`engine.set_generation`), following the `cfg_drums` seam. Ranges/defaults match
the `magenta-realtime` reference (`Settings.tsx` / `defaultParams.ts`). Each
knob has its own reset (↺) to the tuned baseline. The tuning **persists per deck**
(shell `settings.json`) and is re-sent to a fresh worker on `ready`.

The unit tests cover the wire shape, the store mirror, the boundary clamps, the
engine threading (into `generate_chunk` **and** `render_clip`), and the drawer
projection/writes. **This checklist is the part tests can't reach**: that each
knob audibly moves the real model, that a tuned deck's character shows in its
pad renders, and that a set value survives a restart and a model switch.
Tick a box only after hearing it on a real stream.

A change lands at the next chunk boundary but is *heard* only once the deck's
buffered audio drains — expect **~3–4 s** from drag to ear on an unarmed deck
(the 1 s chunk plus the worker's ~3 s pacing cushion).

## Setup

- [ ] `just tauri-dev`, app open; deck A playing a textured style (e.g.
      "warm disco funk") so sampling changes are audible.
- [ ] Open deck A's performance door (the Config rail on the prompt pad). The
      **Sampling & guidance** section (below **Drums adherence**) holds three
      sliders — **Temperature**, **Top-k**, **Prompt adherence** — each with a
      hint and a reset (↺). **Note adherence** sits higher up, in the
      **steering** block beside key/scale/mode (it only bites while steering).

## Each knob, by ear

- [ ] **Temperature** — drag high (~2.5): generation wanders, more surprising /
      unstable. Drag low (~0.2): it settles into repetition. Reset (↺) returns
      to ~1.1 and the character returns to the tuned default. Dragging to the
      far-left (0) does **not** glitch or drop out (the shell floors it off zero).
- [ ] **Top-k** — drag low (~5): output narrows/focuses. Drag high (~500+): more
      varied. Reset returns to 50.
- [ ] **Prompt adherence** (`cfg_musiccoca`) — drag high (~5): generation locks
      tightly to the current prompt/style. Drag low (~0.5): it drifts off the
      prompt. Reset returns to ~1.6.
- [ ] **Note adherence** (`cfg_notes`, in the steering block) — with **MIDI
      steering OFF**, moving it has **no audible effect** (the hint says so). Arm
      MIDI steering, hold a chord, then move it: high binds tightly to the held
      notes, low embellishes more. Reset returns to ~2.4.

## Pad renders honor the tuning (issue #84)

- [ ] Tune deck A well off baseline (e.g. Temperature ~2.5, Prompt adherence
      ~0.6). Stop the deck. Render a pad/clip from a prompt on that deck: the
      rendered clip reflects the deck's tuned character (wilder / looser), not
      the reference baseline. (A render on a *stopped* deck still works because
      the shell re-sends the params to the worker on `ready`.)

## Persistence & fresh workers

- [ ] Set non-default values on both decks, quit the app, relaunch: the sliders
      come back at the values you left (per deck), not the baseline.
- [ ] Switch a deck's model (Settings → Models) and play again: the deck's
      tuning re-takes effect on the fresh worker (re-sent on `ready`), audible
      within a few seconds of the first chunk.

## Independence

- [ ] The Sampling & guidance knobs never arm the deck (the MIDI-steering switch
      stays off, the chunk cadence unchanged) — they are conditioning/sampling,
      not a performance gesture.
- [ ] Tuning deck A does not change deck B (each deck runs its own worker and
      keeps its own params).
