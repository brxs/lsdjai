import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DeckId } from '../audio/engine'
import { createControlBus, type ControlBus } from '../control/bus'
import { ControlBusProvider } from '../control/ControlBusProvider'
import type { StylePreset } from '../presets'
import { MediaExplorer } from './MediaExplorer'

type Handlers = {
  onLoadPreset?: (deck: DeckId, preset: StylePreset) => void
  onLoadTrack?: (deck: DeckId, wav: ArrayBuffer, title: string) => Promise<boolean>
  onLoadLive?: (deck: DeckId) => void
}

function renderExplorer(
  handlers: Handlers = {},
  presets: StylePreset[] = [],
  bus: ControlBus = createControlBus(),
) {
  render(
    <ControlBusProvider bus={bus}>
      <MediaExplorer
        presets={presets}
        onLoadPreset={handlers.onLoadPreset ?? vi.fn()}
        onDeletePreset={vi.fn()}
        onImportPresets={vi.fn()}
        onLoadTrack={handlers.onLoadTrack ?? vi.fn(async () => true)}
        onLoadLive={handlers.onLoadLive ?? vi.fn()}
      />
    </ControlBusProvider>,
  )
}

function stubFetch(response: Partial<Response> = {}) {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(4),
    json: async () => ({}),
    ...response,
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function composeTrack(title: string) {
  fireEvent.click(screen.getByRole('tab', { name: 'Generate' }))
  fireEvent.change(screen.getByLabelText('Track prompt'), {
    target: { value: title },
  })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Compose' }))
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('MediaExplorer', () => {
  it('opens on the folded-in crates tab', () => {
    renderExplorer()
    expect(
      screen.getByText("No presets yet — save a deck's style below its pad"),
    ).toBeInTheDocument()
  })

  it('offers the live stream as a loadable item — the exit from playback', () => {
    const onLoadLive = vi.fn()
    renderExplorer({ onLoadLive })
    fireEvent.click(
      screen.getByRole('button', { name: 'Load Live stream to deck A' }),
    )
    expect(onLoadLive).toHaveBeenCalledWith('a')
  })

  it('composes an SA3 track and loads it onto a deck', async () => {
    const fetchMock = stubFetch()
    const onLoadTrack = vi.fn(async () => true)
    renderExplorer({ onLoadTrack })

    await composeTrack('late night dub techno')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/generate',
      expect.objectContaining({
        body: JSON.stringify({
          prompt: 'late night dub techno',
          seconds: 120,
          kind: 'track',
        }),
      }),
    )
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Load late night dub techno #1 to deck B',
      }),
    )
    await act(async () => {})
    // The short id rides along to the deck, so two takes of the same
    // prompt stay tellable apart.
    expect(onLoadTrack).toHaveBeenCalledWith(
      'b',
      expect.any(ArrayBuffer),
      'late night dub techno #1',
    )
    // The row names the model that produced the take (the same label
    // also lives in the engine dropdown, hence the class filter).
    expect(
      screen
        .getAllByText('Track (SA3 medium)')
        .some((element) => element.classList.contains('media__meta')),
    ).toBe(true)
  })

  it('routes Magenta tracks to the render engine within its cap', async () => {
    const fetchMock = stubFetch()
    renderExplorer()
    fireEvent.click(screen.getByRole('tab', { name: 'Generate' }))
    // A length past Magenta's cap must snap back into range when the
    // engine switches (the render worker caps at 3 minutes).
    fireEvent.change(screen.getByLabelText('Length'), {
      target: { value: '380' },
    })
    fireEvent.change(screen.getByLabelText('Engine'), {
      target: { value: 'magenta' },
    })
    fireEvent.change(screen.getByLabelText('Track prompt'), {
      target: { value: 'air horn symphony' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Compose' }))
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/render',
      expect.objectContaining({
        body: JSON.stringify({ prompt: 'air horn symphony', seconds: 60 }),
      }),
    )
  })

  it('surfaces the backend detail and drops the pending row on failure', async () => {
    stubFetch({
      ok: false,
      status: 502,
      json: async () => ({ detail: 'render timed out' }),
    } as Partial<Response>)
    renderExplorer()
    await composeTrack('doomed')
    expect(
      screen.getByText('Track generation failed: render timed out'),
    ).toBeInTheDocument()
    expect(screen.queryByText('doomed — composing…')).toBeNull()
  })

  it('loads the rotary-highlighted track on a hardware LOAD', async () => {
    stubFetch()
    const onLoadTrack = vi.fn(async () => true)
    const bus = createControlBus()
    renderExplorer({ onLoadTrack }, [], bus)
    await composeTrack('first')
    fireEvent.change(screen.getByLabelText('Track prompt'), {
      target: { value: 'second' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Compose' }))
    })

    act(() => bus.publish({ kind: 'browse_scroll', steps: 1 }))
    await act(async () => {
      bus.publish({ kind: 'browse_load', deck: 'a' })
    })
    expect(onLoadTrack).toHaveBeenCalledWith(
      'a',
      expect.any(ArrayBuffer),
      'second #2',
    )
  })

  it('offers the small models too, with their shorter length menu', async () => {
    const fetchMock = stubFetch()
    renderExplorer()
    fireEvent.click(screen.getByRole('tab', { name: 'Generate' }))
    fireEvent.change(screen.getByLabelText('Engine'), {
      target: { value: 'sfx' },
    })
    fireEvent.change(screen.getByLabelText('Track prompt'), {
      target: { value: 'vinyl spinback' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Compose' }))
    })
    // 120 s is past the small-model cap, so the length snapped down.
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/generate',
      expect.objectContaining({
        body: JSON.stringify({ prompt: 'vinyl spinback', seconds: 10, kind: 'sfx' }),
      }),
    )
    expect(
      screen
        .getAllByText('SFX (SA3 small)')
        .some((element) => element.classList.contains('media__meta')),
    ).toBe(true)
  })

  it('saves a generated take as a WAV download', async () => {
    stubFetch()
    const createObjectURL = vi.fn(() => 'blob:fake')
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL: vi.fn(),
    })
    renderExplorer()
    await composeTrack('keeper')
    fireEvent.click(screen.getByRole('button', { name: 'Save keeper #1' }))
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
  })

  it('cycles the visible tab on a hardware rotary press', () => {
    const bus = createControlBus()
    renderExplorer({}, [], bus)
    act(() => bus.publish({ kind: 'browse_tab' }))
    expect(screen.getByLabelText('Track prompt')).toBeInTheDocument()
    act(() => bus.publish({ kind: 'browse_tab' }))
    expect(
      screen.getByRole('button', { name: 'Choose folder' }),
    ).toBeInTheDocument()
    act(() => bus.publish({ kind: 'browse_tab' }))
    // Full circle: back on the crates tab.
    expect(
      screen.getByText("No presets yet — save a deck's style below its pad"),
    ).toBeInTheDocument()
  })

  it('says so when folder browsing is unsupported', () => {
    renderExplorer()
    fireEvent.click(screen.getByRole('tab', { name: 'Folder' }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }))
    expect(
      screen.getByText(
        "Folder browsing needs Chromium's File System Access API",
      ),
    ).toBeInTheDocument()
  })

  it('lists a chosen folder’s audio files and loads one', async () => {
    const wav = new ArrayBuffer(8)
    const fileHandle = (name: string) => ({
      kind: 'file',
      name,
      getFile: async () => ({ arrayBuffer: async () => wav }),
    })
    vi.stubGlobal(
      'showDirectoryPicker',
      vi.fn(async () => ({
        name: 'DJ Sets',
        values: () =>
          (async function* () {
            yield fileHandle('b-side.wav')
            yield { kind: 'file', name: 'notes.txt' }
            yield fileHandle('a-side.mp3')
          })(),
      })),
    )
    const onLoadTrack = vi.fn(async () => true)
    renderExplorer({ onLoadTrack })
    fireEvent.click(screen.getByRole('tab', { name: 'Folder' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }))
    })
    expect(screen.getByText('DJ Sets')).toBeInTheDocument()
    expect(screen.queryByText('notes.txt')).toBeNull()
    // Sorted: the mp3 lands first despite arriving second.
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Load a-side.mp3 to deck A' }),
      )
    })
    expect(onLoadTrack).toHaveBeenCalledWith('a', wav, 'a-side.mp3')
  })
})

describe('rotary inside the folded-in crates tab', () => {
  const preset = (name: string): StylePreset => ({
    name,
    targets: [{ x: 0.5, y: 0.5, text: 'funk' }],
    cursor: { x: 0.5, y: 0.5 },
    fx: { kind: null, amount: 0 },
  })

  it('scrolls the crate highlight and quick-loads it', () => {
    const bus = createControlBus()
    const onLoadPreset = vi.fn()
    renderExplorer({ onLoadPreset }, [preset('one'), preset('two')], bus)
    act(() => bus.publish({ kind: 'browse_scroll', steps: 1 }))
    expect(
      screen.getByRole('button', { name: 'Select preset two' }),
    ).toHaveAttribute('aria-current', 'true')
    act(() => bus.publish({ kind: 'browse_load', deck: 'a' }))
    expect(onLoadPreset).toHaveBeenCalledWith('a', preset('two'))
  })
})
