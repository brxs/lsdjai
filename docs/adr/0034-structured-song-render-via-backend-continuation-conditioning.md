# 0034. Structured songs render via a backend continuation-conditioning pipeline

- **Status:** Proposed
- **Date:** 2026-07-10
- **Deciders:** Daniel Peter

## Context

[ADR-0033](0033-song-as-an-arrangement-of-reusable-parts.md) models a structured
song as parts referenced by a letter arrangement. Rendering one raises a
question ADR-0033 deliberately deferred: **who generates the distinct parts,
makes them cohere, and joins them — and where.**

The forces:

- **The controller is a pure generation server.** `backend/lsdj/controller.py`
  exposes render/generate/models and nothing else; each `/api/generate` call
  spawns one short-lived SA3 subprocess, serialised behind a single-slot
  semaphore, capped at 380 s per call
  ([ADR-0002](0002-browser-app-with-python-model-workers.md) lineage,
  [ADR-0012](0012-generated-pads-via-a-spawned-sa3-mlx-subprocess.md)). It is
  strictly one-call-one-clip today.
- **A structured song is many generations that must cohere.** Each distinct
  part is its own SA3 render, and adjacent parts should share key, tempo, and
  timbre or the song falls apart at the joins. Issue #54 already provides the
  coherence primitive: `init_audio`/audio-to-audio and `inpaint_range`, so a
  part can be conditioned on real audio rather than prompt text alone.
- **Seams and lengths need a beat grid.** Gapless, beat-aligned joins with short
  crossfades need bar boundaries; bar-accurate part lengths need a target BPM.
  Beat estimation lands in issue #77.
- **Two DSP homes already exist.** The Rust audio engine owns **realtime**
  mixing/DSP ([ADR-0017](0017-native-rust-audio-engine-superseding-web-audio.md));
  SA3 generation and WAV assembly already live **Python-side**. A song render is
  offline, not realtime.

## Decision

We will render a structured song with a **backend orchestration in/beside the
controller** that:

- generates each **distinct** part **conditioned on the tail of its neighbour**
  via #54's `init_audio` (audio-to-audio continuation), so key/tempo/timbre
  carry across the arrangement;
- **reuses the rendered clip for every repeated letter** (per ADR-0033), so only
  distinct letters cost a generation;
- renders a **variation** (`A'`, per ADR-0033) from its **parent's** clip using
  #54's existing variation surface — **audio-to-audio** (`init_audio` +
  variation-strength `init_noise_level`) for a global evolution, or
  **inpainting** (`inpaint_range`) to regenerate just a window and keep the rest
  of the parent identical — so it lands as "the same, evolved" and needs no new
  model surface; which of the two a variation uses is an authoring choice left to
  `/berlitz-engineering:fix-issue`;
- **stitches parts on bar/beat boundaries with short crossfades** into a single
  WAV.

This **expands the controller's role** from single-clip generation to
**multi-part song orchestration** — an explicit widening of ADR-0002's
"pure generation server" framing. The orchestration lives **backend-side** on
purpose: it keeps the SA3 subprocess serialisation and the single generation
lock in one place, avoids N frontend round-trips per song, and colocates the
stitch with the generation that produces the audio.

The **offline stitch/crossfade DSP runs Python-side** (numpy, beside the
existing SA3 WAV assembly), **not** in the Rust engine. The Rust engine stays
realtime-only; a song render is offline work and does not belong on the audio
thread.

A song render is long — several serialised SA3 calls — so the orchestration is
**cancellable and reports per-part progress**. (We sketch that surface here; the
exact IPC/endpoint shape is for `/berlitz-engineering:fix-issue`.)

## Consequences

- **Coherent multi-part songs** without the webview ever touching DSP or holding
  a partial render.
- **The controller gains a long-running job.** It is no longer strictly
  one-call-one-clip: it now owns a cancellable, progress-reporting orchestration.
  That is new surface — a job lifecycle, cancellation, and progress — layered
  onto a server that had none.
- **Sequential by design.** The single SA3 generation lock means parts render
  one at a time; a song's wall time is roughly the sum of its *distinct* parts.
  Accepted: it keeps worst-case memory flat next to the two deck workers, exactly
  as ADR-0012 intended.
- **Coherence and error both chain.** Continuation conditioning is the coherence
  mechanism, but it also means a bad part can bleed into the next; per-part
  reroll (ADR-0033) is the escape hatch.
- **Seam quality tracks the beat grid.** Clean joins depend on accurate bar
  boundaries, so structured songs inherit issue #77 as a real dependency.
- **The Rust engine is untouched.** Keeping the stitch in Python means no new
  offline-render path on the realtime engine, at the cost of a numpy DSP path the
  backend must own and test.

## Alternatives considered

- **Frontend orchestrates: call `/api/generate` N times and stitch in the
  webview** — rejected: it puts DSP and audio assembly in the untrusted webview,
  pays N round-trips per song, and re-implements the serialisation the backend
  already owns.
- **Stitch in the Rust engine** — rejected: the engine is for realtime mixing;
  an offline render stitch belongs with the generation that made the clips, and
  Python already assembles those WAVs.
- **Independent parts with a shared seed/style only, simple concatenation** —
  rejected this session: without neighbour conditioning, parts drift in key and
  timbre and the joins are audible seams; audio-to-audio continuation is the
  reason #54's surface exists.
- **One big one-shot generation with a structured prompt** — rejected: SA3 won't
  reliably produce a returning *identical* chorus and the result isn't rerollable
  per section — the same rationale that motivates ADR-0033.

<!-- Status values: Proposed | Accepted | Rejected | Deprecated |
     Superseded by ADR-NNNN -->
