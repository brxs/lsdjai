# 2D net hardware checklist — controller-driven prompt navigation

Manual verification of the live-mode "net": HOT CUE pads select prompt dots and
the jog reels the selected dots in/out of the cursor. Hardware cannot be
e2e-automated (ADR-0005): the geometry (`netGeometry.ts`), the selection/jog
wiring (`DeckColumn`), and the LED echo (`flx4.ts`/`useMidi`) are unit-tested;
this checklist covers the last hop — real FLX4 firmware bytes through a real
browser into the net — and resolves the one measured unknown: whether the HOT
CUE pads show brightness (the dim-vs-bright LED scheme). See the byte map in
[`midi-ddj-flx4.md`](midi-ddj-flx4.md) (HOT CUE and jog rows, LED feedback).

## Setup

- [ ] Pioneer DDJ-FLX4 connected over USB and powered on.
- [ ] `just tauri-dev`, app open, **Connect MIDI** allowed (LED green).
- [ ] A deck in **realtime** (live) mode with three or more style targets on the
      pad, so the net has strands and a web to show.

## Selection (HOT CUE pad → toggle)

- [ ] Tapping a HOT CUE pad selects its prompt: on screen the dot gets a ring/
      glow and its strand lights; the blend does **not** jump (no cursor-snap).
- [ ] Tapping the same pad again deselects it (ring/strand return to idle).
- [ ] Tapping several pads selects several dots at once.
- [ ] A pad with no prompt behind it (index ≥ target count) does nothing.

## Jog reels the selection in / out

- [ ] With one dot selected, turning the jog **clockwise** moves the dot toward
      the cursor and that prompt audibly grows in the blend.
- [ ] **Counter-clockwise** pushes it back out; the prompt recedes.
- [ ] A dot never collapses onto the cursor nor leaves the pad at the extremes.
- [ ] With several dots selected, one jog moves them all together.
- [ ] With **nothing** selected, the jog does nothing in live mode (no scratch,
      no drift) — the realtime stream is untouched (ADR-0004).
- [ ] The mouse still drags both the cursor and any dot; the net follows.

## SHIFT+jog steers the blue dot (full 2D)

- [ ] Hold a deck's **SHIFT**: turning **jog A** moves THAT deck's blue dot
      left/right (CW → right), turning **jog B** moves it up/down (CW → down).
      Both wheels together navigate the dot anywhere on the pad.
- [ ] Holding the OTHER deck's SHIFT steers the other deck's dot the same way.
- [ ] While SHIFT is held the jogs steer and do **not** reel selected dots;
      release SHIFT and the plain-jog reel is back.
- [ ] Steering feel: tune `CURSOR_JOG_STEP` in `DeckColumn.tsx` if a turn moves
      the dot too far / not far enough. Tuned value = `______`.
- [ ] If the OTHER deck is in **playback**, steering borrows its jog **without**
      scrubbing that track — the playback position holds while you steer.
      (Holding SHIFT on a playback deck still scrubs it normally.)

## LED scheme — the measured unknown (decision §4.4)

- [ ] Selected pads read **brighter** than available-but-unselected pads.
- [ ] If the pads are on/off only (no brightness), available and selected both
      simply read "lit" — acceptable; the on-screen net carries the selection.
- [ ] If dim pads read as off (or barely lit), bump `PAD_LED_DIM` in `flx4.ts`
      until "available" is clearly dim-but-on, and note the value here:
      measured dim velocity = `0x____`.
- [ ] Empty pads (no prompt) stay dark.

## No regression to playback mode

- [ ] Load a track (deck flips to playback). HOT CUE pads set/jump hot cues as
      before; the jog seeks/nudges as before; neither touches the net.
- [ ] Returning to live (Back to Live / load a crate) restores net behaviour and
      starts with nothing selected.

## Visual pass

- [ ] The net reads well: strands swirl out of the cursor, the web leans inward,
      selected strands/dots glow. Tune `STRAND_SWIRL` / `WEB_INSET` / the glow in
      `netGeometry.ts` / `ui.css` if it looks off.
- [ ] Dots and their strands move in lockstep — no dot trailing its own net —
      both when dragging with the mouse and when jogging.
