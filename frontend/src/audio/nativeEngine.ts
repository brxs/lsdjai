/** The native (Tauri) AudioEngine: the SAME `AudioEngine` / `DeckChannel`
 * interface as the Web Audio engine (`engine.ts`), but every control call is a
 * Tauri `invoke` to the Rust audio engine, and every synchronous getter
 * (`getLevel`, `getTrackStatus`, `getMasterLevel`, `getContextTime`, …) reads a
 * per-frame snapshot the poller caches (ADR-0017/0018, the Phase 2 part 3 swap).
 *
 * # Why a cache
 *
 * The interface has many *synchronous* getters the UI calls every animation
 * frame, but IPC is asynchronous. So a single poller invokes one consolidated
 * `engine_snapshot` command per `requestAnimationFrame` and stores the result;
 * the getters serve from that cache. `playLoop`'s synchronous boolean — the only
 * control return the UI consumes synchronously — is answered from the cached slot
 * state (the engine returns false iff the slot is empty, which the cache knows).
 *
 * # What moved, what stayed
 *
 * - Model PCM no longer flows through the UI: the sidecar feeds the engine
 *   directly (part 4), so `postPcm` is a no-op here. Until part 4 the WebSocket
 *   feed in `useDeck` still drives the TS beat/loudness analysis (ADR-0017).
 * - `getTrackPeaks` is computed in TS from the decoded channels this adapter
 *   keeps per deck (sync + exact at any bucket count) — no IPC for the overview.
 * - Cue routing is native: the engine derives the headphone feed and routes it
 *   to the output device's channels 3/4, so the webview only sends the live
 *   controls (`setCue`/`setCueMix`). `setBeatPeriod` (synced dub echo) is a
 *   documented follow-up; `nudgeTrackPhase` (the jog-while-playing platter bend)
 *   is wired to the engine's `nudge_track_phase` rate bend. */

import type { EqBand } from './eq'
import {
  SAMPLE_RATE,
  type AudioEngine,
  type DeckChannel,
  type DeckId,
  type OutputDevice,
  type StatsHandler,
} from './types'
import type { FxKind } from './fx'
import { interleaveChannels } from './styleSample'

/** Minimal shape of the `withGlobalTauri` global we use (core `invoke`). */
type TauriGlobal = {
  core: {
    invoke: <T>(cmd: string, args?: unknown, options?: unknown) => Promise<T>
  }
}

function tauriGlobal(): TauriGlobal | null {
  const g = globalThis as { __TAURI__?: TauriGlobal }
  return g.__TAURI__ ?? null
}

/** Whether the native (Tauri) IPC bridge is present. False in a plain browser (dev
 * without the shell), where native-only actions like writing a song to disk can't
 * run — callers skip them rather than surfacing an avoidable error. */
export function isTauri(): boolean {
  return tauriGlobal() !== null
}

let apiBaseUrlPromise: Promise<string> | null = null

/** Base URL for the backend `/api/*` generation endpoints (sa3/Magenta pad+track
 * render). FastAPI no longer serves the UI, so the Rust shell runs a generation
 * server on a loopback port it reports via `app_info`; the webview fetches
 * `http://127.0.0.1:<port>/api/...`. Resolved once and cached; falls back to ''
 * (relative) if the port can't be resolved. */
export function getApiBaseUrl(): Promise<string> {
  if (!apiBaseUrlPromise) {
    apiBaseUrlPromise = invoke<{ generationPort: number | null }>('app_info')
      .then((info) => (info.generationPort ? `http://127.0.0.1:${info.generationPort}` : ''))
      .catch(() => '')
  }
  return apiBaseUrlPromise
}

/** The native MCP server endpoint + bearer token (ADR-0020 Phase 2), reported by
 * `app_info`. `port` is null when `LSDJ_MCP` is unset / the server failed; the
 * Settings drawer surfaces these so a client can be pointed at the loopback URL. */
export type McpInfo = { port: number | null; token: string | null }

export function getMcpInfo(): Promise<McpInfo> {
  return invoke<{ mcpPort: number | null; mcpToken: string | null }>('app_info')
    .then((info) => ({ port: info.mcpPort ?? null, token: info.mcpToken ?? null }))
    .catch(() => ({ port: null, token: null }))
}

