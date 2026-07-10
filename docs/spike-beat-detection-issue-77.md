# Beat detection expanded-corpus spike — issue 77

Measured 2026-07-10 against the unchanged shipping Rust estimator from
`e2a0859`/`a17323f`. The only `beat.rs` change in the measurement checkpoint is
moving its old test-only corpus module into the expanded runner; tracker, score,
gate, and constants are unchanged.

The locked corpus contains 20 PCM16 stereo/48 kHz clips (534 seconds, 97.8 MiB):
the original ten M14 fixtures, two generated clips for each owner-approved
genre family, two short-intro scenarios, and two opposed tempo-change
scenarios. Its manifest SHA-256 is
`922443f1481cd457b21813f36aa0d96321eb07fdc03a0cba3b525191a8799ddb`.

Reproduce the fixture and shipping-code measurements:

```sh
cd backend
.venv/bin/python scripts/spike_beat_corpus.py --verify

cd ../src-tauri
cargo test -p lsdj-app \
  analysis::beat_corpus::the_expanded_spike_corpus_reports_shipping_metrics \
  -- --nocapture
```

The generator itself was also rerun after the corpus was locked. All twenty
SHA-256 comparisons passed, proving deterministic regeneration under
`magenta-rt 2.0.2`, `librosa 0.11.0`, and `mrt2_small`. The original ten WAV
hashes and M14 reference values remain independently locked in the generator.

## Metrics

- `raw`: first correct estimate at or above the shipping 0.4 confidence floor,
  relative to rhythmic onset.
- `first`: first correctly gated display, also relative to rhythmic onset.
- `raw-rec` / `recover`: the corresponding times after a tempo-change boundary.
- `correct/total`: seconds showing a metrical match versus total streamed
  seconds.
- `wrong`: seconds showing a value that is not a metrical match for the active
  segment; blanks are counted separately and do not pretend to be errors.
- Correctness retains ADR-0010's factors `(0.5, 2/3, 0.75, 1, 4/3, 1.5, 2)`
  within 8% of the locked librosa reference.

Every tick is one pushed-audio second. A tick exactly on a scenario boundary
belongs to the segment whose last samples it has just consumed; the next tick
is the first one exposed to the new segment.

## Unchanged-estimator measurement

| Clip | Scenario | Reference | Final | Correct / total | Wrong | Raw | First | Raw recover | Recover | Confidence |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| techno | steady | 130.8 | 131.7 | 10 / 24 | 0 | 13 | 15 | — | — | 0.29–0.73 |
| house | steady | 119.7 | 119.9 | 10 / 24 | 0 | 13 | 15 | — | — | 0.23–0.58 |
| dnb | steady | 89.3 | 119.5 | 10 / 24 | 0 | 13 | 15 | — | — | 0.25–0.63 |
| hiphop | steady | 95.3 | 188.5 | 12 / 24 | 0 | 11 | 13 | — | — | 0.35–0.60 |
| garage | steady | 133.9 | 135.2 | 5 / 24 | 0 | 13 | 20 | — | — | 0.26–0.49 |
| dub | steady | 140.6 | 138.9 | 9 / 24 | 0 | 14 | 16 | — | — | 0.14–0.57 |
| triphop | steady | 45.0 | — | 0 / 24 | 0 | — | — | — | — | 0.09–0.33 |
| ambient | steady | 160.7 | — | 0 / 24 | 0 | — | — | — | — | 0.32–0.48 |
| soundscape | steady | 119.7 | — | 0 / 24 | 0 | — | — | — | — | 0.14–0.24 |
| piano | steady | 74.0 | — | 0 / 24 | 0 | — | — | — | — | 0.03–0.19 |
| jungle amen | steady | 114.8 | 114.2 | 12 / 24 | 0 | 11 | 13 | — | — | 0.35–0.67 |
| jungle rolling | steady | 117.2 | 117.0 | 16 / 24 | 0 | 7 | 9 | — | — | 0.49–0.74 |
| swung house | steady | 125.0 | 125.4 | 9 / 24 | 0 | 14 | 16 | — | — | 0.27–0.44 |
| garage two-step | steady | 112.5 | 139.8 | 10 / 24 | 0 | 13 | 15 | — | — | 0.31–0.60 |
| minimal percussion | steady | 72.1 | — | 0 / 24 | 0 | — | — | — | — | 0.16–0.41 |
| sparse dub | steady | 200.9 | — | 0 / 24 | 0 | 13 | — | — | — | 0.09–0.46 |
| 4 s intro → jungle amen | short intro | 160.7 → 114.8 | 114.0 | 11 / 28 | 0 | 12 | 14 | — | — | 0.17–0.67 |
| 2 s intro → minimal percussion | short intro | 119.7 → 72.1 | — | 0 / 26 | 0 | — | — | — | — | 0.16–0.40 |
| house → dub | tempo change | 119.7 → 140.6 | 138.9 | 19 / 48 | 1 | 13 | 15 | 14 | 16 | 0.11–0.58 |
| dub → house | tempo change | 140.6 → 119.7 | 119.9 | 19 / 48 | 3 | 14 | 16 | 13 | 15 | 0.14–0.58 |

