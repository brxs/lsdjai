/** The shared audio contract — deck/mixer types + a few constants the whole app
 * types against. Extracted from the Web Audio engine so the native engine adapter
 * (`nativeEngine.ts`) and the UI/deck/control layers depend on the interface, not
 * the implementation. The Web Audio engine that originally defined these is gone
 * (the app runs only under Tauri now); the Rust engine implements `AudioEngine`
 * over IPC. */

import type { EqBand } from './eq'
import type { FxKind } from './fx'
import type { TrackLoop } from './track'

export type DeckId = 'a' | 'b'

export type DeckChannel = {
  postPcm: (samples: Float32Array) => void
  reset: () => void
  setVolume: (volume: number) => void
  setEq: (band: EqBand, value: number) => void
  /** Feed this channel (post-EQ, pre-fader) into the headphone cue bus. */
  setCue: (on: boolean) => void
  /** Swap the Color FX insert's effect; null removes it (M12). */
  setFx: (kind: FxKind | null) => void
  /** Knob position for the active effect; inside the effect's dead zone
   * the insert is bit-transparently bypassed (ADR-0008). */
  setFxAmount: (amount: number) => void
  /** Detected beat period (M14), null while the gate refuses — graphs
   * with a musical clock (the synced dub echo) follow it. */
  setBeatPeriod: (seconds: number | null) => void
  /** Off-air mutes the channel's master feed only — generation, meters,
   * and the cue tap stay live. The primed-deck state (M10). */
  setOnAir: (on: boolean) => void
  /** Gain-staging trim at the chain head (M17): live stream and
   * freeze loops alike, pre-EQ so kills stay the performer's move. */
  setTrim: (db: number) => void
  /** Freeze pads (M13, ADR-0009): capture the just-played tail into a
   * slot. Resolves false when too little has been played to loop. */
  captureLoop: (slot: number, seconds: number) => Promise<boolean>
  /** Generated pads (M18, ADR-0012): decode a WAV into a slot. Loops
   * arrive with a surplus seam tail and get the capture treatment
   * (fold + wrap); one-shots are stored as-is. False on a bad slot or
   * an undecodable body. */
  loadGeneratedLoop: (
    slot: number,
    wav: ArrayBuffer,
    oneShot: boolean,
  ) => Promise<boolean>
  /** Swap the channel source from the live stream to a filled slot's
   * loop (false when the slot is empty). The stream keeps running,
   * muted, so stopLoop returns to fresh material instantly. One-shot
   * slots overlay instead: they sum onto whatever is playing, fire
   * once, and fall silent — the live/loop handover is untouched. */
  playLoop: (slot: number) => boolean
  stopLoop: () => void
  /** Cut a ringing one-shot (deck STOP silences everything). */
  stopOneShot: () => void
  clearLoop: (slot: number) => void
  /** Style sampling (M15): the just-played tail as wire-format PCM,
   * or null when too little has played to embed meaningfully. */
  captureSample: (seconds: number) => Promise<Float32Array<ArrayBuffer> | null>
  /** Playback mode (M19, ADR-0013): decode a whole track into the
   * channel. Resolves to its duration plus live views of the decoded
   * channels (for the offline BPM pass — no second decode), or null
   * when the body doesn't decode. Replaces any previous track. */
  loadTrack: (wav: ArrayBuffer) => Promise<{
    duration: number
    sampleRate: number
    left: Float32Array
    right: Float32Array
  } | null>
  /** Start (or resume) the track; from the ended state it restarts at
   * the top. False with no track loaded. */
  playTrack: () => boolean
  /** Park the playhead where it is. */
  pauseTrack: () => void
  /** Jump the playhead; whether it was playing is preserved. Exits
   * an active loop (ADR-0015). */
  seekTrack: (seconds: number) => void
  /** Loop region on the source's native loop (M21, ADR-0015):
   * survives pause and rate changes; any seek exits it. Quantise is
   * the caller's job; the boundary refuses regions that can't loop. */
  setTrackLoop: (start: number, end: number) => void
  clearTrackLoop: () => void
  /** Playhead snapshot, or null with no track loaded. The end is an
   * explicit state: silence with the position parked (ADR-0013).
   * `rate` is the base varispeed rate (M20), bends excluded; the
   * position folds through an active loop (M21). */
  getTrackStatus: () => {
    position: number
    duration: number
    playing: boolean
    ended: boolean
    rate: number
    loop: TrackLoop | null
    /** Context time of this snapshot — lets callers convert the
     * track-domain playhead into the shared audio clock (M20). */
    contextTime: number
  } | null
  /** Varispeed (M20, ADR-0014): the playback rate the tempo control
   * set; the transport re-anchors so the playhead stays exact. */
  setTrackRate: (rate: number) => void
  /** Phase nudge: slip the playhead by `seconds` via a stepped rate
   * bend (the platter-drag metaphor) — never a click. Playing only. */
  nudgeTrackPhase: (seconds: number) => void
  /** Static min/max envelope of the loaded track for the overview. */
  getTrackPeaks: (
    buckets: number,
  ) => { min: Float32Array; max: Float32Array } | null
  /** Drop the track — leaving playback mode frees the buffer. */
  unloadTrack: () => void
  /** Post-fader RMS level, 0..~1 (for channel meters). */
  getLevel: () => number
  dispose: () => void
}

