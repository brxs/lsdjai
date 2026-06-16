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

/** Fire a command at the Rust engine (or a Tauri plugin, e.g. `plugin:dialog|open`).
 * Rejects (caught by callers that care) when the IPC bridge is absent — never
 * throws synchronously. Exported for the few non-engine native callers
 * (MediaExplorer's folder picker). */
export function invoke<T = void>(cmd: string, args?: unknown, options?: unknown): Promise<T> {
  const g = tauriGlobal()
  if (!g) return Promise.reject(new Error('Tauri IPC unavailable'))
  return g.core.invoke<T>(cmd, args, options)
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
        await invoke('load_generated_loop', framePayload([deck, slot, oneShot ? 1 : 0], pcm))
        return awaitSlotFilled(deck, slot)
      },
      // Synchronous boolean from the cached slot state (false iff empty — exactly
      // the engine's own false condition).
      playLoop: (slot) => {
        const filled = snapshot?.loops[deck]?.[slot]?.filled ?? false
        if (filled) send('play_loop', { deck, slot })
        return filled
      },
      stopLoop: () => send('stop_loop', { deck }),
      stopOneShot: () => send('stop_one_shot', { deck }),
      clearLoop: (slot) => send('clear_loop', { deck, slot }),
      captureSample: async (seconds) => {
        const samples = await invoke<number[] | null>('capture_sample', { deck, seconds })
        return samples ? Float32Array.from(samples) : null
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
    // Discrete, rare device commands — a direct invoke, never the per-frame
    // coalescing. setOutputDevice's promise is returned so the caller can catch
    // a rejection (the device couldn't be opened; audio stays undisturbed).
    listOutputDevices: () => invoke<OutputDevice[]>('list_output_devices'),
    setOutputDevice: (name) => invoke('set_output_device', { name }),
    getMasterLevel: () => snapshot?.health.masterPeak ?? 0,
    getMasterGainReduction: () => snapshot?.health.masterGainReductionDb ?? 0,
    // The engine taps the master bus on its render thread; stop returns a WAV.
    startRecording: () => invoke('start_recording'),
    stopRecording: () =>
      invoke<ArrayBuffer>('stop_recording').then(
        (wav) => new Blob([wav], { type: 'audio/wav' }),
      ),
  }
}
