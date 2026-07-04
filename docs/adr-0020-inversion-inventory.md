# ADR-0020 inversion inventory — what still isn't store-owned

**Status: working inventory (2026-07-04), audited on the issue-48 branch.**
ADR-0020 made the Rust store the single source of truth and scoped "React
becomes a projection" as the larger, deferred half. This is the complete map
of where that half stands, produced after a night of mirror-synchronisation
bugs (the prompt-revert pair, the wedged play guard) that all trace to the
same cause: **React-authoritative state with a store copy needs echo gates,
and every echo gate is a latent race.** Four distinct gate mechanisms coexist
today — `mixerSyncedRef` (per-field value compare), `styleExternal` (writer
keyed), `cuesSyncedRef` (track-scoped arming), and `useProjected`'s 120 ms
settle window — plus the transport's `playPendingRef` in-flight guard. A
finished inversion deletes the entire class.

Classification: **PROJECTION** (store-owned, React renders — done),
**MIRRORED** (React-authoritative + store copy — the bug class),
**REACT-ONLY** (semantic state the store never sees — agents and hardware
are blind to it), **VIEW** (legitimately React per ADR-0020's narrowing).

## Already inverted (the pattern to copy)

| State | Notes |
| --- | --- |
| `playing` | Store-owned; webview projects + `playPendingRef` bridges the round trip (useDeck:649-669) |
| `performance` (armed/key/scale/mode), `notes`, `drums` | Pure intent→store→projection (issue #48; PerformanceDrawer) |
| live beat `analysis` | Shell-written measurement (ADR-0025) |
| `crossfade`, `cueMix` | Store-owned with `useProjected` optimistic overlay (App:228-237) — but persistence is still webview localStorage, and MCP-adopted moves are silently not persisted |
| MIDI status/monitor, model-manager status | Projections over their own channels |
| engine transport/health read-backs | Engine-owned, polled (`engine_snapshot`) — fine as is |

## MIRRORED — React authoritative, store copy, gate-protected

| State | Owner | Gate | Persistence | What moves to Rust on inversion |
| --- | --- | --- | --- | --- |
| Style targets + cursor + net selection | DeckColumn:225-264 | `styleExternal` writer flag (DeckColumn:391-416) | `updateDeckSettings` (targets/cursor; sampled chips excluded) | spawn/sweep/fan-out geometry (padWeights.ts), MAX_TARGETS cap, dup/rename rules, throttled style send, restart re-send episode gate, preset apply |
| volume / eq / cue / fx / trim | useDeck:301-313,395-407 | `mixerSyncedRef` per-field epsilon compare (useDeck:421-487) | `updateDeckSettings` per field (`cue` deliberately unpersisted) | persistence + boot hydration (today the channel replays localStorage into the engine, nativeEngine:892-909); FX rest-position-on-select; trim auto/manual mode + the auto-gain loop (fed by the TS loudness tracker — the coupling that keeps trim webview-side) |
| hot cues (points + set/jump/clear logic) | useDeck:341, 1044-1075 | `cuesSyncedRef` track-scoped arming (useDeck:512-528) | none (session) | capture = playhead snapped to grid when confident; jump-is-a-seek; clamping |
| track identity / transport / loop-labels / model / primed | useDeck (write-only mirrors) | none (write-only) | none | these become Rust-internal store feeds once their owners invert |
| media library lists | MediaExplorer:298-350 | filename-keyed reconcile | disk registry (already shell-owned) | pending-generation overlay + session takes; generation jobs are webview `fetch`es today |
| mcpInfo (port/token) | App:351-364 | fetch-once cache, no reconcile | Rust-side already | fold into a store/event feed (mind token exposure) |

## REACT-ONLY — the store (and every agent) is blind

| State | Owner | Why it matters |
| --- | --- | --- |
| **Deck mode** (realtime/playback) | useDeck:335-340 | Gates nearly every intent (transport branches, all track ops, pad meaning, PCM tap). Explicitly flagged pre-inversion (nativeEngine:361-363). The `mcp://deck-command` and `mcp://load-*` webview relays exist *only* because of this |
| **Operability** (connection/workerDied/switchingModel/error) | deckState:51-57 | An agent cannot see a dead worker. Shell already receives every input (sidecar status relay) — this is a shell-side write plus projection, no webview semantics to move |
| **Loop slots** (filled/pending/one-shot/layering) | useDeck:314-332 | Store has labels only; capture races (`loopGestureRef`, `slotGenerationRef`), quantised capture length, layer-vs-replace, auto-save — all invisible |
| **Beatgrid + quantise + sync** | useDeck:341-357, 1077-1170 | grid never reaches the store; loop IN/OUT/beat-loop quantise, phase meter, sync verdicts (`no_tempo`/`out_of_range`) all webview |
| **Generate flow** | useDeck:1465-1576 | webview HTTP to the generation server; BPM stamping, bar snapping — bypasses the store entirely |
| **Recording** (active/busy) | RecordControl:33-34 | the shell records; only the webview knows it's recording; reload desyncs |
| **shiftHeld** | App:499-503 | originates in the shell translator, kept only in React |
| **Output device choices** | App:259-264 | engine applies; store blind; localStorage persisted |
| **Presets/crates** | App:482 + persistence.ts | localStorage collection; parse/validation webview-side |
| **Browse state** (explorer tab/highlights/folder scope, crate highlight) | MediaExplorer:294-328, CrateBrowser:35 | consumed AND mutated by hardware intents; folder path is a read-scope (security-relevant) |
| **accent / beatView / recordingsFolder** | App:266-316 | plain settings, localStorage; `set_recordings_folder` etc. would be trivial store settings |
| availableModels/ramInfo, activeStyle, rtf | deckState | telemetry/read-backs to re-home when their flows move |

## VIEW — stays in React (correct today)

Drawer/door open state, text drafts (`targetDraft`, compose fields, preset
name, port draft), in-place edit state, focus refs, transient errors/flashes,
`sampling`/`dragging` flags, media tray open/height (persisted but layout),
picker enumerations, `previewingId` row mapping, throttle/coalescer instances.

## Systemic constraints any phase must respect

1. **Persistence moves with ownership.** Every inverted field's localStorage
   slot (`lsdj:v1` deck + app settings, presets) must be replaced by
   shell-side persistence AND shell-side boot hydration — the `synced` gates
   exist precisely because the webview replays localStorage into the engine
   at boot. Half-moving (store owns, webview persists) recreates the race.
2. **`cue` (PFL) is deliberately never persisted** — the rule survives the
   move.
3. **Sampled style chips are session-only** (ADR-0011) and excluded from
   persistence; the store already omits their embedding ids.
4. **The TS loudness tracker feeds auto-trim** — trim inversion either moves
   the loudness measurement shell-side (it already has the PCM tee) or keeps
   an auto-trim *intent stream* from the webview. Decide before touching trim.
5. **MCP relays die with their causes**: `mcp://deck-command`,
   `mcp://load-track/-sample` exist because mode/load/transport semantics are
   webview-side; each inversion phase should delete its relay rather than
   keep both paths.

## Phasing (proposed)

- **Phase A — shell-truth quick wins (no webview semantics move):** DONE.
  operability → store (relay-fed), recording → store (recorder-fed),
  shiftHeld → store (translator-fed), devices/recordingsFolder →
  shell-persisted settings in the store (accent/beatView stayed webview-side:
  presentation-only, the shell never consumes them). Each deletes a blind
  spot; none needs an echo gate afterwards.
- **Phase B — the style pad:** DONE. Full inversion of
  targets/cursor/selection with store intents (`style_add_target`,
  `style_add_sample_target`, `style_move_target`, `style_remove_target`,
  `style_rename_target`, `style_toggle_selection`, `style_fan_out`,
  `style_set_cursor`, `style_apply_preset`); geometry/caps/dedup in
  `style.rs`; the worker blend send + restart re-send in `style_send.rs`
  (the shell sender); persistence + boot hydration in the shell settings;
  the `styleExternal` gate, the atomic mirror, and the webview
  `deck_set_style` path deleted. The proven bleeder; biggest single payoff.
- **Phase C — mixer fields + boot hydration:** DONE. The shell hydrates the
  mixer (volume/eq/fx/trim, crossfade/cue mix) into engine + store from the
  settings file BEFORE the webview exists, and `settings::watch_persistence`
  persists the store's settings slice — so `mixerSyncedRef`, the webview
  boot replay (App.tsx and `createDeckChannel`'s initial-config replay), and
  the localStorage slots are gone. Mixer gestures are deck-indexed intents
  (`nativeEngine.setDeckVolume`/`Eq`/`Trim`/`Cue`/`Fx`/`FxAmount`),
  independent of the channel lifecycle; Rust `set_fx`/`clear_fx` park the
  amount at the kind's rest in the same write (the engine already did). The
  trim decision (constraint 4): the loudness tracker stays TS — auto-trim
  remains a webview intent stream, and only the auto/manual MODE persists
  webview-side (`trimMode`).
- **Phase D — transport & mode:** DONE (except the relay — see below). Deck
  mode is in the store (`set_deck_mode`, written by the webview's load flow);
  the hot cues are store-OWNED — the bank opens/drops with the track identity
  in `set_track` (the same-write rule that killed the stale-cue window
  `cuesSyncedRef` fenced), pads mutate through the `set_deck_cue_point`
  intent and the MCP cue tools, and the webview projects them.
  `playPendingRef` is gone: `deck_play` guards itself with the store's
  atomic `start_transport` (stopped→playing under the lock), so a racing
  second tap is a shell-side no-op that cannot re-arm the worker or reset
  held steering. Found in the field right after D: gate-free adoption is
  only sound if snapshots arrive in MUTATION order, and the store's
  emit-after-unlock let a streaming deck's analysis tick publish a stale
  snapshot over a fresh `deck_play` (the play-button-lights-late bug) —
  snapshots now enqueue under the state lock and a single publisher thread
  emits + fans out to the watchers in that order. The `mcp://deck-command`
  relay REMAINS for
  seek/rate/sync/beatloop/onair: those semantics (transport wrappers,
  quantise, sync, the prime flow) are exactly Phase E's items, and the relay
  dies with them (constraint 5) rather than half-moving now.
- **Phase E — the long tail (own issues):** loop-slot semantics, beatgrid/
  quantise/sync, the playback transport (retiring `mcp://deck-command`),
  generate flow, media/browse state + presets.
