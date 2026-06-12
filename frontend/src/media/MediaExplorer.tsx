import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { DeckId } from '../audio/engine'
import { useControlBus } from '../control/busContext'
import { CrateBrowser } from '../crates/CrateBrowser'
import type { StylePreset } from '../presets'
import { Button } from '../ui/Button'
import { Panel } from '../ui/Panel'
import { Select } from '../ui/Select'
import { TextField } from '../ui/TextField'
import './media.css'

type MediaTab = 'crates' | 'generate' | 'folder'
type TrackEngine = 'sfx' | 'music' | 'track' | 'magenta'

type GeneratedTrack =
  | { id: number; state: 'pending'; title: string; engine: TrackEngine }
  | {
      id: number
      state: 'ready'
      title: string
      engine: TrackEngine
      wav: ArrayBuffer
    }

type FolderFile = { name: string; handle: FileSystemFileHandle }

// Chromium's File System Access API; the DOM lib types stop short of
// the directory iterator, so the shapes are pinned down here.
type DirectoryHandle = FileSystemDirectoryHandle & {
  values: () => AsyncIterable<FileSystemHandle>
}
type DirectoryPicker = { showDirectoryPicker?: () => Promise<DirectoryHandle> }

const AUDIO_FILE = /\.(wav|mp3|flac|m4a|ogg|aif|aiff)$/i
// Per-engine length menus, mirroring the backend caps: the small DiTs
// stop at sa3.MAX_SECONDS (32 s), the medium track DiT at
// sa3.TRACK_MAX_SECONDS (6:20), Magenta renders at
// controller.RENDER_MAX_SECONDS (3:00).
const ENGINE_LENGTHS: Record<TrackEngine, number[]> = {
  sfx: [5, 10, 20, 30],
  music: [5, 10, 20, 30],
  track: [60, 120, 240, 380],
  magenta: [30, 60, 120, 180],
}
const ENGINES = Object.keys(ENGINE_LENGTHS) as TrackEngine[]
// Tracks carry no BPM stamp, so the full backend prompt cap applies.
const TRACK_PROMPT_MAX_LENGTH = 500

