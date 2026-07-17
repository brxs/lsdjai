import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '../ui/Button'
import { Select } from '../ui/Select'
import { TextField } from '../ui/TextField'
import {
  cancelInstall,
  deleteLora,
  installLora,
  invoke,
  modelStatus,
  openModelFolder,
  subscribeModelProgress,
  subscribeModelsChanged,
  type LoraBase,
  type ModelProgress,
  type ModelStatus,
} from '../audio/nativeEngine'
import { formatBytes } from './formatBytes'

/** Accept what people actually paste as a repo: a bare `owner/name` id or a
 * full huggingface.co URL (scheme/host, a /tree/… suffix, query, fragment).
 * Best-effort — anything without a recognisable id inside passes through
 * unchanged and the shell's validation names the problem. Mirrors the Rust
 * `loras::normalize_hf_repo`. */
function normalizeHfRepo(input: string): string {
  const rest = input
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/^(www\.)?(huggingface\.co|hf\.co)\//, '')
    .split(/[?#]/)[0]
  const segments = rest.split('/').filter(Boolean)
  return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : input.trim()
}

/** The LoRA library (issue #66): list / import / delete Stable Audio 3 LoRA
 * adapters, its own settings section beside the model manager. Same shape as
 * the manager — Rust owns the lifecycle, this reads `model_status` and drives
 * the import commands, and the in-flight install survives a drawer
 * close/reopen via the status snapshot. */
export function LoraLibrary() {
  const { t } = useTranslation()
  const [status, setStatus] = useState<ModelStatus | null>(null)
  // The in-flight install across ALL families — the shell runs one install at
  // a time, so a Magenta/SA3 download gates the import buttons here too; only
  // lora events surface as this section's label/error.
  const [inflight, setInflight] = useState<ModelProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The import controls: a HuggingFace repo/link draft and the base override
  // ('auto' = infer from the adapter's shapes, the normal case).
  const [repo, setRepo] = useState('')
  const [base, setBase] = useState<'auto' | LoraBase>('auto')

  const refresh = useCallback(() => {
    modelStatus().then(setStatus).catch(() => {})
  }, [])

  useEffect(() => {
    refresh()
    const unsubChanged = subscribeModelsChanged(refresh)
    const unsubProgress = subscribeModelProgress((event) => {
      // `done` (success) and `cancelled` (user stop) both just clear the
      // in-flight UI; the follow-up `models://changed` reflects the new state.
      if (event.stage === 'done' || event.stage === 'cancelled') {
        setInflight(null)
        setError(null)
      } else if (event.stage === 'error') {
        setInflight(null)
        // Another family's failure is the model manager's story to tell.
        if (event.family === 'lora') {
          setError(event.message ?? t('modelManager.stage.error'))
        }
      } else {
        setInflight(event)
        if (event.family === 'lora') setError(null)
      }
    })
    return () => {
      unsubChanged()
      unsubProgress()
    }
  }, [refresh, t])

  const onInstall = useCallback(
    (source: { hfRepo: string } | { path: string }, name: string) => {
      setError(null)
      // The display name mirrors the Rust spec's display_name (the progress
      // event key), so the pending label shows before the first event lands.
      setInflight({ family: 'lora', name, stage: 'fetch', message: null, file: null })
      installLora(source, base === 'auto' ? undefined : base).catch((e: unknown) => {
        setInflight(null)
        setError(String(e))
      })
    },
    [base],
  )

  const onImportFile = useCallback(() => {
    void (async () => {
      // The native file picker (dialog plugin) — WKWebView has no File System
      // Access API. Only .safetensors is offered (ADR-0028's trust boundary;
      // the shell refuses anything else anyway).
      const path = await invoke<string | null>('plugin:dialog|open', {
        options: {
          multiple: false,
          filters: [{ name: t('modelManager.loraFileFilter'), extensions: ['safetensors'] }],
        },
      }).catch(() => null)
      if (!path) return // the user dismissed the picker
      const name = path.replace(/\/+$/, '').split('/').pop() || path
      onInstall({ path }, name)
    })()
  }, [onInstall, t])

  const onDelete = useCallback((name: string) => {
    setError(null)
    // The follow-up `models://changed` refreshes the list.
    deleteLora(name).catch((e: unknown) => setError(String(e)))
  }, [])

  if (!status) {
    return <p className="modelmgr__empty">{t('modelManager.loading')}</p>
  }

  const snapshot = status.installing
  const isInstalling = inflight !== null || snapshot !== null
  // The in-flight import's label — live event (detailed) or status snapshot.
  const label =
    inflight?.family === 'lora'
      ? (() => {
          const stage = t(`modelManager.stage.${inflight.stage}`, {
            defaultValue: inflight.stage,
          })
          // The keyed stage carries the wording; only the file (data) rides along.
          return inflight.file ? `${stage} ${inflight.file}` : stage
        })()
      : snapshot?.family === 'lora'
        ? t('modelManager.installing')
        : null
  const repoDraft = normalizeHfRepo(repo)

  return (
    <div>
      {error && (
        <p className="modelmgr__error" role="alert">
          {t('modelManager.errorPrefix', { message: error })}
        </p>
      )}

      <section className="modelmgr__section">
        <div className="modelmgr__section-head">
          <h4 className="modelmgr__subheading">{t('modelManager.loras')}</h4>
          <Button onClick={() => openModelFolder('lora')}>{t('modelManager.openFolder')}</Button>
        </div>
        {status.loras.length === 0 && (
          <p className="modelmgr__empty">{t('modelManager.loraNone')}</p>
        )}
        {status.loras.map((adapter) => (
          <div className="modelmgr__row" key={adapter.name}>
            <div className="modelmgr__row-main">
              <div className="modelmgr__name">{adapter.slug}</div>
              <div className="modelmgr__meta">
                {t(`modelManager.loraBase.${adapter.base}`)}
                {` · ${formatBytes(adapter.sizeBytes)}`}
              </div>
            </div>
            <div className="modelmgr__actions">
              <Button
                aria-label={t('modelManager.loraDelete', { name: adapter.slug })}
                onClick={() => onDelete(adapter.name)}
              >
                ✕
              </Button>
            </div>
          </div>
        ))}
        <div className="modelmgr__import">
          <div className="modelmgr__import-repo">
            <TextField
              label={t('modelManager.loraRepo')}
              value={repo}
              placeholder={t('modelManager.loraRepoPlaceholder')}
              onChange={(event) => setRepo(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && repoDraft && !isInstalling) {
                  onInstall({ hfRepo: repoDraft }, repoDraft)
                }
              }}
            />
          </div>
          <Select
            label={t('modelManager.loraBaseLabel')}
            value={base}
            options={[
              { value: 'auto', label: t('modelManager.loraBaseAuto') },
              { value: 'small', label: t('modelManager.loraBase.small') },
              { value: 'medium', label: t('modelManager.loraBase.medium') },
            ]}
            onChange={(value) => setBase(value as 'auto' | LoraBase)}
          />
          {label ? (
            <Button onClick={() => cancelInstall()}>{t('modelManager.cancel')}</Button>
          ) : (
            <>
              <Button
                variant="primary"
                disabled={!repoDraft || isInstalling}
                onClick={() => onInstall({ hfRepo: repoDraft }, repoDraft)}
              >
                {t('modelManager.install')}
              </Button>
              <Button disabled={isInstalling} onClick={onImportFile}>
                {t('modelManager.loraImportFile')}
              </Button>
            </>
          )}
        </div>
        {label && <div className="modelmgr__progress">{label}</div>}
      </section>
    </div>
  )
}
