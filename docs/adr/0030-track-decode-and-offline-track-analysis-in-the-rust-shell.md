# 0030. Track decode and offline track analysis in the Rust shell

- **Status:** Proposed
- **Date:** 2026-07-03
- **Deciders:** Daniel Peter

## Context

ADR-0013 gave a deck its playback life: one decoded track, whose BPM and
beatgrid come from an offline pass at load. ADR-0017 ported the mix graph
to Rust but recorded that "the M14/M20/M22 analysis **stays in
TypeScript**: the beat tracker, loudness, band scroller, and the offline
beatgrid" — the death of Web Audio did not force them to move. ADR-0025
has already narrowed that clause once, moving the *live* beat estimator
into the shell (issue #47).

The native load flow makes the residual arrangement look stranger than it
is old. The webview has no filesystem access: every audio byte already
comes from a scoped shell command (`read_audio_file`,
`read_generated_song`) that resolves and validates the path Rust-side.
The webview's contribution is one call to the OS decoder
(`OfflineAudioContext.decodeAudioData`, nativeEngine.ts) — after which it
ships the decoded PCM (~110 MB for a 6:20 track) back across binary IPC
to the engine, and *retains the channels* so `trackBpm`, `trackBeatgrid`,
`trackBands`, and the overview peaks can run in TypeScript. The shell is
already the path authority; the webview is a decode middleman.

Issue #47 forces the question. Porting the live estimator per ADR-0025
leaves the offline pass (`trackBpm`) as `beat.ts`'s only remaining caller
— the same corpus-locked algorithm alive in two languages, the exact
split ADR-0025 exists to remove. And moving `trackBpm` alone cannot fix
it: the beatgrid and band profile still need the decoded buffer
webview-side, so track PCM would cross the boundary anyway, merely in the
opposite direction. The intended endpoint is already written down beside
the code: "the shell decodes + resamples in Phase 2; this slice takes
decoded 48 k f32" (engine playback.rs).

## Decision

- **Deck tracks load by reference, and the shell decodes.** `loadTrack`'s
  contract changes from "webview passes bytes it fetched from the shell"
  to "webview passes the same scoped reference it fetched them *with*" —
  a folder `dir`+`name` or a library item name. The shell resolves the
  path under the existing scoping rules, reads, decodes (symphonia,
  pinned, features matched to the audio-extension allowlist), resamples
  to 48 kHz (rubato, already a justified workspace dependency —
  ADR-0017/0029), and hands the buffer to the engine exactly as
  `Host::load_track` receives it today. Freshly composed in-memory takes
  (the `/api/generate` WAV that may not be on disk) load through a bytes
  variant of the same command: the WAV container bytes cross once;
  decoded PCM never crosses in either direction.
- **Offline track analysis runs in the shell, on the decoded buffer.**
  The coarse tempo pass (ADR-0025's estimator + gate at the live
  cadence), the beatgrid refinement, the band profile, and the overview
  peaks are computed at load on a shell thread (never the `cpal`
  callback). Only results cross: `{bpm, grid, duration}` as numbers, the
  band profile (~340 KB per 6:20 track), and the bucketed peaks (the
  `track_peaks` command already exists end to end). The webview retains
  no decoded channels.
- **The honesty rules port verbatim in intent, and the test suites are
  the contract.** The beatgrid keeps ADR-0014's "no grid beats a wrong
  grid": 16-onset minimum, 0.35 resultant floor, the ±2 % rate search,
  the half-split drift check at 0.15 phase agreement. The synthetic
  beatgrid/bands suites (click tracks, kick-hat fixtures, spliced-tempo
  refusal) move to Rust with the code; the coarse pass answers to
  ADR-0025's corpus harness. Constants are measurements, not choices —
  re-tuning requires re-measuring, as ADR-0025 rules for the live path.
- **The decision covers all file-audio decode; the migration is staged.**
  Issue #47 migrates the deck-track path — the one entangled with beat
  detection. The audition preview (ADR-0027) and sample/loop loading keep
  the webview decoder until a follow-up issue moves them onto the shell
  decoder. Live-wire analysis that is pure UI feed (loudness, the live
  band scroller) stays in TypeScript: ADR-0017's clause survives for
  visuals only.

## Consequences

- One Rust home holds everything the app knows about a track — buffer,
  tempo, grid, bands, peaks — beside the live analysis (ADR-0025), key
  when it lands (ADR-0024), and the interface store (ADR-0020). The
  per-load boundary crossing shrinks from ~110 MB of PCM to ~350 KB of
  summaries.
- MCP's `load_track` stops round-tripping bytes through the webview: the
  `mcp://load-track` handler invokes the by-reference command instead of
  fetching and decoding. The webview remains the load-state orchestrator
  (deck mode is React state until ADR-0020's store owns it); it stops
  being a decoder.
- **Format coverage changes from the OS decoder to symphonia.**
  `decodeAudioData` decoded anything CoreAudio could; symphonia covers
  wav/aiff/flac/alac/mp3/aac-lc/ogg-vorbis behind pinned features. The
  `list_audio_files` extension allowlist must be derived from the enabled
  features, so the browser never offers a file the decoder will refuse;
  anything the OS handled beyond that set degrades to an explicit load
  error. Accepted: a pure-Rust pinned decoder beats hand-written unsafe
  CoreAudio FFI on a load-bearing path.
- New pinned dependency: symphonia. The shell gains its own offline
  (allocating, non-RT) use of rubato; the device path's RT resampler
  (ADR-0029) is untouched.
- `beat.ts`, `beatgrid.ts`, and the offline half of `bands.ts` are
  deleted with their suites once the Rust ports' suites are green;
  `getTrackPeaks` switches from the TS envelope over retained channels to
  the existing `track_peaks` command, fetched once per load and cached so
  the getter stays synchronous.
- Decode failures change shape: command errors instead of
  `decodeAudioData` rejections. The load flow's error states cannot be
  fully verified by tests — the hardware/manual checklist covers them.
- ADR-0013's "track-deck features read the buffer" is amended to "read
  the shell's analysis of the buffer"; ADR-0014's grid semantics are
  untouched (the rules move, they do not change); ADR-0017's
  analysis-stays-in-TypeScript clause narrows to live visuals. None of
  the three flips status. ADR-0010 flips per ADR-0025's own corpus gate,
  not this record.

## Alternatives considered

- **Keep webview decode; move only the analyses' call sites** — the
  beatgrid and bands still need the decoded buffer in TypeScript, so PCM
  crosses Rust→webview instead of webview→Rust: the same shipment
  reversed, plus a decoder dependency for no boundary win. Rejected.
- **Port only the live estimator; leave all offline analysis in
  TypeScript** — `beat.ts` survives as `trackBpm`'s engine, the
  corpus-locked algorithm lives in two languages, and every future track
  feature (harmonic auto-mix reading track key, ADR-0024) re-fights this
  split. Rejected as institutionalising the fragmentation ADR-0025 names.
- **CoreAudio (`ExtAudioFile`) FFI instead of symphonia** — exactly
  matches the format coverage the app has today, but through hand-written
  unsafe bindings on a load-bearing path, and locks decode to macOS while
  the rest of the audio stack (cpal/fundsp/rubato) is portable. Rejected;
  revisit only if symphonia's coverage proves short in the field.
- **Full shell-side load orchestration (mode switch, transport) in the
  same move** — the clean endpoint, but it needs the ADR-0020 store to
  own deck mode first; a bespoke mode-state channel now would re-scatter
  what ADR-0020 unifies. Deferred, matching ADR-0025's "cross-deck
  aggregates wait for the store".

<!-- Status values: Proposed | Accepted | Rejected | Deprecated |
     Superseded by ADR-NNNN -->
