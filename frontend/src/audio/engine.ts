/** Shared audio graph (ADR-0003): one AudioContext for the whole app.
 *
 *   deck worklet → EQ → deck volume gain → crossfade gain ─┐
 *   deck worklet → EQ → deck volume gain → crossfade gain ─┴→ master → speakers
 *                   └→ cue toggle ─┐
 *                   └→ cue toggle ─┴→ cue bus ─┐ (blend) → cue out → phones
 *                                     master ──┘
 *
 * The crossfader lives here, not in a deck: it blends the two decks with
 * equal-power gains so the perceived loudness stays constant across the
 * sweep. The cue path (ADR-0006) taps each deck post-EQ, pre-fader, blends
 * with the master per the cue-mix position, and leaves through a SECOND
 * sink — an audio element pinned to the chosen headphone device — because
 * Chromium caps a context's output at stereo. The graph is created lazily:
 * normally on the first play(), or at load when a persisted cue route
 * restores — either way the context stays suspended (silent) until a user
 * gesture resumes it, per the browser autoplay policy.
 */

import { EQ_BANDS, EQ_FILTERS, eqValueToDb, type EqBand } from './eq'
import { fxBlend, isFxActive, type FxKind } from './fx'
import { buildFxGraph, type FxGraph } from './fxGraphs'
import { rangeFromBytes, rmsFromBytes } from './levels'
import {
  buildLoopChannel,
  LOOP_CROSSFADE_SECONDS,
  LOOP_SLOT_COUNT,
  MIN_LOOP_SECONDS,
} from './loops'
import {
  clipGuardCurve,
  dbToGain,
  LIMITER_ATTACK_SECONDS,
  LIMITER_KNEE_DB,
  LIMITER_MAKEUP_DB,
  LIMITER_RATIO,
  LIMITER_RELEASE_SECONDS,
  LIMITER_THRESHOLD_DB,
} from './master'
import { interleaveChannels, MIN_STYLE_SAMPLE_SECONDS } from './styleSample'
import { encodeWav, floatToInt16 } from './wav'

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
  /** Post-fader RMS level, 0..~1 (for channel meters). */
  getLevel: () => number
  /** Min/max of the latest audio window, -1..1 (for waveform strips). */
  getWaveformRange: () => [number, number]
  dispose: () => void
}

export type StatsHandler = (stats: {
  underruns: number
  bufferedSeconds: number
  playing: boolean
}) => void

export type AudioEngine = {
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
  /** Route the cue feed to an output device; null switches it off. */
  setCueDevice: (deviceId: string | null) => Promise<void>
  /** Tap the blended headphone feed as interleaved stereo float32
   * batches — the backend cue sink's wire format (ADR-0007). Starting a
   * new capture replaces a running one. */
  startCueCapture: (
    onChunk: (samples: Float32Array<ArrayBuffer>) => void,
  ) => Promise<void>
  stopCueCapture: () => void
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
const PARAM_RAMP_SECONDS = 0.02
const FLUSH_TIMEOUT_MS = 2_000

/** setTargetAtTime converges but never lands; for params whose targets
 * must hold exactly (the FX bypass pair, ADR-0008), a scheduled set
 * finishes the ramp once it is inaudibly close (e⁻⁶ ≈ 0.25% off). */
const SNAP_AFTER_SECONDS = PARAM_RAMP_SECONDS * 6

function snapRamp(param: AudioParam, target: number, time: number) {
  param.cancelAndHoldAtTime(time)
  param.setTargetAtTime(target, time, PARAM_RAMP_SECONDS)
  param.setValueAtTime(target, time + SNAP_AFTER_SECONDS)
}

/** A channel of a decoded buffer; a mono decode serves both sides. */
function channelData(buffer: AudioBuffer, channel: number): Float32Array {
  return buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1))
}

/** Centre position; the single source for App state and the bus default. */
export const INITIAL_CROSSFADE = 0.5

