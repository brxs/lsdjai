# Issue #37 Phase 2 — native MCP server: round-trip checklist

Phase 2 of issue #37 (ADR-0020) exposes the instrument over a native **MCP server**
hosted inside the Tauri process: an external AI agent (Claude Desktop / Claude Code)
acts as a co-DJ — it **observes** the live state (a store-snapshot resource) and
**acts** through tools that mutate the one interface store, so its move shows on
screen and drives the audio exactly like a hardware or on-screen move (the
bidirectional projection).

The unit and integration tests cover the store mutators, the tool wiring, and the
projection hooks. **This checklist is the part tests can't reach**: that a real MCP
client connects, reads the live state, and drives the decks/mixer/FX/cues/style and
generation — with the screen and audio following. Tick a box only after seeing it
with a real client and real audio.

## Setup

- [ ] `just tauri-dev`, app open, both decks audible, mixer visible. (The MCP server
      is **always on** now — no flag.)
- [ ] Open **Settings → AI co-DJ (MCP)** (bottom of the drawer). The **endpoint**
      (`http://127.0.0.1:<port>/mcp`) and a **bearer token** are shown, with
      copy-paste snippets for Claude Code and Claude Desktop / Cursor.

## Connection — always-on + token

- [ ] **Claude Code.** Run the shown `claude mcp add --transport http lsdj …
      --header "Authorization: Bearer …"` command. `claude mcp list` (or the client's
      tool list) shows `lsdj` connected with its tools.
- [ ] **Claude Desktop / Cursor.** Paste the shown `mcpServers` block into the config
      file at the path the panel names, restart the client; `lsdj` appears connected.
- [ ] **Token required.** A request with **no** `Authorization` header, or a wrong
      token, is rejected `401 Unauthorized` (try `curl http://127.0.0.1:<port>/mcp`
      with no header). The right token is accepted.
- [ ] **Loopback only.** The endpoint is bound to `127.0.0.1`; it is not reachable
      from another machine on the network.

## Observe — the interface-state resource

- [ ] The client lists a resource **`lsdj://interface-state`**. Read it: the JSON
      reflects the current crossfade, cue-mix, and per-deck volume / EQ / cue / FX /
      trim / model / playing / cues / track / style.
- [ ] Move something by hand (a fader on screen or the FLX4), re-read the resource:
      the value has changed to match. The agent observes the live instrument.

## Act — mixer (bidirectional)

For each: call the tool from the client, watch the **on-screen** control follow and
the **audio** change; then move the same control by hand and confirm a re-read of the
resource reflects it.

- [ ] `set_crossfade(position)` — the crossfader slides; audio blends A↔B.
- [ ] `set_volume(deck, gain)` — the channel fader moves; the deck gets louder/quieter.
- [ ] `set_eq(deck, band, value)` — low/mid/high knob turns; the band shifts.
- [ ] `set_cue_mix(position)` — the headphone cue/master blend shifts.
- [ ] `set_fx(deck, kind)` / `set_fx_amount(deck, amount)` / `clear_fx(deck)` — the
      Color FX selection AND its intensity change on screen; the effect is heard.
- [ ] `set_trim(deck, db)` — the trim moves. `set_cue(deck, on)` — the channel's
      headphone-cue (PFL) tap toggles on screen.

## Act — realtime decks

- [ ] `deck_play(deck)` on a realtime deck — it starts generating; the deck shows
      **playing** (the transport button follows) and audio comes up.
- [ ] `deck_stop(deck)` — it stops; the screen and audio follow.
- [ ] **Agent-started health.** After an agent `deck_play` (with no prior on-screen
      play), the deck's buffer / BPM / underrun meters populate, not just the button.
- [ ] `set_model(deck, model)` — the deck switches model (loading → ready on screen).
- [ ] `set_prompt(deck, prompt)` — the prompt appears on the style pad as one target
      and the generated audio moves toward it.

## Act — hot cues (a playback deck with a loaded track)

- [ ] `set_hot_cue(deck, index, seconds)` — the pad lights at that position on screen.
- [ ] `clear_hot_cue(deck, index)` — the pad clears.
- [ ] `jump_to_hot_cue(deck, index)` — the track **seeks** to the cue (transport jumps
      straight through the engine); the playhead moves and audio jumps.
- [ ] On a **realtime deck / no track**, the cue tools return a "no loaded track"
      message rather than doing nothing silently. An out-of-range pad is reported.

## Act — generative style pad (a realtime deck)

- [ ] `set_style(deck, targets, cursor)` — the style pad re-renders with the new
      targets and blend point; the **generative output audibly shifts** toward the new
      prompt mix within a few seconds (the blend is pushed to the worker).
- [ ] `set_style_cursor(deck, x, y)` — only the blend point moves; the output leans
      toward the nearer targets. The targets themselves are unchanged.
- [ ] Move the pad by hand afterward: it still works, and a re-read of the resource
      reflects the hand-set arrangement (no echo fight, no boot-time clobber of the
      persisted layout).

## Act — load tracks & clips

- [ ] `list_songs()` / `list_samples()` return the library entries (each with a
      `file`), matching what the Media Explorer shows.
- [ ] `load_track(deck, file)` — the deck flips to **playback** and shows the track
      (overview + title), the same as a Media-Explorer "load to deck".
- [ ] `load_sample(deck, file)` — the clip lands in the deck's pad/loop slot.
- [ ] A bad `file` is reported ("call list_songs…"), not a silent no-op.

## Act — track transport (a loaded track)

- [ ] `seek_track(deck, seconds)` — the playhead jumps; audio follows.
- [ ] `set_tempo(deck, bpm)` — the deck's tempo readout and pitch change (clamped to
      the varispeed range). With no loaded track, it reports there's no BPM to set.
- [ ] `sync_deck(deck)` — the deck beat-matches the other deck's tempo.
- [ ] `beat_loop(deck, beats)` — an N-beat loop engages and shows on screen.

## Generation

- [ ] `generate_sample(prompt, seconds, kind)` with `kind` = `sfx` or `music` —
      after a short wait the clip **appears in the Samples tab** (the folder watcher
      surfaces it) and is loadable onto a deck.
- [ ] `generate_track(deck, prompt, seconds)` — after the (longer) render, a full
      track is saved to the songs library AND **loaded onto the deck** (it flips to
      playback and shows the track).
- [ ] A bad request (empty prompt, out-of-range `seconds`) returns the generation
      server's validation message, not a crash. With the generation server down, the
      tool reports it's unavailable.

## Token rotation

- [ ] **Settings → Rotate token.** A new token is shown and the snippets update.
- [ ] A client still using the **old** token is now rejected `401`; reconnecting with
      the **new** token works. (The new token persists across relaunch — the config
      stays valid without re-copying.)

## Concurrency (nice-to-have)

- [ ] Drive a fader on screen while the agent drives another control: both land on the
      one store (last-write-wins), with no divergence between the screen, the hardware,
      and the agent's view.
