import { useCallback, useEffect, useReducer, useRef, useState } from 'react'

import { useAudioEngine } from '../audio/engineContext'
import type { DeckChannel, DeckId } from '../audio/engine'
import {
  deckReducer,
  initialDeckState,
  type DeckState,
  type ServerEvent,
} from './deckState'

const RECONNECT_DELAY_MS = 2_000

export type DeckControls = {
  state: DeckState
  volume: number
  play: () => Promise<void>
  stop: () => void
  setPrompt: (prompt: string) => void
  setModel: (model: string) => void
  restartWorker: () => void
  setVolume: (volume: number) => void
}

/** Owns one deck's WebSocket and its channel on the shared audio engine
 * (worklet ring buffer → deck gain → crossfade bus, see audio/engine.ts). */
export function useDeck(deckId: DeckId): DeckControls {
  const engine = useAudioEngine()
  const [state, dispatch] = useReducer(deckReducer, initialDeckState)
  const [volume, setVolumeState] = useState(0.8)
  const volumeRef = useRef(volume)

  const socketRef = useRef<WebSocket | null>(null)
  const channelRef = useRef<DeckChannel | null>(null)
  // Memoised in-flight channel build so rapid play() clicks share one
  // channel instead of stacking worklets on the bus.
  const channelPromiseRef = useRef<Promise<DeckChannel> | null>(null)

  const ensureChannel = useCallback(() => {
    if (!channelPromiseRef.current) {
      channelPromiseRef.current = engine
        .createDeckChannel(deckId, volumeRef.current, (stats) =>
          dispatch({ type: 'worklet_stats', stats }),
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
          channelRef.current?.postPcm(new Float32Array(event.data))
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
            // the crash banner.
            channelRef.current?.reset()
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
  }, [deckId])

  const send = useCallback((command: object) => {
    const socket = socketRef.current
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(command))
    }
  }, [])

  const play = useCallback(async () => {
    try {
      const channel = await ensureChannel()
      await engine.resume()
      // Drop whatever an earlier session left in the ring buffer, so the
      // first thing heard is the new stream, not stale chunks.
      channel.reset()
    } catch (error) {
      dispatch({
        type: 'local_error',
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }
    send({ type: 'play' })
    dispatch({ type: 'play_requested' })
  }, [ensureChannel, engine, send])

  const stop = useCallback(() => {
    send({ type: 'stop' })
    // Flush instead of letting the buffered seconds play out, so stop is
    // immediate like a DJ expects.
    channelRef.current?.reset()
    dispatch({ type: 'stop_requested' })
  }, [send])

  const setPrompt = useCallback(
    (prompt: string) => {
      send({ type: 'set_prompt', prompt })
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

  const setVolume = useCallback((next: number) => {
    setVolumeState(next)
    volumeRef.current = next
    channelRef.current?.setVolume(next)
  }, [])

  return {
    state,
    volume,
    play,
    stop,
    setPrompt,
    setModel,
    restartWorker,
    setVolume,
  }
}
