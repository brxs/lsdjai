import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { DeckId } from '../audio/types'
import { getApiBaseUrl, invoke, isTauri } from '../audio/nativeEngine'
import { useControlBus } from '../control/busContext'
import { CrateBrowser } from '../crates/CrateBrowser'
import type { StylePreset } from '../presets'
import { Button } from '../ui/Button'
import { Panel } from '../ui/Panel'
import { Select } from '../ui/Select'
import { TextField } from '../ui/TextField'
import { randomSongTitle } from './songTitle'
import './media.css'

type MediaTab = 'crates' | 'generate' | 'folder'
type TrackEngine = 'sfx' | 'music' | 'track' | 'magenta'

// One row of the on-disk song registry (Rust `songs::SongEntry`, camelCase): a file
// in the songs folder with the provenance the filesystem can't carry.
type SongEntry = {
  file: string
  title: string
  prompt: string | null
  model: string | null
}

type GeneratedTrack =
  | { id: number; state: 'pending'; title: string; prompt: string; model: TrackEngine }
  | {
      id: number
      state: 'ready'
      // The full display label (prompt + session id for a composed take, or the
      // filename stem for a file found in the folder).
      title: string
      // The full prompt that composed the take, shown by the 🔍 button (prompts are
      // now uncapped, so the row only shows a compact form). null for a file found in
      // the folder that SlipMate didn't generate.
      prompt: string | null
      // The engine that composed the take, or null for a file found in the songs
      // folder that SlipMate didn't generate ("model as option").
      model: TrackEngine | null
      // The filename on disk (the registry identity). null only outside Tauri, where
      // nothing was persisted and the take lives solely in `wav`.
      file: string | null
      // Bytes held only for a take composed THIS session; a restored take reads them
      // from disk on demand (a full render is 100 MB+ — don't hold them all).
      wav?: ArrayBuffer
    }

// A browsable file: just the name. `read_audio_file` re-derives the path from the
// chosen folder + name (the webview never supplies a path to read).
type FolderFile = { name: string }

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

