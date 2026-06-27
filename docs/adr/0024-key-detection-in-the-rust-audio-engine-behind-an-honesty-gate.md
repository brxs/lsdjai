# 0024. Key detection in the Rust audio engine, behind an honesty gate

- **Status:** Proposed
- **Date:** 2026-06-27
- **Deciders:** Daniel Peter

## Context

Harmonic auto-mix wants the *generative* deck to play in a key compatible
with the *playing* deck — the AI-native version of harmonic mixing. With
note conditioning wired (ADR-0023), the missing piece is measuring the
playing deck's key. The codebase has none: a search for chroma/chord/key
detection finds only keyboard-shortcut "chords" and prompt text. So this is
a new analysis, and it sits in tension on the same three axes ADR-0010
settled for tempo:

- **Where it runs.** ADR-0025 moves beat detection out of the frontend and
  into the Rust shell, on a non-realtime analysis thread fed by the PCM that
  already terminates in Rust (`run_reader`, src-tauri/src/sidecar.rs), and
  narrows ADR-0017's "analysis stays in TypeScript" clause accordingly. Key
  is a *new* analysis with no shipping code to relocate, so the only question
  is where to *birth* it — and a second analysis home in TypeScript would
  split musical state across the process boundary from the opposite side of
  the one ADR-0025 just consolidated.
- **How "unsure" is handled.** A *wrong* key clashes harder than no
  steering — and here the estimate doesn't just light a readout, it drives
  generation. Atonal and percussive material has no key at all.
- **Who consumes it, and across which boundary.** The consumer is the
  *other* deck. A key that steers the opposite deck is inter-deck musical
  state by definition; it cannot live hook-local in `useDeck`.

## Decision

- **Detection is born in the Rust shell, beside beat detection.** A pure
  incremental estimator — a sibling module to ADR-0025's beat estimator, in
  the **shell crate** (`lsdj-app`, src-tauri/src), not the headless
  `lsdj-engine` — consumes the same per-deck PCM off the same `run_reader`
  tee on the same non-realtime analysis thread, and **never** runs on the
  `cpal` callback (device.rs), which only drains the ring under
  `assert_no_alloc`. Because key needs an FFT/chroma pass per window —
  heavier than beat's autocorrelation — the dedicated analysis thread is
  mandatory here so a slow pass cannot block the socket read in `run_reader`.
  No backend, no audio-graph node, no new transport.
- **Chroma plus a key profile, gated like the BPM readout.** Per-frame
  12-bin pitch-class energy accumulates over a window; key-profile
  correlation (Krumhansl-Schmuckler or equivalent) yields a key/mode
  estimate (24 major/minor) and a confidence. An **honesty gate owns the
  output**: confidence must clear a corpus-calibrated threshold and agree
  across consecutive windows before a key publishes; low confidence or
  disagreement blanks it. Material with no key never publishes — that
  property is the feature (ADR-0010's stance, inherited through ADR-0025).
  The threshold and stability counts are calibrated against a key corpus
  this analysis must establish from birth — it carries no legacy corpus, so
  unlike beat (ADR-0025) it is not gated on reproducing a prior
  measurement, only on standing up its own.
- **The gated key — not the raw analysis — is lifted to shared, cross-deck
  state.** Because the consumer is the opposite deck, the published key
  rides whatever ADR-0020 settles for the interface-state store rather than
  a bespoke side-channel; only the gated value crosses, never the
  per-frame chroma. This is the same published-scalar shell-state surface
  ADR-0025 defines for the gated BPM, so tempo and key share one home and
  one MCP-readable surface (ADR-0020).
- **Consumers map key→conditioning and quantise to the bar themselves.**
  Harmonic auto-mix turns the published key into a scale/chord-tone multihot
  and sends it over ADR-0023's note path, quantising the change to the
  playing deck's beat grid (ADR-0014, now fed from ADR-0025's Rust gate) so
  harmony shifts on a bar, not mid-phrase. Detection reports key only; the
  pitch-class mapping and timing are the consumer's.
- **Estimates never span streams** — load, play, stop, model switch, worker
  crash reset estimator and gate alike (the ADR-0009/0010 discontinuity
  rule), the reset reaching the Rust estimator and gate atomically.

## Consequences

- Easier: harmonic auto-mix and any key-aware feature (e.g. a snap-to-scale
  default) read one gated value; the estimator is one chroma-plus-correlation
  pass per deck per window on the analysis thread — the cost class ADR-0010
  already accepted, off the realtime path.
- One musical-state authority. Born in Rust beside beat (ADR-0025), key
  avoids the guaranteed future port that a TypeScript birth would incur once
  it must reach the other deck — and it does not re-open the tempo/key split
  ADR-0025 closes. Building it in TypeScript would be "build it twice".
- Acquisition latency: a key gates in only after a few seconds of steady,
  tonal audio and trails a key change by about one window — the deliberate
  price of never asserting a wrong key, the same trade the BPM readout makes.
- Modulating or ambiguous material may blank or settle on a relative
  major/minor; auto-mix simply stops steering when the gate blanks, reverting
  the generative deck to free harmony.
- This publishes the first piece of shared inter-deck *musical* state, which
  is why it is pinned to ADR-0020's store rather than a one-off channel. The
  cross-deck *consumer* (steering the opposite deck) is genuinely blocked on
  ADR-0020 being Accepted and implemented — and ADR-0020 is currently
  Proposed and unbuilt (no shell-level store exists yet; React remains
  authoritative for semantic state). If that store is not yet in place,
  auto-mix is blocked on it, not on a private workaround. (Computing key in
  Rust and surfacing it per deck is not so blocked — the same asymmetry
  ADR-0025 records for beat.)
- Key-level, not chord-level: the estimate is enough for scale-compatible
  steering. Finer chord tracking is deferred unless auto-mix proves too
  coarse.

## Alternatives considered

- **Detection in the frontend (`key.ts`, sibling to `beat.ts`)** — rejected:
  it would split musical state across the process boundary now that ADR-0025
  has moved beat detection into Rust, and it would strand the cross-deck key
  in the webview, the wrong side of the boundary from its opposite-deck
  consumer and the ADR-0020 store. The earlier draft of this record chose
  the frontend by mirroring ADR-0010; ADR-0025 reverses that premise.
- **Backend / librosa detection** — the measurement tool, not the product
  (ADR-0010's wording): it adds a separate protocol surface and a third
  process for an estimator the analysis thread runs beside the PCM source.
- **Steer on the best-guess key with no gate** — rejected: a wrong key
  clashes harder than silence, and this estimate drives generation, not just
  a readout; blank-when-unsure is the only safe input to harmony.
- **Full beat-synced chord transcription** — more DSP/model than
  scale-compatible auto-mix needs; deferred behind the key-level estimate.

<!-- Status values: Proposed | Accepted | Rejected | Deprecated |
     Superseded by ADR-NNNN -->
