import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useAudioEngine } from '../audio/engineContext'
import type { OutputDevice } from '../audio/types'
import { Select, type SelectOption } from './Select'

/** Sentinel for "no device chosen". For the MAIN picker it means the system
 * default output; for the CUE picker it means "same as main" — the cue rides the
 * main device's channels 3/4 (the FLX4 phones jack). An empty string can't
 * collide with a real device name, and is what an absent persisted choice is. */
const DEFAULT_VALUE = ''

type OutputDevicePickerProps = {
  /** 'main' routes the master (its channels 1/2); 'cue' routes the headphone
   * cue (a separate device's 1/2, or the main device's 3/4 when "same as main"). */
  mode: 'main' | 'cue'
  /** The chosen device name owned by the app (empty = the mode's default). */
  value: string
  /** Called once a switch SUCCEEDS — the app persists it. A failed switch
   * never fires this, so the displayed value reverts to `value`. */
  onSelect: (name: string) => void
  /** CUE picker only: the current main device name, so the "same as main" option
   * can flag when the main device can't carry the combined cue (a stereo main —
   * combined needs a ≥4-channel device). */
  mainDeviceName?: string
}

/** Output-device picker for either the master or the headphone cue (dual-mode,
 * ADR-0021). The MAIN picker chooses the master device (master → its 1/2); the
 * CUE picker chooses where the cue plays — "same as main" rides the main device's
 * channels 3/4 (the FLX4 phones jack), or pick any second device for a private
 * cue. Composes the design-system Select; loads the device list from the engine
 * on mount and on each reopen. A failed switch surfaces an error and leaves the
 * selection where it was (audio undisturbed). */
export function OutputDevicePicker({
  mode,
  value,
  onSelect,
  mainDeviceName,
}: OutputDevicePickerProps) {
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
    // Every choice (including the DEFAULT_VALUE sentinel) goes to the engine: the
    // main switch reads "" as the system default; the cue switch reads "" as
    // "same as main". On success we commit + persist via onSelect; on failure we
    // surface the error and the controlled select snaps back to `value`.
    const switchDevice =
      mode === 'main' ? engine.setMainDevice : engine.setCueDevice
    switchDevice(name).then(
      () => {
        setError(null)
        onSelect(name)
      },
      (cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
    )
  }

  // The "same as main" cue option only carries the combined cue when the main
  // device is ≥4 channels. The default device's capability is unknown (it has no
  // name in the list), so assume it works; a named stereo main is flagged.
  const mainIsCueCapable =
    mainDeviceName === '' ||
    devices.some((device) => device.name === mainDeviceName && device.cueCapable)

  const defaultOption: SelectOption =
    mode === 'main'
      ? { value: DEFAULT_VALUE, label: t('mixer.outputDefault') }
      : {
          value: DEFAULT_VALUE,
          label: mainIsCueCapable
            ? t('mixer.cueSameAsMain')
            : t('mixer.cueSameAsMainNoCh'),
        }

  const options: SelectOption[] = [
    defaultOption,
    ...devices.map((device) => ({ value: device.name, label: device.name })),
    // Keep a persisted-but-currently-absent device visible so its name still
    // shows rather than silently snapping to the default.
    ...(value && !devices.some((device) => device.name === value)
      ? [{ value, label: value }]
      : []),
  ]

  return (
    <div className="mixer__phones-device">
      <Select
        label={mode === 'main' ? t('mixer.outputMain') : t('mixer.outputCueDevice')}
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