function formatLength(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** A registry `model` string back into a known engine, or null ("none") for a file
 * the app didn't generate — so an unknown/absent value renders as "Imported". */
function asTrackEngine(model: string | null): TrackEngine | null {
  return model && (ENGINES as string[]).includes(model) ? (model as TrackEngine) : null
}

/** Pretty-print a prompt when it's JSON so the inspector is readable (a pasted spec is
 * often minified or awkwardly wrapped); otherwise show it verbatim. */
function prettyPrompt(prompt: string): string {
  try {
    return JSON.stringify(JSON.parse(prompt), null, 2)
  } catch {
    return prompt
  }
}

/** The take's label for the row, the deck, and aria: the title plus a session-unique
 * #id for a composed take (so same-title siblings stay tellable apart), or just the
 * name for an imported file (no prompt). */
function trackLabel(track: GeneratedTrack): string {
  return track.prompt != null ? `${track.title} #${track.id}` : track.title
}

/** What the webview sends with a freshly composed take (Rust `songs::NewSong`). */
type NewSong = { title: string; prompt: string; model: TrackEngine }

/** Persist a ready take to ~/Documents/SlipMate/generated_songs through the Rust shell
 * and return its registry entry. Frame [u32 LE meta-JSON length][meta JSON utf-8]
 * [WAV bytes] as one binary payload — the same binary-IPC shape the engine's
 * load/embed commands use (a JSON args map would be megabytes of text for a multi-MB
 * WAV). The old `<a download>` is gone: it silently no-ops in WKWebView. */
function saveGeneratedSong(meta: NewSong, wav: ArrayBuffer): Promise<SongEntry> {
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta))
  const payload = new Uint8Array(4 + metaBytes.length + wav.byteLength)
  new DataView(payload.buffer).setUint32(0, metaBytes.length, true)
  payload.set(metaBytes, 4)
  payload.set(new Uint8Array(wav), 4 + metaBytes.length)
  return invoke<SongEntry>('save_generated_song', payload)
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
  // The take name (and on-disk filename), decoupled from the prompt. Blank → a random
  // song title at compose time, so a long/JSON prompt never becomes the name.
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [engine, setEngine] = useState<TrackEngine>('track')
  const [seconds, setSeconds] = useState(120)
  const [generateError, setGenerateError] = useState<string | null>(null)
  // Auto-save runs after a take is composed; its failure is separate from a
  // generation failure (the take is already playable from memory).
  const [saveError, setSaveError] = useState<string | null>(null)
  const [folderName, setFolderName] = useState<string | null>(null)
  // The native picker's absolute folder path; `read_audio_file` scopes reads to it.
  const [folderPath, setFolderPath] = useState<string | null>(null)
  const [files, setFiles] = useState<FolderFile[]>([])
  const [folderError, setFolderError] = useState<string | null>(null)
  // The rotary highlight for the generate/folder tabs; the crates tab
  // keeps its own inside CrateBrowser (mounted only while visible, so
  // exactly one list answers the hardware at a time).
  const [highlight, setHighlight] = useState(0)
  // The take whose full prompt the 🔍 button has expanded, or null. One at a time.
  const [expandedId, setExpandedId] = useState<number | null>(null)
  // A ref, not state: two composes batched into one render (Enter +
  // click) must not mint the same id.
  const nextIdRef = useRef(1)

  const ready = tracks.filter(
    (track): track is GeneratedTrack & { state: 'ready' } =>
      track.state === 'ready',
  )
  const highlightedReadyId =
    ready.length === 0 ? null : ready[Math.min(highlight, ready.length - 1)].id

  async function loadGeneratedTrack(
    deck: DeckId,
    track: GeneratedTrack & { state: 'ready' },
  ) {
    setGenerateError(null)
    try {
      // In memory for a take composed this session; otherwise read the bytes back
      // from disk (scoped to the songs folder by the Rust shell).
      const label = trackLabel(track)
      let wav = track.wav
      if (!wav) {
        if (!track.file) throw new Error(t('media.undecodable', { title: label }))
        wav = await invoke<ArrayBuffer>('read_generated_song', { name: track.file })
      }
      // decodeAudioData detaches the buffer it is given — hand over a copy so the
      // take can be loaded again (or onto the other deck).
      const loaded = await onLoadTrack(deck, wav.slice(0), label)
      if (!loaded) setGenerateError(t('media.undecodable', { title: label }))
    } catch (error) {
      // The click is fire-and-forget (`void loadGeneratedTrack`), so a rejected
      // read/decode/load would otherwise vanish and look like nothing happened.
      setGenerateError(error instanceof Error ? error.message : String(error))
    }
  }

  const dropTrack = (id: number) =>
    setTracks((current) => current.filter((entry) => entry.id !== id))

  async function removeTrack(track: GeneratedTrack & { state: 'ready' }) {
    // An in-memory-only take (no file, or no native shell) just leaves the list. A
    // persisted one is removed only AFTER the file is moved to the Trash and the
    // registry pruned — so a failed delete keeps the row, matching what's on disk
    // rather than vanishing and then reappearing on the next launch's scan.
    if (!isTauri() || !track.file) {
      dropTrack(track.id)
      return
    }
    try {
      await invoke('delete_generated_song', { name: track.file })
      dropTrack(track.id)
    } catch (error) {
      setSaveError(
        t('media.generate.deleteFailed', {
          title: track.title,
          message: error instanceof Error ? error.message : String(error),
        }),
      )
    }
  }

  async function loadFolderFile(deck: DeckId, file: FolderFile) {
    setFolderError(null)
    try {
      // The Rust command reads the bytes, scoped to the chosen folder.
      const wav = await invoke<ArrayBuffer>('read_audio_file', {
        dir: folderPath,
        name: file.name,
      })
      const loaded = await onLoadTrack(deck, wav, file.name)
      if (!loaded) setFolderError(t('media.undecodable', { title: file.name }))
    } catch (error) {
      setFolderError(error instanceof Error ? error.message : String(error))
    }
  }

  // Restore the take list from the on-disk registry at startup, reconciled against
  // the folder by the Rust shell (files added by hand appear with no model; deleted
  // files drop out). Tauri only — a plain browser has nothing persisted. Restored
  // takes carry no in-memory `wav`; their bytes load from disk on demand.
  useEffect(() => {
    if (!isTauri()) return
    let live = true
    void (async () => {
      try {
        const entries = (await invoke<SongEntry[]>('list_generated_songs')) ?? []
        if (!live) return
        const restored: GeneratedTrack[] = entries.map((entry) => ({
          id: nextIdRef.current++,
          state: 'ready',
          title: entry.title,
          prompt: entry.prompt,
          model: asTrackEngine(entry.model),
          file: entry.file,
        }))
        const restoredFiles = new Set(entries.map((entry) => entry.file))
        // Keep any take composed before this resolved (not in the registry read).
        setTracks((current) => [
          ...restored,
          ...current.filter(
            (track) =>
              track.state !== 'ready' ||
              track.file == null ||
              !restoredFiles.has(track.file),
          ),
        ])
      } catch {
        // A failed scan just means no restored list; composing still works.
      }
    })()
    return () => {
      live = false
    }
  }, [])

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
          void loadGeneratedTrack(intent.deck, ready[index])
        } else {
          void loadFolderFile(intent.deck, files[index])
        }
      }
    }),
  )

  function generateTrack() {
    const trimmedPrompt = prompt.trim()
    if (!trimmedPrompt) return
    const id = nextIdRef.current++
    const requestEngine = engine
    // The name (and on-disk filename) come from the Title field, NOT the prompt — a
    // blank title gets a random song title so a long/JSON prompt never becomes the
    // name. The row appends a session-unique #id to tell same-title siblings apart.
    const songTitle = title.trim() || randomSongTitle()
    setGenerateError(null)
    setSaveError(null)
    setTracks((current) => [
      ...current,
      { id, state: 'pending', title: songTitle, prompt: trimmedPrompt, model: requestEngine },
    ])
    void (async () => {
      try {
        const apiBase = await getApiBaseUrl()
        const response = await fetch(
          `${apiBase}${requestEngine === 'magenta' ? '/api/render' : '/api/generate'}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(
              requestEngine === 'magenta'
                ? { prompt: trimmedPrompt, seconds }
                : { prompt: trimmedPrompt, seconds, kind: requestEngine },
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
              ? {
                  id,
                  state: 'ready',
                  title: songTitle,
                  prompt: trimmedPrompt,
                  model: requestEngine,
                  file: null,
                  wav,
                }
              : track,
          ),
        )
        // Auto-persist to the songs folder so a take is never lost to a webview that
        // can't download. Skipped in a plain browser (no shell to write through); a
        // native write failure is surfaced but leaves the in-memory take playable.
        // On success, stamp the take with its on-disk filename so it survives a
        // restart and can be reloaded/deleted.
        if (isTauri()) {
          try {
            const entry = await saveGeneratedSong(
              { title: songTitle, prompt: trimmedPrompt, model: requestEngine },
              wav,
            )
            setTracks((current) =>
              current.map((track) =>
                track.id === id && track.state === 'ready'
                  ? { ...track, file: entry.file }
                  : track,
              ),
            )
          } catch (error) {
            setSaveError(
              t('media.generate.saveFailed', {
                title: songTitle,
                message: error instanceof Error ? error.message : String(error),
              }),
            )
          }
        }
      } catch (error) {
        setTracks((current) => current.filter((track) => track.id !== id))
        setGenerateError(error instanceof Error ? error.message : String(error))
      }
    })()
  }

  async function chooseFolder() {
    setFolderError(null)
    // The OS folder picker (dialog plugin) + a Rust dir listing — WKWebView has no
    // File System Access API.
    try {
      const dir = await invoke<string | null>('plugin:dialog|open', {
        options: { directory: true, multiple: false },
      })
      if (!dir) return // the user dismissed the picker
      const names = await invoke<string[]>('list_audio_files', { dir })
      setFolderPath(dir)
      setFolderName(dir.replace(/\/+$/, '').split('/').pop() || dir)
      setFiles(names.map((name) => ({ name })))
      setHighlight(0)
    } catch (error) {
      setFolderError(error instanceof Error ? error.message : String(error))
    }
  }

  async function openSongsFolder() {
    setSaveError(null)
    // The Rust shell owns the folder path and reveals it in Finder (the webview
    // can't), so the webview just asks — no path crosses the boundary.
    try {
      await invoke('open_songs_folder')
    } catch (error) {
      setSaveError(
        t('media.generate.openFolderFailed', {
          message: error instanceof Error ? error.message : String(error),
        }),
      )
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
          <div className="media__generate-toolbar">
            <Button onClick={() => void openSongsFolder()}>
              {t('media.generate.openFolder')}
            </Button>
          </div>
          <div className="media__generate-row">
            <div className="media__title-field">
              <TextField
                label={t('media.generate.title')}
                value={title}
                placeholder={t('media.generate.titlePlaceholder')}
                onChange={(event) => setTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') generateTrack()
                }}
              />
            </div>
            <TextField
              label={t('media.generate.prompt')}
              value={prompt}
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
              {tracks.map((track) => {
                // Composed takes (those carrying a prompt) get a #id to tell same-title
                // siblings apart; an imported file shows just its name. The title
                // ellipsises in the row; the tag never shrinks.
                const composed = track.prompt != null
                const rowLabel = trackLabel(track)
                return (
                  <li
                    key={track.id}
                    className={`media__item${
                      track.id === highlightedReadyId
                        ? ' media__item--highlighted'
                        : ''
                    }`}
                  >
                    <span className="media__name">
                      <span className="media__name-text">
                        {track.state === 'pending'
                          ? t('media.generate.pending', { title: track.title })
                          : track.title}
                      </span>
                      {track.state === 'ready' && composed && (
                        <span className="media__name-tag">{`#${track.id}`}</span>
                      )}
                    </span>
                    <span className="media__meta">
                      {track.model == null
                        ? t('media.generate.imported')
                        : t(`media.generate.engines.${track.model}`)}
                    </span>
                    {track.state === 'ready' &&
                      loadButtons(
                        (deck) => void loadGeneratedTrack(deck, track),
                        rowLabel,
                      )}
                    {track.state === 'ready' && track.prompt != null && (
                      <Button
                        aria-label={t('media.generate.inspect', { name: rowLabel })}
                        lit={expandedId === track.id}
                        onClick={() =>
                          setExpandedId((current) =>
                            current === track.id ? null : track.id,
                          )
                        }
                      >
                        🔍
                      </Button>
                    )}
                    {track.state === 'ready' && (
                      <Button
                        aria-label={t('media.remove', { name: rowLabel })}
                        onClick={() => void removeTrack(track)}
                      >
                        ✕
                      </Button>
                    )}
                    {track.state === 'ready' &&
                      track.prompt != null &&
                      expandedId === track.id && (
                        <p className="media__prompt">{prettyPrompt(track.prompt)}</p>
                      )}
                  </li>
                )
              })}
            </ul>
          )}
          {generateError && (
            <p className="media__error" role="alert">
              {t('media.generate.failed', { message: generateError })}
            </p>
          )}
          {saveError && (
            <p className="media__error" role="alert">
              {saveError}
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
                    <span className="media__name-text">{file.name}</span>
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
