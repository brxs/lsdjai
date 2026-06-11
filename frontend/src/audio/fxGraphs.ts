/** Color FX node graphs (M12, ADR-0008): one builder per effect kind,
 * each a small Web Audio graph between the channel's fx send and wet
 * gain. Intensity lives here, applied from the pure curves in fx.ts;
 * the dry/wet routing around the graph belongs to the channel. Not
 * unit-testable in jsdom (no AudioContext) — covered by the curve
 * tests, the bypass routing tests, and the hardware checklist. */

import {
  crushCurve,
  DUB_ECHO_SECONDS,
  DUB_ECHO_TONE_HZ,
  dubEchoCurve,
  echoDelaySeconds,
  filterCurve,
  noiseCurve,
  spaceCurve,
  sweepCurve,
  type FxKind,
} from './fx'

// Matches the engine's PARAM_RAMP_SECONDS: fast enough to feel direct,
// slow enough not to zipper.
const RAMP_SECONDS = 0.02

export type FxGraph = {
  input: AudioNode
  output: AudioNode
  /** Push the knob position into the graph's parameters. The beat
   * period (M14, null while the gate refuses) only matters to graphs
   * with a musical clock — the dub echo's synced delay. */
  apply: (amount: number, time: number, beatPeriodSeconds: number | null) => void
  dispose: () => void
}

function whiteNoiseBuffer(context: BaseAudioContext, seconds: number): AudioBuffer {
  const length = Math.floor(context.sampleRate * seconds)
  const buffer = context.createBuffer(2, length, context.sampleRate)
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel)
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1
  }
  return buffer
}

/** Exponentially decaying noise burst — a serviceable hall. */
function impulseResponse(context: BaseAudioContext): AudioBuffer {
  const seconds = 2.5
  const decayPower = 3
  const length = Math.floor(context.sampleRate * seconds)
  const buffer = context.createBuffer(2, length, context.sampleRate)
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel)
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** decayPower
    }
  }
  return buffer
}

export function buildFxGraph(context: BaseAudioContext, kind: FxKind): FxGraph {
  switch (kind) {
    case 'filter': {
      const filter = context.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.value = 18_000
      return {
        input: filter,
        output: filter,
        apply(amount, time) {
          const { type, frequency } = filterCurve(amount)
          // The type flip is instant, but it can only happen across the
          // centre dead zone, where the wet gain is already silent.
          filter.type = type
          filter.frequency.setTargetAtTime(frequency, time, RAMP_SECONDS)
        },
        dispose() {
          filter.disconnect()
        },
      }
    }

    case 'dub_echo': {
      const input = context.createGain()
      const delay = context.createDelay(1)
      delay.delayTime.value = DUB_ECHO_SECONDS
      const tone = context.createBiquadFilter()
      tone.type = 'lowpass'
      tone.frequency.value = DUB_ECHO_TONE_HZ
      const feedback = context.createGain()
      feedback.gain.value = 0
      const wet = context.createGain()
      wet.gain.value = 0
      input.connect(delay)
      delay.connect(tone)
      tone.connect(feedback)
      feedback.connect(delay)
      delay.connect(wet)
      return {
        input,
        output: wet,
        apply(amount, time, beatPeriodSeconds) {
          const params = dubEchoCurve(amount)
          feedback.gain.setTargetAtTime(params.feedback, time, RAMP_SECONDS)
          wet.gain.setTargetAtTime(params.wet, time, RAMP_SECONDS)
          // Synced when the gate is confident, free-running otherwise.
          delay.delayTime.setTargetAtTime(
            echoDelaySeconds(beatPeriodSeconds),
            time,
            RAMP_SECONDS,
          )
        },
        dispose() {
          for (const node of [input, delay, tone, feedback, wet]) {
            node.disconnect()
          }
        },
      }
    }

    case 'space': {
      const convolver = context.createConvolver()
      convolver.buffer = impulseResponse(context)
      const wet = context.createGain()
      wet.gain.value = 0
      convolver.connect(wet)
      return {
        input: convolver,
        output: wet,
        apply(amount, time) {
          wet.gain.setTargetAtTime(spaceCurve(amount).wet, time, RAMP_SECONDS)
        },
        dispose() {
          convolver.disconnect()
          wet.disconnect()
        },
      }
    }

    case 'crush': {
      const node = new AudioWorkletNode(context, 'bit-crusher', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      })
      return {
        input: node,
        output: node,
        apply(amount) {
          node.port.postMessage(crushCurve(amount))
        },
        dispose() {
          node.disconnect()
        },
      }
    }

    case 'noise': {
      // Adds a filtered riser; the channel signal itself stays on the
      // dry branch, so the graph's input goes nowhere by design.
      const input = context.createGain()
      const source = context.createBufferSource()
      source.buffer = whiteNoiseBuffer(context, 1)
      source.loop = true
      const filter = context.createBiquadFilter()
      filter.type = 'bandpass'
      filter.Q.value = 0.8
      const level = context.createGain()
      level.gain.value = 0
      source.connect(filter)
      filter.connect(level)
      source.start()
      return {
        input,
        output: level,
        apply(amount, time) {
          const params = noiseCurve(amount)
          level.gain.setTargetAtTime(params.level, time, RAMP_SECONDS)
          filter.frequency.setTargetAtTime(params.frequency, time, RAMP_SECONDS)
        },
        dispose() {
          source.stop()
          for (const node of [input, source, filter, level]) node.disconnect()
        },
      }
    }

    case 'sweep': {
      const duck = context.createGain()
      duck.gain.value = 1
      const lfo = context.createOscillator()
      lfo.type = 'sine'
      lfo.frequency.value = 0.5
      const lfoDepth = context.createGain()
      lfoDepth.gain.value = 0
      lfo.connect(lfoDepth)
      lfoDepth.connect(duck.gain)
      lfo.start()
      return {
        input: duck,
        output: duck,
        apply(amount, time) {
          const params = sweepCurve(amount)
          // Base sits at 1 − depth/2 with the LFO swinging ±depth/2,
          // so the duck breathes between 1 and 1 − depth.
          lfo.frequency.setTargetAtTime(params.rateHz, time, RAMP_SECONDS)
          duck.gain.setTargetAtTime(1 - params.depth / 2, time, RAMP_SECONDS)
          lfoDepth.gain.setTargetAtTime(params.depth / 2, time, RAMP_SECONDS)
        },
        dispose() {
          lfo.stop()
          for (const node of [duck, lfo, lfoDepth]) node.disconnect()
        },
      }
    }
  }
}
