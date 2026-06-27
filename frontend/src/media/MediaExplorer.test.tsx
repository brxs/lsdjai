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
  onLoadSample?: (
    deck: DeckId,
    wav: ArrayBuffer,
    oneShot: boolean,
    label: string,
  ) => Promise<boolean>
  onPreview?: (wav: ArrayBuffer) => Promise<void>
  onStopPreview?: () => void
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
        onLoadSample={handlers.onLoadSample ?? vi.fn(async () => true)}
        onPreview={handlers.onPreview ?? vi.fn(async () => {})}
        onStopPreview={handlers.onStopPreview ?? vi.fn()}
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

/** Compose a clip in the Samples tab. One-shot by default so the requested length is
 * exact (a loop adds the seam surplus the engine folds on reload). */
async function composeSampleClip(name: string, oneShot = true) {
  fireEvent.click(screen.getByRole('tab', { name: 'Samples' }))
  if (oneShot) {
    fireEvent.click(screen.getByRole('button', { name: 'Toggle loop or one-shot' }))
  }
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: name } })
  fireEvent.change(screen.getByLabelText('Loop prompt'), { target: { value: name } })
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

  it('previews a take in the headphones and toggles it off', async () => {
    stubFetch()
    const onPreview = vi.fn(async () => {})
    const onStopPreview = vi.fn()
    renderExplorer({ onPreview, onStopPreview })
    await composeTrack('dub')

    fireEvent.click(
      screen.getByRole('button', { name: 'Preview dub #1 in headphones' }),
    )
    await act(async () => {})
    expect(onPreview).toHaveBeenCalledWith(expect.any(ArrayBuffer))
    // The button flips to a stop affordance; a second press stops the preview.
    fireEvent.click(screen.getByRole('button', { name: 'Stop preview' }))
    expect(onStopPreview).toHaveBeenCalled()
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

    // Newest sits at the top, so the rotary starts on 'second #2'; one step
    // down lands on the older 'first #1'.
    act(() => bus.publish({ kind: 'browse_scroll', steps: 1 }))
    await act(async () => {
      bus.publish({ kind: 'browse_load', deck: 'a' })
    })
    expect(onLoadTrack).toHaveBeenCalledWith(
      'a',
      expect.any(ArrayBuffer),
      'first #1',
    )
  })

  it('composes a short loop in the Samples tab with the small SFX model', async () => {
    // The small SFX/Music models compose into the samples library now (ADR-0022),
    // not the Generate tab; their shorter length menu lives on the Samples tab.
    const fetchMock = stubFetch()
    renderExplorer()
    fireEvent.click(screen.getByRole('tab', { name: 'Samples' }))
    // One-shot so the requested length is exact (a loop adds the seam surplus).
    fireEvent.click(screen.getByRole('button', { name: 'Toggle loop or one-shot' }))
    fireEvent.change(screen.getByLabelText('Loop prompt'), {
      target: { value: 'vinyl spinback' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Compose' }))
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/generate',
      expect.objectContaining({
        body: JSON.stringify({ prompt: 'vinyl spinback', seconds: 10, kind: 'sfx' }),
      }),
    )
    // The row's meta shows the small-model engine (combined with the play mode).
    expect(
      screen
        .getAllByText('SFX (SA3 small)', { exact: false })
        .some((element) => element.classList.contains('media__meta')),
    ).toBe(true)
  })

  it('auto-saves a composed sample to the samples folder, carrying oneShot', async () => {
    stubFetch()
    const calls: { cmd: string; args: unknown }[] = []
    const invoke = vi.fn(async (cmd: string, args?: unknown) => {
      calls.push({ cmd, args })
      if (cmd === 'list_generated_samples') return []
      if (cmd === 'save_generated_sample') {
        return { file: 'riff.wav', title: 'riff', prompt: 'riff', model: 'sfx', oneShot: true }
      }
      return undefined
    })
    vi.stubGlobal('__TAURI__', { core: { invoke } })
    renderExplorer()
    await composeSampleClip('riff')
    const saveCall = calls.find((c) => c.cmd === 'save_generated_sample')
    expect(saveCall).toBeDefined()
    // The same binary frame as a song save: [u32 LE meta-JSON length][meta JSON][WAV].
    const payload = saveCall!.args as Uint8Array
    const metaLen = new DataView(
      payload.buffer,
      payload.byteOffset,
      payload.byteLength,
    ).getUint32(0, true)
    const meta = JSON.parse(new TextDecoder().decode(payload.subarray(4, 4 + metaLen)))
    expect(meta).toEqual({ title: 'riff', prompt: 'riff', model: 'sfx', oneShot: true })
  })

  it('loads a restored sample into a deck loop slot via onLoadSample', async () => {
    const wav = new ArrayBuffer(8)
    const calls: { cmd: string; args: unknown }[] = []
    const invoke = vi.fn(async (cmd: string, args?: unknown) => {
      calls.push({ cmd, args })
      if (cmd === 'list_generated_samples') {
        return [
          { file: 'break.wav', title: 'break', prompt: 'break', model: 'music', oneShot: false },
        ]
      }
      if (cmd === 'read_generated_sample') return wav
      return undefined
    })
    vi.stubGlobal('__TAURI__', { core: { invoke } })
    const onLoadSample = vi.fn(async () => true)
    renderExplorer({ onLoadSample })
    fireEvent.click(screen.getByRole('tab', { name: 'Samples' }))
    const loadButton = await screen.findByRole('button', {
      name: 'Load break #1 to deck A',
    })
    await act(async () => {
      fireEvent.click(loadButton)
    })
    // A restored sample carries no in-memory bytes, so the scoped read fetches them,
    // and the sample's oneShot flag rides along to the slot loader.
    const readCall = calls.find((c) => c.cmd === 'read_generated_sample')
    expect(readCall?.args).toEqual({ name: 'break.wav' })
    expect(onLoadSample).toHaveBeenCalledWith('a', expect.any(ArrayBuffer), false, 'break #1')
  })

  it('live-reloads the Samples tab on the folder-watcher event, keeping ids stable', async () => {
    // The folder watcher fires `library://changed` when a deck saves out-of-band or a
    // file is dropped in; the tab re-lists, reusing existing rows by filename.
    let rows = [
      { file: 'one.wav', title: 'one', prompt: 'one', model: 'sfx', oneShot: false },
    ]
    let onChange: ((e: { payload: unknown }) => void) | null = null
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'list_generated_samples') return rows
      return undefined
    })
    const listen = vi.fn(
      async (event: string, handler: (e: { payload: unknown }) => void) => {
        if (event === 'library://changed') onChange = handler
        return () => {}
      },
    )
    vi.stubGlobal('__TAURI__', { core: { invoke }, event: { listen } })
    renderExplorer()
    fireEvent.click(screen.getByRole('tab', { name: 'Samples' }))
    // Scope to the name cell: a take whose title equals its prompt now shows the
    // text twice (the name and the always-visible prompt line).
    expect(
      await screen.findByText('one', { selector: '.media__name-text' }),
    ).toBeInTheDocument()
    expect(screen.getByText('#1')).toBeInTheDocument()

    // A deck saves a second sample → the watcher fires → the tab re-lists.
    rows = [
      { file: 'one.wav', title: 'one', prompt: 'one', model: 'sfx', oneShot: false },
      { file: 'two.wav', title: 'two', prompt: 'two', model: 'music', oneShot: false },
    ]
    await act(async () => {
      onChange?.({ payload: { library: 'samples' } })
    })
    expect(
      await screen.findByText('two', { selector: '.media__name-text' }),
    ).toBeInTheDocument()
    // The pre-existing row kept its identity across the reload (no id churn).
    expect(screen.getByText('one', { selector: '.media__name-text' })).toBeInTheDocument()
    expect(screen.getByText('#1')).toBeInTheDocument()
    expect(screen.getByText('#2')).toBeInTheDocument()
  })

  it('restores samples, tagging a freeze and a hand-added file', async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'list_generated_samples') {
        return [
          { file: 'Freeze A.wav', title: 'Freeze A', prompt: null, model: 'freeze', oneShot: false },
          { file: 'break.wav', title: 'break', prompt: null, model: null, oneShot: false },
        ]
      }
      return undefined
    })
    vi.stubGlobal('__TAURI__', { core: { invoke } })
    renderExplorer()
    fireEvent.click(screen.getByRole('tab', { name: 'Samples' }))
    // A deck capture reads as "Freeze" in its meta; a hand-added file as "Imported".
    await screen.findByText('break')
    const metas = [...document.querySelectorAll('.media__meta')].map(
      (el) => el.textContent ?? '',
    )
    expect(metas.some((text) => text.includes('Freeze'))).toBe(true)
    expect(metas.some((text) => text.includes('Imported'))).toBe(true)
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
    // (scoped to the name: this take's title equals its prompt, which the prompt
    // line also renders.)
    expect(
      await screen.findByText('late night dub', { selector: '.media__name-text' }),
    ).toBeInTheDocument()
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

  it('shows the prompt inline on the row, with the full text on hover', async () => {
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
    // The prompt rides the same line as the title (CSS truncates it to one row);
    // the full text is on the title tooltip rather than behind a toggle.
    await screen.findByText('Dub Reverie', { selector: '.media__name-text' })
    const promptLine = document.querySelector('.media__prompt')
    expect(promptLine).toHaveTextContent(prompt)
    expect(promptLine).toHaveAttribute('title', prompt)
  })

  it('pretty-prints a JSON prompt in the inline prompt line', async () => {
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
    await screen.findByText('My Take', { selector: '.media__name-text' })
    // The prompt is re-indented, not the minified original.
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
    // Samples sits between Generate and Folder in the rotation.
    expect(screen.getByLabelText('Loop prompt')).toBeInTheDocument()
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
