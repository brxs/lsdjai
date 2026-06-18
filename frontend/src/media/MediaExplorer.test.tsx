import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DeckId } from '../audio/types'
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

// Sets the Title field too (to the same string) so the take's name and #id label are
// deterministic rather than a random title — most assertions key off the label.
async function composeTrack(name: string) {
  fireEvent.click(screen.getByRole('tab', { name: 'Generate' }))
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: name } })
  fireEvent.change(screen.getByLabelText('Track prompt'), { target: { value: name } })
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
    await composeTrack('second')

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

  it('auto-saves a composed take to the songs folder via the Rust shell', async () => {
    stubFetch()
    const calls: { cmd: string; args: unknown }[] = []
    const invoke = vi.fn(async (cmd: string, args?: unknown) => {
      calls.push({ cmd, args })
      if (cmd === 'list_generated_songs') return []
      if (cmd === 'save_generated_song') {
        return { file: 'keeper #1.wav', title: 'keeper #1', prompt: 'keeper', model: 'track' }
      }
      return undefined
    })
    vi.stubGlobal('__TAURI__', { core: { invoke } })
    renderExplorer()
    await composeTrack('keeper')
    // The composed take is persisted without a second click — no download button.
    expect(screen.queryByRole('button', { name: 'Save keeper #1' })).toBeNull()
    const saveCall = calls.find((c) => c.cmd === 'save_generated_song')
    expect(saveCall).toBeDefined()
    // The payload frames [u32 LE meta-JSON length][meta JSON][WAV bytes].
    const payload = saveCall!.args as Uint8Array
    const metaLen = new DataView(
      payload.buffer,
      payload.byteOffset,
      payload.byteLength,
    ).getUint32(0, true)
    const meta = JSON.parse(new TextDecoder().decode(payload.subarray(4, 4 + metaLen)))
    expect(meta).toEqual({ title: 'keeper', prompt: 'keeper', model: 'track' })
  })

  it('does not attempt a save outside the native shell', async () => {
    stubFetch()
    // No __TAURI__: a plain browser has no disk to write through, so auto-save is
    // skipped silently rather than surfacing an avoidable error.
    renderExplorer()
    await composeTrack('keeper')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('opens the songs folder through the Rust shell', async () => {
    const calls: string[] = []
    const invoke = vi.fn(async (cmd: string) => {
      calls.push(cmd)
      return undefined
    })
    vi.stubGlobal('__TAURI__', { core: { invoke } })
    renderExplorer()
    fireEvent.click(screen.getByRole('tab', { name: 'Generate' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open songs folder' }))
    })
    expect(calls).toContain('open_songs_folder')
  })

  it('restores takes from the registry on startup, tagging hand-added files as imported', async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'list_generated_songs') {
        return [
          {
            file: 'late night dub.wav',
            title: 'late night dub',
            prompt: 'late night dub',
            model: 'track',
          },
          { file: 'mixtape.wav', title: 'mixtape', prompt: null, model: null },
        ]
      }
      return undefined
    })
    vi.stubGlobal('__TAURI__', { core: { invoke } })
    renderExplorer()
    fireEvent.click(screen.getByRole('tab', { name: 'Generate' }))
    // The composed take comes back as its title + a kept-visible #id tag…
    expect(await screen.findByText('late night dub')).toBeInTheDocument()
    expect(screen.getByText('#1')).toBeInTheDocument()
    // …and the hand-added one is marked Imported (no model).
    expect(screen.getByText('mixtape')).toBeInTheDocument()
    expect(
      screen.getAllByText('Imported').some((el) => el.classList.contains('media__meta')),
    ).toBe(true)
  })

  it('loads a restored take by reading its bytes from disk', async () => {
    const wav = new ArrayBuffer(8)
    const calls: { cmd: string; args: unknown }[] = []
    const invoke = vi.fn(async (cmd: string, args?: unknown) => {
      calls.push({ cmd, args })
      if (cmd === 'list_generated_songs') {
        return [{ file: 'keeper #1.wav', title: 'keeper', prompt: 'keeper', model: 'track' }]
      }
      if (cmd === 'read_generated_song') return wav
      return undefined
    })
    vi.stubGlobal('__TAURI__', { core: { invoke } })
    const onLoadTrack = vi.fn(async () => true)
    renderExplorer({ onLoadTrack })
    fireEvent.click(screen.getByRole('tab', { name: 'Generate' }))
    const loadButton = await screen.findByRole('button', {
      name: 'Load keeper #1 to deck A',
    })
    await act(async () => {
      fireEvent.click(loadButton)
    })
    // A restored take carries no in-memory bytes, so the scoped read fetches them.
    const readCall = calls.find((c) => c.cmd === 'read_generated_song')
    expect(readCall?.args).toEqual({ name: 'keeper #1.wav' })
    expect(onLoadTrack).toHaveBeenCalledWith('a', expect.any(ArrayBuffer), 'keeper #1')
  })

  it('deletes a take via ✕, moving the file to the Trash and pruning the registry', async () => {
    const calls: { cmd: string; args: unknown }[] = []
    const invoke = vi.fn(async (cmd: string, args?: unknown) => {
      calls.push({ cmd, args })
      if (cmd === 'list_generated_songs') {
        return [{ file: 'keeper #1.wav', title: 'keeper', prompt: 'keeper', model: 'track' }]
      }
      return undefined
    })
    vi.stubGlobal('__TAURI__', { core: { invoke } })
    renderExplorer()
    fireEvent.click(screen.getByRole('tab', { name: 'Generate' }))
    const removeButton = await screen.findByRole('button', { name: 'Remove keeper #1' })
    await act(async () => {
      fireEvent.click(removeButton)
    })
    expect(screen.queryByRole('button', { name: 'Remove keeper #1' })).toBeNull()
    const deleteCall = calls.find((c) => c.cmd === 'delete_generated_song')
    expect(deleteCall?.args).toEqual({ name: 'keeper #1.wav' })
  })

  it('keeps the row and surfaces an error when a delete fails', async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'list_generated_songs') {
        return [{ file: 'keeper #1.wav', title: 'keeper', prompt: 'keeper', model: 'track' }]
      }
      if (cmd === 'delete_generated_song') throw new Error('Trash is unavailable')
      return undefined
    })
    vi.stubGlobal('__TAURI__', { core: { invoke } })
    renderExplorer()
    fireEvent.click(screen.getByRole('tab', { name: 'Generate' }))
    const removeButton = await screen.findByRole('button', { name: 'Remove keeper #1' })
    await act(async () => {
      fireEvent.click(removeButton)
    })
    // The disk delete failed, so the row stays (matching disk) and the error shows —
    // it must not vanish and then reappear on the next launch's scan.
    expect(screen.getByRole('button', { name: 'Remove keeper #1' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('delete keeper')
    expect(screen.getByRole('alert')).toHaveTextContent('Trash is unavailable')
  })

  it('reveals the full prompt behind the 🔍 button and toggles it off', async () => {
    const prompt = 'deep rolling dub techno with tape hiss and a long modular intro'
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'list_generated_songs') {
        return [{ file: 'dub.wav', title: 'Dub Reverie', prompt, model: 'magenta' }]
      }
      return undefined
    })
    vi.stubGlobal('__TAURI__', { core: { invoke } })
    renderExplorer()
    fireEvent.click(screen.getByRole('tab', { name: 'Generate' }))
    const lupe = await screen.findByRole('button', {
      name: 'Show the full prompt for Dub Reverie #1',
    })
    // The full prompt block isn't rendered until asked (the row only shows the title).
    expect(document.querySelector('.media__prompt')).toBeNull()
    fireEvent.click(lupe)
    expect(document.querySelector('.media__prompt')).toHaveTextContent(prompt)
    // Clicking again collapses it.
    fireEvent.click(lupe)
    expect(document.querySelector('.media__prompt')).toBeNull()
  })

  it('pretty-prints a JSON prompt in the 🔍 inspector', async () => {
    const minified = '{"title":"X","bpm":120}'
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'list_generated_songs') {
        return [{ file: 'x.wav', title: 'My Take', prompt: minified, model: 'magenta' }]
      }
      return undefined
    })
    vi.stubGlobal('__TAURI__', { core: { invoke } })
    renderExplorer()
    fireEvent.click(screen.getByRole('tab', { name: 'Generate' }))
    const lupe = await screen.findByRole('button', {
      name: 'Show the full prompt for My Take #1',
    })
    fireEvent.click(lupe)
    // The inspector shows the prompt re-indented, not the minified original.
    const expected = JSON.stringify(JSON.parse(minified), null, 2)
    expect(document.querySelector('.media__prompt')?.textContent).toBe(expected)
  })

  it('uses the Title field for the name and filename, independent of the prompt', async () => {
    stubFetch()
    const calls: { cmd: string; args: unknown }[] = []
    const invoke = vi.fn(async (cmd: string, args?: unknown) => {
      calls.push({ cmd, args })
      if (cmd === 'list_generated_songs') return []
      if (cmd === 'save_generated_song') {
        return { file: 'Porcelain Halo.wav', title: 'Porcelain Halo', prompt: '{"a":1}', model: 'track' }
      }
      return undefined
    })
    vi.stubGlobal('__TAURI__', { core: { invoke } })
    renderExplorer()
    fireEvent.click(screen.getByRole('tab', { name: 'Generate' }))
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Porcelain Halo' } })
    fireEvent.change(screen.getByLabelText('Track prompt'), { target: { value: '{"a":1}' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Compose' }))
    })
    // The row shows the title, not the (JSON) prompt.
    expect(screen.getByText('Porcelain Halo')).toBeInTheDocument()
    // Saved metadata keeps the title and the prompt separate.
    const saveCall = calls.find((c) => c.cmd === 'save_generated_song')
    const payload = saveCall!.args as Uint8Array
    const metaLen = new DataView(
      payload.buffer,
      payload.byteOffset,
      payload.byteLength,
    ).getUint32(0, true)
    const meta = JSON.parse(new TextDecoder().decode(payload.subarray(4, 4 + metaLen)))
    expect(meta).toEqual({ title: 'Porcelain Halo', prompt: '{"a":1}', model: 'track' })
  })

  it('falls back to a random title when the Title field is blank', async () => {
    stubFetch()
    const calls: { cmd: string; args: unknown }[] = []
    const invoke = vi.fn(async (cmd: string, args?: unknown) => {
      calls.push({ cmd, args })
      if (cmd === 'list_generated_songs') return []
      if (cmd === 'save_generated_song') {
        return { file: 'x.wav', title: 'x', prompt: 'x', model: 'track' }
      }
      return undefined
    })
    vi.stubGlobal('__TAURI__', { core: { invoke } })
    renderExplorer()
    fireEvent.click(screen.getByRole('tab', { name: 'Generate' }))
    // Title left blank — only a prompt is given.
    fireEvent.change(screen.getByLabelText('Track prompt'), {
      target: { value: 'rolling sub bass' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Compose' }))
    })
    const saveCall = calls.find((c) => c.cmd === 'save_generated_song')
    const payload = saveCall!.args as Uint8Array
    const metaLen = new DataView(
      payload.buffer,
      payload.byteOffset,
      payload.byteLength,
    ).getUint32(0, true)
    const meta = JSON.parse(new TextDecoder().decode(payload.subarray(4, 4 + metaLen)))
    // A non-empty title was generated, distinct from the prompt that was sent.
    expect(meta.title).toBeTruthy()
    expect(meta.title).not.toBe('rolling sub bass')
    expect(meta.prompt).toBe('rolling sub bass')
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

  it('uses the native picker + Rust commands under Tauri', async () => {
    const wav = new ArrayBuffer(8)
    // Record (cmd, args) so the read's scoped {dir, name} can be asserted.
    const calls: { cmd: string; args: unknown }[] = []
    const invoke = vi.fn(async (cmd: string, args?: unknown) => {
      calls.push({ cmd, args })
      if (cmd === 'plugin:dialog|open') return '/Users/dj/DJ Sets'
      if (cmd === 'list_audio_files') return ['a-side.mp3', 'b-side.wav']
      if (cmd === 'read_audio_file') return wav
      return undefined
    })
    // Presence of `__TAURI__` is what isTauri() keys on; its core.invoke is the bridge.
    vi.stubGlobal('__TAURI__', { core: { invoke } })
    const onLoadTrack = vi.fn(async () => true)
    renderExplorer({ onLoadTrack })
    fireEvent.click(screen.getByRole('tab', { name: 'Folder' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }))
    })
    // The picked path's basename shows, and the Rust listing populates.
    expect(screen.getByText('DJ Sets')).toBeInTheDocument()
    expect(screen.getByText('a-side.mp3')).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Load a-side.mp3 to deck A' }),
      )
    })
    // Read is scoped: the command gets the chosen dir + the plain name, not a path.
    const readCall = calls.find((c) => c.cmd === 'read_audio_file')
    expect(readCall?.args).toEqual({ dir: '/Users/dj/DJ Sets', name: 'a-side.mp3' })
    expect(onLoadTrack).toHaveBeenCalledWith('a', wav, 'a-side.mp3')
  })

  it('dismissing the native picker lists nothing and shows no error', async () => {
    const invoke = vi.fn(async (cmd: string) =>
      cmd === 'plugin:dialog|open' ? null : undefined,
    )
    vi.stubGlobal('__TAURI__', { core: { invoke } })
    renderExplorer()
    fireEvent.click(screen.getByRole('tab', { name: 'Folder' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }))
    })
    expect(invoke.mock.calls.some((c) => c[0] === 'list_audio_files')).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('trims a trailing slash from the native folder name', async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'plugin:dialog|open') return '/Users/dj/My Sets/'
      if (cmd === 'list_audio_files') return []
      return undefined
    })
    vi.stubGlobal('__TAURI__', { core: { invoke } })
    renderExplorer()
    fireEvent.click(screen.getByRole('tab', { name: 'Folder' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }))
    })
    expect(screen.getByText('My Sets')).toBeInTheDocument()
  })

  it('surfaces a native listing error', async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'plugin:dialog|open') return '/Users/dj/Locked'
      if (cmd === 'list_audio_files') throw new Error('cannot read folder: denied')
      return undefined
    })
    vi.stubGlobal('__TAURI__', { core: { invoke } })
    renderExplorer()
    fireEvent.click(screen.getByRole('tab', { name: 'Folder' }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }))
    })
    expect(screen.getByRole('alert')).toHaveTextContent('cannot read folder: denied')
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