/** Even cue/master blend in the phones; same role as INITIAL_CROSSFADE. */
export const INITIAL_CUE_MIX = 0.5

/** Equal-power crossfade gains for a position in [0, 1] (0 = full A). */
export function equalPowerGains(position: number): { a: number; b: number } {
  const clamped = Math.min(1, Math.max(0, position))
  return {
    a: Math.cos((clamped * Math.PI) / 2),
    b: Math.sin((clamped * Math.PI) / 2),
  }
}

type Bus = {
  context: AudioContext
  master: GainNode
  /** Post-limiter (M17): what the speakers, the recorder, and the
   * phones' master blend actually receive. */
  limited: WaveShaperNode
  masterAnalyser: AnalyserNode
  crossfade: Record<DeckId, GainNode>
  cueBus: GainNode
  cueLevel: GainNode
  cueMonitor: GainNode
  cueFeed: GainNode
  cueOut: MediaStreamAudioDestinationNode
}

const ANALYSER_FFT_SIZE = 2048

function rmsLevel(analyser: AnalyserNode, buffer: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(buffer)
  return rmsFromBytes(buffer)
}

type Recorder = {
  node: AudioWorkletNode
  chunks: Int16Array<ArrayBuffer>[]
}

export function createAudioEngine(): AudioEngine {
  let busPromise: Promise<Bus> | null = null
  let crossfadePosition = INITIAL_CROSSFADE
  let cueMixPosition = INITIAL_CUE_MIX
  // The cue feed's second sink (ADR-0006): an audio element carrying the
  // cue-out stream to the chosen headphone device.
  let cueElement: HTMLAudioElement | null = null
  let cueDeviceId: string | null = null
  let cueCapture: AudioWorkletNode | null = null
  let recorder: Recorder | null = null
  // Mirrors bus.masterAnalyser: getMasterLevel must be synchronous (meters
  // poll it every frame) while the bus itself sits behind a promise.
  let masterAnalyserRef: AnalyserNode | null = null
  let limiterRef: DynamicsCompressorNode | null = null
  let masterBuffer: Uint8Array<ArrayBuffer> | null = null

  async function buildBus(): Promise<Bus> {
    const context = new AudioContext({ sampleRate: SAMPLE_RATE })
    try {
      await context.audioWorklet.addModule('/player-worklet.js')
      const master = context.createGain()
      // Master housekeeping (M17): compressor-as-limiter for the
      // musical work, clip guard for the hard ceiling. Everything
      // downstream — speakers, meter, recorder, the phones' master
      // blend — hears the limited signal: the WAV is what was heard.
      const limiter = context.createDynamicsCompressor()
      limiter.threshold.value = LIMITER_THRESHOLD_DB
      limiter.knee.value = LIMITER_KNEE_DB
      limiter.ratio.value = LIMITER_RATIO
      limiter.attack.value = LIMITER_ATTACK_SECONDS
      limiter.release.value = LIMITER_RELEASE_SECONDS
      // Cancel the compressor's spec-mandated implicit makeup gain
      // (see LIMITER_MAKEUP_DB) so the limiter is level-transparent
      // until it works; the clip guard sees the compensated signal,
      // keeping the ceiling guarantee intact.
      const makeupCompensation = context.createGain()
      makeupCompensation.gain.value = dbToGain(-LIMITER_MAKEUP_DB)
      const limited = context.createWaveShaper()
      limited.curve = clipGuardCurve()
      master.connect(limiter)
      limiter.connect(makeupCompensation)
      makeupCompensation.connect(limited)
      limited.connect(context.destination)
      limiterRef = limiter
      const masterAnalyser = context.createAnalyser()
      masterAnalyser.fftSize = ANALYSER_FFT_SIZE
      limited.connect(masterAnalyser)
      masterAnalyserRef = masterAnalyser
      masterBuffer = new Uint8Array(masterAnalyser.fftSize)
      const gains = equalPowerGains(crossfadePosition)
      const crossfade = { a: context.createGain(), b: context.createGain() }
      crossfade.a.gain.value = gains.a
      crossfade.b.gain.value = gains.b
      crossfade.a.connect(master)
      crossfade.b.connect(master)
      // Headphone feed (ADR-0006): cue taps sum into cueBus; the blend
      // pair reuses the equal-power law (a = cue, b = master). cueFeed is
      // the summed result — what the phones hear — so the browser sink
      // and the backend cue capture (ADR-0007) share one tap point.
      const cueGains = equalPowerGains(cueMixPosition)
      const cueBus = context.createGain()
      const cueLevel = context.createGain()
      cueLevel.gain.value = cueGains.a
      const cueMonitor = context.createGain()
      cueMonitor.gain.value = cueGains.b
      const cueFeed = context.createGain()
      const cueOut = context.createMediaStreamDestination()
      cueBus.connect(cueLevel)
      cueLevel.connect(cueFeed)
      limited.connect(cueMonitor)
      cueMonitor.connect(cueFeed)
      cueFeed.connect(cueOut)
      return {
        context,
        master,
        limited,
        masterAnalyser,
        crossfade,
        cueBus,
        cueLevel,
        cueMonitor,
        cueFeed,
        cueOut,
      }
    } catch (error) {
      void context.close()
      throw error
    }
  }

  function stopCueCapture() {
    const node = cueCapture
    if (!node) return
    cueCapture = null
    node.port.postMessage({ type: 'stop' })
    node.port.onmessage = null
    void busPromise?.then((bus) => bus.cueFeed.disconnect(node)).catch(() => {})
  }

  function ensureBus(): Promise<Bus> {
    if (!busPromise) {
      busPromise = buildBus().catch((error: unknown) => {
        busPromise = null // allow a retry after failure
        throw error
      })
    }
    return busPromise
  }

  return {
    async createDeckChannel(deckId, initial, onStats) {
      const bus = await ensureBus()
      const worklet = new AudioWorkletNode(bus.context, 'pcm-player', {
        numberOfOutputs: 1,
        outputChannelCount: [2],
      })
      // worklet → live gain → trim → low → mid → high → volume →
      // on-air → crossfade (M6/M10/M17), with the cue tap branching
      // off post-EQ, pre-fader (M9), and the freeze-pad loop source
      // (M13) summing into the trim next to the live gain — the loop
      // replaces the source, so everything downstream stays live on it.
      const eqNodes = Object.fromEntries(
        EQ_BANDS.map((band) => {
          const layout = EQ_FILTERS[band]
          const filter = bus.context.createBiquadFilter()
          filter.type = layout.type
          filter.frequency.value = layout.frequency
          if (layout.q !== undefined) filter.Q.value = layout.q
          filter.gain.value = eqValueToDb(initial.eq[band])
          return [band, filter]
        }),
      ) as Record<EqBand, BiquadFilterNode>
      const liveGain = bus.context.createGain()
      const loopGain = bus.context.createGain()
      loopGain.gain.value = 0
      worklet.connect(liveGain)
      // Trim (M17) is the summing head: live stream and freeze loops
      // alike pass through it, pre-EQ — gain staging compensates the
      // SOURCE, kills and effects stay the performer's moves.
      const trim = bus.context.createGain()
      trim.gain.value = dbToGain(initial.trimDb)
      liveGain.connect(trim)
      loopGain.connect(trim)
      let head: AudioNode = trim
      for (const band of EQ_BANDS) {
        head.connect(eqNodes[band])
        head = eqNodes[band]
      }
      // Color FX insert (M12, ADR-0008): a parallel pair — unity dry
      // branch and the active effect's graph — summed into `post`, the
      // point both the cue tap and the fader read, so the phones preview
      // effects. Inside the effect's dead zone the wet gain is exactly 0
      // and the dry exactly 1: bit-transparent bypass.
      const fxDry = bus.context.createGain()
      const fxSend = bus.context.createGain()
      const fxWet = bus.context.createGain()
      fxWet.gain.value = 0
      const post = bus.context.createGain()
      head.connect(fxDry)
      fxDry.connect(post)
      head.connect(fxSend)
      fxWet.connect(post)
      let fxKind: FxKind | null = null
      let fxAmount = 0
      let fxGraph: FxGraph | null = null
      let beatPeriod: number | null = null
      function applyFx() {
        const time = bus.context.currentTime
        const kind = fxKind
        if (kind === null || !isFxActive(kind, fxAmount)) {
          snapRamp(fxDry.gain, 1, time)
          snapRamp(fxWet.gain, 0, time)
        } else {
          snapRamp(fxDry.gain, fxBlend(kind) === 'add' ? 1 : 0, time)
          snapRamp(fxWet.gain, 1, time)
        }
        fxGraph?.apply(fxAmount, time, beatPeriod)
      }
      function swapFx(kind: FxKind | null) {
        if (kind === fxKind) return
        if (fxGraph) {
          fxSend.disconnect()
          fxGraph.dispose()
          fxGraph = null
        }
        fxKind = kind
        if (kind) {
          fxGraph = buildFxGraph(bus.context, kind)
          fxSend.connect(fxGraph.input)
          fxGraph.output.connect(fxWet)
        }
        applyFx()
      }
      fxAmount = initial.fx.amount
      swapFx(initial.fx.kind)

      // Freeze pads (M13, ADR-0009): slot buffers are session-only and
      // live with the channel; the source node swaps in behind the
      // live/loop gain pair above. Captures are answered by the player
      // worklet from its played history, matched by id.
      type LoopSlotBuffer = { buffer: AudioBuffer; oneShot: boolean }
      const loopBuffers: (LoopSlotBuffer | null)[] =
        Array<LoopSlotBuffer | null>(LOOP_SLOT_COUNT).fill(null)
      let loopSource: AudioBufferSourceNode | null = null
      // One ringing one-shot at a time: a re-fire cuts the previous
      // (the per-pad mono convention of hardware samplers).
      let oneShotSource: AudioBufferSourceNode | null = null
      function stopOneShotSource() {
        const source = oneShotSource
        if (!source) return
        oneShotSource = null
        source.onended = () => source.disconnect()
        source.stop()
      }
      let nextCaptureId = 0
      type Captured = { left: Float32Array; right: Float32Array }
      const pendingCaptures = new Map<number, (captured: Captured) => void>()
      function requestCapture(frames: number): Promise<Captured | null> {
        return new Promise((resolve) => {
          const id = nextCaptureId++
          // A suspended context never services the port; fail the press
          // instead of leaving it pending forever (the recorder-flush
          // precedent).
          const deadline = setTimeout(() => {
            pendingCaptures.delete(id)
            resolve(null)
          }, FLUSH_TIMEOUT_MS)
          pendingCaptures.set(id, (captured) => {
            clearTimeout(deadline)
            resolve(captured)
          })
          worklet.port.postMessage({ type: 'capture', id, frames })
        })
      }
      // stopLoop lets the outgoing source ring through the down-ramp;
      // it stays tracked here so a quick follow-up playLoop can cut it
      // dead instead of summing two loops into the up-ramp.
      let fadingLoopSource: AudioBufferSourceNode | null = null
      function stopLoopSource(at: number) {
        const source = loopSource
        if (!source) return
        loopSource = null
        fadingLoopSource = source
        source.onended = () => {
          source.disconnect()
          if (fadingLoopSource === source) fadingLoopSource = null
        }
        source.stop(at)
      }
      function cutFadingLoopSource(at: number) {
        // A second stop() merely re-schedules the earlier one.
        fadingLoopSource?.stop(at)
      }

      const cueToggle = bus.context.createGain()
      cueToggle.gain.value = initial.cue ? 1 : 0
      post.connect(cueToggle)
      cueToggle.connect(bus.cueBus)
      const volume = bus.context.createGain()
      volume.gain.value = initial.volume
      post.connect(volume)
      const onAir = bus.context.createGain()
      volume.connect(onAir)
      onAir.connect(bus.crossfade[deckId])
      // Post-fader tap for the channel meter and waveform strip.
      const analyser = bus.context.createAnalyser()
      analyser.fftSize = ANALYSER_FFT_SIZE
      volume.connect(analyser)
      const analyserBuffer = new Uint8Array(analyser.fftSize)
      worklet.port.onmessage = (event) => {
        // Stats messages predate the capture protocol and carry no type.
        if (event.data.type === 'captured') {
          pendingCaptures.get(event.data.id)?.(event.data as Captured)
          pendingCaptures.delete(event.data.id)
          return
        }
        onStats(event.data)
      }
      return {
        postPcm(samples) {
          worklet.port.postMessage({ type: 'pcm', samples }, [samples.buffer])
        },
        reset() {
          worklet.port.postMessage({ type: 'reset' })
        },
        setVolume(next) {
          volume.gain.setTargetAtTime(
            next,
            bus.context.currentTime,
            PARAM_RAMP_SECONDS,
          )
        },
        setEq(band, value) {
          eqNodes[band].gain.setTargetAtTime(
            eqValueToDb(value),
            bus.context.currentTime,
            PARAM_RAMP_SECONDS,
          )
        },
        setCue(on) {
          cueToggle.gain.setTargetAtTime(
            on ? 1 : 0,
            bus.context.currentTime,
            PARAM_RAMP_SECONDS,
          )
        },
        setFx(kind) {
          swapFx(kind)
        },
        setFxAmount(amount) {
          fxAmount = amount
          applyFx()
        },
        setBeatPeriod(seconds) {
          if (seconds === beatPeriod) return
          beatPeriod = seconds
          fxGraph?.apply(fxAmount, bus.context.currentTime, beatPeriod)
        },
        setOnAir(on) {
          onAir.gain.setTargetAtTime(
            on ? 1 : 0,
            bus.context.currentTime,
            PARAM_RAMP_SECONDS,
          )
        },
        setTrim(db) {
          // Slower than the control ramp: trim is gain staging, and
          // the auto updates arrive once a second — a glide, not a
          // step.
          trim.gain.setTargetAtTime(dbToGain(db), bus.context.currentTime, 0.2)
        },
        async captureLoop(slot, seconds) {
          if (slot < 0 || slot >= LOOP_SLOT_COUNT) return false
          const rate = bus.context.sampleRate
          const fadeFrames = Math.round(LOOP_CROSSFADE_SECONDS * rate)
          const captured = await requestCapture(
            Math.round(seconds * rate) + fadeFrames,
          )
          // The worklet returns what its played history holds; less
          // than the floor would loop as a stutter, so refuse.
          if (
            !captured ||
            captured.left.length < Math.round(MIN_LOOP_SECONDS * rate) + fadeFrames
          ) {
            return false
          }
          const left = buildLoopChannel(captured.left, fadeFrames)
          const right = buildLoopChannel(captured.right, fadeFrames)
          const buffer = bus.context.createBuffer(2, left.length, rate)
          buffer.copyToChannel(left, 0)
          buffer.copyToChannel(right, 1)
          loopBuffers[slot] = { buffer, oneShot: false }
          return true
        },
        async loadGeneratedLoop(slot, wav, oneShot) {
          if (slot < 0 || slot >= LOOP_SLOT_COUNT) return false
          let decoded: AudioBuffer
          try {
            // decodeAudioData resamples to the context rate, so the
            // generator's 44.1 kHz lands on the graph's 48 k for free.
            decoded = await bus.context.decodeAudioData(wav)
          } catch {
            return false
          }
          if (oneShot) {
            loopBuffers[slot] = { buffer: decoded, oneShot: true }
            return true
          }
          // Loops get the capture treatment: the request carried a
          // surplus seam tail, folded here so the wrap point is
          // continuous and the musical length stays exact.
          const rate = bus.context.sampleRate
          const fadeFrames = Math.round(LOOP_CROSSFADE_SECONDS * rate)
          const left = buildLoopChannel(channelData(decoded, 0), fadeFrames)
          const right = buildLoopChannel(channelData(decoded, 1), fadeFrames)
          const buffer = bus.context.createBuffer(2, left.length, rate)
          buffer.copyToChannel(left, 0)
          buffer.copyToChannel(right, 1)
          loopBuffers[slot] = { buffer, oneShot: false }
          return true
        },
        playLoop(slot) {
          const filled = loopBuffers[slot]
          if (!filled) return false
          const time = bus.context.currentTime
          if (filled.oneShot) {
            // Overlay, not handover: the one-shot sums into the trim
            // head next to whatever is playing and ends itself.
            stopOneShotSource()
            const source = bus.context.createBufferSource()
            source.buffer = filled.buffer
            source.connect(trim)
            source.onended = () => {
              source.disconnect()
              if (oneShotSource === source) oneShotSource = null
            }
            source.start(time)
            oneShotSource = source
            return true
          }
          // Loop→loop swaps cut hard (the sampler convention); only the
          // live↔loop handover below is ramped. A source still fading
          // out from a recent stopLoop is cut too.
          cutFadingLoopSource(time)
          stopLoopSource(time)
          const source = bus.context.createBufferSource()
          source.buffer = filled.buffer
          source.loop = true
          source.connect(loopGain)
          source.start(time)
          loopSource = source
          snapRamp(liveGain.gain, 0, time)
          snapRamp(loopGain.gain, 1, time)
          return true
        },
        stopLoop() {
          if (!loopSource) return
          const time = bus.context.currentTime
          snapRamp(liveGain.gain, 1, time)
          snapRamp(loopGain.gain, 0, time)
          // The source rings through the down-ramp, then stops.
          stopLoopSource(time + SNAP_AFTER_SECONDS)
        },
        stopOneShot() {
          stopOneShotSource()
        },
        clearLoop(slot) {
          if (slot < 0 || slot >= LOOP_SLOT_COUNT) return
          loopBuffers[slot] = null
        },
        async captureSample(seconds) {
          const rate = bus.context.sampleRate
          const captured = await requestCapture(Math.round(seconds * rate))
          if (
            !captured ||
            captured.left.length < Math.round(MIN_STYLE_SAMPLE_SECONDS * rate)
          ) {
            return null
          }
          return interleaveChannels(captured.left, captured.right)
        },
        getLevel() {
          return rmsLevel(analyser, analyserBuffer)
        },
        getWaveformRange() {
          analyser.getByteTimeDomainData(analyserBuffer)
          return rangeFromBytes(analyserBuffer)
        },
        dispose() {
          worklet.port.onmessage = null
          worklet.disconnect()
          cutFadingLoopSource(bus.context.currentTime)
          stopLoopSource(bus.context.currentTime)
          stopOneShotSource()
          liveGain.disconnect()
          loopGain.disconnect()
          trim.disconnect()
          for (const band of EQ_BANDS) eqNodes[band].disconnect()
          fxGraph?.dispose()
          for (const node of [fxDry, fxSend, fxWet, post]) node.disconnect()
          cueToggle.disconnect()
          volume.disconnect()
          onAir.disconnect()
          analyser.disconnect()
        },
      }
    },

    async resume() {
      const bus = await ensureBus()
      await bus.context.resume()
      // A cue device restored on page load couldn't start its element
      // without a gesture; every resume() runs inside one, so retry here.
      if (cueElement && cueDeviceId && cueElement.paused) {
        void cueElement.play().catch(() => {})
      }
    },

    async startRecording() {
      if (recorder) return
      const bus = await ensureBus()
      if (recorder) return // a concurrent call won the await race
      const node = new AudioWorkletNode(bus.context, 'pcm-recorder', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
      })
      const chunks: Int16Array<ArrayBuffer>[] = []
      node.port.onmessage = (event) => {
        if (event.data.type === 'pcm') {
          chunks.push(floatToInt16(event.data.samples as Float32Array))
        }
      }
      bus.limited.connect(node)
      node.port.postMessage({ type: 'start' })
      recorder = { node, chunks }
    },

    async stopRecording() {
      if (!recorder) throw new Error('no recording in progress')
      const bus = await ensureBus()
      const { node, chunks } = recorder
      recorder = null
      try {
        // Worklet messages are serviced by the rendering thread; a
        // suspended context (audio interruption) would otherwise leave the
        // stop unacknowledged forever.
        await bus.context.resume()
        // The worklet flushes its partial batch before acknowledging the
        // stop, so the file ends exactly where the user stopped.
        await new Promise<void>((resolve, reject) => {
          const deadline = setTimeout(
            () => reject(new Error('recorder did not flush in time')),
            FLUSH_TIMEOUT_MS,
          )
          node.port.onmessage = (event) => {
            if (event.data.type === 'pcm') {
              chunks.push(floatToInt16(event.data.samples as Float32Array))
            } else if (event.data.type === 'done') {
              clearTimeout(deadline)
              resolve()
            }
          }
          node.port.postMessage({ type: 'stop' })
        })
      } finally {
        bus.limited.disconnect(node)
      }
      return encodeWav(chunks, SAMPLE_RATE, 2)
    },

    getMasterLevel() {
      if (!masterBuffer || !masterAnalyserRef) return 0
      return rmsLevel(masterAnalyserRef, masterBuffer)
    },

    getMasterGainReduction() {
      return limiterRef?.reduction ?? 0
    },

    setCueMix(position) {
      cueMixPosition = position
      void busPromise
        ?.then((bus) => {
          const gains = equalPowerGains(position)
          const now = bus.context.currentTime
          bus.cueLevel.gain.setTargetAtTime(gains.a, now, PARAM_RAMP_SECONDS)
          bus.cueMonitor.gain.setTargetAtTime(gains.b, now, PARAM_RAMP_SECONDS)
        })
        .catch(() => {})
    },

    async setCueDevice(deviceId) {
      cueDeviceId = deviceId
      if (!deviceId) {
        cueElement?.pause()
        return
      }
      const bus = await ensureBus()
      if (!cueElement) {
        cueElement = new Audio()
        cueElement.srcObject = bus.cueOut.stream
      }
      await cueElement.setSinkId(deviceId)
      // Autoplay may block this outside a gesture (e.g. restoring the
      // persisted device on load); resume() retries inside one.
      void cueElement.play().catch(() => {})
    },

    async startCueCapture(onChunk) {
      stopCueCapture()
      const bus = await ensureBus()
      const node = new AudioWorkletNode(bus.context, 'pcm-recorder', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
      })
      node.port.onmessage = (event) => {
        if (event.data.type === 'pcm') {
          onChunk(event.data.samples as Float32Array<ArrayBuffer>)
        }
      }
      bus.cueFeed.connect(node)
      node.port.postMessage({ type: 'start' })
      cueCapture = node
    },

    stopCueCapture,

    setCrossfade(position) {
      crossfadePosition = position
      // Applies live when the bus exists; otherwise buildBus picks the
      // stored position up at creation. A failed bus build already surfaces
      // through play(); the fader move itself has nothing to report.
      void busPromise
        ?.then((bus) => {
          const gains = equalPowerGains(position)
          const now = bus.context.currentTime
          bus.crossfade.a.gain.setTargetAtTime(gains.a, now, PARAM_RAMP_SECONDS)
          bus.crossfade.b.gain.setTargetAtTime(gains.b, now, PARAM_RAMP_SECONDS)
        })
        .catch(() => {})
    },
  }
}