The original ten verdicts and exact shown values reproduce M14. The stronger
beatless assertion also passes: ambient reaches 0.48 raw confidence, but no
beatless clip displays at any tick.

## Failure diagnosis

### Acquisition

- Only rolling jungle displays inside ten seconds. Every other rhythmic source
  takes 13–20 seconds or never acquires.
- On ordinary rhythmic clips the gate usually adds two seconds after the first
  correct confident raw estimate. Garage adds seven because its barely-above-
  threshold estimates do not agree consecutively.
- Minimal percussion never produces a correct confident estimate. This is an
  envelope/scoring coverage failure, not merely conservative gating.
- Sparse dub produces one correct confident estimate at 13 seconds but never
  stabilises. Its failure spans envelope consistency and gate dynamics.
- A short intro does not improve the situation: jungle needs 14 seconds after
  its rhythmic onset, and the minimal-percussion scenario never displays.

### Tempo changes

- The raw estimator needs 13–14 seconds of new material; the gate recovers at
  15–16 seconds. The 12-second history is the dominant delay, with the stable
  gate adding the expected two seconds.
- The gate mostly blanks while unsure, but carries the stale old tempo for one
  second in house → dub and three seconds in dub → house. The latter exceeds
  the one-miss-grace premise even though later disagreement eventually blanks.

### Genre accuracy

- Both jungle and both swung-family clips eventually produce accepted metrical
  matches, although acquisition remains slow.
- Both sparse/minimal clips fail to display. One lacks a sufficiently strong
  correct raw estimate; the other cannot sustain agreement. This is the
  material ADR-0010 required before considering a stronger onset envelope.
- No faster-but-wrong or beatless display is present in the steady/intro
  baseline. That zero is the hard honesty margin candidate work must retain.

## Proposed numeric targets — owner approval gate

These targets are recorded in every manifest entry with `status: proposed`.
The Rust runner validates their shape but deliberately does not enforce them
until the owner approves this checkpoint and their status flips to `approved`.

1. **Acquisition:** every rhythmic steady or short-intro clip, including all
   original rhythmic styles, shows a correct metrical match within **10 seconds
   of rhythmic onset**. Tempo-change clips owe the same initial acquisition.
2. **Recovery:** both change scenarios show the new correct metrical match
   within **8 seconds** of the boundary.
3. **Honesty:** steady, intro, beatless, and ambiguous clips allow **0 wrong
   display seconds**. A tempo change allows at most **1 stale/wrong second**,
   matching the existing one-miss grace.
4. **Original contract:** every original rhythmic final remains a metrical
   match, beatless clips never display at any tick, and ambiguous material is
   blank or correct. The 60–200 bpm range and metrical tolerance do not change.

Why 10 / 8 / 1:

- Ten seconds halves the observed 20-second worst case and moves every
  beat-aligned feature into the first ten seconds rather than merely shaving a
  tick from the current median. It is still above the current best honest
  acquisition (9 seconds), so it does not demand an unmeasured instant guess.
- Eight seconds halves the 15–16 second recovery and is short enough that a
  full 12-second stale window cannot be the winning design.
- One wrong second preserves the explicit grace already accepted by ADR-0010;
  permitting three would convert gate inertia into knowingly stale display.

Candidate work is paused until these numbers are accepted or replaced.