/** Mint a new MCP bearer token, persist it, and swap it in live (the Settings
 * "Rotate token" button) — invalidating a leaked token without an app restart.
 * Resolves to the new token. */
export function rotateMcpToken(): Promise<string> {
  return invoke<string>('rotate_mcp_token')
}

/** Fire a command at the Rust engine (or a Tauri plugin, e.g. `plugin:dialog|open`).
 * Rejects (caught by callers that care) when the IPC bridge is absent — never
 * throws synchronously. Exported for the few non-engine native callers
 * (MediaExplorer's folder picker). */
export function invoke<T = void>(cmd: string, args?: unknown, options?: unknown): Promise<T> {
  const g = tauriGlobal()
  if (!g) return Promise.reject(new Error('Tauri IPC unavailable'))
  return g.core.invoke<T>(cmd, args, options)
}

/** Minimal shape of the Tauri event API we use (`event.listen`). */
type TauriEventApi = {
  listen: (
    event: string,
    handler: (e: { payload: unknown }) => void,
  ) => Promise<() => void>
}

/** The library a `library://changed` event names (Rust `watcher::LibraryChanged`). */
export type LibraryKind = 'songs' | 'samples'

/** Subscribe to the Rust folder watcher's `library://changed` event (ADR-0022): the
 * named library's folder changed out-of-band — a deck auto-saved a sample, a file
 * was dropped in or deleted by hand — so the matching Media Explorer tab should
 * re-list. Returns an unsubscribe fn (safe to call before the async `listen`
 * resolves). A no-op outside Tauri or without the event bridge (so tests that stub
 * only `core` are unaffected). */
export function subscribeLibraryChanged(
  onChange: (library: LibraryKind) => void,
): () => void {
  return listenTo<{ library?: LibraryKind }>('library://changed', (payload) => {
    if (payload.library === 'songs' || payload.library === 'samples') onChange(payload.library)
  })
}

// --- Model manager (issue #43) ---------------------------------------------

/** A model family the manager installs (Rust `models::Family`). */
export type ModelFamily = 'magenta' | 'sa3'

/** One installed Magenta model in `model_status` (serde camelCase). */
export type InstalledModel = {
  name: string
  sizeBytes: number
  /** Files present but the shared resources a load needs are not. */
  needsResources: boolean
}

/** SA3's four readiness states (Rust `models`/`sa3.readiness`). */
export type Sa3State = 'missing' | 'venv_missing' | 'not_warmed' | 'ready'

/** The source an SA3 checkout was installed from / is pinned to (Rust
 * `models::Sa3Source`): the `sa3-pin.json` repo + commit. */
export type Sa3Source = { repo: string; commit: string }

/** The model-manager status for both families (Rust `models::ModelStatus`). */
export type ModelStatus = {
  magenta: {
    modelsDir: string
    resourcesPresent: boolean
    installable: string[]
    installed: InstalledModel[]
  }
  sa3: {
    state: Sa3State
    sizeBytes: number
    checkout: string | null
    /** What the installed checkout was fetched from (`null` when unstamped). */
    installedSource: Sa3Source | null
    /** What's currently pinned. */
    pinnedSource: Sa3Source
    /** The installed checkout differs from the pin (or is unstamped) — offer an update. */
    updateAvailable: boolean
  }
  /** The in-flight install, so the manager reflects it after a close/reopen even
   * though the live `model://progress` events were missed while unmounted. */
  installing: { family: ModelFamily; name: string } | null
}

/** A live install-progress event (Rust `models::ModelProgress`). */
export type ModelProgress = {
  family: ModelFamily
  name: string
  stage: string
  message: string | null
  file: string | null
}

function eventApi(): TauriEventApi | null {
  return (globalThis as { __TAURI__?: { event?: TauriEventApi } }).__TAURI__?.event ?? null
}

/** Subscribe to a Tauri event; a no-op (and safe unsubscribe) without the event
 * bridge, so tests that stub only `core` are unaffected. */
function listenTo<T>(event: string, onEvent: (payload: T) => void): () => void {
  const ev = eventApi()
  if (!ev) return () => {}
  let unlisten: (() => void) | null = null
  let cancelled = false
  void ev.listen(event, (e) => onEvent(e.payload as T)).then((un) => {
    if (cancelled) un()
    else unlisten = un
  })
  return () => {
    cancelled = true
    unlisten?.()
  }
}

