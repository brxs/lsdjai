# Issue 48 hardware checklist — native MIDI and playing the deck

Manual verification of the ADR-0031 cutover (all MIDI I/O native in the Rust
shell, `tauri-plugin-midi` removed) and the issue #48 performance surface.
The translator, LED builders, note service, and chunk knob are unit-tested
with the fixtures ported byte-for-byte from the retired TypeScript layer —
but a port of a *measured* layer is a new implementation until the device
says otherwise (ADR-0031), so **every mapped control re-verifies here**, plus
the bytes issue #48 interpolated (the KEYBOARD bank and its selector) and
everything only ears can judge (steering latency, snap-to-scale, onset feel).

## Setup

- [x] Native app via `just tauri-dev`, models installed, DDJ-FLX4 on USB
      before launch. The statusbar binds it within ~1 s of launch with no
      connect gesture (the Web MIDI permission flow is gone).
- [x] Deck A playing a steadily rhythmic style (e.g. "driving techno, four
      on the floor"), ~20 s to settle so the beat gate acquires (the BPM
      stat shows) — onset quantise needs the gated clock.
- [ ] Optionally: an external MIDI keyboard on USB, and a DDJ-400 for the
      second-controller pass.

## Transport and binding (the ADR-0005 flows, now native)

- [x] Hot-plug: unplug the FLX4 mid-session → statusbar drops to "No
      supported controller found" within ~2 s; replug → rebinds within ~2 s
      and the knobs/faders re-sync (the position-query flood — watch the
      monitor fill on rebind).
- [x] The monitor shows raw bytes for every gesture (the arbiter still
      works); a fader ride streams entries, a pad press shows its note.
- [x] With both Pioneers connected the picker appears; choosing the DDJ-400
      rebinds to it (its own position SysEx fires) and back.

## Control-surface re-verification (every mapped control, per deck where applicable)

Each row = move the physical control, confirm the app responds exactly as
before the port (and the monitor shows the documented bytes).

- [ ] PLAY/PAUSE toggles the deck (realtime and playback modes).
- [ ] Channel faders ride volume smoothly, full 14-bit (no coarse steps).
- [ ] Crossfader sweeps A↔B; HEADPHONES MIX blends cue↔master.
- [ ] EQ HI/MID/LOW per deck; TRIM sets manual gain and drops auto-trim.
- [ ] SMART CFX rides the Color FX amount; SHIFT + CFX sweeps the style
      cursor; release restores FX.
- [ ] HOT CUE pads: realtime = net selection toggles; playback = set/jump
      cues; SHIFT + pad clears a cue (shift pad layer).
- [ ] PAD FX pads select/deselect effects; SAMPLER pads drive the freeze
      slots; SHIFT + SAMPLER clears a slot.
- [ ] Browse rotary scrolls the explorer (direction correct, fast turns
      multi-step); rotary press cycles tabs; LOAD loads onto each deck.
- [ ] Jog: paused fine-seek, playing phase-nudge, SHIFT+jog scrub
      (CC `0x29`); realtime net reel/steer still works, including the
      cross-deck SHIFT+jog cursor steering.
- [ ] Tempo sliders varispeed a playback deck (low = slow end); LOOP
      IN/OUT, 4 BEAT/EXIT toggle, CUE/LOOP CALL halve/double.
- [ ] BEAT FX ON/OFF toggles recording; channel CUE toggles PFL; transport
      CUE preps/stops.

## LEDs (now painted from the store by the shell)

- [ ] On bind, the LEDs match the app state (target pads, FX pad, filled
      loop slots, channel/transport CUE) without touching anything.
- [ ] Switching pad mode on the device repaints the freshly-selected bank
      (the device clears pad LEDs on a switch; the shell repaints).
- [ ] The net's bright/dim distinction reads on the pads; if `0x20` is not
      visibly dim-but-on, measure a better value and update `PAD_LED_DIM`
      in `src-tauri/src/midi/leds.rs` (it was provisional before the port
      and stays provisional until this box is ticked).
- [ ] LED changes track app actions live: select an FX → its pad lights;
      fill a loop slot → its pad lights; prime a deck → transport CUE lit.

## The KEYBOARD bank (interpolated bytes — measure them)

- [x] Press SHIFT + HOT CUE mode on deck A: the selector (`0x90 0x69`)
      arms the deck — **confirmed 2026-07-03: the performance door slides
      open from the hardware.**
- [x] In KEYBOARD mode, pads 1–8 send notes `0x40`–`0x47` with press AND
      release visible in the monitor. **Measured 2026-07-03: `0x97`/`0x99`
      plain, moving to the shift pad layer (`0x98`/`0x9A`) while SHIFT is
      held — the translator accepts both layers as the same pad so playing
      never needs SHIFT and a mid-hold SHIFT can't stick a note.**
