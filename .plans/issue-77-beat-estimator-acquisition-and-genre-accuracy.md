---
issue: 77
url: https://github.com/brxs/lsdjai/issues/77
title: "Improve the beat estimator: acquisition speed and genre accuracy, behind an expanded corpus"
date: 2026-07-10
baseline: e2a0859
main_at_draft: e2a0859
status: in_progress
---

# Plan: Improve beat-estimator acquisition and genre accuracy (#77)

## Progress

- [x] Read issue 77 and its dependency, issue 47.
- [x] Inspect the shipping Rust estimator, live-analysis cadence, corpus harness,
  generation recipe, manifest, ADR-0010/0025, and project test conventions.
- [x] Re-run the original ten-clip Rust corpus gate and record the baseline facts
  below.
- [x] Write an implementation-ready, measurement-first plan.
- [x] Resolve owner decisions: Git LFS fixtures, two new clips per genre family,
  and an approval pause after the baseline targets are drafted.
- [x] Start implementation on clean branch `issue-77-beat-detection` from
  `main` at `e2a0859` (issue 54 merged as PR 87).
- [x] Phase 1: commit and validate the expanded deterministic corpus (20 clips,
  97.8 MiB; 10 legacy + 6 genre + 4 timing scenarios; all hashes and WAV
  contracts verified).
- [x] Phase 1: extend the Rust harness with acquisition, recovery,
  wrong-display, confidence, and coverage metrics; original outputs reproduce
  exactly and beatless clips never display at any tick.
- [x] Phase 2: measure the unchanged shipping estimator, classify failures, and
  commit proposed numeric targets (10 s acquisition, 8 s recovery, 0 wrong
  steady/beatless seconds, at most 1 stale change second).
- [ ] Phase 2 owner gate: approve or replace the proposed targets, then flip
  their manifest status from `proposed` to `approved` before tuning.
- [ ] Phase 3: run corpus-wide candidate experiments and make the ADR decision.
- [ ] Phase 4: ship the smallest winning estimator/gate change and turn the
  frozen targets into regression gates.
- [ ] Phase 5: run automated checks and complete the live-audio checklist.

## Problem

The shipping Rust estimator in `src-tauri/src/analysis/beat.rs` deliberately
trades responsiveness for honesty. It needs at least six seconds of onset
history and three stable one-second readings before the gate shows a BPM. On
the original corpus that means first display at 13–20 seconds. The same history
and stability dynamics leave an old value visible while a changed tempo works
through the window and gate.

That trade was calibrated on one deterministic clip per original style family.
It does not establish coverage for breakbeats/jungle, swing, or sparse
percussion, and the current regression only records final/display-duration
verdicts. It cannot say how long a correct BPM took to appear relative to a
rhythmic onset or how long the gate took to recover after a known tempo change.

Issue 77 therefore has two deliberately separate deliverables:

1. a reproducible measurement spike that exposes the shipping estimator's
   failures and freezes meaningful numeric targets; and
2. an improvement selected by that measurement, without weakening
   blank-when-unsure or regressing any original corpus verdict.

## Baseline facts

- Issue 47 is closed. Beat detection now lives only in the Rust shell and the
  original ADR-0025 cutover corpus is green.
- `BeatTracker` builds a band-split log-energy-flux envelope in 512-frame hops,
  keeps a 12-second ring, refuses to estimate before six seconds, and applies
  comb-scored autocorrelation over 60–200 bpm. `BeatGate` then requires three
  confident readings within 4%, with one-miss grace and octave folding.
- The live path (`src-tauri/src/analysis/live.rs`) feeds the tracker off the
  non-realtime sidecar-reader tee and calls the estimator once per 48,000 pushed
  frames. The corpus harness reproduces that as 40 ms chunks and one estimate
  per simulated second. Neither path runs on the `cpal` callback.
