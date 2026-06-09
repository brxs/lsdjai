/** Pure deck state: every WebSocket and worklet event funnels through this
 * reducer, so the UI is a function of one state object and the stream's
 * health (buffer level, underruns) is always visible, never inferred. */

export type ServerEvent =
  | {
      event: 'hello'
      deck: string
      model: string
      sample_rate: number
      channels: number
      chunk_seconds: number
      models: string[]
      restarting: boolean
      total_ram_gb: number
      model_ram_estimate_gb: Record<string, number>
    }
  | { event: 'ready'; deck: string; model: string }
  | { event: 'chunk'; index: number; rtf: number | null; prompt: string | null }
  | { event: 'prompt_applied'; prompt: string; effective_from_chunk: number }
  | { event: 'model_loading'; model: string }
  | { event: 'worker_died'; model: string }
  | { event: 'error'; error: string }

export type WorkletStats = {
  underruns: number
  bufferedSeconds: number
  playing: boolean
}

export type RamInfo = {
  totalGb: number
  estimateGbByModel: Record<string, number>
}

export type DeckAction =
  | { type: 'socket_connecting' }
  | { type: 'socket_open' }
  | { type: 'socket_closed' }
  | { type: 'server_event'; event: ServerEvent }
  | { type: 'worklet_stats'; stats: WorkletStats }
  | { type: 'play_requested' }
  | { type: 'stop_requested' }
  | { type: 'local_error'; error: string }

export type DeckState = {
  connection: 'connecting' | 'open' | 'closed'
  model: string | null
  availableModels: string[]
  ramInfo: RamInfo | null
  /** A model switch (worker restart) is in flight. */
  switchingModel: boolean
  /** The worker process died; the deck offers a restart. */
  workerDied: boolean
  /** The user pressed play and the worker is expected to stream. */
  playing: boolean
  /** The worklet is actually emitting sound (false while prebuffering). */
  audible: boolean
  activePrompt: string | null
  bufferedSeconds: number
  underruns: number
  generationSpeed: number | null
  error: string | null
}

export const initialDeckState: DeckState = {
  connection: 'connecting',
  model: null,
  availableModels: [],
  ramInfo: null,
  switchingModel: false,
  workerDied: false,
  playing: false,
  audible: false,
  activePrompt: null,
  bufferedSeconds: 0,
  underruns: 0,
  generationSpeed: null,
  error: null,
}

export function deckReducer(state: DeckState, action: DeckAction): DeckState {
  switch (action.type) {
    case 'socket_connecting':
      return { ...state, connection: 'connecting' }
    case 'socket_open':
      return { ...state, connection: 'open', error: null }
    case 'socket_closed':
      return { ...state, connection: 'closed', playing: false, audible: false }
    case 'play_requested':
      return { ...state, playing: true }
    case 'stop_requested':
      return { ...state, playing: false }
    case 'local_error':
      return { ...state, error: action.error }
    case 'worklet_stats':
      return {
        ...state,
        bufferedSeconds: action.stats.bufferedSeconds,
        underruns: action.stats.underruns,
        audible: action.stats.playing,
      }
    case 'server_event':
      return applyServerEvent(state, action.event)
  }
}

function applyServerEvent(state: DeckState, event: ServerEvent): DeckState {
  switch (event.event) {
    case 'hello':
      // hello is authoritative for the switch flag: a reconnect can land
      // after a switch finished (its ready event drained with the old
      // session), and the stale flag would otherwise lock the deck forever.
      return {
        ...state,
        model: event.model,
        availableModels: event.models,
        switchingModel: event.restarting,
        ramInfo: {
          totalGb: event.total_ram_gb,
          estimateGbByModel: event.model_ram_estimate_gb,
        },
      }
    case 'ready':
      // A fresh worker finished loading — after startup, a model switch, or
      // a crash restart. It has no prompt and is not streaming.
      return {
        ...state,
        model: event.model,
        switchingModel: false,
        workerDied: false,
        error: null,
      }
    case 'model_loading':
      // The old worker (and its stream and prompt) is gone. Adopting the
      // target model now lets the RAM warning lead the load instead of
      // trailing it.
      return {
        ...state,
        model: event.model,
        switchingModel: true,
        workerDied: false,
        playing: false,
        activePrompt: null,
        generationSpeed: null,
      }
    case 'worker_died':
      return { ...state, workerDied: true, playing: false }
    case 'chunk':
      return { ...state, generationSpeed: event.rtf }
    case 'prompt_applied':
      return { ...state, activePrompt: event.prompt, error: null }
    case 'error':
      return { ...state, error: event.error }
    default:
      return state
  }
}
