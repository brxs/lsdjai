# magenta-dj Roadmap

A DJ interface over [Magenta RealTime 2](https://github.com/magenta/magenta-realtime):
two locally-running model "decks" steered by text prompts, blended with a
crossfader. Architecture decisions are recorded in [`adr/`](adr/) — notably
[ADR-0002](adr/0002-browser-app-with-python-model-workers.md) (browser app,
Python model workers) and
[ADR-0003](adr/0003-frontend-audio-mixing-via-web-audio.md) (frontend mixing
via Web Audio).

Milestones are ordered by risk: each one retires the biggest remaining unknown
before building on top of it. No dates — exit criteria gate progression.

Standing assumption: the app runs on Apple Silicon machines with enough
headroom for two concurrent model instances (Pro/Max-class for two
`mrt2_base` decks). Feasibility is taken as given; buffer-health surfacing
(M2) is how a machine that falls short shows it.

## M1 — One deck, audible

**Status: ✅ done (2026-06-09).** Exit criteria verified with
`backend/scripts/verify_m1.py` (full soak run waived); MRT2 API facts
recorded in [`spike-mrt2.md`](spike-mrt2.md).

**Goal:** end-to-end skeleton — model worker → WebSocket → browser playback.

Scope:

- Install `magenta-rt[mlx]` (uv), `mrt models init`; map the streaming API
  from the installed package (class/method names, chunk duration, sample
  rate, state between chunks — it is undocumented online).
- `backend/` (uv project): FastAPI controller; one deck worker process
  (`magenta_rt` MLX) supervised by the controller.
- WebSocket protocol v0: binary frames = PCM chunks; JSON frames = control
  (`play`, `stop`, `set_prompt`).
- Throwaway test page (no React yet) with an AudioWorklet ring buffer
  (retired in M2 as planned).

**Exit criteria:** continuous audio in the browser for 10+ minutes with no
underruns; a prompt change audibly takes effect at the next chunk boundary.

## M2 — Real frontend

**Status: ✅ done (2026-06-09).** Exit criteria verified end-to-end in
headless Chromium (`frontend/scripts/verify_m2.mjs`): deck driven entirely
from the React UI, health row (buffer meter, underrun counter, generation
speed) live in the UI; component tests pin the underrun visibility.

**Goal:** the React app replaces the test page.

Scope:

- `frontend/` (Vite + React + TS), served by the controller in production
  mode, Vite dev server with WS proxy during development.
- Deck component: prompt input, play/stop, volume fader (GainNode).
- Buffer-health indicator per deck (fed by worker status messages + client
  ring-buffer level) — this is how generation-too-slow shows up honestly.

**Exit criteria:** one deck fully usable from the React UI; underruns are
visible in the UI rather than silent glitches.

## M3 — Two decks, crossfader, model picker

**Goal:** the actual DJ instrument.

Scope:

- Second deck worker; independent WebSocket per deck.
- Equal-power crossfader on the master bus.
- Per-deck model selection (`mrt2_small` / `mrt2_base`): switching restarts
  that worker only; UI warns when the combined choice looks tight for the
  machine's available RAM.
- Worker-death recovery: deck shows an error state and offers restart instead
  of taking the app down.

**Exit criteria:** start both decks on different prompts, blend between them
live; switch one deck's model while the other keeps playing.

## M4 — Performance features

**Goal:** smoother, more musical transitions.

Scope:

- Prompt morph within a deck: two prompt slots + morph slider, worker
  re-blends the style embedding per chunk.
- BPM control, best-effort: start with a tempo hint in the prompt; promote to
  per-deck nudge/sync only if steering proves reliable in practice.

**Exit criteria:** a deck can glide between two prompts without a hard style
jump; the UI only exposes the tempo control that actually works (no
overpromising).

## M5 — Recording and polish

**Goal:** a jam is worth keeping; the app survives a session.

Scope:

- Session recording: tap the master bus, encode WAV client-side, download.
- Polish: keyboard shortcuts for fader/prompt focus, persisted last-used
  prompts/settings, graceful shutdown of workers.

**Exit criteria:** record a 5-minute mix to WAV that matches what was heard;
close/reopen the app and pick up previous settings.

## Later (not committed)

Ideas parked deliberately — each would get its own ADR if picked up:

- **Tauri desktop wrap** — webview + Python sidecars; revisit trigger in
  ADR-0002.
- **C++ engine (`magentart::core`) backend** — single distributable binary,
  supersedes ADR-0002 if pursued.
- **MIDI controller mapping** (Web MIDI) — physical crossfader and knobs.
- **Audio-prompt styles** — MRT styles can come from reference audio, not just
  text: "make deck B sound like this track".
- **Output device picker** (`setSinkId`) / external interface routing.
- **Per-deck visuals** — waveform/spectrum via AnalyserNodes (cheap, cut from
  MVP by choice).
- **Prompt/preset library** with crates of saved styles.

## Standing risks

| Risk | Impact | Mitigation |
| ---- | ------ | ---------- |
| Machine falls short of two real-time instances | Glitchy decks | Run on Pro/Max-class hardware; `mrt2_small` as default; buffer-health UI (M2) makes shortfall visible |
| BPM not reliably steerable by prompt | M4 scope shrinks | Treated as best-effort from the start; UI follows what works |
| MRT2 streaming API shifts under us (young project) | Rework in workers | Worker isolates all `magenta_rt` calls behind one small interface |
| Memory pressure with `mrt2_base` decks | Crashes mid-session | RAM guardrails in model picker (M3); worker-death recovery |
