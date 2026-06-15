# Spike A — offline parity contract

Shared interface between the Rust engine (`engine/`) and the Web Audio golden
oracle (`golden/`). Both process the SAME `artifacts/input.f32` and write one
output per case; `golden/compare.mjs` diffs them. Spec: [`../../docs/spike-rust-audio.md`](../../docs/spike-rust-audio.md).

This is the **offline DSP-parity slice** of Spike A (no audio device): it answers
"can fundsp reproduce the Web Audio engine's DSP within the stated tolerance?".
The device run, the sustained run, and the transport measurement are separate.

## File format

All `.f32` files: **interleaved stereo float32 little-endian, 48000 Hz**, no
header. Frame = 2 samples (L, R) = 8 bytes. Files live in `artifacts/`
(git-ignored).

- Input: `artifacts/input.f32` (192000 frames = 4.0 s), written by
  `golden/gen_input.mjs`. Deterministic, no RNG.
- Golden: `artifacts/golden_<case>.f32` (Chromium Web Audio, `golden/render_golden.mjs`).
- Rust: `artifacts/rust_<case>.f32` (fundsp, `engine/` CLI: `engine <case> <in> <out>`).

## Input signal (`gen_input.mjs`, documented for reproducibility)

4 one-second segments, both channels identical, pure math:
1. `[0,1)s` three sines summed: 100 Hz + 1000 Hz + 6000 Hz, each amplitude 0.2.
2. `[1,2)s` log sweep 20 Hz → 20000 Hz, amplitude 0.25.
3. `[2,3)s` loud burst: 200 Hz sine, amplitude **1.5** (drives the ceiling).
4. `[3,4)s` quiet: 440 Hz sine, amplitude **0.02** (sub-threshold transparency).

## Cases (exact processing — both sides must match)

Helpers: `dbToGain(db) = 10^(db/20)`. `eqValueToDb(v)`: clamp v to [0,1]; if
`v>=0.5` → `((v-0.5)/0.5)*6`; else `(1 - v/0.5)*(-40)`.

| case | processing | comparison rule |
| --- | --- | --- |
| `eq_flat` | 3-band EQ, low=mid=high=0.5 | epsilon |
| `eq_kill_low` | EQ low=0.0, mid=0.5, high=0.5 | epsilon |
| `eq_boost` | EQ low=mid=high=1.0 | epsilon |
| `filter_lp` | Color FX `filter`, amount 0.25, fully wet (replace) | epsilon |
| `bypass` | identity (FX amount within dead zone → dry) | **bit-exact** vs input |
| `master_limiter` | the M17 master chain on the full input | **invariant** + report |

**EQ** = three biquads in series, applied per channel:
`lowshelf(250, gain=dbToGain(eqValueToDb(low)))` →
`peaking(1000, Q=0.7, gain=dbToGain(eqValueToDb(mid)))` →
`highshelf(2500, gain=dbToGain(eqValueToDb(high)))`.
Web Audio shelves take **no Q**; fundsp shelves do — pick a shelf Q that best
matches the WA fixed slope and **report the residual** (this is the MED-risk
target). Mid uses a peaking/bell with gain (fundsp `bell_hz`), not `peak_hz`.

**filter_lp**: `filterCurve(0.25)` → lowpass at `18000*(80/18000)^0.5 ≈ 1200 Hz`,
**Q = 1.0** (Web Audio BiquadFilter default — the real `fxGraphs.ts` filter node
does NOT set Q). Fully wet: output = filtered signal (replace blend).

**bypass**: pure passthrough (`pass()`), output MUST equal input sample-for-sample
(IEEE-754, ULP 0; treat -0.0 == +0.0). This is the ADR-0008 dead-zone guarantee.

**master_limiter**: faithful WA chain is
`DynamicsCompressor(thr -6, knee 0, ratio 20, attack 0.002, release 0.25)` →
makeup-cancel gain `dbToGain(-LIMITER_MAKEUP_DB)` where
`FULL_SCALE_GAIN_DB = -6 - (-6/20) = -5.7`, `LIMITER_MAKEUP_DB = -0.6*-5.7 = +3.42`
(so cancel gain ≈ 0.6745) → hard clip to ±**0.9296875**.
fundsp has no DynamicsCompressor equivalent (HIGH-risk). The Rust side need only
satisfy the two **invariants** (not a waveform diff):
- **ceiling**: no output sample exceeds 0.9296875 (test on the loud seg). The
  clip-guard (`clamp ±0.9296875`) guarantees this regardless of the limiter.
- **sub-threshold transparency**: on the quiet seg the output ≈ input (the limiter
  must not engage and any makeup must cancel) within epsilon.
Implement the master as `[your best limiter or passthrough] → clamp ±0.9296875`.
**Report** the loud-seg divergence vs golden as data (the expected HIGH-risk gap);
it is NOT pass/fail.

## Tolerances

- **bit-exact** (`bypass`): every output sample byte-identical to input. 0 ULP.
- **ceiling**: `max|out| <= 0.9296875` exactly.
- **epsilon** (EQ, filter, transparency): after removing any fixed integer-sample
  group delay (cross-correlate, ±64 samples) and trimming 1024-sample warmup,
  `max-abs error <= 1e-3` AND report RMS error in dBFS. EQ shelves are expected
  near but not at parity; record the actual number rather than pass/fail-ing a
  hair over 1e-3 — the spike's job is to MEASURE the gap.