/** Fetch the model-manager status (both families). */
export function modelStatus(): Promise<ModelStatus> {
  return invoke<ModelStatus>('model_status')
}

/** Start installing a model (Magenta needs `name`; SA3 ignores it). Resolves once
 * the install has STARTED; progress arrives via `subscribeModelProgress` and a
 * final `models://changed`. */
export function installModel(family: ModelFamily, name?: string): Promise<void> {
  return invoke('install_model', { family, name: name ?? null })
}

/** Update a family in place to the pinned source (SA3: re-fetch the pinned
 * checkout, rebuild, re-warm). Progress arrives like an install. */
export function updateModel(family: ModelFamily): Promise<void> {
  return invoke('update_model', { family })
}

/** Cancel the in-flight install (kills the child + cleans partials). */
export function cancelInstall(): Promise<void> {
  return invoke('cancel_install')
}

/** Reveal a family's folder in the OS file manager (for inspecting or removing
 * models natively — the watcher reflects a native delete live). Magenta opens its
 * models dir; SA3 opens its checkout. */
export function openModelFolder(family: ModelFamily): Promise<void> {
  return invoke('open_model_folder', { family })
}

/** Subscribe to `models://changed` (the models-dir watcher / an install finishing):
 * re-fetch `model_status` and the deck picker's `/api/models`. */
export function subscribeModelsChanged(onChange: () => void): () => void {
  return listenTo<unknown>('models://changed', () => onChange())
}

/** Subscribe to live install progress (`model://progress`). */
export function subscribeModelProgress(onProgress: (p: ModelProgress) => void): () => void {
  return listenTo<ModelProgress>('model://progress', onProgress)
}

// --- The interface-state store (ADR-0020, issue #37 Phase 1) ---
//
// Rust owns the semantic/audio-param interface state; the webview projects it.
// These mirror the Rust `store::InterfaceState` serde shape (camelCase). The FX
// kind is the camelCase wire value (`dubEcho`), matching `FX_ARG`.

/** A Color FX kind as it appears in the store snapshot (the camelCase wire value). */
export type FxKindSnap = 'filter' | 'dubEcho' | 'space' | 'crush' | 'noise' | 'sweep'

/** One deck's state in the store: the mixer channel plus the realtime read-backs
 * the store mirrors (model / playing). */
export type DeckSnap = {
  volume: number
  eq: { low: number; mid: number; high: number }
  trimDb: number
  cue: boolean
  onAir: boolean
  fx: { kind: FxKindSnap | null; amount: number }
  /** The realtime deck's loaded model (a sidecar read-back the store mirrors). */
  model: string | null
  /** Whether the realtime deck is generating (a derived read-back the store mirrors). */
  playing: boolean
  /** Hot-cue points on the loaded track in track seconds, one per pad (empty with
   * no track). ADR-0015's cue state, mirrored here per ADR-0020. */
  cues: (number | null)[]
  /** The loaded track's identity on a playback deck (a read-back the store
   * mirrors), or null on a realtime deck / with no track. */
  track: { title: string; bpm: number | null; durationSeconds: number } | null
  /** Freeze/sample loop-slot labels, one per pad (null for an empty/unlabelled
   * slot) — a read-back the store mirrors. */
  loopLabels: (string | null)[]
  /** The realtime deck's 2D style-pad targets (prompt + position), mirrored from
   * DeckColumn (sampled-target embedding ids stay out). */
  styleTargets: { x: number; y: number; text: string }[]
  /** The 2D style-pad cursor (the blend point). */
  cursor: { x: number; y: number }
}

/** The authoritative interface state the webview projects (mirrors Rust
 * `store::InterfaceState`). View state is deliberately absent — it stays in React
 * (the ADR-0020 narrowing). */
export type InterfaceState = {
  decks: DeckSnap[]
  crossfade: number
  cueMix: number
}

/** Fetch the current interface-state snapshot (the projection's initial hydrate). */
export function storeSnapshot(): Promise<InterfaceState> {
  return invoke<InterfaceState>('store_snapshot')
}

/** Subscribe to `store://changed` — the store emits the fresh snapshot on every
 * mutation (from any controller: UI, MIDI, or a future MCP agent). Returns an
 * unsubscribe fn. */