function formatLength(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** Same prompt, different roll of the dice: the session-unique short
 * id keeps siblings tellable apart, on the row and on the deck. */
function displayName(track: GeneratedTrack): string {
  return `${track.title} #${track.id}`
}

function saveWav(track: GeneratedTrack & { state: 'ready' }) {
  const url = URL.createObjectURL(new Blob([track.wav], { type: 'audio/wav' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${displayName(track).replace(/[/\\:]/g, '-')}.wav`
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

type MediaExplorerProps = {
  presets: StylePreset[]
  onLoadPreset: (deck: DeckId, preset: StylePreset) => void
  onDeletePreset: (name: string) => void
  onImportPresets: (presets: StylePreset[]) => void
  /** Load a decoded-to-be track onto a deck — flips it to playback
   * mode (ADR-0013). Resolves false when the audio doesn't decode. */
  onLoadTrack: (deck: DeckId, wav: ArrayBuffer, title: string) => Promise<boolean>
  /** Return a deck to its live stream — the guaranteed exit from
   * playback, expressed as a load like everything else (ADR-0013). */
  onLoadLive: (deck: DeckId) => void
}

/** The Media Explorer (M19, ADR-0013): one pane below the booth that
 * owns loading. Crates (M16, folded in), generated tracks, and local
 * folder tracks all load onto a deck; the item type decides the deck's
 * mode. The FLX4 rotary browses the visible tab; LOAD loads its
 * highlighted item. */
export function MediaExplorer({
  presets,
  onLoadPreset,
  onDeletePreset,
  onImportPresets,
  onLoadTrack,
  onLoadLive,
}: MediaExplorerProps) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<MediaTab>('crates')
  const [tracks, setTracks] = useState<GeneratedTrack[]>([])
  const [prompt, setPrompt] = useState('')
  const [engine, setEngine] = useState<TrackEngine>('track')
  const [seconds, setSeconds] = useState(120)
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [folderName, setFolderName] = useState<string | null>(null)
  const [files, setFiles] = useState<FolderFile[]>([])
  const [folderError, setFolderError] = useState<string | null>(null)
  // The rotary highlight for the generate/folder tabs; the crates tab
  // keeps its own inside CrateBrowser (mounted only while visible, so
  // exactly one list answers the hardware at a time).
  const [highlight, setHighlight] = useState(0)
  // A ref, not state: two composes batched into one render (Enter +
  // click) must not mint the same id.
  const nextIdRef = useRef(1)

  const ready = tracks.filter(
    (track): track is GeneratedTrack & { state: 'ready' } =>
      track.state === 'ready',
  )
  const highlightedReadyId =
    ready.length === 0 ? null : ready[Math.min(highlight, ready.length - 1)].id

  async function loadTrackItem(deck: DeckId, wav: ArrayBuffer, title: string) {
    // decodeAudioData detaches the buffer it is given — hand over a
    // copy so the item can be loaded again (or onto the other deck).
    const loaded = await onLoadTrack(deck, wav.slice(0), title)
    if (!loaded) setGenerateError(t('media.undecodable', { title }))
  }

  async function loadFolderFile(deck: DeckId, file: FolderFile) {
    setFolderError(null)
    try {
      const wav = await (await file.handle.getFile()).arrayBuffer()
      const loaded = await onLoadTrack(deck, wav, file.name)
      if (!loaded) setFolderError(t('media.undecodable', { title: file.name }))
    } catch (error) {
      setFolderError(error instanceof Error ? error.message : String(error))
    }
  }

  const bus = useControlBus()
  useEffect(() =>
    bus.subscribe((intent) => {
      if (intent.kind === 'browse_tab') {
        // Rotary press: cycle the visible tab from the hardware.
        setTab((current) => {
          const order: MediaTab[] = ['crates', 'generate', 'folder']
          return order[(order.indexOf(current) + 1) % order.length]
        })
        setHighlight(0)
        return
      }
      if (tab === 'crates') return // CrateBrowser owns its own list
      const count = tab === 'generate' ? ready.length : files.length
      if (intent.kind === 'browse_scroll') {
        if (count === 0) return
        setHighlight((current) =>
          Math.max(0, Math.min(count - 1, Math.min(current, count - 1) + intent.steps)),
        )
      } else if (intent.kind === 'browse_load') {
        const index = Math.min(highlight, count - 1)
        if (index < 0) return
        if (tab === 'generate') {
          const track = ready[index]
          void loadTrackItem(intent.deck, track.wav, displayName(track))
        } else {
          void loadFolderFile(intent.deck, files[index])
        }
      }
    }),
  )

  function generateTrack() {
    const trimmed = prompt.trim()
    if (!trimmed) return
    const id = nextIdRef.current++
    const requestEngine = engine
    setGenerateError(null)
    setTracks((current) => [
      ...current,
      { id, state: 'pending', title: trimmed, engine: requestEngine },
    ])
    void (async () => {
      try {
        const response = await fetch(
          requestEngine === 'magenta' ? '/api/render' : '/api/generate',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(
              requestEngine === 'magenta'
                ? { prompt: trimmed, seconds }
                : { prompt: trimmed, seconds, kind: requestEngine },
            ),
          },
        )
        if (!response.ok) {
          const detail = await response
            .json()
            .then((body: { detail?: string }) => body.detail)
            .catch(() => null)
          throw new Error(detail || `generation failed (${response.status})`)
        }
        const wav = await response.arrayBuffer()
        setTracks((current) =>
          current.map((track) =>
            track.id === id
              ? { id, state: 'ready', title: trimmed, engine: requestEngine, wav }
              : track,
          ),
        )
      } catch (error) {
        setTracks((current) => current.filter((track) => track.id !== id))
        setGenerateError(error instanceof Error ? error.message : String(error))
      }
    })()
  }

  async function chooseFolder() {
    const picker = (window as Window & DirectoryPicker).showDirectoryPicker
    if (!picker) {
      setFolderError(t('media.folder.unsupported'))
      return
    }
    setFolderError(null)
    try {
      const directory = await picker()
      const found: FolderFile[] = []
      for await (const handle of directory.values()) {
        if (handle.kind === 'file' && AUDIO_FILE.test(handle.name)) {
          found.push({ name: handle.name, handle: handle as FileSystemFileHandle })
        }
      }
      found.sort((left, right) => left.name.localeCompare(right.name))
      setFolderName(directory.name)
      setFiles(found)
      setHighlight(0)
    } catch (error) {
      // A dismissed picker is not an error worth shouting about.
      if (error instanceof DOMException && error.name === 'AbortError') return
      setFolderError(error instanceof Error ? error.message : String(error))
    }
  }

  const lengths = ENGINE_LENGTHS[engine]

  function loadButtons(onLoad: (deck: DeckId) => void, name: string) {
    return (['a', 'b'] as const).map((deck) => (
      <Button
        key={deck}
        aria-label={t('media.loadTo', { name, deck: deck.toUpperCase() })}
        onClick={() => onLoad(deck)}
      >
        {t('media.loadShort', { deck: deck.toUpperCase() })}
      </Button>
    ))
  }

  return (
    <Panel className="media" aria-label={t('media.title')}>
      <div className="media__header">
        <h2 className="media__title">{t('media.title')}</h2>
        <div className="media__tabs" role="tablist">
          {(['crates', 'generate', 'folder'] as const).map((name) => (
            <Button
              key={name}
              lit={tab === name}
              role="tab"
              aria-selected={tab === name}
              aria-label={t(`media.tabs.${name}`)}
              onClick={() => {
                setTab(name)
                setHighlight(0)
              }}
            >
              {t(`media.tabs.${name}`)}
            </Button>
          ))}
        </div>
        {/* The guaranteed exit from playback: the live stream is itself
            a loadable item, so leaving is a load too (ADR-0013). */}
        <div className="media__live">
          <span className="media__live-label">{t('media.live')}</span>
          {loadButtons(onLoadLive, t('media.live'))}
        </div>
      </div>

      {tab === 'crates' && (
        <CrateBrowser
          presets={presets}
          onLoad={onLoadPreset}
          onDelete={onDeletePreset}
          onImport={onImportPresets}
        />
      )}

      {tab === 'generate' && (
        <div className="media__generate">
          <div className="media__generate-row">
            <TextField
              label={t('media.generate.prompt')}
              value={prompt}
              maxLength={TRACK_PROMPT_MAX_LENGTH}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') generateTrack()
              }}
            />
            <Select
              label={t('media.generate.engine')}
              value={engine}
              options={ENGINES.map((name) => ({
                value: name,
                label: t(`media.generate.engines.${name}`),
              }))}
              onChange={(value) => {
                const next = value as TrackEngine
                setEngine(next)
                // Each engine has its own ceiling; snap into range.
                if (!ENGINE_LENGTHS[next].includes(seconds)) {
                  setSeconds(ENGINE_LENGTHS[next][1])
                }
              }}
            />
            <Select
              label={t('media.generate.length')}
              value={String(seconds)}
              options={lengths.map((length) => ({
                value: String(length),
                label: formatLength(length),
              }))}
              onChange={(value) => setSeconds(Number(value))}
            />
            <Button disabled={!prompt.trim()} onClick={generateTrack}>
              {t('media.generate.action')}
            </Button>
          </div>
          {tracks.length === 0 ? (
            <p className="media__empty">{t('media.generate.empty')}</p>
          ) : (
            <ul className="media__list">
              {tracks.map((track) => (
                <li
                  key={track.id}
                  className={`media__item${
                    track.id === highlightedReadyId
                      ? ' media__item--highlighted'
                      : ''
                  }`}
                >
                  <span className="media__name">
                    {track.state === 'pending'
                      ? t('media.generate.pending', { title: displayName(track) })
                      : displayName(track)}
                  </span>
                  <span className="media__meta">
                    {t(`media.generate.engines.${track.engine}`)}
                  </span>
                  {track.state === 'ready' && (
                    <Button
                      aria-label={t('media.save', { name: displayName(track) })}
                      onClick={() => saveWav(track)}
                    >
                      {t('media.saveShort')}
                    </Button>
                  )}
                  {track.state === 'ready' &&
                    loadButtons(
                      (deck) =>
                        void loadTrackItem(deck, track.wav, displayName(track)),
                      displayName(track),
                    )}
                  {track.state === 'ready' && (
                    <Button
                      aria-label={t('media.remove', { name: displayName(track) })}
                      onClick={() =>
                        setTracks((current) =>
                          current.filter((entry) => entry.id !== track.id),
                        )
                      }
                    >
                      ✕
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {generateError && (
            <p className="media__error" role="alert">
              {t('media.generate.failed', { message: generateError })}
            </p>
          )}
        </div>
      )}

      {tab === 'folder' && (
        <div className="media__folder">
          <div className="media__folder-row">
            <Button onClick={() => void chooseFolder()}>
              {t('media.folder.choose')}
            </Button>
            {folderName && (
              <span className="media__folder-name">{folderName}</span>
            )}
          </div>
          {folderName && files.length === 0 && (
            <p className="media__empty">
              {t('media.folder.empty', { name: folderName })}
            </p>
          )}
          {files.length > 0 && (
            <ul className="media__list">
              {files.map((file, index) => (
                <li
                  key={file.name}
                  className={`media__item${
                    index === Math.min(highlight, files.length - 1)
                      ? ' media__item--highlighted'
                      : ''
                  }`}
                >
                  <button
                    className="media__name media__name--button"
                    aria-label={t('media.highlight', { name: file.name })}
                    aria-current={index === Math.min(highlight, files.length - 1)}
                    onClick={() => setHighlight(index)}
                  >
                    {file.name}
                  </button>
                  {loadButtons((deck) => void loadFolderFile(deck, file), file.name)}
                </li>
              ))}
            </ul>
          )}
          {folderError && (
            <p className="media__error" role="alert">
              {folderError}
            </p>
          )}
        </div>
      )}
    </Panel>
  )
}