/** An output device the native engine can open. `cueCapable` is `channels >= 4`
 * — only a ≥4-channel device (e.g. the FLX4) can carry the headphone cue on
 * channels 3/4 while the master plays out 1/2. */
export type OutputDevice = {
  name: string
  channels: number
  cueCapable: boolean
}

export type StatsHandler = (stats: {
  underruns: number
  bufferedSeconds: number
  playing: boolean
  /** Cumulative frames consumed since the last reset, and the
   * worklet clock at snapshot time — the played-index anchor the
   * beat clock extrapolates from (M20, ADR-0014). */
  playedFrames: number
  contextTime: number
}) => void

export type AudioEngine = {
  /** The shared context clock, or null before the bus exists — the
   * zoom view extrapolates played positions in this domain (M22). */
  getContextTime: () => number | null
  createDeckChannel: (
    deckId: DeckId,
    initial: {
      volume: number
      eq: Record<EqBand, number>
      cue: boolean
      fx: { kind: FxKind | null; amount: number }
      trimDb: number
    },
    onStats: StatsHandler,
  ) => Promise<DeckChannel>
  resume: () => Promise<void>
  setCrossfade: (position: number) => void
  /** Cue/master blend for the headphone feed: 0 = cue only, 1 = master. */
  setCueMix: (position: number) => void
  /** The output devices the engine can open, with their channel counts —
   * a ≥4-channel device can carry the headphone cue on channels 3/4. */
  listOutputDevices: () => Promise<OutputDevice[]>
  /** Switch the engine's output device by name. Rejects (audio left
   * undisturbed) when the device can't be opened. */
  setOutputDevice: (name: string) => Promise<void>
  /** Master-bus RMS level, 0..~1 (what the speakers get). */
  getMasterLevel: () => number
  /** The limiter's current gain reduction in dB (≤ 0); 0 when idle. */
  getMasterGainReduction: () => number
  /** Start capturing the master bus (exactly the speaker feed). */
  startRecording: () => Promise<void>
  /** Stop capturing and return the session as a WAV blob. */
  stopRecording: () => Promise<Blob>
}

/** The wire and graph rate end to end (backend workers generate 48 k). */
export const SAMPLE_RATE = 48_000

/** Centre position; the single source for App state and the bus default. */
export const INITIAL_CROSSFADE = 0.5

/** Even cue/master blend in the phones; same role as INITIAL_CROSSFADE. */
export const INITIAL_CUE_MIX = 0.5