export function subscribeStoreChanged(onChange: (state: InterfaceState) => void): () => void {
  return listenTo<InterfaceState>('store://changed', onChange)
}

/** Mirror a realtime deck's derived state (model + playing) into the store. The
 * webview owns the derivation (worker status + play/stop); this writes the current
 * value up so the store stays the single source of truth — no engine effect.
 * Fire-and-forget (a dropped mirror write must never surface as a rejection). */
export function setDeckRealtime(deck: number, model: string | null, playing: boolean): void {
  void invoke('set_deck_realtime', { deck, model, playing }).catch(() => {})
}

/** Mirror a playback deck's hot-cue points into the store (ADR-0015 → ADR-0020).
 * The webview owns the set/jump logic; this writes the current points up.
 * Fire-and-forget. */
export function setDeckCues(deck: number, cues: (number | null)[]): void {
  void invoke('set_deck_cues', { deck, cues }).catch(() => {})
}

/** Mirror a playback deck's loaded-track identity into the store (null clears it).
 * A read-back the webview writes up; no engine effect. Fire-and-forget. */
export function setDeckTrack(
  deck: number,
  track: { title: string; bpm: number | null; durationSeconds: number } | null,
): void {
  void invoke('set_deck_track', { deck, track }).catch(() => {})
}

/** Mirror a deck's freeze/sample loop-slot labels into the store. A read-back the
 * webview writes up when its slots change. Fire-and-forget. */
export function setDeckLoopLabels(deck: number, labels: (string | null)[]): void {
  void invoke('set_deck_loop_labels', { deck, labels }).catch(() => {})
}

// Coalesce high-rate mirror writes to ~one invoke per animation frame, like the
// engine's control coalescer. The style-pad mirror fires per pointermove (and the
// 14-bit jog can drive cursor changes at 200-600/s); the write-only mirror must not
// flood the store with full-state broadcasts (each re-renders every projection
// consumer). Only the latest value per key in a frame is shipped.
const mirrorPending = new Map<string, () => void>()
let mirrorFlushScheduled = false
function coalesceMirror(key: string, run: () => void): void {
  mirrorPending.set(key, run)
  if (mirrorFlushScheduled) return
  mirrorFlushScheduled = true
  requestAnimationFrame(() => {
    mirrorFlushScheduled = false
    const due = [...mirrorPending.values()]
    mirrorPending.clear()
    for (const r of due) r()
  })
}

/** Mirror a realtime deck's 2D style-pad targets + cursor into the store. The
 * blended prompt still goes to the worker via deck_set_style; this records the UI
 * source for a future MCP read. Coalesced to ~one invoke per frame (a style-pad
 * drag fires this per pointermove). Fire-and-forget. */
export function setDeckStyle(
  deck: number,
  targets: { x: number; y: number; text: string }[],
  cursor: { x: number; y: number },
): void {
  coalesceMirror(`set_deck_style:${deck}`, () => {
    void invoke('set_deck_style', { deck, targets, cursor }).catch(() => {})
  })
}

const DECK_INDEX: Record<DeckId, number> = { a: 0, b: 1 }

/** Map the TS `FxKind` (snake) to the Rust `FxKindArg` (camel, serde). */
const FX_ARG: Record<FxKind, string> = {
  filter: 'filter',
  dub_echo: 'dubEcho',
  space: 'space',
  crush: 'crush',
  noise: 'noise',
  sweep: 'sweep',
}

// --- The wire DTOs (serde camelCase from `src-tauri/src/commands.rs`) ---

type TrackStatusDto = {
  playhead: number
  playing: boolean
  durationFrames: number
  rate: number
  ended: boolean
  loopRegion: { start: number; end: number } | null
}

type LoopSlotDto = { filled: boolean; playing: boolean }

type HealthDto = {
  outputRingFrames: number
  deckRingFrames: number[]
  deckUnderruns: number
  outputUnderruns: number
  masterPeak: number
  masterGainReductionDb: number
  deckLevels: number[]
  contextFrames: number
}

type EngineSnapshotDto = {
  health: HealthDto
  tracks: (TrackStatusDto | null)[]
  loops: LoopSlotDto[][]
}

/** Build the binary payload Tauri ships to the Rust engine: little-endian `u32`
 * prefix words (deck, …) then the interleaved-stereo f32 PCM as raw bytes. */
