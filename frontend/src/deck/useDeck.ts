import { useCallback, useEffect, useReducer, useRef, useState } from 'react'

import { createBeatGate, createBeatTracker, trackBpm } from '../audio/beat'
import { EQ_FLAT, type EqBand } from '../audio/eq'
import { fxRestPosition, type FxKind } from '../audio/fx'
import {
  DEFAULT_LOOP_SECONDS,
  generatedLoopSeconds,
  LOOP_CROSSFADE_SECONDS,
  LOOP_SLOT_COUNT,
  quantiseLoopSeconds,
} from '../audio/loops'
import { createLoudnessTracker, trimDbFor } from '../audio/master'
import { STYLE_SAMPLE_SECONDS } from '../audio/styleSample'
import { useAudioEngine } from '../audio/engineContext'
import { loadDeckSettings, updateDeckSettings } from '../persistence'
import { SAMPLE_RATE, type DeckChannel, type DeckId } from '../audio/engine'
import {
  deckReducer,
  initialDeckState,
  type ActiveStyle,
  type DeckState,
  type ServerEvent,
} from './deckState'

const RECONNECT_DELAY_MS = 2_000

/** Gain-staging trim (M17): auto follows the source's loudness; a
 * manual knob move takes over until auto is re-engaged. */
export type TrimState = { mode: 'auto' | 'manual'; db: number }

/** One pad slot. The audio buffers live in the channel; `label` is null
 * for captures from the deck and the prompt for generated slots (M18).
 * One-shots overlay the playing source and end themselves; everything
 * else replaces the live stream while active. */
export type LoopSlot =
  | { state: 'empty' }
  | { state: 'pending'; label: string; oneShot: boolean }
  | { state: 'filled'; label: string | null; oneShot: boolean }

export type LoopState = {
  slots: LoopSlot[]
  /** The slot currently replacing the live stream, if any. */
  active: number | null
  /** Capture length for the next press; persisted, unlike the loops. */
  seconds: number
}

export type GenerateEngine = 'sfx' | 'music' | 'magenta'

/** The backend caps prompts at 500 chars; the input stops short of it so
 * the BPM stamp (", NNN BPM") can never push a legal prompt over the cap. */
export const GENERATE_PROMPT_MAX_LENGTH = 500 - ', 999 BPM'.length

/** A deck's source (M19, ADR-0013): the live Magenta stream, or one
 * decoded track. Loading decides the mode — there is no toggle. */
export type DeckMode = 'realtime' | 'playback'

/** The UI's view of the loaded track; the audio itself is session-only
 * in the channel, like every captured artefact. */
export type TrackState = {
  /** Monotonic per load — the collision-proof identity for derived
   * work like the overview envelope (titles can repeat). */
  loadId: number
  title: string
  duration: number
  position: number
  playing: boolean
  ended: boolean
  /** The offline tracker's verdict at load — null is honest (M14). */
  bpm: number | null
}

const EMPTY_SLOT: LoopSlot = { state: 'empty' }

function withSlot(current: LoopState, slot: number, value: LoopSlot): LoopSlot[] {
  return current.slots.map((existing, index) => (index === slot ? value : existing))
}