- [ ] Switching to any other pad bank closes the door (disarms).

## Playing the deck (the issue #48 acceptance criteria, by ear)

- [ ] Arm deck A (pad-mode selector or the panel button); the worker drops
      to ~200 ms chunks (the `chunk_frames_applied` status in the logs) with
      no underruns over a minute of steering — watch the health row.
- [ ] Chord-follow (default): hold pad 1 (the tonic triad) — the deck's
      harmony audibly moves to it **within ~one beat**; hold pad 5 against
      it — the change lands as a chord change, not a glitch.
- [ ] Snap-to-scale: with key C major, every pad is consonant; switch the
      panel to A minor and the same pads play the minor world. Chromatic
      turns snapping off (keyboard input passes through unquantised).
- [ ] Onset mode: tap a pad — the attack lands **on the next beat** (audibly
      on-grid against the playing groove), not on the finger. With the beat
      gate blank (deck just started), taps land immediately instead.
- [ ] Releases: letting go of all pads returns the deck to free generation
      within a few chunks (masked, not silence).
- [ ] External keyboard: with deck A armed, keys steer it (snapped); with
      both decks armed, keys steer both; disarmed decks ignore it.
- [ ] Play/stop/model-switch mid-hold: steering resets cleanly (no stale
      notes over the fresh stream), the panel's held readout clears, and
      the disarm→1 s chunk path restores after disarming.
- [ ] MCP `set_notes` still steers by ear (rerun the issue-46 checklist's
      C-major item) — now through the shell service, no webview relay.

## The store-owned style pad (ADR-0020 phase B — the pad is a projection now)

- [ ] Add a prompt while the deck is PLAYING — it stays (the historical
      revert bug class; the store is the only writer now, so there is no
      mirror to race).
- [ ] Drag a dot and the cursor with the mouse — both track smoothly (each
      gesture round-trips through the shell store; no visible lag/jitter).
- [ ] Relaunch the app — the pad layout (prompts + cursor) comes back from
      the shell settings file, and the deck resumes that blend on play
      (the shell sender re-sends on worker ready).
- [ ] Sample the other deck, then switch the model — the chip disappears
      (shell-side strip), the text prompts survive, and after the reload
      the blend is re-sent without the dead chip.
- [ ] MCP `set_style`/`set_prompt` on a playing deck — the pad updates
      immediately; a local edit right after is kept (last writer wins, no
      revert).

## The shell-owned mixer (ADR-0020 phase C — boot values come from Rust)

- [ ] Relaunch the app — faders, EQ, FX (kind + knob), trim, crossfade, and
      cue mix come back where they were left (persisted in the shell
      settings file now, not localStorage).
- [ ] Pick an FX with the knob turned up, then switch kinds — the knob
      parks at the new kind's rest (centre for filter, zero otherwise) with
      no flicker of the old amount.
- [ ] Before the first play (no deck channel yet): pick an FX and toggle
      CUE — both stick (they are store intents now, and used to be lost
      until the channel existed).
- [ ] Ride the FLX4 EQ/fader while an MCP agent moves the same deck's FX —
      both land; neither control snaps back.

## Store-owned hot cues + the transport guard (ADR-0020 phase D)

- [ ] Load a track, set two hot cues, load a DIFFERENT track — the pads
      clear (the bank lives and dies with the track identity, shell-side);
      re-loading the same track keeps them for the session.
- [ ] Hammer PLAY twice quickly from stopped — one clean stream start, no
      restart glitch, and held MIDI steering survives a redundant tap on a
      playing deck (the shell's atomic start_transport is the guard now).
- [ ] With deck A streaming (or freshly stopped), press PLAY on the other
      deck — the button lights immediately, first press, no ~1 s catch-up
      (the ordered store publisher: an analysis tick can no longer publish
      a stale snapshot over the fresh transport).
- [ ] MCP `set_hot_cue`/`clear_hot_cue` light/clear the on-screen pads
      immediately; a pad set on-screen right after is kept.

## Regression sweeps

- [ ] `just check` green; the app boots with sidecars and no MIDI-related
      errors in the console.
- [ ] DDJ-400 pass: repeat the control-surface + LED sections on the
      DDJ-400 (shared byte scheme; its own position SysEx).
- [ ] A long set (~15 min) with hardware in use: no MIDI dropouts, no
      renderer instability (the Chromium MIDI-output crash class must stay
      gone — MIDI never touches the webview now).
