# 0025. Beat detection in the Rust audio engine

- **Status:** Proposed
- **Date:** 2026-06-27
- **Deciders:** Daniel Peter

## Context

ADR-0010 settled beat detection on three axes — *where* it runs
(frontend, on the wire feed), *how* "unsure" is gated (the honesty
gate: 0.4 confidence, three consecutive estimates agreeing within 4 %,
one-miss grace), and *how* consumers survive metrical-level ambiguity
(level-tolerant by construction). It runs today in
[beat.ts](../../frontend/src/audio/beat.ts): band-split log-energy
flux (200 Hz / 4 kHz) → smoothed envelope → autocorrelation over
60–200 bpm, comb-scored under a club-tempo prior, with every constant
traced to the deterministic spike corpus that `beatCorpus.test.js`
streams the *shipping* code over.

ADR-0010 explicitly rejected moving detection off the frontend:
backend/librosa detection "would add a protocol surface and split
tempo state across processes for an estimator the frontend runs in
microseconds". That objection was correct *when the only consumer was a
same-deck readout*. Two forces have since inverted it:

- **The native pivot already terminates PCM in Rust.** After
  ADR-0017/0018/0019 the per-deck PCM arrives on a non-realtime
  sidecar reader thread in the shell crate (`run_reader`,
  src-tauri/src/sidecar.rs) and is written to the engine's wait-free
  SPSC ring *before* it is teed back out to the webview for analysis.
  The samples beat detection needs are already in the Rust process;
  today they round-trip to TypeScript to be analysed and the answer
  round-trips back for cross-deck features. ADR-0010's "split across
  processes" is now partly a round-trip we pay anyway.
- **Musical state has become inter-deck and inter-process.** Key
  detection (ADR-0024) steers the *opposite* deck and drives
  *generation* over ADR-0023's note path; the co-DJ / MCP vision
  (ADR-0020) wants an agent to read tempo *and* key together. Once
  tempo must cross the boundary to reach its consumers, computing it on
  the far side — next to the PCM source, the key estimator, and the
  interface-state store — stops being gratuitous. Splitting analysis so
  tempo lives in TypeScript and key lives in Rust is the real
  fragmentation.

This record reverses ADR-0010 on the *where* axis only, and narrows
ADR-0017's clause that the analysis stays in TypeScript. It keeps
everything else ADR-0010 decided.

## Decision

- **Detection moves to the Rust shell, on a non-realtime analysis
  thread.** The band-flux/autocorrelation estimator and the honesty
  gate move from `beat.ts` into a Rust analysis module in the **shell
  crate** (`lsdj-app`, src-tauri/src) — the same crate as `run_reader`
  — fed PCM by a bounded channel off the same reader tee that already
  feeds the webview analysis tap. It does **not** live in the headless
  `lsdj-engine` crate (src-tauri/engine), which keeps owning only the
  wait-free ring and the `cpal` callback, so the engine stays RT-safe
  and semantic state stays shell-side (ADR-0020). Analysis runs on a
  dedicated spawned thread so a slow pass cannot block the socket read
  in `run_reader`; it **never** runs on the `cpal`/CoreAudio callback
  (device.rs `open_spread_stream`), which sets FTZ/DAZ once and drains
  the ring under `assert_no_alloc` — no allocation, locks, syscalls, or
  logging — and **must never read analysis state** (no `Arc<Mutex<…>>`
  reachable from it); lock contention there would stall audio.
- **The estimator and gate port verbatim in intent.** The spec the
  port must reproduce is ADR-0010's, unchanged: band crossovers
  (200 / 4000 Hz), hop (512 frames @ 48 kHz), windows (12 s / 6 s min),
  the `[0.25 0.5 1 0.5 0.25]` smoothing kernel, the 120-bpm / 0.7-octave
  prior, and the gate (0.4 confidence, three-stable, 4 % tolerance,
  one-miss grace, octave folding, beatless-never-displays). These are
  *measurements*, not choices, so the port does not get to re-pick them.
- **The corpus is the contract, and a green Rust run is the cutover
  gate.** Beat detection's entire shipping margin is the corpus
  *measurement of the shipping code*, not the algorithm. The Rust
  estimator does not ship — and ADR-0010 does not flip to Superseded —
  until a Rust harness replays the same deterministic spike WAVs
  (`backend/spike_corpus`) at the same 40 ms / one-estimate-per-second
  cadence against the same locked librosa manifest, with the same
  metrical-level tolerance set (0.5, 2/3, 0.75, 1, 4/3, 1.5, 2 within
  ~8 %) and the same pass rule (rhythmic styles display, beatless stay
  blank, ambiguous may do either). The spec is **octave-match-or-better
  against the manifest**, not bit-identical to `beat.ts`: an FFT-based
  or differently-ordered kernel is allowed *only* if it passes. The
  knife-edge cases ADR-0010 measured — ambient (0.48) staying blank
  beside garage (0.49), held by the *stability* requirement not the
  threshold — mean numeric drift is acceptable only insofar as it does
  not flip a corpus verdict. Re-tuning a constant is permitted only
  after re-measuring the full corpus under identical generation and
  streaming conditions; constants may not be hand-carried into Rust and
  assumed valid.
- **Only the gated value crosses.** The published surface is a per-deck
  gated scalar set `{bpm, confidence, phase-anchor}`, updated at most
  ~once per second and read by the UI and the opposite deck — never by
  the `cpal` callback. It is therefore plain shell-level semantic
  state, not realtime engine state, and needs no wait-free discipline
  (that is the audio thread's concern, and the audio thread never
  touches it). Interim it ships as an `analysis::State` bridge value
  over a Tauri event (like `sidecar://status`) or the snapshot poll
  (`engine_snapshot`), designed to transplant into ADR-0020's
  shell-level store unchanged. The raw per-frame estimates never cross.
  Phase (the anchor) is defined against the played-consumed-frames
  counter (ADR-0014), not the realtime render clock, with the
  per-stream origin captured on reset — or freeze-pad and dub-echo
  quantisation drift against the worklet clock.
