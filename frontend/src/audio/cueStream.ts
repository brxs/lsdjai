/** Browser side of the backend cue sink (ADR-0007): capture the blended
 * headphone feed and stream it up /ws/cue so the backend can play it on
 * a device's phones pair — the channels Web Audio cannot reach. */

import type { AudioEngine } from './engine'

export type CueJackOutput = { name: string }

/** Phones-capable backend outputs for the picker. Resolves to [] when
 * the endpoint is unreachable so the browser-sink options keep working
 * without the backend. */
export async function listCueJackOutputs(): Promise<CueJackOutput[]> {
  try {
    const response = await fetch('/api/cue/outputs')
    if (!response.ok) return []
    const parsed: unknown = await response.json()
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (entry): entry is { name: string } =>
          typeof (entry as { name?: unknown } | null)?.name === 'string',
      )
      .map(({ name }) => ({ name }))
  } catch {
    return []
  }
}

/** Open the cue stream to `deviceName`. Resolves with a stop function
 * once the backend signals `ready` and capture is running; rejects when
 * the backend refuses (unknown device, busy sink) or capture cannot
 * start. The socket *opening* is not acceptance — the backend accepts
 * every handshake so its refusal reason survives to the close frame. */
export function startCueStream(
  engine: AudioEngine,
  deviceName: string,
): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
    const socket = new WebSocket(
      `${scheme}://${location.host}/ws/cue?device=${encodeURIComponent(deviceName)}`,
    )
    socket.binaryType = 'arraybuffer'
    let ready = false

    function stop() {
      engine.stopCueCapture()
      socket.onclose = null
      socket.close()
    }

    socket.onmessage = (event) => {
      if (ready || typeof event.data !== 'string') return
      let parsed: unknown
      try {
        parsed = JSON.parse(event.data)
      } catch {
        return
      }
      if ((parsed as { event?: unknown }).event !== 'ready') return
      ready = true
      engine
        .startCueCapture((samples) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(samples)
        })
        .then(
          () => resolve(stop),
          (cause: unknown) => {
            socket.close()
            reject(cause instanceof Error ? cause : new Error(String(cause)))
          },
        )
    }
    socket.onclose = (event) => {
      if (ready) {
        // The backend went away mid-stream; stop feeding a dead socket.
        engine.stopCueCapture()
      } else {
        reject(new Error(event.reason || 'cue stream refused'))
      }
    }
  })
}