function framePayload(prefix: number[], pcm: Float32Array): Uint8Array {
  const header = new Uint8Array(prefix.length * 4)
  const view = new DataView(header.buffer)
  prefix.forEach((value, i) => view.setUint32(i * 4, value >>> 0, true))
  const body = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const out = new Uint8Array(header.length + body.length)
  out.set(header, 0)
  out.set(body, header.length)
  return out
}

/** Frame a save payload for the songs/samples libraries: `[u32 LE meta-JSON
 * byte-length][meta JSON utf-8][WAV bytes]`. A JSON args map would be MBs of text for
 * a multi-MB WAV, so the bytes ride a single binary-IPC arg. Shared by every
 * `save_generated_*` caller (the song/sample compose paths and the deck channel). */
export function encodeMetaFrame(meta: object, wav: ArrayBuffer): Uint8Array {
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta))
  const payload = new Uint8Array(4 + metaBytes.length + wav.byteLength)
  new DataView(payload.buffer).setUint32(0, metaBytes.length, true)
  payload.set(metaBytes, 4)
  payload.set(new Uint8Array(wav), 4 + metaBytes.length)
  return payload
}

/** Decode + resample a WAV to 48 kHz: an `OfflineAudioContext` at the engine rate
 * resamples in `decodeAudioData`. WebKit (the native webview) supports this. */
async function decodeTo48k(wav: ArrayBuffer): Promise<AudioBuffer> {
  // `decodeAudioData` detaches its input — clone so the caller's buffer survives.
  const ctx = new OfflineAudioContext(2, 1, SAMPLE_RATE)
  return ctx.decodeAudioData(wav.slice(0))
}

/** Compute a min/max envelope at `buckets` resolution from a decoded channel
 * (mono mix of L/R) — the waveform overview, computed in TS so `getTrackPeaks`
 * stays synchronous (ADR-0017: visuals stay in TS). */
function envelope(
  left: Float32Array,
  right: Float32Array,
  buckets: number,
): { min: Float32Array; max: Float32Array } {
  const min = new Float32Array(buckets)
  const max = new Float32Array(buckets)
  const frames = Math.min(left.length, right.length)
  const per = Math.max(1, Math.floor(frames / buckets))
  for (let b = 0; b < buckets; b++) {
    const start = b * per
    const end = b === buckets - 1 ? frames : Math.min(frames, start + per)
    let lo = 0
    let hi = 0
    for (let i = start; i < end; i++) {
      const s = (left[i] + right[i]) * 0.5
      if (s < lo) lo = s
      if (s > hi) hi = s
    }
    min[b] = lo
    max[b] = hi
  }
  return { min, max }
}

/** Per-deck decoded channels the adapter retains for `getTrackPeaks`; cleared on
 * unload. (The playback buffer itself lives in Rust; this is the overview copy.) */
type DecodedTrack = { left: Float32Array; right: Float32Array }

