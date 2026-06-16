import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useAudioEngine } from '../audio/engineContext'
import type { OutputDevice } from '../audio/types'
import { Select, type SelectOption } from './Select'

/** Sentinel value for "no device chosen — system default". An empty string can't
 * collide with a real device name, and is what an absent persisted choice is. */
const DEFAULT_VALUE = ''

type OutputDevicePickerProps = {
  /** The chosen device name owned by the app (empty = system default). */
  value: string
  /** Called once a switch SUCCEEDS — the app persists it. A failed switch
   * never fires this, so the displayed value reverts to `value`. */
  onSelect: (name: string) => void
}

/** Headphone-cue output picker (post-Tauri-cutover): the engine routes the cue
 * to channels 3/4 of a ≥4-channel device, so the list flags which devices can
 * carry it. Composes the design-system Select; loads the device list from the
 * engine on mount and refreshes it each time the menu reopens. A failed switch
 * surfaces an error and leaves the selection where it was (audio undisturbed). */
export function OutputDevicePicker({ value, onSelect }: OutputDevicePickerProps) {
  const { t } = useTranslation()
  const engine = useAudioEngine()
  const [devices, setDevices] = useState<OutputDevice[]>([])
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    engine
      .listOutputDevices()
      .then(setDevices)
      .catch(() => setDevices([]))
  }, [engine])

  useEffect(refresh, [refresh])

  function pick(name: string) {
    // Every choice goes to the engine, including the `DEFAULT_VALUE` sentinel
    // (empty string) — the engine reads that as "the system default device" and
    // reopens it. On success we commit + persist via onSelect; on failure we
    // surface the error and the controlled select snaps back to `value`.
    engine.setOutputDevice(name).then(
      () => {
        setError(null)
        onSelect(name)
      },
      (cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
    )
  }

  const options: SelectOption[] = [
    { value: DEFAULT_VALUE, label: t('mixer.outputDefault') },
    ...devices.map((device) => ({
      value: device.name,
      label: device.cueCapable
        ? t('mixer.outputCue', { name: device.name })
        : t('mixer.outputNoCue', { name: device.name }),
    })),
    // Keep a persisted-but-currently-absent device visible so its name still
    // shows rather than silently snapping to the default.
    ...(value && !devices.some((device) => device.name === value)
      ? [{ value, label: value }]
      : []),
  ]

  return (
    <div className="mixer__phones-device">
      <Select
        label={t('mixer.output')}
        value={value}
        options={options}
        onChange={pick}
        onReopen={refresh}
      />
      {error && (
        <span className="mixer__error" role="alert">
          {t('mixer.outputError', { message: error })}
        </span>
      )}
    </div>
  )
}
