# Issue #50 — drum-sit layering: by-ear checklist

Issue #50 exposes the #46 drum conditioning as a per-deck mixing control: a
**Drums** tri-state in the performance drawer (webview → `set_deck_drums` →
the shell `NoteSteering` service → worker), sticky across play/stop — the
shell re-asserts the authored state over each fresh stream, superseding the
reset-on-discontinuity behaviour the issue-46 checklist recorded for drums
(held *notes* still reset).

The unit tests cover the store mirror surviving transport transitions and
the authored state surviving a discontinuity clear; the play-edge re-assert
itself has no automated test — it is verified only here. **This checklist is
the part tests can't reach**: that the control audibly suppresses/forces the
real model's drums, and that the re-assert really lands on a fresh stream.
Tick a box only after hearing it on a real stream.

A change lands at the next chunk boundary but is *heard* only once the deck's
buffered audio drains — expect **~3–4 s** from click to ear on an unarmed
deck (the 1 s chunk plus the worker's ~3 s pacing cushion).

## Setup

- [ ] `just tauri-dev`, app open; deck A playing a drum-heavy style (e.g.
      "four on the floor techno" plus something pitched, e.g. "warm dub
      chords").
- [ ] Open deck A's performance door (the Config rail on the prompt pad):
      the **No drums — sit beside** toggle is off (auto), with MIDI steering
      off. The control is a binary toggle, matching the magenta-realtime
      `drumless` — there is no "force drums".

## The control, by ear

- [ ] Flip **No drums** on for the playing deck: the kit audibly thins/drops
      within ~4 s (from a fresh stream) while the pitched content continues.
      On a stream that has been drumming a while, expect the full thinning to
      take ~10-30 s as the drummed context rolls out (docs/spike-mrt2.md) —
      not instant.
- [ ] Flip it back off: the model's own drum choice returns.
- [ ] It works with **MIDI steering off** — the toggle never arms the deck
      (the steer switch stays off, the chunk cadence unchanged).

## Suppression strength (cfg_drums, issue #50)

- [ ] The **Suppression strength** slider appears only with No-drums on, not
      when off, range **0-5**, defaulting to **4** (matching the
      magenta-realtime reference's `DEFAULT_CFG_DRUMS`).
- [ ] With No-drums on, lowering strength toward 0 audibly weakens the
      suppression (drums creep back); raising toward ~5 bites hardest. Confirm
      4 is a good default on real speakers; note if a different value is
      preferable and adjust `DEFAULT_DRUM_STRENGTH`.
- [ ] Strength persists across stop→play with the toggle (both are deck
      config).

## Sticky across discontinuities (the #50 semantics)

- [ ] **No drums** on, then **stop** deck A and **play** again: the toggle
      still reads on, and within ~4 s of the fresh stream the drums are
      audibly suppressed again (the re-assert landed).
- [ ] **No drums** on, then **switch deck A's model**: after the reload and a
      fresh play, the toggle still reads on and the suppression audibly holds.
- [ ] Held **notes** still die on stop→play (steer a chord via pads/MCP,
      stop, play): free harmony returns — only drums stick.

## The two-deck point of the feature

- [ ] Deck B looping a beat (layered sample or its own stream) under deck
      A: flipping deck A's **No drums** on audibly un-muddies the low end;
      flipping back restores the clash.

## Onset note decay (issue #46/#48, folded in)

The engine now decays a held onset (state 2) to sustain (1) after the chunk
that sounds it, so a held key stops re-attacking at the chunk rate. Unit tests
cover the state decay; this confirms it by ear.

- [ ] Arm a deck (MIDI steering on), set Note mode to **On-grid onset**, and
      hold a pad/key: the note attacks once and then **rings/sustains** — no
      machine-gun re-attack at the ~5 Hz chunk rate.
- [ ] **Chord follow** is unchanged: held pads still re-voice per chunk (the
      forgiving default), not a stuck single attack.

## Reference-aligned sampling defaults (issue #50 audit, folded in)

`engine.py` now sets the magenta-realtime app defaults (`cfg_musiccoca` 1.6,
`cfg_notes` 2.4, `temperature` 1.1, `top_k` 50) instead of the raw library
floor. This changes generation character globally — unit tests lock the values
but only ears judge the result.

- [ ] General playback sounds musical, not degraded — with the looser prompt
      adherence (`cfg_musiccoca` 1.6 vs old 3.0) the model drifts more
      creatively from the prompt; confirm that reads as better, not worse.
- [ ] Note steering (issue #48) binds *more* tightly to held notes than before
      (`cfg_notes` 2.4 vs old 1.0) — held chords should track more strongly.
- [ ] Non-held pitches are now MASKED, not off (matching the reference): a held
      chord anchors the harmony and the model **embellishes around it** rather
      than playing only the held notes. Confirm this sounds fuller/more musical
      than the old off behavior.

## Agent/UI agreement

- [ ] MCP `set_drums` (suppress/auto) moves the drawer toggle; the toggle is
      reflected in the MCP interface-state resource (`drums: false / null`).
      The MCP tool sets the mode only and inherits the deck's current
      strength.