export type DeckControls = {
  state: DeckState
  volume: number
  eq: Record<EqBand, number>
  /** Headphone cue (PFL) on this channel. Deliberately not persisted:
   * a reload never blasts the phones unexpectedly. */
  cue: boolean
  setCue: (on: boolean) => void
  /** Color FX insert (M12): the selected effect and its knob position. */
  fx: { kind: FxKind | null; amount: number }
  /** Selecting an effect parks the knob at its rest position, so a
   * switch never lands mid-effect. */
  setFx: (kind: FxKind | null) => void
  setFxAmount: (amount: number) => void
  /** Freeze pads (M13, ADR-0009): one press on an empty slot captures
   * the just-played tail and loops it on air; a filled slot swaps in;
   * the active slot returns to live. Loops are session-only. */
  loop: LoopState
  toggleLoopPad: (slot: number) => void
  clearLoopPad: (slot: number) => void
  setLoopSeconds: (seconds: number) => void
  /** Generated pads (M18, ADR-0012): fill the first empty slot from a
   * text prompt. The engine picks the sound world — Stable Audio's
   * sfx/music models, or the booth's own third Magenta engine (a
   * dedicated render worker; first use pays its model load inside the
   * pending state). One-shots overlay, loops replace like captures;
   * music-model loops snap to whole bars while the tempo gate is
   * locked and respect the quality floor. */
  generateToPad: (prompt: string, engine: GenerateEngine, oneShot: boolean) => void
  /** Why the last generation produced nothing, until the next attempt. */
  generateError: string | null
  /** Detected tempo of the deck's stream (M14, ADR-0010), or null
   * while the honesty gate refuses — never a wrong number. */
  bpm: number | null
  /** Style sampling (M15): the just-played tail as wire-format PCM,
   * or null when the deck has not played enough to embed. */
  captureStyleSample: () => Promise<Float32Array<ArrayBuffer> | null>
  /** Per-channel trim (M17): auto-gain toward the loudness target, or
   * a held manual value. */
  trim: TrimState
  setTrimDb: (db: number) => void
  enableAutoTrim: () => void
  /** Playback mode (M19, ADR-0013): trade the live stream for one
   * decoded track. loadTrack and leavePlayback are the only doors —
   * loading decides the mode. */
  mode: DeckMode
  track: TrackState | null
  loadTrack: (wav: ArrayBuffer, title: string) => Promise<boolean>
  leavePlayback: () => void
  /** Jump the track playhead (overview click / FLX4); playback-mode
   * only, a no-op on the live stream. */
  seekTrack: (seconds: number) => void
  /** Relative seek (the jog wheel): reads the channel's live playhead
   * so rapid ticks accumulate instead of racing the 250 ms poll. */
  nudgeTrack: (seconds: number) => void
  /** Static envelope of the loaded track for the overview strip. */
  getTrackPeaks: (
    buckets: number,
  ) => { min: Float32Array; max: Float32Array } | null
  /** Generating but off air (M10): buffer fills, only the cue tap hears
   * it. play() then drops it on air without flushing what was built up.
   * On a playback deck, CUE instead returns the track to the top. */
  primed: boolean
  prime: () => Promise<void>
  play: () => Promise<void>
  stop: () => void
  setStyle: (style: ActiveStyle) => void
  setModel: (model: string) => void
  restartWorker: () => void
  setVolume: (volume: number) => void
  setEqBand: (band: EqBand, value: number) => void
  getChannelLevel: () => number
  getChannelWaveformRange: () => [number, number]
}

/** Owns one deck's WebSocket and its channel on the shared audio engine
 * (worklet ring buffer → deck gain → crossfade bus, see audio/engine.ts). */
