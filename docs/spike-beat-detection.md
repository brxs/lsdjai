# Beat detection on generated output — spike findings

Measured 2026-06-11 on a deterministic 10-style corpus
(`backend/scripts/spike_beat_corpus.py`, `mrt2_small`, 24 s per style;
generation is deterministic per spike-bpm.md round 3, so the corpus is
reproducible). The estimator under test is the **shipping** code —
`frontend/src/audio/beat.ts` streamed in live-feed chunks by
`frontend/src/audio/beatCorpus.test.js` — not a Python stand-in.

**Verdict: ship.** The M14 kill criterion ("no style family yields a
stable estimate") is comfortably cleared.

## The measurement

| Style | librosa ref | shown | confidence | displayed | first shown |
| ----- | ----------- | ----- | ---------- | --------- | ----------- |
| techno | 130.8 | **131.7** | 0.29–0.73 | 10/24 s | 15 s |
| house | 119.7 | **119.9** | 0.23–0.58 | 10/24 s | 15 s |
| dnb | 89.3 | **119.5** | 0.25–0.63 | 10/24 s | 15 s |
| hiphop | 95.3 | **188.5** | 0.35–0.60 | 12/24 s | 13 s |
| garage | 133.9 | **135.2** | 0.26–0.49 | 5/24 s | 20 s |
| dub | 140.6 | **138.9** | 0.14–0.57 | 9/24 s | 16 s |
| triphop | 45.0 | — | 0.09–0.33 | 0/24 s | — |
| ambient (beatless) | (160.7) | — | 0.32–0.48 | 0/24 s | — |
| soundscape (beatless) | (119.7) | — | 0.14–0.24 | 0/24 s | — |
| piano (beatless) | (74.0) | — | 0.03–0.19 | 0/24 s | — |

Reading the disagreements honestly:

- **dnb 119.5 vs 89.3** — the clip is metrically ambiguous: librosa's
  *own* tempogram has 89.3 (0.66) and 119.7 (0.59) nearly tied; we
  show its second candidate (a 4:3 relation). Both are defensible
  readings of the same groove; the hardware checklist's hand-count is
  the final arbiter.
- **hiphop 188.5 vs 95.3** — librosa's top tempogram candidate is
  187.5; its `beat_track` default picked the half. We show the level
  the tempogram itself ranks first.
- **triphop blank** — correct: librosa's tempogram has no candidate
  above 0.43 on this clip (weakly rhythmic source material), so the
  corpus marks it *ambiguous*, not rhythmic.
- **ambient is the knife edge** — a drone reaches confidence 0.48,
  within a hair of garage's peak 0.49. The threshold alone cannot
  separate them; the stability requirement (three consecutive
  agreeing estimates) is what actually holds the line. Ambient never
  once displayed across 24 s.

## What the measurement forced into the design

1. **Band-split flux** (200 Hz / 4 kHz one-pole crossovers, per-band
   log-energy flux summed). Full-band flux left dnb at confidence
   ≤ 0.22 — a sustained bassline masks its own kick pattern. Bands
   lifted every rhythmic style by ~0.1–0.4 and dnb from dead to 0.63.
2. **Envelope smoothing** ([0.25 0.5 1 0.5 0.25]). Sharp transients
   put 1–2-hop spikes in the envelope, making non-integer true lags
   (150 bpm = 37.5 hops) lose to their integer-lag octave alias.
3. **Subharmonic penalty** in the comb score. A 174 bpm click train is
   *also* an 87 bpm pattern; a candidate whose half-lag correlates is
   the octave-down alias, and the club-tempo prior alone cannot break
   that tie.
4. **Flux-variance floor** (volume-invariant, log-domain). A steady
   tone's hop-quantisation ripple is genuinely periodic and fooled the
   scale-invariant autocorrelation into confidence on *silence-grade*
   material.
5. **Octave folding in the gate.** Hip hop alternated confidently
   between ~95 and ~190 and the stability check read that as a
   quarrel; half/double of a held tempo now folds onto it.
6. **One-miss grace, bounded.** Generative music breathes; one
   unconfident second holds the readout (re-acquiring costs 3+ s), a
   second consecutive miss — or three confident-but-disagreeing
   estimates — drops it. Acquisition stays strict.
7. **Hysteresis on the locked value.** Successive analysis windows
   jitter by fractions of a bpm; a locked readout (and the synced
   echo's delay) holds still until the median moves beyond the gate
   tolerance — the table's "shown" column is the first locked value.

## The shipped gate

`GATE_MIN_CONFIDENCE 0.4`, `GATE_STABLE_COUNT 3`, `GATE_TOLERANCE 4%`,
`GATE_GRACE_MISSES 1` — set by this table, not guessed. Acquisition
takes 13–20 s of steady audio (6 s minimum window + stability), which
is the honest price of never showing a drone a tempo.

## Limits worth remembering

- Estimates are *metrical-level* accurate, not always the level a
  human would tap (octave/4:3 relations happen on ambiguous grooves).
  Consumers must be level-tolerant: synced echo uses beat *fractions*,
  loop quantisation uses whole beats — both musical at any level.
- Tempo below 60 bpm reads as its double or not at all (triphop).
- The readout trails reality by the stability window on tempo changes
  (~3 s after the analysis window turns over).

Re-run the measurement any time:
`cd backend && uv run python scripts/spike_beat_corpus.py`, then
`cd frontend && npx vitest run src/audio/beatCorpus.test.js`.
