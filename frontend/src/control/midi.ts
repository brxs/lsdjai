/** Web MIDI plumbing for supported DJ controllers (ADR-0005, issue #30).
 * Framework-free so the connect/hot-plug/permission/selection flow is
 * unit-testable with a fake MIDIAccess; the React side lives in useMidi. The
 * link is device-agnostic: it matches connected ports against the injected
 * driver registry (one driver per controller — registry.ts), binds the active
 * device, and sends that driver's position-sync SysEx. Access is only
 * requested from an explicit user gesture — the browser permission prompt
 * should never appear unprompted.
 *
 * In the native shell (Phase 2) there is no browser Web MIDI: tauri-plugin-midi
 * injects `navigator.requestMIDIAccess` as a polyfill over midir/CoreMIDI at
 * webview startup (SysEx + output send included; ports poll every 1 s for
 * hot-plug). The single callsite below is that shim's target, so the same code
 * drives both transports. */

import type { ControllerDriver } from './driver'

export type MidiStatus =
  | 'unsupported'
  | 'idle'
  | 'requesting'
  | 'connected'
  | 'no-device'
  | 'denied'

/** A connected controller the registry recognises: its raw MIDI port name
 * (shown in the picker) paired with the driver that drives it. */
export type MidiDevice = { name: string; driver: ControllerDriver }

export type MidiLink = {
  /** Request access and bind the active controller; safe to call again to
   * retry. */
  connect: () => Promise<void>
  /** Choose which matched controller drives the app (by its port name) when
   * more than one is connected; re-binds immediately. */
  select: (name: string) => void
  /** Send bytes to the active controller (LED feedback); no-op without a
   * device. */
  send: (data: number[]) => void
}

type MidiLinkOptions = {
  /** The controllers to recognise, matched in order (first match wins). */
  drivers: ControllerDriver[]
  onMessage: (data: Uint8Array) => void
  onStatus: (
    status: MidiStatus,
    active: MidiDevice | null,
    available: MidiDevice[],
  ) => void
  /** Injectable for tests; defaults to navigator.requestMIDIAccess. */
  requestAccess?: () => Promise<MIDIAccess>
}

type MatchedPort<Port> = { name: string; driver: ControllerDriver; port: Port }

/** Ports whose name contains a registered driver's fragment, paired with the
 * first such driver — the order of `drivers` decides ties. */
function matchPorts<Port extends MIDIPort>(
  ports: ReadonlyMap<string, Port>,
  drivers: ControllerDriver[],
): MatchedPort<Port>[] {
  const matched: MatchedPort<Port>[] = []
  for (const port of ports.values()) {
    const name = port.name
    if (!name) continue
    const driver = drivers.find((candidate) => name.includes(candidate.nameFragment))
    if (driver) matched.push({ name, driver, port })
  }
  return matched
}

function findOutput(
  outputs: ReadonlyMap<string, MIDIOutput>,
  driver: ControllerDriver,
): MIDIOutput | null {
  for (const port of outputs.values()) {
    if (port.name?.includes(driver.nameFragment)) return port
  }
  return null
}

export function createMidiLink({
  drivers,
  onMessage,
  onStatus,
  requestAccess,
}: MidiLinkOptions): MidiLink {
  const request =
    requestAccess ??
    (typeof navigator !== 'undefined' &&
    typeof navigator.requestMIDIAccess === 'function'
      ? // The position query is SysEx, so ask for it — but a SysEx-only
        // refusal (separate prompt, policy) must not kill the link:
        // everything except the connect-time sync works without it.
        async () => {
          try {
            return await navigator.requestMIDIAccess({ sysex: true })
          } catch {
            return navigator.requestMIDIAccess()
          }
        }
      : null)

  let access: MIDIAccess | null = null
  let boundInput: MIDIInput | null = null
  let output: MIDIOutput | null = null
  // The user's explicit pick (a port name) when several controllers are
  // connected; null means "the first match". Survives re-binds so a chosen
  // device stays chosen across hot-plug events.
  let selectedName: string | null = null

  // Re-scan on every state change so unplugging and replugging a controller
  // mid-set recovers without another permission round-trip.
  function bind(granted: MIDIAccess) {
    const matched = matchPorts(granted.inputs, drivers)
    // Honour an explicit selection while it is still present, otherwise fall
    // back to the first match by registry order — deterministic regardless of
    // the order the OS enumerates the ports.
    let active = matched.find((device) => device.name === selectedName) ?? null
    if (!active) {
      for (const driver of drivers) {
        const device = matched.find((candidate) => candidate.driver === driver)
        if (device) {
          active = device
          break
        }
      }
    }

    // Keep the message handler attached to the active input only.
    const nextInput = active ? active.port : null
    const rebound = nextInput !== boundInput
    if (rebound) {
      if (boundInput) boundInput.onmidimessage = null
      boundInput = nextInput
      if (boundInput) {
        boundInput.onmidimessage = (event) => {
          if (event.data) onMessage(event.data)
        }
      }
    }

    output = active ? findOutput(granted.outputs, active.driver) : null
    // Sync the app to the hardware only on an ACTUAL (re)bind — a freshly bound device.
    // The controller answers the query by reporting all current knob/fader positions,
    // which flow through the translator like any other move; re-sending it on a rescan
    // that did NOT change the bound input would re-assert those physical positions and
    // clobber a software / MCP mixer move. In the native shell tauri-plugin-midi
    // re-enumerates ports ~1 Hz for hot-plug (each firing onstatechange → bind), so the
    // steady-state rescan is frequent. Without the SysEx grant — or a driver with no
    // query — the sync is skipped, not the connection.
    if (rebound && active && granted.sysexEnabled && active.driver.initSysex) {
      output?.send(active.driver.initSysex)
    }

    const available = matched.map(({ name, driver }) => ({ name, driver }))
    onStatus(
      active ? 'connected' : 'no-device',
      active ? { name: active.name, driver: active.driver } : null,
      available,
    )
  }

  return {
    async connect() {
      // Access already granted (a no-device retry): just re-scan, keeping
      // the existing statechange handler single-bound.
      if (access) {
        bind(access)
        return
      }
      if (!request) {
        onStatus('unsupported', null, [])
        return
      }
      onStatus('requesting', null, [])
      let granted: MIDIAccess
      try {
        granted = await request()
      } catch {
        onStatus('denied', null, [])
        return
      }
      access = granted
      granted.onstatechange = () => bind(granted)
      bind(granted)
    },
    select(name) {
      selectedName = name
      if (access) bind(access)
    },
    send(data) {
      output?.send(data)
    },
  }
}