- The same tracker/gate also powers decoded-track `track_bpm`. A kernel or
  constant change is therefore not live-stream-only; offline track-analysis
  regressions must be included.
- Phase anchoring uses a separate low-band linear-flux envelope and
  `AnchorGate`. Phase quality is outside issue 77, but tempo work must preserve
  that data path and its existing tests.
- The current corpus module is embedded at the end of `beat.rs`. It prints
  `displayed seconds` and `first at`, but asserts only the final BPM for
  rhythmic/ambiguous clips and only the final blank state for beatless clips.
  It has no scenario boundaries or recovery metric.
- The ten 24-second stereo PCM16 WAVs occupy about 44 MiB locally. Both the WAVs
  and `manifest.json` are ignored by `backend/.gitignore`; `git ls-files
  backend/spike_corpus` currently returns no files. The current test silently
  returns when the manifest is missing. Issue 77 requires the opposite: fixtures
  and locked manifest committed, and absence must fail.
- The 2026-07-10 targeted Rust run reproduced the original measurement exactly:
  techno/house/dnb first displayed at 15 s, hip-hop at 13 s, garage at 20 s,
  dub at 16 s; trip-hop and all three beatless clips remained blank.
- The corpus recipe uses `mrt2_small`, 24-second deterministic generations,
  48 kHz stereo PCM16 output, and librosa references. `backend/uv.lock` pins
  `magenta-rt` 2.0.2, even though `pyproject.toml` expresses a compatible lower
  bound.
- Implementation started on `issue-77-beat-detection` at `e2a0859`, equal to
  `main`/`origin/main` after issue 54 merged as PR 87. The worktree contained
  only this untracked plan.

## Decisions for this implementation

1. **The spike is a hard checkpoint.** Commit the expanded corpus, metric
   harness, unchanged-estimator measurement, failure analysis, and frozen
   targets before changing `BeatTracker`, `BeatGate`, their constants, or their
   cadence. Keep this as a reviewable commit/PR boundary even if both halves are
   delivered on one branch. After the unchanged-estimator table and proposed
   numeric targets are ready, pause for owner approval; tuning does not begin
   until those targets are accepted.
2. **Commit the actual PCM fixtures through Git LFS.** Preserve and commit the
   original ten WAVs bit-for-bit, then add the expanded WAVs and versioned
   manifest. Add a narrow `.gitattributes` rule for
   `backend/spike_corpus/*.wav`; keep the small JSON manifest and recipes in
   ordinary Git. Record exact content hashes in the manifest so regeneration
   drift is visible independently of LFS pointer metadata. Verify LFS checkout
   in a clean clone and any CI checkout path used by the project.
3. **One runner defines both reports and gates.** Extract the growing
   test-only corpus machinery from `beat.rs` into
   `src-tauri/src/analysis/beat_corpus.rs`. It must replay the real
   `BeatTracker`/`BeatGate`, produce deterministic per-second observations, and
   feed both the human-readable report and machine assertions. Do not create a
   Python estimator or a second Rust approximation.
4. **A displayed value counts only when it is correct.** Correct means a
   displayed BPM matches the active locked librosa reference under ADR-0010's
   existing metrical-level set and ±8% tolerance. A blank is not a wrong BPM,
   and a wrong BPM is not successful acquisition.
5. **Do not preselect the winning algorithm.** Evaluate acquisition dynamics and
   envelope quality independently, then combine them only if the targets require
   it. Stop at the smallest candidate that clears every frozen gate.
6. **Keep the architecture unless the measurement disproves it.** Kernel,
   window, cadence-internal, and gate-constant changes amend ADR-0025 and the
   measurement record. A change to threading, IPC/published state, realtime
   boundaries, reset semantics, or the tracker/gate split requires a new ADR,
   accepted before production implementation.

## Corpus contract

### Coverage matrix

Keep the original ten clips as the immutable `legacy` tier. Add the
owner-selected, deliberately small but non-token `expanded` tier:

- two independent generated clips for breakbeat/jungle;
- two for swung rhythm, covering swung house and UK garage/2-step;
- two for sparse/minimal percussion;
- at least two short-intro scenarios with different rhythmic families and
  explicit `rhythm_onset_seconds` boundaries; and
- at least two tempo-change scenarios, one moving faster and one slower, with
  explicit change boundaries and before/after references that are not
  equivalent under the accepted metrical-level tolerance.

The existing beatless clips remain the primary honesty controls. Add a new
beatless control only if a new candidate exposes a specific false-positive
class; do not pad the matrix with redundant fixtures.

Generate all new source material through the same `mrt2_small` path as the M14
corpus. Build intro and tempo-change scenarios deterministically from generated
PCM (fixed slices, fixed intro length/change boundary, and a documented fixed
crossfade or hard boundary). Do not depend on random selection or hand-edited
DAW files. Keep enough post-onset/post-change audio for the unchanged estimator
to reach a verdict, even when that verdict is "never acquired."

### Versioned manifest

Change `manifest.json` from a bare array to a schema-versioned object. Record:

- corpus schema/version and generation provenance (`mrt2_small`, package/model
  version, sample format, generation frame/chunk length, and recipe command);
- per-file SHA-256, prompt/source recipe, sample rate, duration, tier, and
  scenario kind (`steady`, `short_intro`, or `tempo_change`);
- the existing `rhythmic`, `beatless`, or `ambiguous` expectation;
- one or more timed reference segments with locked librosa BPMs;
- `rhythm_onset_seconds` for intro scenarios and `change_at_seconds` plus old/new
  segment references for change scenarios; and
- the final per-clip acquisition/recovery budgets once Phase 2 freezes them.

The generator must refuse duplicate slugs, invalid/overlapping segment bounds,
missing scenario boundaries, and non-48-kHz/stereo/PCM16 output. Add a
model-free `--verify` path that checks the committed files, headers, durations,
manifest coverage, and hashes without loading MRT2. Regeneration remains an
explicit model-loaded command; ordinary tests never regenerate fixtures.

Update `backend/.gitignore` with narrow negations for the corpus manifest and
WAV fixtures while leaving other backend WAV output ignored. Add
`.gitattributes` with the matching narrow Git LFS rule and document `git lfs
pull` as part of corpus setup. Once committed, remove the Rust harness's
"manifest missing, skip" branch: a missing manifest, an unfetched LFS pointer in
place of a WAV, or a missing referenced file is a test failure with an actionable
message.

## Metric definitions

The runner records every one-second estimate tick: raw BPM/confidence,
gate-displayed BPM, active reference segment, and whether the displayed value
is metrically correct. Aggregate and print, in stable manifest order:

- **time to first correct display:** earliest correct displayed tick minus the
  rhythmic onset (zero for a steady clip); `none` if it never acquires;
- **time to recover after change:** earliest correct displayed tick for the new
  reference minus `change_at_seconds`; `none` if it never recovers;
- **wrong-display seconds:** ticks on which the gate shows a BPM that matches no
  active reference (including the stale old tempo after a change);
- **blank seconds and correct-display coverage:** keep honesty and usefulness
  visible separately instead of folding both into one score;
- **first raw-confident estimate and confidence range:** enough diagnostic data
  to distinguish envelope failure from gate delay; and
- **final displayed BPM/verdict:** preserves the ADR-0025 regression view.

Because estimates occur once per pushed-audio second, report whole-second tick
times; do not imply sub-second precision. Scenario boundaries must land on the
same 40 ms generation grid and preferably on whole seconds. If a boundary is
not a whole second, calculate elapsed time from pushed frames rather than wall
clock.

For the spike, these metrics report without imposing a new improvement budget;
the original verdict rules remain hard assertions. After the baseline table is
written, freeze numeric per-clip/aggregate budgets in the manifest and
measurement document. Those budgets must at minimum require:

- every expanded rhythmic steady/intro clip eventually displays a correct
  metrical match;
- every tempo-change clip recovers to the new reference;
- all original rhythmic/beatless/ambiguous verdicts remain at least as strong;
- no beatless clip ever displays at any tick (strengthening today's final-state
  assertion); and
- acquisition improves materially rather than merely moving delay between the
  estimator and gate.

Do not invent exact time budgets in this plan: issue 77 explicitly requires
them to be derived from the unchanged estimator's expanded-corpus measurement.
Record the derivation before candidate results are examined so targets cannot
move to fit a preferred implementation.

## Implementation steps

### Phase 1 — corpus and measurement harness

1. **Make the recipe reproducible**
   (`backend/scripts/spike_beat_corpus.py`): preserve the original source
   definitions, add the named style matrix and deterministic scenario
   composition, write the versioned manifest/hashes, and implement `--verify`.
   Keep librosa as reference/measurement tooling, not product code.
2. **Commit the locked fixtures** (`backend/.gitignore`,
   `.gitattributes`, `backend/spike_corpus/`): track only corpus WAVs through Git
   LFS and keep every other backend WAV ignored. Verify that a clean checkout
   with `git lfs pull` can run corpus verification and the Rust corpus test
   without MRT2 installed. Configure the same LFS-fetch behaviour in CI when a
   repository CI workflow exists.
3. **Extract and extend the Rust runner**
   (`src-tauri/src/analysis/beat_corpus.rs`,
   `src-tauri/src/analysis/mod.rs`, `src-tauri/src/analysis/beat.rs`): centralise
   WAV loading, manifest validation, stream replay, metrical matching, tick
   observations, aggregates, stable tabular output, and verdict assertions.
   Keep `hound` test-only.
4. **Protect the legacy baseline:** before adding new metrics, prove the
   refactor reproduces all six original shown BPMs, display durations, and
   first-display ticks from the baseline run. Then strengthen beatless checks
   from "blank at the end" to "never displayed."

### Phase 2 — unchanged-estimator spike and targets

5. **Run the shipping estimator unchanged** over every committed clip using the
   targeted `cargo test ... -- --nocapture` command. Save the exact commit,
   manifest hash, command, full per-clip table, and summary in a new
   `docs/spike-beat-detection-issue-77.md`; link it from the original M14 spike
   document.
6. **Classify failures before proposing a fix:** separate "raw estimate absent or
   wrong" (envelope/scoring problem) from "raw estimates correct but display
   late" (window/gate problem), and document false displays, never-acquired
   clips, acquisition distribution, and recovery distribution.
7. **Freeze targets:** derive explicit per-clip and summary budgets from that
   table, add them to the manifest/document, and record why each number is a
   meaningful improvement while preserving blank-when-unsure. Commit this
   checkpoint, present the baseline and proposed targets to the owner, and pause
   until they are approved. Record that approval in this plan's **Progress**
   section before changing production estimator code.

### Phase 3 — corpus-gated candidate work

8. **Add a measurement-only configuration seam** in `beat.rs` so candidate
   kernels/windows/gates run through the same tracker and harness without
   changing `BeatTracker::new()` by accident. Pin the default configuration's
   output to the Phase 2 baseline. Do not ship a user/runtime algorithm switch.
9. **Measure acquisition candidates first:** try shorter and/or multi-scale
   history and gate dynamics with the existing band-flux envelope. Change one
   axis at a time, replay the full corpus after each change, and reject any
   variant that introduces a beatless/wrong-display regression.
10. **Measure accuracy candidates where needed:** if named-style failures remain,
    evaluate an FFT spectral-flux envelope while retaining the existing
    autocorrelation/prior/gate initially. Only add combined kernel/window/gate
    variants after isolated results show why they are needed.
