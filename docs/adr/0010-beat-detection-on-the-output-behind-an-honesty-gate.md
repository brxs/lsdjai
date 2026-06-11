# 0010. Beat detection on the output, behind an honesty gate

- **Status:** Accepted
- **Date:** 2026-06-11
- **Deciders:** Daniel Peter

## Context

ADR-0004 closed tempo as a *generation* parameter — the model does not
take a clock. M14 asks the inverse question: can the app *measure* the
tempo of what comes out, well enough to power beat-aware features
(tempo-synced dub echo, beat-quantised freeze loops, an honest BPM
readout)? The roadmap made the spike the milestone's gate, with a kill
criterion; the measurement (docs/spike-beat-detection.md) came back
ship. Three design questions needed settling: where detection runs,
how "unsure" is handled, and how consumers survive the estimator's
inherent metrical-level ambiguity.

## Decision

- **Detection runs in the frontend, on the wire feed.** Each deck's
  PCM chunks pass through a pure incremental estimator
  (`frontend/src/audio/beat.ts`) on their way to the player worklet —
  no audio nodes, no worklet changes, no backend involvement. The feed
  runs ahead of the speakers by the buffer lead; tempo does not care,
  and *phase* is deliberately not reported (no shipped consumer needs
  it — the roadmap's `{bpm, confidence, phase}` shrank to what is
  honest and used).
- **The estimator is pure and corpus-calibrated.** Band-split
  log-energy flux (200 Hz / 4 kHz) → smoothed envelope →
  autocorrelation over 60–200 bpm, comb-scored with a subharmonic
  penalty under a mild club-tempo prior. Every constant traces to a
  measurement: the spike corpus runs the *shipping* code and is the
  regression suite (`beatCorpus.test.js`, skipped without the corpus).
- **An honesty gate owns the display.** Confidence (raw periodicity,
  unscaled by the prior) must clear 0.4 for three consecutive
  one-second estimates agreeing within 4 % before anything shows; one
  miss is ridden out, a second — or three confident-but-disagreeing
  estimates — blanks the readout. Half/double estimates fold onto the
  held tempo (the same rhythm at another metrical level). The beatless
  corpus styles never display; that property is the feature.
- **Consumers are metrical-level-tolerant by construction.** The
  estimator can sit an octave or a 4:3 level away from where a human
  taps on ambiguous grooves, so nothing consumes the absolute level:
  the dub echo snaps to the beat *fraction* nearest its free-running
  0.35 s character, and freeze captures quantise to *whole beats* —
  both musical at any level. Both revert to free-running behaviour the
  moment the gate blanks.
- **Estimates never span streams.** Play, prime, stop, model switches,
  and worker crashes reset tracker and gate alike — the discontinuity
  rule the freeze-pad capture history follows (ADR-0009).

## Consequences

- Easier: a new beat-aware consumer is a pure function plus a read of
  the gated value; the estimator's cost is one autocorrelation pass
  per deck per second on the main thread (~10⁵ multiplies — noise).
- Acquisition takes 13–20 s of steady audio (6 s minimum window plus
  stability) and the readout trails tempo changes by ~3 s after the
  analysis window turns over — the deliberate price of never showing
  a drone a number.
- Tempo below 60 bpm reads as its double or not at all.
- The BPM readouts of the two decks are not comparable at face value
  when either sits on a different metrical level than a human would
  tap; beat-matching by eye stays out of scope (and ADR-0004 means
  there is no sync to build on it anyway).

## Alternatives considered

- **Spectral-flux onset detection (FFT)** — strictly better envelopes,
  meaningfully more code and CPU; band-split energy flux cleared every
  corpus criterion, so the simpler kernel ships until material proves
  it short.
- **Detection in an AudioWorklet** — puts DSP on the rendering thread
  for no benefit; the wire feed is already on the main thread and
  ahead of time.
- **Backend detection (librosa)** — the measurement tool, not the
  product: it would add a protocol surface and split tempo state
  across processes for an estimator the frontend runs in microseconds.
- **Showing the best guess with a confidence colour** — a number on
  screen gets trusted regardless of its colour; blank-when-unsure is
  the only honest readout (the M4 rule: only expose what works).

<!-- Status values: Proposed | Accepted | Rejected | Deprecated |
     Superseded by ADR-NNNN -->
