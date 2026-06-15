# 0019. PCM transport from the Python sidecars to the Rust audio engine

- **Status:** Proposed
- **Date:** 2026-06-15
- **Deciders:** Daniel Peter

## Context

ADR-0002 defined protocol v0: one WebSocket per deck carrying binary PCM frames
(~2 s of 48 kHz) plus JSON control, consumed by the browser, which mixed in Web
Audio (ADR-0003). The native pivot changes both ends of that pipe:

- ADR-0018 reduces Python to model-inference sidecars (PyInstaller-frozen,
  separate processes) and moves serving and supervision into the Rust shell.
- ADR-0017 moves mixing into a realtime Rust engine: a `cpal`/CoreAudio callback
  draining a wait-free ring, with nothing on the audio thread allowed to
  allocate, lock, or block on IO.

So PCM no longer flows worker → WebSocket → browser. It flows worker (Python
sidecar) → some transport → the Rust engine, then across the realtime boundary
into the audio callback. *How* it crosses is the single biggest unknown behind
"glitch-free real-time output under the Python PCM feed" (ADR-0017's spike): the
sidecar process boundary, IPC jitter, and the handoff into the callback are the
whole real-time-safety story — and ADR-0002 never had to answer it, because the
browser absorbed jitter in a Web Audio worklet ring. This is a foundational
interface change on the level of protocol v0 itself, so it gets its own record.

## Decision

We fix the architecture now and defer only the concrete channel to the spike:

- **Framing is preserved from protocol v0** — per-deck binary PCM frames + JSON
  control. The Python side barely changes; it keeps emitting the same bytes.
- **The Rust shell terminates the transport on a non-realtime IO thread.** That
  thread decodes frames and writes f32 samples into a per-deck wait-free SPSC
  ring (`rtrb`). The `cpal` audio callback only ever *drains* the ring — no
  allocation, no locks, no syscalls, no contact with the sidecar.
- **The concrete channel is chosen by ADR-0017's spike**, by measuring jitter
  and throughput across the candidates: loopback TCP/WebSocket (reuses v0 almost
  verbatim), a Unix domain socket, or a shared-memory ring. The real-time
  discipline above holds whichever wins.

This supersedes ADR-0002's transport — specifically the browser as the PCM
consumer — while preserving its binary-PCM-plus-JSON-control framing and its
Python model workers.

## Consequences

- The realtime boundary is explicit and one-directional: jitter is absorbed in
  the non-RT IO thread plus the ring, never on the audio callback. This is the
  discipline that makes ADR-0017's "glitch-free" claim testable rather than
  hoped-for.
- Minimal churn on the Python side — the sidecars keep their v0 framing, so the
  inference workers are nearly untouched, consistent with ADR-0018's "Python is
  an isolated inference RPC."
- The buffer-health surfacing that ADR-0003 created (M2 — buffer meter, underrun
  counter) moves to the engine: ring fill and underrun counts come from the Rust
  side as telemetry the thin UI renders, rather than from a Web Audio worklet.
- Open until the spike: the concrete channel. Loopback sockets are simplest and
  reuse v0; shared memory is lowest-overhead but adds lifetime and cleanup
  complexity across a process boundary. The spike decides on measured jitter.
- On acceptance this supersedes ADR-0002's transport aspect (jointly with
  ADR-0017 and ADR-0018); until then ADR-0002 stays Accepted.

## Alternatives considered

- **Keep the WebSocket, browser consumes (ADR-0002 / 0003)** - the status quo,
  removed by the move of mixing into the Rust engine. The decision being
  superseded.
- **Push PCM straight into the `cpal` callback from the transport** - skips the
  ring, but any IO or decode on the audio thread is a real-time violation that
  causes exactly the dropouts we are trying to avoid. Rejected.
- **Mix in Python and ship one stream to the engine** - ADR-0003's lineage;
  reintroduces the chunk-boundary and round-trip coupling the crossfader must
  avoid. Rejected.
- **A new, fatter protocol** - more surface for no gain; v0's framing already
  carries PCM plus control. Rejected in favour of reuse.

<!-- Status values: Proposed | Accepted | Rejected | Deprecated |
     Superseded by ADR-NNNN -->