11. **Record the full candidate matrix:** for every candidate, capture constants,
    corpus commit/hash, acquisition/recovery summaries, wrong/beatless display
    counts, original verdicts, and whole-corpus runtime. Reject a design that
    cannot comfortably process faster than realtime on the analysis thread.
12. **Apply the ADR gate:** if the winner stays inside ADR-0025's thread/state
    architecture, amend ADR-0025 with the new measurement and superseded
    constants/kernel. If it crosses the architecture boundary listed in
    **Decisions**, write and accept a new ADR before Phase 4.

### Phase 4 — production winner and hard gates

13. **Ship only the winning path** (`src-tauri/src/analysis/beat.rs`): make the
    default tracker/gate use the measured kernel/constants, delete losing
    production branches, and keep comments tracing every changed constant to
    the issue-77 measurement table. If FFT wins, add its crate as a direct,
    justified, exact Cargo dependency rather than relying on `rustfft`/`realfft`
    being present transitively through the resampler.
14. **Preserve surrounding contracts:** do not move analysis onto the audio
    callback, change bounded-feed/reset ordering, widen the published snapshot,
    change `AnchorGate`, alter the 60–200 bpm range, or add phase/key work. Keep
    existing phase, reset, synced-echo, and offline `track_bpm` tests green.
15. **Turn targets into tests:** make the runner assert every frozen
    acquisition/recovery budget plus zero original regressions and zero
    beatless displays. The final suite must fail on the unchanged Phase 2
    estimator for the specific shortcomings the winner fixes.
16. **Remove experimental seams that no longer earn their keep.** A small
    test-only configuration surface may remain when it directly explains
    constants, but no unused alternate estimator should ship.

### Phase 5 — documentation and verification

17. **Finish the measurement record:** add the selected candidate table, final
    per-clip results, before/after deltas, rejected alternatives, runtime, and
    exact provenance to `docs/spike-beat-detection-issue-77.md`. Update
    ADR-0025 and code comments so every shipped constant/kernel has one clear
    measurement trail.
18. **Add `docs/issue-77-hardware-checklist.md`:** verify faster acquisition on
    representative generated streams, tempo/style-change recovery, a long
    beatless stream that stays blank, stop/play reset, and unchanged phase
    meter, synced echo, loop quantisation, and free-running fallback. Phase
    quality itself is not re-scored.
19. **Run the gates:** corpus `--verify`, targeted corpus test with captured
    report, beat/live/grid/offline-analysis tests, `cargo test --workspace`, and
    root `just check`. Complete the hardware checklist before closing the issue.

## Tests and acceptance mapping

- **Committed, reproducible corpus:** Git LFS tracks every
  manifest-referenced WAV and a clean LFS-enabled checkout fetches real WAV
  content rather than pointer files; `spike_beat_corpus.py --verify` validates
  schema, headers, duration, hashes, scenario boundaries, and the exact
  two-per-family genre count without loading a model.
- **Acquisition metrics per clip:** deterministic runner tests cover immediate
  rhythm, delayed onset, tempo increase, tempo decrease, never-acquired, and
  stale-old-tempo cases; report output includes first-correct and recovery for
  every applicable entry.
- **Baseline failure write-up:** the spike document pins code/manifest hashes,
  exact command, per-clip data, failure classification, and frozen targets.
- **Targets met:** final corpus test enforces the frozen per-clip acquisition
  and recovery budgets and correct metrical verdicts.
- **Original corpus unchanged:** legacy entries preserve their files/references;
  all six rhythmic finals remain correct, all three beatless clips never show,
  and ambiguous material is blank or correct.
- **Blank when unsure:** synthetic gate tests plus every beatless tick prohibit a
  display below confidence/stability requirements; wrong-display accounting
  prevents faster-but-wrong acquisition from looking successful.
- **Live/offline parity:** shared tracker tests and `track_bpm` regressions prove
  the chosen estimator applies consistently to live streams and decoded tracks.