export function useDeck(deckId: DeckId): DeckControls {
  const engine = useAudioEngine()
  const [state, dispatch] = useReducer(deckReducer, initialDeckState)
  const [volume, setVolumeState] = useState(() => loadDeckSettings(deckId).volume ?? 0.8)
  const volumeRef = useRef(volume)
  const [eq, setEqState] = useState<Record<EqBand, number>>(
    () =>
      loadDeckSettings(deckId).eq ?? { low: EQ_FLAT, mid: EQ_FLAT, high: EQ_FLAT },
  )
  const eqRef = useRef(eq)
  const [cue, setCueState] = useState(false)
  const cueRef = useRef(cue)
  const [fx, setFxState] = useState<{ kind: FxKind | null; amount: number }>(
    () => loadDeckSettings(deckId).fx ?? { kind: null, amount: 0 },
  )
  const fxRef = useRef(fx)
  const [loop, setLoopState] = useState<LoopState>(() => ({
    slots: Array<LoopSlot>(LOOP_SLOT_COUNT).fill(EMPTY_SLOT),
    active: null,
    seconds: loadDeckSettings(deckId).loopSeconds ?? DEFAULT_LOOP_SECONDS,
  }))
  const loopRef = useRef(loop)
  const setLoop = useCallback((next: LoopState) => {
    setLoopState(next)
    loopRef.current = next
  }, [])
  // Capture is a port round-trip; a STOP or another pad press landing
  // inside that window must win over the stale capture. Every loop
  // gesture bumps this, and the capture callback bails if it moved.
  const loopGestureRef = useRef(0)
  // Generations are slower round-trips with the same race: a clear (or
  // a newer generation) during the flight must win. Per-slot counters,
  // bumped by anything that takes the slot over.
  const slotGenerationRef = useRef<number[]>(Array<number>(LOOP_SLOT_COUNT).fill(0))
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [bpm, setBpm] = useState<number | null>(null)
  const [mode, setModeState] = useState<DeckMode>('realtime')
  const modeRef = useRef(mode)
  const setMode = useCallback((next: DeckMode) => {
    setModeState(next)
    modeRef.current = next
  }, [])
  const [track, setTrack] = useState<TrackState | null>(null)
  const trackLoadRef = useRef(0)
  // Tracker + gate per deck (M14), and the loudness tracker behind
  // auto-gain (M17) — all reset on stream discontinuities so an
  // estimate never spans two unrelated streams (the reset rule the
  // capture history follows too, ADR-0009). The trim VALUE holds
  // across resets; only the measurement starts over.
  const [beat] = useState(() => ({
    tracker: createBeatTracker(SAMPLE_RATE),
    gate: createBeatGate(),
  }))
  const [loudness] = useState(() => createLoudnessTracker(SAMPLE_RATE))
  const resetStreamMeasurements = useCallback(() => {
    beat.tracker.reset()
    beat.gate.reset()
    loudness.reset()
    channelRef.current?.setBeatPeriod(null)
    setBpm(null)
  }, [beat, loudness])
  const [trim, setTrimState] = useState<TrimState>(
    () => loadDeckSettings(deckId).trim ?? { mode: 'auto', db: 0 },
  )
  const trimRef = useRef(trim)
  const applyTrim = useCallback(
    (next: TrimState) => {
      setTrimState(next)
      trimRef.current = next
      updateDeckSettings(deckId, { trim: next })
      channelRef.current?.setTrim(next.db)
    },
    [deckId],
  )
  const [primed, setPrimedState] = useState(false)
  const primedRef = useRef(primed)

  const setPrimed = useCallback((next: boolean) => {
    setPrimedState(next)
    primedRef.current = next
  }, [])

  const socketRef = useRef<WebSocket | null>(null)
  const channelRef = useRef<DeckChannel | null>(null)
  // Memoised in-flight channel build so rapid play() clicks share one
  // channel instead of stacking worklets on the bus.
  const channelPromiseRef = useRef<Promise<DeckChannel> | null>(null)

  const ensureChannel = useCallback(() => {
    if (!channelPromiseRef.current) {
      channelPromiseRef.current = engine
        .createDeckChannel(
          deckId,
          {
            volume: volumeRef.current,
            eq: eqRef.current,
            cue: cueRef.current,
            fx: fxRef.current,
            trimDb: trimRef.current.db,
          },
          (stats) => dispatch({ type: 'worklet_stats', stats }),
        )
        .then((channel) => {
          channelRef.current = channel
          return channel
        })
        .catch((error: unknown) => {
          channelPromiseRef.current = null // allow a retry after failure
          throw error
        })
    }
    return channelPromiseRef.current
  }, [engine, deckId])

  useEffect(() => {
    let disposed = false
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined

    function connect() {
      if (disposed) return
      dispatch({ type: 'socket_connecting' })
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
      const socket = new WebSocket(`${scheme}://${location.host}/ws/deck/${deckId}`)
      socket.binaryType = 'arraybuffer'
      socketRef.current = socket

      socket.onopen = () => dispatch({ type: 'socket_open' })
      socket.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          // A parked deck (playback mode) drops stragglers: a chunk the
          // worker flushed late must not pollute the track's clock.
          if (modeRef.current === 'playback') return
          const samples = new Float32Array(event.data)
          // Beat and loudness tracking read first — postPcm transfers
          // the buffer away. (The feed runs ahead of the speakers by
          // the buffer lead; neither measurement cares, ADR-0010.)
          beat.tracker.push(samples)
          loudness.push(samples)
          channelRef.current?.postPcm(samples)
        } else {
          let parsed: ServerEvent
          try {
            parsed = JSON.parse(event.data) as ServerEvent
          } catch {
            console.warn(`deck ${deckId}: dropping malformed frame`, event.data)
            return
          }
          if (parsed.event === 'model_loading' || parsed.event === 'worker_died') {
            // The stream this buffer came from is gone with the old worker;
            // a crashed deck goes silent rather than draining its tail under
            // the crash banner. The beat tracker forgets it too.
            channelRef.current?.reset()
            resetStreamMeasurements()
          }
          dispatch({ type: 'server_event', event: parsed })
        }
      }
      socket.onclose = () => {
        if (disposed) return
        dispatch({ type: 'socket_closed' })
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS)
      }
    }

    connect()
    return () => {
      disposed = true
      clearTimeout(reconnectTimer)
      socketRef.current?.close()
      channelRef.current?.dispose()
      channelRef.current = null
      channelPromiseRef.current = null
    }
  }, [deckId, beat, loudness, resetStreamMeasurements])

  // One estimate per second through the honesty gate (M14); the state
  // setter is a no-op re-render-wise while the gated value holds. The
  // channel follows so the synced dub echo has its clock. Auto-gain
  // (M17) rides the same tick: a slow glide toward the loudness
  // target, held when the tracker has nothing trustworthy.
  useEffect(() => {
    const timer = setInterval(() => {
      // A playback deck holds its load-time analysis: the stream
      // trackers are empty and a tick would only blank the track's
      // clock (ADR-0013).
      if (modeRef.current === 'playback') return
      const displayed = beat.gate.push(beat.tracker.estimate())
      setBpm(displayed)
      channelRef.current?.setBeatPeriod(
        displayed === null ? null : 60 / displayed,
      )
      if (trimRef.current.mode === 'auto') {
        const db = trimDbFor(loudness.rms())
        if (db !== null && Math.abs(db - trimRef.current.db) > 0.1) {
          applyTrim({ mode: 'auto', db })
        }
      }
    }, 1_000)
    return () => clearInterval(timer)
  }, [beat, loudness, applyTrim])

  const send = useCallback((command: object) => {
    const socket = socketRef.current
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(command))
    }
  }, [])

  const play = useCallback(async () => {
    // A playback deck's PLAY drives the track, not the worker.
    if (modeRef.current === 'playback') {
      try {
        await engine.resume()
      } catch (error) {
        dispatch({
          type: 'local_error',
          error: error instanceof Error ? error.message : String(error),
        })
        return
      }
      channelRef.current?.playTrack()
      return
    }
    // Dropping a primed deck on air: the worker already streams and the
    // buffer holds the prepped audio — unmute, don't flush or replay.
    if (primedRef.current) {
      channelRef.current?.setOnAir(true)
      setPrimed(false)
      return
    }
    try {
      const channel = await ensureChannel()
      await engine.resume()
      // Drop whatever an earlier session left in the ring buffer, so the
      // first thing heard is the new stream, not stale chunks. The beat
      // tracker starts over with the stream.
      channel.reset()
      resetStreamMeasurements()
      channel.setOnAir(true)
    } catch (error) {
      dispatch({
        type: 'local_error',
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }
    send({ type: 'play' })
    dispatch({ type: 'play_requested' })
  }, [ensureChannel, engine, send, setPrimed, resetStreamMeasurements])

  /** Start generating off air: like play(), but muted on the master so
   * the prep is only audible over the cue tap (M10 transport CUE). */
  const prime = useCallback(async () => {
    // Transport CUE on a track deck: return to the top, parked — the
    // deck-prep semantics, adapted (ADR-0013).
    if (modeRef.current === 'playback') {
      channelRef.current?.pauseTrack()
      channelRef.current?.seekTrack(0)
      return
    }
    if (primedRef.current) return
    try {
      const channel = await ensureChannel()
      await engine.resume()
      channel.reset()
      resetStreamMeasurements()
      channel.setOnAir(false)
    } catch (error) {
      dispatch({
        type: 'local_error',
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }
    setPrimed(true)
    send({ type: 'play' })
    dispatch({ type: 'play_requested' })
  }, [ensureChannel, engine, send, setPrimed, resetStreamMeasurements])

  const stop = useCallback(() => {
    // A playback deck's STOP pauses the track; running pads stop with
    // it, exactly as on the live deck.
    if (modeRef.current === 'playback') {
      channelRef.current?.pauseTrack()
      loopGestureRef.current += 1
      channelRef.current?.stopLoop()
      channelRef.current?.stopOneShot()
      if (loopRef.current.active !== null) {
        setLoop({ ...loopRef.current, active: null })
      }
      return
    }
    send({ type: 'stop' })
    // Flush instead of letting the buffered seconds play out, so stop is
    // immediate like a DJ expects. The empty channel goes back on air so
    // the next plain play() isn't silent.
    channelRef.current?.reset()
    channelRef.current?.setOnAir(true)
    // STOP silences the deck — a running freeze loop goes with it (the
    // slot keeps its capture), a ringing one-shot is cut, and an
    // in-flight capture may not land.
    loopGestureRef.current += 1
    channelRef.current?.stopLoop()
    channelRef.current?.stopOneShot()
    if (loopRef.current.active !== null) {
      setLoop({ ...loopRef.current, active: null })
    }
    resetStreamMeasurements()
    setPrimed(false)
    dispatch({ type: 'stop_requested' })
  }, [send, setPrimed, setLoop, resetStreamMeasurements])

  const setStyle = useCallback(
    (style: ActiveStyle) => {
      send({ type: 'set_style', prompts: style.prompts })
    },
    [send],
  )

  const loadTrack = useCallback(
    async (wav: ArrayBuffer, title: string) => {
      let channel: DeckChannel
      try {
        channel = await ensureChannel()
        await engine.resume()
      } catch (error) {
        dispatch({
          type: 'local_error',
          error: error instanceof Error ? error.message : String(error),
        })
        return false
      }
      // A rolling deck keeps rolling across a load: read it before the
      // load replaces the channel's track and STOP parks the source.
      // "Rolling" means ON AIR — a primed deck is audible only in the
      // phones, so its track loads parked rather than blasting the
      // master (the deck-prep semantics, ADR-0013).
      const wasPlaying =
        modeRef.current === 'playback'
          ? (channel.getTrackStatus()?.playing ?? false)
          : state.playing && !primedRef.current
      const decoded = await channel.loadTrack(wav)
      if (!decoded) return false
      // Park whatever was running — the live stream's worker idles
      // warm, a previous track pauses — exactly like STOP (ADR-0013).
      stop()
      // The decoded buffer clears the same honesty bar as the stream,
      // offline; the synced echo takes its clock from the verdict.
      const trackTempo = trackBpm(decoded.left, decoded.right, decoded.sampleRate)
      channel.setBeatPeriod(trackTempo === null ? null : 60 / trackTempo)
      setMode('playback')
      if (wasPlaying) channel.playTrack()
      setTrack({
        loadId: ++trackLoadRef.current,
        title,
        duration: decoded.duration,
        position: 0,
        playing: wasPlaying,
        ended: false,
        bpm: trackTempo,
      })
      return true
    },
    [ensureChannel, engine, stop, setMode, state.playing],
  )

  const leavePlayback = useCallback(() => {
    if (modeRef.current !== 'playback') return
    // A rolling track hands straight back to the stream; a parked one
    // leaves the deck stopped, like a track load in reverse.
    const wasPlaying = channelRef.current?.getTrackStatus()?.playing ?? false
    channelRef.current?.unloadTrack()
    setMode('realtime')
    setTrack(null)
    // The stream's measurements start over either way.
    resetStreamMeasurements()
    if (wasPlaying) void play()
  }, [setMode, resetStreamMeasurements, play])

  const getTrackPeaks = useCallback(
    (buckets: number) => channelRef.current?.getTrackPeaks(buckets) ?? null,
    [],
  )

  const seekTrack = useCallback((seconds: number) => {
    if (modeRef.current !== 'playback') return
    channelRef.current?.seekTrack(seconds)
    const status = channelRef.current?.getTrackStatus()
    if (!status) return
    setTrack(
      (current) =>
        current && {
          ...current,
          position: status.position,
          playing: status.playing,
          ended: status.ended,
        },
    )
  }, [])

  const nudgeTrack = useCallback(
    (seconds: number) => {
      const status = channelRef.current?.getTrackStatus()
      if (!status) return
      seekTrack(status.position + seconds)
    },
    [seekTrack],
  )

  // The playhead readout follows the channel while a track is loaded —
  // the graph is the source of truth (the LevelMeter pattern).
  useEffect(() => {
    if (mode !== 'playback') return
    const timer = setInterval(() => {
      const status = channelRef.current?.getTrackStatus()
      if (!status) return
      setTrack(
        (current) =>
          current && {
            ...current,
            position: status.position,
            playing: status.playing,
            ended: status.ended,
          },
      )
    }, 250)
    return () => clearInterval(timer)
  }, [mode])

  const setModel = useCallback(
    (model: string) => {
      send({ type: 'set_model', model })
    },
    [send],
  )

  const restartWorker = useCallback(() => {
    send({ type: 'restart' })
  }, [send])

  const setVolume = useCallback(
    (next: number) => {
      setVolumeState(next)
      volumeRef.current = next
      channelRef.current?.setVolume(next)
      updateDeckSettings(deckId, { volume: next })
    },
    [deckId],
  )

  const getChannelLevel = useCallback(
    () => channelRef.current?.getLevel() ?? 0,
    [],
  )

  const getChannelWaveformRange = useCallback(
    (): [number, number] => channelRef.current?.getWaveformRange() ?? [0, 0],
    [],
  )

  const captureStyleSample = useCallback(
    () =>
      // The worklet history holds the dead stream in playback mode;
      // sampling a track will slice the buffer instead — deferred past
      // M19 (ADR-0013).
      modeRef.current === 'playback'
        ? Promise.resolve(null)
        : (channelRef.current?.captureSample(STYLE_SAMPLE_SECONDS) ??
          Promise.resolve(null)),
    [],
  )

  const setTrimDb = useCallback(
    (db: number) => applyTrim({ mode: 'manual', db }),
    [applyTrim],
  )

  const enableAutoTrim = useCallback(() => {
    // Snap to the tracker's current opinion when it has one; the next
    // tick keeps following either way.
    const db = trimDbFor(loudness.rms())
    applyTrim({ mode: 'auto', db: db ?? trimRef.current.db })
  }, [applyTrim, loudness])

  const setCue = useCallback((on: boolean) => {
    setCueState(on)
    cueRef.current = on
    channelRef.current?.setCue(on)
  }, [])

  const setFx = useCallback(
    (kind: FxKind | null) => {
      const next = { kind, amount: kind ? fxRestPosition(kind) : 0 }
      setFxState(next)
      fxRef.current = next
      updateDeckSettings(deckId, { fx: next })
      channelRef.current?.setFx(kind)
      channelRef.current?.setFxAmount(next.amount)
    },
    [deckId],
  )

  const setFxAmount = useCallback(
    (amount: number) => {
      const next = { ...fxRef.current, amount }
      setFxState(next)
      fxRef.current = next
      updateDeckSettings(deckId, { fx: next })
      channelRef.current?.setFxAmount(amount)
    },
    [deckId],
  )

  const toggleLoopPad = useCallback(
    (slot: number) => {
      const channel = channelRef.current
      if (!channel || slot < 0 || slot >= LOOP_SLOT_COUNT) return
      const gesture = ++loopGestureRef.current
      const current = loopRef.current
      const slotState = current.slots[slot]
      // A pending generation owns the slot; the press waits it out.
      if (slotState.state === 'pending') return
      if (current.active === slot) {
        channel.stopLoop()
        setLoop({ ...current, active: null })
        return
      }
      if (slotState.state === 'filled') {
        if (!channel.playLoop(slot)) return
        // One-shots overlay and end themselves — never "active", which
        // means "replacing the live stream".
        if (!slotState.oneShot) setLoop({ ...current, active: slot })
        return
      }
      // In playback mode the worklet's history holds the dead stream —
      // a capture would loop garbage. Buffer slicing is deferred past
      // M19; until then an empty pad refuses the press (ADR-0013).
      if (modeRef.current === 'playback') return
      // One gesture: capture the just-played tail AND freeze onto it.
      // The press is refused (no state change) when too little has
      // played to loop (ADR-0009). A gated tempo snaps the length to
      // whole beats (M14).
      const gatedBpm = beat.gate.current()
      const seconds =
        gatedBpm === null
          ? current.seconds
          : quantiseLoopSeconds(current.seconds, gatedBpm)
      void channel.captureLoop(slot, seconds).then((captured) => {
        if (!captured || channelRef.current !== channel) return
        if (loopGestureRef.current !== gesture) {
          // Overtaken by STOP or a newer press: drop the buffer too, so
          // the engine's slot state matches the UI's "empty".
          channel.clearLoop(slot)
          return
        }
        if (!channel.playLoop(slot)) return
        const latest = loopRef.current
        setLoop({
          ...latest,
          slots: withSlot(latest, slot, {
            state: 'filled',
            label: null,
            oneShot: false,
          }),
          active: slot,
        })
      })
    },
    [setLoop, beat],
  )

  const clearLoopPad = useCallback(
    (slot: number) => {
      if (slot < 0 || slot >= LOOP_SLOT_COUNT) return
      loopGestureRef.current += 1
      slotGenerationRef.current[slot] += 1
      const channel = channelRef.current
      const current = loopRef.current
      if (current.active === slot) channel?.stopLoop()
      channel?.clearLoop(slot)
      if (current.slots[slot].state === 'empty') return
      setLoop({
        ...current,
        slots: withSlot(current, slot, EMPTY_SLOT),
        active: current.active === slot ? null : current.active,
      })
    },
    [setLoop],
  )

  const generateToPad = useCallback(
    (prompt: string, engine: GenerateEngine, oneShot: boolean) => {
      const trimmed = prompt.trim()
      if (!trimmed) return
      const current = loopRef.current
      const slot = current.slots.findIndex((entry) => entry.state === 'empty')
      if (slot === -1) return
      // A locked tempo (M14) shapes a MUSIC-model loop on both axes:
      // whole bars and the figure in the prompt, plus the measured
      // quality floor (more bars beat broken audio). Other engines
      // take the picker's length as asked — the floor is an sm-music
      // fact, and Magenta ignores tempo text by design (ADR-0004).
      const gatedBpm = !oneShot && engine === 'music' ? beat.gate.current() : null
      const seconds =
        !oneShot && engine === 'music'
          ? generatedLoopSeconds(current.seconds, gatedBpm)
          : current.seconds
      const requestPrompt =
        gatedBpm === null ? trimmed : `${trimmed}, ${Math.round(gatedBpm)} BPM`
      // Loops carry the seam surplus the engine folds away (the capture
      // convention), so the musical length survives the splice.
      const requestSeconds = oneShot ? seconds : seconds + LOOP_CROSSFADE_SECONDS
      const generation = ++slotGenerationRef.current[slot]
      setGenerateError(null)
      setLoop({
        ...current,
        slots: withSlot(current, slot, {
          state: 'pending',
          label: trimmed,
          oneShot,
        }),
      })
      const stale = () => slotGenerationRef.current[slot] !== generation
      void (async () => {
        try {
          // The channel is created on demand: pads can fill before the
          // deck has ever played (prepping weapons before the set).
          const [channel, response] = await Promise.all([
            ensureChannel(),
            fetch(
              engine === 'magenta' ? '/api/render' : '/api/generate',
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(
                  engine === 'magenta'
                    ? { prompt: requestPrompt, seconds: requestSeconds }
                    : {
                        prompt: requestPrompt,
                        seconds: requestSeconds,
                        kind: engine,
                      },
                ),
              },
            ),
          ])
          if (!response.ok) {
            // The backend's detail names the problem (502/503 carry the
            // CLI tail or the setup hint).
            const detail = await response
              .json()
              .then((body: { detail?: string }) => body.detail)
              .catch(() => null)
            throw new Error(detail || `generation failed (${response.status})`)
          }
          const wav = await response.arrayBuffer()
          if (stale()) return
          if (!(await channel.loadGeneratedLoop(slot, wav, oneShot))) {
            throw new Error('generated audio could not be decoded')
          }
          // A clear landing mid-decode wins: the slot stays empty in the
          // UI and the channel's orphaned buffer waits for the next
          // capture to overwrite it.
          if (stale()) return
          const latest = loopRef.current
          setLoop({
            ...latest,
            slots: withSlot(latest, slot, {
              state: 'filled',
              label: trimmed,
              oneShot,
            }),
          })
        } catch (error) {
          if (stale()) return
          const latest = loopRef.current
          setLoop({ ...latest, slots: withSlot(latest, slot, EMPTY_SLOT) })
          setGenerateError(error instanceof Error ? error.message : String(error))
        }
      })()
    },
    [setLoop, beat, ensureChannel],
  )

  const setLoopSeconds = useCallback(
    (seconds: number) => {
      setLoop({ ...loopRef.current, seconds })
      updateDeckSettings(deckId, { loopSeconds: seconds })
    },
    [deckId, setLoop],
  )

  const setEqBand = useCallback(
    (band: EqBand, value: number) => {
      const next = { ...eqRef.current, [band]: value }
      eqRef.current = next
      setEqState(next)
      updateDeckSettings(deckId, { eq: next })
      channelRef.current?.setEq(band, value)
    },
    [deckId],
  )

  return {
    state,
    volume,
    eq,
    cue,
    setCue,
    fx,
    setFx,
    setFxAmount,
    loop,
    toggleLoopPad,
    clearLoopPad,
    setLoopSeconds,
    generateToPad,
    generateError,
    bpm,
    captureStyleSample,
    mode,
    track,
    loadTrack,
    leavePlayback,
    seekTrack,
    nudgeTrack,
    getTrackPeaks,
    trim,
    setTrimDb,
    enableAutoTrim,
    primed,
    prime,
    play,
    stop,
    setStyle,
    setModel,
    restartWorker,
    setVolume,
    setEqBand,
    getChannelLevel,
    getChannelWaveformRange,
  }
}
