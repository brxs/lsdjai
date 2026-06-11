import { useCallback, useEffect, useReducer, useRef, useState } from 'react'

import { createBeatGate, createBeatTracker } from '../audio/beat'
import { EQ_FLAT, type EqBand } from '../audio/eq'
import { fxRestPosition, type FxKind } from '../audio/fx'
import {
  DEFAULT_LOOP_SECONDS,
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

export type LoopState = {
  /** Which slots hold a captured loop (the buffers live in the channel). */
  filled: boolean[]
  /** The slot currently replacing the live stream, if any. */
  active: number | null
  /** Capture length for the next press; persisted, unlike the loops. */
  seconds: number
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
  /** Generating but off air (M10): buffer fills, only the cue tap hears
   * it. play() then drops it on air without flushing what was built up. */
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
    filled: Array<boolean>(LOOP_SLOT_COUNT).fill(false),
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
  const [bpm, setBpm] = useState<number | null>(null)
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
    send({ type: 'stop' })
    // Flush instead of letting the buffered seconds play out, so stop is
    // immediate like a DJ expects. The empty channel goes back on air so
    // the next plain play() isn't silent.
    channelRef.current?.reset()
    channelRef.current?.setOnAir(true)
    // STOP silences the deck — a running freeze loop goes with it (the
    // slot keeps its capture), and an in-flight capture may not land.
    loopGestureRef.current += 1
    channelRef.current?.stopLoop()
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
    () => channelRef.current?.captureSample(STYLE_SAMPLE_SECONDS) ?? Promise.resolve(null),
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
      if (current.active === slot) {
        channel.stopLoop()
        setLoop({ ...current, active: null })
        return
      }
      if (current.filled[slot]) {
        if (channel.playLoop(slot)) setLoop({ ...current, active: slot })
        return
      }
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
          filled: latest.filled.map((wasFilled, index) =>
            index === slot ? true : wasFilled,
          ),
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
      const channel = channelRef.current
      const current = loopRef.current
      if (current.active === slot) channel?.stopLoop()
      channel?.clearLoop(slot)
      if (!current.filled[slot]) return
      setLoop({
        ...current,
        filled: current.filled.map((wasFilled, index) =>
          index === slot ? false : wasFilled,
        ),
        active: current.active === slot ? null : current.active,
      })
    },
    [setLoop],
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
    bpm,
    captureStyleSample,
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