- **Realtime boundary:** existing live-feed/reset tests remain green, the audio
  callback stays untouched, and the candidate table records whole-corpus
  runtime.
- **Constants are measurements:** final code/ADR comments point to the frozen
  candidate/result table, with no unexplained tuning values.

## Affected areas

- `backend/.gitignore`
- `.gitattributes` (new Git LFS rule for corpus WAVs)
- `backend/scripts/spike_beat_corpus.py`
- `backend/spike_corpus/manifest.json` plus committed WAV fixtures
- `src-tauri/src/analysis/beat.rs`
- `src-tauri/src/analysis/beat_corpus.rs` (new, test-only harness)
- `src-tauri/src/analysis/mod.rs`
- `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` only if the selected kernel
  needs a direct dependency
- `docs/spike-beat-detection.md` (link to the new measurement)
- `docs/spike-beat-detection-issue-77.md` (new)
- `docs/adr/0025-beat-detection-in-the-rust-audio-engine.md`
- `docs/adr/README.md` and a new ADR only if the architecture gate fires
- `docs/issue-77-hardware-checklist.md` (new)

Deliberately untouched: the `lsdj-engine` realtime callback, IPC/store schema,
frontend UI, phase-anchor quality work, key detection, sub-60-bpm support,
generation controls, and beat-consumer product behaviour.

## Risks

- **LFS availability and quota:** PCM fixtures are large and the current ten
  already total ~44 MiB. Confirm Git LFS is installed for contributors, LFS
  objects are uploaded before review, clone/CI paths fetch them, and the hosting
  quota can absorb the selected corpus. Keep the two-per-family expansion
  purposeful, avoid duplicate scenario audio where a deterministic recipe can
  share sources without weakening the committed-fixture requirement, and
  report exact object count/size in review.
- **"Deterministic" is versioned, not timeless:** regeneration depends on the
  locked Python package and model assets. Hash committed outputs and record
  provenance; never silently refresh references after a dependency/model bump.
- **Reference ambiguity:** breakbeats and swing legitimately produce alternate
  metrical readings. Preserve ADR-0010's accepted factors, store segment-local
  librosa references, and classify genuinely weak material as ambiguous before
  candidate tuning—not after a preferred estimator misses it.
- **Target leakage/overfitting:** freeze corpus, references, and targets before
  candidate work. Use multiple clips per new family and publish rejected
  candidate results rather than tuning a hidden per-clip exception.
- **Faster can become dishonest:** lowering history or stability may make first
  display look good while increasing wrong or beatless displays. Treat
  wrong-display seconds and beatless-never-displays as hard vetoes.
- **FFT cost/dependency:** spectral flux moves work from three IIR bands to many
  windowed transforms. Measure full-corpus throughput, reuse buffers off the RT
  thread, and directly pin/justify the dependency only if it wins.
- **Collateral analysis behaviour:** `BeatTracker` serves live and decoded-track
  analysis, and its low-band data feeds phase anchoring. Keep those regression
  suites and the hardware checklist in the final gate.

## Definition of done

- The complete original and expanded deterministic corpus is tracked through
  Git LFS, hashed, reproducible, and verified from a clean LFS-enabled checkout
  without MRT2 at test time.
- The Rust shipping-code harness reports correct acquisition and tempo-change
  recovery metrics per applicable clip at the live 40 ms / one-second cadence.
- The unchanged estimator's failures and numeric targets are committed before
  estimator changes, with exact provenance, and the owner has approved the
  targets at the recorded Phase 2 pause.
- The selected smallest candidate meets every frozen target, no original
  verdict regresses, no beatless clip ever displays, and blank-when-unsure is
  unchanged in premise.
- Every changed kernel/constant traces to the full-corpus measurement, with the
  required ADR path completed.
- `just check`, the targeted corpus report, corpus verification, and the live
  hardware checklist all pass.
