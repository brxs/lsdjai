# 0035. Dual-envelope beat detection with fast change invalidation

- **Status:** Accepted (2026-07-10)
- **Date:** 2026-07-10
- **Deciders:** Daniel Peter

## Context

ADR-0010 selected band-split log-energy flux because it was the simplest onset
envelope that cleared the original ten-clip corpus. ADR-0025 moved that
estimator into the Rust shell without changing its measured constants. Issue
#77 added ten more committed fixtures for jungle/breakbeats, swing,
sparse/minimal percussion, short intros, and opposed tempo changes, then
measured the unchanged shipping code before tuning it.

The expanded measurement exposed two independent failures:

- the 12-second history plus three-stable gate first displayed at 13–20 seconds
  and recovered 15–16 seconds after a change; and
- neither sparse/minimal clip displayed. One never produced a correct confident
  band-flux estimate, while the other produced only an isolated one.

The honesty margin remained load-bearing. A shorter band-flux window acquired
more quickly but displayed the original ambient fixture for 3–10 seconds. FFT
spectral flux acquired the rhythmic material quickly, including minimal
percussion, but by itself displayed ambient and soundscape. Lowering confidence
or the stable count made both failure classes worse. No single envelope or gate
constant met the owner-approved targets: correct acquisition within 10 seconds,
recovery within 8 seconds, no wrong steady/beatless displays, and at most one
stale second on a tempo change.

The corpus-gated winner changes the estimator's internal shape, not merely one
constant. That fires issue 77's ADR gate even though its thread, realtime, IPC,
and reset boundaries remain ADR-0025's.

## Decision

We will keep beat detection on the existing non-realtime Rust analysis thread
and replace the single onset path with one adaptive detector containing three
incremental trackers:

1. a six-second band-split log-energy-flux tracker;
2. a six-second, 2048-frame FFT spectral-flux tracker; and
3. a two-second spectral change probe used only to invalidate a stale held
   tempo, never to acquire/display one directly.

The two main envelopes are complementary evidence. Spectral flux wins when its
onset envelope is sufficiently impulsive; the band path is the fallback for
material whose broadband spectral flux is smooth (notably hip-hop, dub, and
sparse dub). A low-impulsiveness spectral estimate may win only when the band
envelope itself is strongly transient. Band fallback is refused when a present
spectral estimate contradicts it. These thresholds and precedence rules are
the measured issue-77 winner, not runtime modes.

The honesty gate keeps three-stable acquisition and one-miss grace. Agreement
and folding now cover the same binary/ternary metrical levels the corpus verdict
already accepts, within 8%. A fast probe may invalidate a held tempo only when
the six-second detector is still confidently holding that old metrical clock.
Two consecutive short-window contradictions must agree with each other; the
first is the single stale tick permitted by the approved target, and the second
blanks the display and enters recovery quarantine. This corroboration prevents
isolated or weak-main short-window aliases from erasing a steady readout.
Recovery resumes only after a confident probe and the main detector agree at an
accepted metrical level. Stream reset still atomically clears all trackers,
pending-change evidence, gate, anchor gate, and frame origin.

The selected constants and full candidate table live in
`docs/spike-beat-detection-issue-77.md`. The final committed corpus test is the
contract; no per-style branch or prompt/file identity enters production.

## Consequences

- Every rhythmic corpus clip, including both sparse/minimal fixtures, acquires
  correctly in at most 9 seconds. The two tempo changes recover in 8 and 1
  seconds. No steady, intro, or beatless fixture displays a wrong BPM; the
  slower-to-faster change uses its one permitted stale second and the reverse
  change uses none.
- Blank-when-unsure becomes stricter at a corroborated change: two consistent
  high-transient contradictions invalidate the held number while isolated
  short-window aliases do not. Ordinary misses retain the one-miss grace.
- Beat detection performs two FFT envelopes plus one band envelope per deck.
  They remain allocating/non-realtime analysis work; the `cpal` callback, engine
  crate, bounded sidecar tee, published snapshot, and consumers are untouched.
  `rustfft` is a direct exact dependency rather than an accidental transitive
  dependency through output resampling.
- The low-band phase-anchor envelope remains present in both main trackers and
  `AnchorGate` is unchanged. Phase quality is not re-scored by this decision.
- Live and decoded-track tempo use the same adaptive detector, avoiding a new
  live/offline algorithm split.
- The detector is more complex than ADR-0010's deliberately simple kernel. The
  committed corpus, candidate record, and explicit arbitration invariants are
  now essential maintenance surfaces; a future simplification must clear the
  same gates.

## Alternatives considered

- **Shorter band-flux window / fewer stable readings** — materially faster, but
  the ambient fixture displayed and sparse/minimal coverage remained incomplete.
- **FFT spectral flux alone** — acquired minimal percussion and most rhythmic
  clips quickly, but confidently assigned tempos to ambient and soundscape.
- **Lower the confidence floor** — raised false displays without fixing the
  underlying envelope disagreement; rejected as a direct weakening of honesty.
- **Require band and spectral estimates to agree** — suppressed some spectral
  false positives, but also suppressed the material for which spectral flux was
  added and missed the acquisition/recovery targets.
- **Keep showing the old tempo until the long window turns over** — preserves
  gate simplicity but knowingly displays a stale value for several seconds and
  cannot meet the one-second honesty budget.

<!-- Status values: Proposed | Accepted | Rejected | Deprecated |
     Superseded by ADR-NNNN -->