- **Consumers read the gated scalar across the boundary.** Today
  `useDeck` owns tracker+gate and five-to-six consumers call instance
  methods (`fx.ts` echo delay, `loops.ts` loop quantise, the phase
  meter, ADR-0023's `liveBeatRef` beat-aligned send). They become reads
  of the published value. The contract is *a stable scalar per deck*,
  not a raw estimate stream; consumers that lose the value fall back to
  free-running, exactly as ADR-0010's gate-blank already drives them.
- **Estimates never span streams.** Play, prime, stop, model switch,
  and worker crash reset estimator and gate alike — the discontinuity
  rule of ADR-0009/0010. The reset must reach the Rust estimator and
  gate *atomically* so the two cannot decohere across the boundary
  (tracker reset while the gate still holds a stale displayed value).

## Consequences

- One Rust home knows what each deck sounds like — tempo, phase, and
  (with ADR-0024) key — beside the PCM source and the future
  interface-state store. That is the substrate harmonic auto-mix and a
  co-DJ agent need, and it removes the webview as a required participant
  in analysis (relevant once the UI becomes a projection per ADR-0020).
- **The corpus reimplementation cost is real and load-bearing, not a
  footnote.** A Rust port is a *new* estimator until the corpus proves
  otherwise: f32-vs-Float32 rounding, autocorrelation normalisation
  order (`coeff[lag] / (n-lag) / (r0/n)`), time-domain-vs-FFT autocorr,
  and band-split IIR state can each shift the confidence distribution
  enough to invalidate the 0.4 gate and flip displayed BPM by an
  octave. Building the Rust corpus harness — replaying the WAVs at live
  cadence against the locked manifest — is itself a project and must
  exist *before* cutover, either as a native harness or by driving the
  Rust estimator over the existing TypeScript harness via FFI/WASM.
- **The user wins nothing measurable on beat performance.** The
  estimator is ~10⁵ multiplies per deck per second (ADR-0010: "noise"),
  and acquisition is a 6–12 s window — a faster Rust kernel cannot
  shorten it. The justification is consolidation and cross-deck reach,
  *not* latency or CPU. If the only goal were exposing BPM to the agent,
  publishing the existing gated TypeScript value into ADR-0020's store
  would deliver it at a fraction of this risk; recording the move here
  is a deliberate single-source-of-truth choice, paid for by the corpus
  gate.
- The phase anchor's frame-domain mapping (played-vs-pushed origin,
  today `playedFramesOriginRef` in `useDeck`) must be rebuilt in engine
  time, or freeze-pad and dub-echo quantisation will lie. This is the
  subtlest part of the port and the most likely to pass tests yet drift
  in the field.
- ADR-0023's beat-aligned note send reads `liveBeatRef`; once that is
  fed from the Rust gate, ADR-0023's "tempo lives in the frontend"
  caveat is corrected by this record — the quantise-on-send consumer
  pattern is unchanged, only its source moves.
- **Dependency on ADR-0020 is asymmetric.** Computing beat in the Rust
  shell and surfacing it *per deck* is **not** blocked on ADR-0020.
  ADR-0020 is itself still Proposed and unbuilt — no shell-level
  interface-state store or MCP server exists today; React
  (`useDeck`/`deckReducer`) remains authoritative for semantic state —
  so the interim home is a Tauri event / snapshot field, designed as a
  bridge type (`analysis::State`) that transplants into ADR-0020's store
  unchanged when it lands. Any *cross-deck aggregate* (tempo consensus
  for the agent) waits for the store rather than a bespoke aggregator —
  building one outside ADR-0020 re-scatters the state ADR-0020 exists to
  unify.
- ADR-0010 stays Accepted, and `beat.ts` stays authoritative, until
  this record is Accepted *and* its corpus gate is green — the same
  "until then it stays Accepted" discipline ADR-0019 used for ADR-0002.

## Alternatives considered

- **Keep detection in TypeScript, publish only the gated BPM into
  ADR-0020's store** — the lowest-risk way to get cross-deck/agent
  reach: it leaves the corpus-validated kernel untouched and avoids the
  phase frame-domain remap and consumer-IPC rewrite. Rejected as the
  *primary* path because it institutionalises tempo-in-TypeScript /
  key-in-Rust — the split this record exists to remove — but it is the
  explicit fallback if the corpus gate proves too costly to clear, and
  it is what runs in the interim while the gate is red.
- **Detection on the audio (cpal) callback** — forbidden: the callback
  is the only realtime path (device.rs), under `assert_no_alloc`; DSP
  or a state read there risks the dropouts ADR-0017/0019 exist to
  prevent.
- **Re-tune the gate constants for the Rust kernel without re-running
  the corpus** — rejected: that silently discards ADR-0010's shipping
  margin. The corpus, not convenience, is the arbiter.
- **Move beat and key in one combined ADR** — rejected: beat is
  shipping and corpus-locked, key is greenfield; beat is self-consumed
  per deck, key drives generation cross-deck; beat is not blocked on
  ADR-0020, key is. One decision per record keeps the corpus gate from
  blocking the greenfield feature.

<!-- Status values: Proposed | Accepted | Rejected | Deprecated |
     Superseded by ADR-NNNN -->
