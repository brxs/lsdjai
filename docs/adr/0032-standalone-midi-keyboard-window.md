# 0032. Standalone MIDI keyboard window, routing decoupled from steering

- **Status:** Accepted (2026-07-08)
- **Date:** 2026-07-08
- **Deciders:** Daniel Peter

## Context

Note/drum steering threads MRT2 conditioning through the pipeline (ADR-0023),
and the Rust shell is the single sender for all note authorship (ADR-0031). The
hardware surfaces — FLX4 performance pads and an external MIDI keyboard — landed
in issue #48. Issue #49 asks for the surface that needs **no hardware**: an
on-screen piano playable from the computer keyboard.

Two forces shape it, neither anticipated by the issue:

- **The piano is an app-wide instrument, not a per-deck control.** Embedding a
  piano per deck fails on two counts: a per-deck *octave shift* can't share one
  global QWERTY capture (a single keypress maps to one octave, not two), and a
  piano hosted in the main window collides with the existing single-letter focus
  shortcuts (`a`/`b`/`x` in `shortcuts.ts`), forcing fragile focus-scoping to
  disambiguate which of two decks is being played.
- **Routing vs. the steering arm.** A deck's performance config already has an
  `armed` flag (the drawer's "MIDI steering" switch) that shrinks its generation
  chunk to ~200 ms and gates the shared hardware keyboard. It is a separate
  question whether playing the on-screen piano should arm the deck. Note
  conditioning is applied to a deck's generation every chunk regardless of
  `armed`; arming only changes latency and hardware routing.

The app has, until now, been a single native window.

## Decision

We will render the on-screen MIDI keyboard as its **own dedicated Tauri window**
(label `piano`, loaded as `index.html?window=piano`; `main.tsx` branches on that
param). The `piano` window is added to the default capability so it can invoke
IPC and receive the store's global `store://changed` broadcast. A
`toggle_piano_window` command creates / shows / hides it; a window close is
intercepted to **hide** (so the toggle re-opens it with its state intact), and
its visibility is mirrored to the store (`piano_window_open`) so the media-tray
toggle reflects it.

The window captures the computer keyboard at the **window level** — the whole
window is the instrument — and holds two routing toggles (A / B) deciding which
decks each note reaches. **Routing only sends notes:** each press calls the
existing per-deck `deck_keyboard_note` → `NoteSteering.keyboard_event_deck`,
which snaps the raw pitch to that deck's key/scale and holds it on a per-deck
`screen_pitches` ledger, and **does not arm the deck**. Arming stays a separate,
deliberate act; a routed-but-unarmed deck still takes the conditioning, at its
default chunk.

## Consequences

- A dedicated window sidesteps both the two-decks-one-octave problem and the
  letter-shortcut collision (a piano window loads no shortcut handler), and it
  can float over the app or move to another display during a set.
- The single-sender contract (ADR-0031) is preserved: all note authorship still
  flows through `NoteSteering`; the window only chooses target decks, exactly as
  the per-deck drawer already does.
- The app is now **multi-window**. Cross-window state rides the existing global
  store broadcast (no new mechanism), but the capability must now scope both
  `main` and `piano`, and any future per-window state/permission needs deliberate
  scoping.
- "Just send notes" means playing an un-armed deck conditions generation at the
  default ~1 s chunk (laggy) until its steering is armed — accepted, so the two
  controls (steering latency vs. note routing) stay orthogonal.
- The held-note lifecycle now spans a window that **hides rather than closes**,
  so the surface must release held notes on blur / hidden / unmount or a pitch
  would drone on in the shell (handled in `PianoWindow`).
- Routing state lives in the piano window (local React state); it survives
  hide/show because the window hides rather than destroys, and resets on app
  restart. If a second surface ever needs to share routing, promote it to the
  store.

## Alternatives considered

- **Per-deck in-drawer piano** — a small piano in each deck's performance
  drawer. Rejected: per-deck octave shift can't share a global QWERTY capture,
  and an in-main-window piano collides with the `a`/`b`/`x` focus shortcuts,
  needing fragile focus-scoping to route to one of two decks.
- **In-app floating panel instead of a real OS window** — less plumbing (no
  second window, no cross-window sync). Rejected: it can't leave the app window
  or sit beside it on another display, which a performer wants.
- **Routing arms the deck (auto-arm on first note)** — like the FLX4 KEYBOARD
  pads. Rejected: it would flip the drawer's steering switch as a side effect,
  conflating two controls the design keeps independent; the performer arms
  steering explicitly when they want the tighter chunk.
- **Own the A/B routing state in the Rust sender and mirror it to the store** —
  instead of frontend-local routing calling per-deck commands. Deferred: the
  webview already chooses the target deck for every note surface, and local
  routing needs no new store field or shell routing state; revisit only if a
  second surface must share the routing.
```
