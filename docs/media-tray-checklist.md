# Media tray checklist — collapsible, resizable drawer

Manual verification of the Media Explorer drawer: it opens/closes like a tray,
resizes by dragging its top grip, toggles on **Cmd/Ctrl+M**, and remembers its
state across reloads. The state plumbing (App ↔ `MediaExplorer`), the persistence
(`loadAppSettings`/`updateAppSettings`), and the toggle/collapse rendering are
unit-tested; this checklist is the last hop — real window, real keyboard, real
pointer (and the one thing tests can't cover: the macOS Cmd+M minimize default).

## Setup

- [ ] `just tauri-dev`, app open, the Media Explorer visible below the decks.

## Open / close

- [ ] Click the header chevron: the tray collapses to a thin bar and the booth
      (decks/waveforms) grows to fill the reclaimed space.
- [ ] Click the chevron again: the tray expands and shows its content at the same
      height it had before.

## Keyboard shortcut

- [ ] Press **Cmd+M** (macOS) / **Ctrl+M** (Win/Linux): the tray toggles.
- [ ] On macOS, Cmd+M **does not also minimize the window** (the in-app
      `preventDefault` wins). If the window minimizes, the native Cmd+M menu
      accelerator is still firing and must be disabled/rebound.
- [ ] The shortcut is ignored while typing in a text field (e.g. a track prompt)
      — pressing it there does not toggle the tray out from under you.

## Resize

- [ ] Drag the grip on the tray's top edge upward: the tray grows; downward: it
      shrinks. The content tracks the cursor smoothly (no easing lag mid-drag).
- [ ] Resize is clamped: it won't grow past a sensible max or shrink below a
      usable min, and the booth stays visible/scrollable at the extremes.

## Persistence

- [ ] Set a custom height, collapse the tray, then reload (or quit + relaunch):
      the tray comes back **collapsed**.
- [ ] Expand it: it returns to the **custom height** you set, not the default.