export function createNativeEngine(): AudioEngine {
  // The latest snapshot the poller cached; the synchronous getters serve from it.
  let snapshot: EngineSnapshotDto | null = null
  // Per-deck stats handlers registered in createDeckChannel, fed from the poller.
  const statsHandlers: (StatsHandler | null)[] = [null, null]
  const decoded: (DecodedTrack | null)[] = [null, null]
  let polling = false
  let lastStatsAt = 0
  const STATS_INTERVAL_MS = 100 // ~10 Hz, matching the worklet's stat cadence

  // --- Per-frame IPC coalescing for high-rate continuous setters ---
  //
  // A fast EQ/fader/filter sweep (pointermove, or the doubled 14-bit FLX4 CCs at
  // ~200-600/s) fires one control command per event. These setters are all
  // idempotent absolute "last-write-wins" sets, so only the latest value per
  // target in a frame matters. We collapse them to ~one invoke per key per
  // animation frame: `coalesce(key, cmd, args)` overwrites the pending entry and
  // schedules a single rAF flush; `flushPending` ships them. Discrete/stateful
  // commands stay immediate and FIRST flush the pending map, so a coalesced
  // value can never leapfrog an ordering-dependent command (e.g. a pending
  // set_fx_amount must land before a set_fx kind-change that resets amount).
  // Purely an IPC reduction — the Rust engine is glitch-free regardless — so it
  // changes no observable behaviour beyond dropping redundant writes.
  type PendingWrite = { cmd: string; args: unknown; fingerprint: string }
  const pending = new Map<string, PendingWrite>()
  // The value last actually shipped per key (written in flushPending, never at
  // queue time) — lets us drop a coalesced write that re-sends an already-applied
  // value (an idempotent absolute set). Safe because every coalesced key is
  // written ONLY through this path, so lastFlushed never drifts from the engine —
  // with one exception that stays consistent: `set_fx` resets the engine's
  // fx_amount to the kind's rest, and `useDeck.setFx` immediately re-applies
  // `setFxAmount(rest)` (the same rest), so after a kind change the engine, the
  // re-applied value, and lastFlushed all agree. Keep that re-apply if you touch
  // the fx kind-change flow.
  const lastFlushed = new Map<string, string>()
  let flushScheduled = false

  function flushPending() {
    flushScheduled = false
    if (pending.size === 0) return
    const due = [...pending.entries()]
    pending.clear()
    for (const [key, { cmd, args, fingerprint }] of due) {
      lastFlushed.set(key, fingerprint)
      void invoke(cmd, args).catch(() => {})
    }
  }

  /** Queue a continuous absolute setter, overwriting any pending value for the
   * same key, and schedule a single flush for the next frame. A value that
   * equals the one last shipped for this key is dropped (idempotent set). */
  function coalesce(key: string, cmd: string, args: unknown) {
    const fingerprint = JSON.stringify(args)
    if (lastFlushed.get(key) === fingerprint) {
      // Already the live value; drop any stale pending entry for this key.
      pending.delete(key)
      return
    }
    pending.set(key, { cmd, args, fingerprint })
    if (!flushScheduled) {
      flushScheduled = true
      requestAnimationFrame(flushPending)
    }
  }

  /** Immediate (non-coalesced) fire-and-forget control for the many `void`
   * setters: first flush every pending coalesced write so this discrete command
   * can never be overtaken, then `invoke` with the rejection swallowed (a dropped
   * control command must never surface as an unhandled rejection). */
  function send(cmd: string, args?: unknown): void {
    flushPending()
    void invoke(cmd, args).catch(() => {})
  }

  function deckTrackStatus(deck: number) {
    const dto = snapshot?.tracks[deck]
    if (!dto) return null
    return {
      position: dto.playhead / SAMPLE_RATE,
      duration: dto.durationFrames / SAMPLE_RATE,
      playing: dto.playing,
      ended: dto.ended,
      rate: dto.rate,
      loop: dto.loopRegion
        ? { start: dto.loopRegion.start / SAMPLE_RATE, end: dto.loopRegion.end / SAMPLE_RATE }
        : null,
      contextTime: (snapshot?.health.contextFrames ?? 0) / SAMPLE_RATE,
    }
  }

  function pumpStats(now: number) {
    if (!snapshot || now - lastStatsAt < STATS_INTERVAL_MS) return
    lastStatsAt = now
    const { health } = snapshot
    const contextTime = health.contextFrames / SAMPLE_RATE
    for (let deck = 0; deck < statsHandlers.length; deck++) {
      const handler = statsHandlers[deck]
      if (!handler) continue
      const track = snapshot.tracks[deck]
      handler({
        underruns: health.deckUnderruns,
        bufferedSeconds: (health.deckRingFrames[deck] ?? 0) / SAMPLE_RATE,
        playing: track ? track.playing : (health.deckRingFrames[deck] ?? 0) > 0,
        playedFrames: health.contextFrames,
        contextTime,
      })
    }
  }

  /** One poll: fetch the consolidated snapshot, cache it, drive the stats
   * handlers, and schedule the next frame. An in-flight guard keeps a slow IPC
   * round-trip from stacking polls. */
  function poll() {
    invoke<EngineSnapshotDto>('engine_snapshot')
      .then((next) => {
        snapshot = next
        pumpStats(performance.now())
      })
      .catch(() => {})
      .finally(() => {
        if (polling) requestAnimationFrame(poll)
      })
  }

  function startPolling() {
    if (polling) return
    polling = true
    requestAnimationFrame(poll)
  }

  /** Resolve once a deck's slot reports `filled` in a fresh snapshot (capture /
   * generated-load landed), or `false` after a short timeout — so the boolean
   * the UI awaits is truthful and the cache is consistent before the follow-up
   * `playLoop` reads it. */
  function awaitSlotFilled(deck: number, slot: number, timeoutMs = 300): Promise<boolean> {
    const deadline = performance.now() + timeoutMs
    return new Promise((resolve) => {
      const check = () => {
        if (snapshot?.loops[deck]?.[slot]?.filled) return resolve(true)
        if (performance.now() >= deadline) return resolve(false)
        requestAnimationFrame(check)
      }
      check()
    })
  }

  function makeDeckChannel(deckId: DeckId): DeckChannel {
    const deck = DECK_INDEX[deckId]
    return {
      // Model PCM is fed engine-side by the sidecar (part 4), not through the UI.
      postPcm: () => {},
      // The realtime ring is cleared by the worker/sidecar lifecycle (part 4);
      // no engine-side reset command in the native path.
      reset: () => {},
      setVolume: (volume) =>
        coalesce(`set_volume:${deck}`, 'set_volume', { deck, gain: volume }),
      setEq: (band, value) =>
        coalesce(`set_eq:${deck}:${band}`, 'set_eq', { deck, band, value }),
      setCue: (on) => send('set_cue', { deck, on }),
      setFx: (kind) =>
        kind === null ? send('clear_fx', { deck }) : send('set_fx', { deck, kind: FX_ARG[kind] }),
      setFxAmount: (amount) =>
        coalesce(`set_fx_amount:${deck}`, 'set_fx_amount', { deck, amount }),
      // Synced dub echo (M14) is a documented parity follow-up.
      setBeatPeriod: () => {},
      setOnAir: (on) => send('set_on_air', { deck, on }),
      setTrim: (db) => coalesce(`set_trim:${deck}`, 'set_trim', { deck, db }),
      captureLoop: async (slot, seconds) => {
        await invoke('capture_loop', { deck, slot, seconds })
        return awaitSlotFilled(deck, slot)
      },
      loadGeneratedLoop: async (slot, wav, oneShot) => {
        const buf = await decodeTo48k(wav)
        const left = buf.getChannelData(0)
        const right = buf.numberOfChannels > 1 ? buf.getChannelData(1) : left
        const pcm = interleaveChannels(left, right)
        // The engine reports whether it accepted the pad (false off Realtime, or a
        // loop too short to install). Trust that verdict rather than polling the
        // slot — a poll can't tell a slow install from a silent refusal, which is
        // what surfaced as a phantom "could not be decoded" on an idle deck.
        return invoke<boolean>(
          'load_generated_loop',
          framePayload([deck, slot, oneShot ? 1 : 0], pcm),
        )
      },
      // Synchronous boolean from the cached slot state (false iff empty — exactly
      // the engine's own false condition). `layer` chooses replace vs sum-on-top
      // (ADR-0022); the engine ignores it for a one-shot buffer.
      playLoop: (slot, layer) => {
        const filled = snapshot?.loops[deck]?.[slot]?.filled ?? false
        if (filled) send('play_loop', { deck, slot, layer })
        return filled
      },
      stopLoop: () => send('stop_loop', { deck }),
      stopLayer: (slot) => send('stop_layer', { deck, slot }),
      stopOneShot: () => send('stop_one_shot', { deck }),
      clearLoop: (slot) => send('clear_loop', { deck, slot }),
      captureSample: async (seconds) => {
        const samples = await invoke<number[] | null>('capture_sample', { deck, seconds })
        return samples ? Float32Array.from(samples) : null
      },
      saveLoopSlot: async (slot, meta) => {
        // A freeze's audio lives only in the engine slot, so the shell reads the
        // exact stored buffer for this deck/slot and persists it — no PCM crosses
        // the boundary here, just the slot coordinates and metadata.
        await invoke('save_loop_slot', { deck, slot, meta })
      },
      saveGeneratedSample: async (wav, meta) => {
        await invoke('save_generated_sample', encodeMetaFrame(meta, wav))
      },
      loadTrack: async (wav) => {
        const buf = await decodeTo48k(wav)
        const left = buf.getChannelData(0).slice()
        const right = (buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0)).slice()
        const pcm = interleaveChannels(left, right)
        await invoke('load_track', framePayload([deck], pcm))
        decoded[deck] = { left, right }
        return { duration: buf.duration, sampleRate: SAMPLE_RATE, left, right }
      },
      // The engine ignores the boolean here (useDeck does too); report the cached
      // loaded state for interface compliance.
      playTrack: () => {
        const loaded = snapshot?.tracks[deck] != null
        send('play_track', { deck })
        return loaded
      },
      pauseTrack: () => send('pause_track', { deck }),
      seekTrack: (seconds) => send('seek_track', { deck, frames: seconds * SAMPLE_RATE }),
      setTrackLoop: (start, end) =>
        send('set_track_loop', {
          deck,
          start: Math.round(start * SAMPLE_RATE),
          end: Math.round(end * SAMPLE_RATE),
        }),
      clearTrackLoop: () => send('clear_track_loop', { deck }),
      getTrackStatus: () => deckTrackStatus(deck),
      setTrackRate: (rate) => send('set_track_rate', { deck, rate }),
      // Platter-drag phase nudge (the never-a-click stepped bend): the engine
      // slips the playhead via a rate bend, so the seconds delta crosses as
      // frames like every other transport command.
      nudgeTrackPhase: (seconds) => send('nudge_track_phase', { deck, frames: seconds * SAMPLE_RATE }),
      getTrackPeaks: (buckets) => {
        const track = decoded[deck]
        if (!track || buckets <= 0) return null
        return envelope(track.left, track.right, buckets)
      },
      unloadTrack: () => {
        decoded[deck] = null
        send('unload_track', { deck })
      },
      getLevel: () => snapshot?.health.deckLevels[deck] ?? 0,
      dispose: () => {
        // Ship any queued writes so the last swept value isn't lost on teardown.
        flushPending()
        decoded[deck] = null
        statsHandlers[deck] = null
      },
    }
  }

  return {
    getContextTime: () => (snapshot ? snapshot.health.contextFrames / SAMPLE_RATE : null),
    createDeckChannel: async (deckId, initial, onStats) => {
      const deck = DECK_INDEX[deckId]
      statsHandlers[deck] = onStats
      // Apply the initial channel config to the engine.
      send('set_volume', { deck, gain: initial.volume })
      for (const band of Object.keys(initial.eq) as EqBand[]) {
        send('set_eq', { deck, band, value: initial.eq[band] })
      }
      if (initial.fx.kind === null) {
        send('clear_fx', { deck })
      } else {
        send('set_fx', { deck, kind: FX_ARG[initial.fx.kind] })
        send('set_fx_amount', { deck, amount: initial.fx.amount })
      }
      send('set_trim', { deck, db: initial.trimDb })
      startPolling()
      return makeDeckChannel(deckId)
    },
    // Audio is always running in the native engine — no Web Audio resume gesture.
    resume: () => Promise.resolve(),
    setCrossfade: (position) => coalesce('set_crossfade', 'set_crossfade', { position }),
    setCueMix: (position) => coalesce('set_cue_mix', 'set_cue_mix', { position }),
    // A library preview routed to the phones only (ADR-0027): decode like a track
    // load, then ship the raw PCM (no per-deck header — the preview is engine-wide).
    auditionPlay: async (wav) => {
      const buf = await decodeTo48k(wav)
      const left = buf.getChannelData(0).slice()
      const right = (
        buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0)
      ).slice()
      await invoke('audition_play', framePayload([], interleaveChannels(left, right)))
    },
    auditionStop: () => send('audition_stop'),
    // Discrete, rare device commands — a direct invoke, never the per-frame
    // coalescing. The promises are returned so the caller can catch a rejection
    // (the device couldn't be opened; audio stays undisturbed).
    listOutputDevices: () => invoke<OutputDevice[]>('list_output_devices'),
    setMainDevice: (name) => invoke('set_main_device', { name }),
    setCueDevice: (name) => invoke('set_cue_device', { name }),
    getMasterLevel: () => snapshot?.health.masterPeak ?? 0,
    getMasterGainReduction: () => snapshot?.health.masterGainReductionDb ?? 0,
    // The engine taps the master bus on its render thread and streams it straight to
    // disk from Rust (the WAV never crosses IPC). The file opens at start, so the
    // path comes back from start_recording; stop just flushes and closes it.
    startRecording: (folder, name) =>
      invoke<string>('start_recording', { folder, name }),
    stopRecording: () => invoke('stop_recording'),
  }
}
