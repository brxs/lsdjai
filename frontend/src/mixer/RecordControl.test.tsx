import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AudioEngineProvider } from '../audio/AudioEngineProvider'
import * as interfaceStore from '../audio/interfaceStore'
import type { AudioEngine } from '../audio/types'
import { createControlBus, type ControlBus } from '../control/bus'
import { ControlBusProvider } from '../control/ControlBusProvider'
import { RecordControl } from './RecordControl'

// The recording flag is store-owned (ADR-0020 phase A): the shell's
// start/stop commands write it. Tests flip a driveable store where the
// command's echo would land.
vi.mock('../audio/interfaceStore', async (importOriginal) => {
  const { useSyncExternalStore } = await import('react')
  const original = await importOriginal<typeof import('../audio/interfaceStore')>()
  let current: unknown = null
  const listeners = new Set<() => void>()
  return {
    ...original,
    useInterfaceStore: () =>
      useSyncExternalStore(
        (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        () => current,
      ),
    __setInterfaceStore: (next: unknown) => {
      current = next
      for (const listener of listeners) listener()
    },
  }
})

/** Flip the store's recording flag the way the shell command's echo would;
 * only the field RecordControl reads is carried. */
function setStoreRecording(active: boolean | null) {
  const push = (
    interfaceStore as unknown as { __setInterfaceStore: (next: unknown) => void }
  ).__setInterfaceStore
  push(active === null ? null : { recording: { active, path: null } })
}

beforeEach(() => setStoreRecording(null))

function makeEngine(overrides: Partial<AudioEngine> = {}): AudioEngine {
  return {
    getContextTime: vi.fn(() => 0),
    createDeckChannel: vi.fn(),
    resume: vi.fn(async () => {}),
    setCrossfade: vi.fn(),
    setCueMix: vi.fn(),
    auditionPlay: vi.fn(async () => {}),
    auditionStop: vi.fn(),
    listOutputDevices: vi.fn(async () => []),
    setMainDevice: vi.fn(async () => {}),
    setCueDevice: vi.fn(async () => {}),
    startRecording: vi.fn(async () => '/Users/dj/Downloads/lsdj-take.wav'),
    stopRecording: vi.fn(async () => {}),
    getMasterLevel: vi.fn(() => 0),
    getMasterGainReduction: vi.fn(() => 0),
    ...overrides,
  }
}

function renderRecord(
  engine: AudioEngine,
  bus: ControlBus = createControlBus(),
  recordingsFolder = '',
) {
  return render(
    <AudioEngineProvider engine={engine}>
      <ControlBusProvider bus={bus}>
        <RecordControl recordingsFolder={recordingsFolder} />
      </ControlBusProvider>
    </AudioEngineProvider>,
  )
}

describe('RecordControl', () => {
  it('opens the take in the chosen folder on start and confirms it on stop', async () => {
    const engine = makeEngine()
    renderRecord(engine, createControlBus(), '/Users/dj/Sets')

    fireEvent.click(screen.getByRole('button', { name: 'Record' }))
    // The take streams to disk, so the file is opened at start: the configured
    // folder and a timestamped stem reach the engine right away.
    await waitFor(() =>
      expect(engine.startRecording).toHaveBeenCalledWith(
        '/Users/dj/Sets',
        expect.stringMatching(/^lsdj-/),
      ),
    )
    expect(engine.resume).toHaveBeenCalled()
    // The shell command records `active` in the store; the button projects it.
    act(() => setStoreRecording(true))
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Stop recording' }),
      ).toBeVisible(),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }))
    await waitFor(() => expect(engine.stopRecording).toHaveBeenCalled())
    act(() => setStoreRecording(false))
    // The basename of the path returned at start is surfaced as reassurance.
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('lsdj-take.wav'),
    )
    expect(screen.getByRole('button', { name: 'Record' })).toBeVisible()
  })

  it('opens in the default (empty folder = Downloads) when none is chosen', async () => {
    const engine = makeEngine()
    renderRecord(engine)

    fireEvent.click(screen.getByRole('button', { name: 'Record' }))
    await waitFor(() =>
      expect(engine.startRecording).toHaveBeenCalledWith(
        '',
        expect.stringMatching(/^lsdj-/),
      ),
    )
  })

  it('surfaces a recording failure instead of swallowing it', async () => {
    const engine = makeEngine({
      startRecording: vi.fn(async () => {
        throw new Error('no audio context')
      }),
    })
    renderRecord(engine)
    fireEvent.click(screen.getByRole('button', { name: 'Record' }))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('no audio context'),
    )
  })

  it('toggles recording from the control bus', async () => {
    const engine = makeEngine()
    const bus = createControlBus()
    renderRecord(engine, bus)

    act(() => bus.publish({ kind: 'record_toggle' }))
    await waitFor(() => expect(engine.startRecording).toHaveBeenCalled())
    act(() => setStoreRecording(true))
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Stop recording' }),
      ).toBeVisible(),
    )
  })
})
