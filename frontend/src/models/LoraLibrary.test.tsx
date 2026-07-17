import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ModelProgress, ModelStatus } from '../audio/nativeEngine'

// Capture the subscriber callbacks so tests can fire watcher / progress events.
let changedCb: (() => void) | null = null
let progressCb: ((event: ModelProgress) => void) | null = null
const modelStatus = vi.fn<() => Promise<ModelStatus>>()
const installLora = vi.fn<(source: object, base?: string) => Promise<void>>(async () => {})
const deleteLora = vi.fn<(name: string) => Promise<void>>(async () => {})
const cancelInstall = vi.fn(async () => {})
const openModelFolder = vi.fn<(family: string) => Promise<void>>(async () => {})
const invoke = vi.fn<(cmd: string, args?: object) => Promise<unknown>>(async () => null)

vi.mock('../audio/nativeEngine', () => ({
  modelStatus: () => modelStatus(),
  installLora: (source: object, base?: string) => installLora(source, base),
  deleteLora: (name: string) => deleteLora(name),
  cancelInstall: () => cancelInstall(),
  openModelFolder: (family: string) => openModelFolder(family),
  invoke: (cmd: string, args?: object) => invoke(cmd, args),
  subscribeModelsChanged: (cb: () => void) => {
    changedCb = cb
    return () => {}
  },
  subscribeModelProgress: (cb: (event: ModelProgress) => void) => {
    progressCb = cb
    return () => {}
  },
}))

import { LoraLibrary } from './LoraLibrary'

function status(overrides: Partial<ModelStatus> = {}): ModelStatus {
  return {
    magenta: {
      modelsDir: '/models',
      resourcesPresent: true,
      installable: ['mrt2_small', 'mrt2_base'],
      installed: [],
    },
    sa3: {
      state: 'ready',
      sizeBytes: 5_000_000_000,
      checkout: '/sa3',
      installedSource: null,
      pinnedSource: { repo: 'https://github.com/brxs/stable-audio-3', commit: 'pinned1' },
      updateAvailable: false,
    },
    loras: [],
    installing: null,
    ...overrides,
  }
}

const maqam = {
  name: 'medium/maqam',
  base: 'medium' as const,
  slug: 'maqam',
  sizeBytes: 200_000_000,
  source: 'motiftechnologies/stable-audio-3-maqam-lora',
  adapterType: 'lora',
  rank: 64,
}

beforeEach(() => {
  vi.clearAllMocks()
  changedCb = null
  progressCb = null
})

describe('LoraLibrary', () => {
  it('lists installed adapters with base and size, and deletes one', async () => {
    modelStatus.mockResolvedValue(status({ loras: [maqam] }))
    render(<LoraLibrary />)
    expect(await screen.findByText('maqam')).toBeInTheDocument()
    expect(screen.getByText('Medium DiT (tracks) · 200 MB')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Delete adapter maqam'))
    expect(deleteLora).toHaveBeenCalledWith('medium/maqam')
  })

  it('reveals the registry folder for native inspection', async () => {
    modelStatus.mockResolvedValue(status())
    render(<LoraLibrary />)
    await screen.findByText('No adapters installed')
    fireEvent.click(screen.getByText('Open folder'))
    expect(openModelFolder).toHaveBeenCalledWith('lora')
  })

  it('imports an adapter from a HuggingFace repo id', async () => {
    modelStatus.mockResolvedValue(status())
    render(<LoraLibrary />)
    await screen.findByText('No adapters installed')
    fireEvent.change(screen.getByLabelText('HuggingFace repo'), {
      target: { value: 'owner/my-lora' },
    })
    fireEvent.click(screen.getByText('Install'))
    expect(installLora).toHaveBeenCalledWith({ hfRepo: 'owner/my-lora' }, undefined)
  })

  it('accepts a pasted huggingface.co URL and installs the canonical repo id', async () => {
    modelStatus.mockResolvedValue(status())
    render(<LoraLibrary />)
    await screen.findByText('No adapters installed')
    fireEvent.change(screen.getByLabelText('HuggingFace repo'), {
      target: {
        value: 'https://huggingface.co/motiftechnologies/stable-audio-3-maqam-lora',
      },
    })
    fireEvent.click(screen.getByText('Install'))
    expect(installLora).toHaveBeenCalledWith(
      { hfRepo: 'motiftechnologies/stable-audio-3-maqam-lora' },
      undefined,
    )
  })

  it('passes an explicit base override to a repo import', async () => {
    modelStatus.mockResolvedValue(status())
    render(<LoraLibrary />)
    await screen.findByText('No adapters installed')
    fireEvent.change(screen.getByLabelText('HuggingFace repo'), {
      target: { value: 'owner/xs-lora' },
    })
    fireEvent.change(screen.getByLabelText('Base'), { target: { value: 'medium' } })
    fireEvent.click(screen.getByText('Install'))
    expect(installLora).toHaveBeenCalledWith({ hfRepo: 'owner/xs-lora' }, 'medium')
  })

  it('imports an adapter file through the native picker', async () => {
    modelStatus.mockResolvedValue(status())
    invoke.mockResolvedValue('/downloads/maqam.safetensors')
    render(<LoraLibrary />)
    await screen.findByText('No adapters installed')
    fireEvent.click(screen.getByText('Import file…'))
    await waitFor(() =>
      expect(installLora).toHaveBeenCalledWith(
        { path: '/downloads/maqam.safetensors' },
        undefined,
      ),
    )
    expect(invoke).toHaveBeenCalledWith(
      'plugin:dialog|open',
      expect.objectContaining({ options: expect.anything() }),
    )
  })

  it('shows live import progress, offers cancel, and re-fetches on change', async () => {
    modelStatus.mockResolvedValue(status())
    render(<LoraLibrary />)
    await screen.findByText('No adapters installed')
    act(() =>
      progressCb?.({
        family: 'lora',
        name: 'owner/my-lora',
        stage: 'download',
        message: null,
        file: 'adapter_model.safetensors',
      }),
    )
    expect(screen.getByText(/adapter_model\.safetensors/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('Cancel'))
    expect(cancelInstall).toHaveBeenCalledTimes(1)
    act(() =>
      progressCb?.({ family: 'lora', name: '', stage: 'cancelled', message: null, file: null }),
    )
    act(() => changedCb?.())
    await waitFor(() => expect(modelStatus).toHaveBeenCalledTimes(2))
    // A cancel is a clean stop, never an error banner.
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it("another family's install gates the import buttons without claiming the label", async () => {
    modelStatus.mockResolvedValue(status())
    render(<LoraLibrary />)
    await screen.findByText('No adapters installed')
    fireEvent.change(screen.getByLabelText('HuggingFace repo'), {
      target: { value: 'owner/my-lora' },
    })
    act(() =>
      progressCb?.({ family: 'sa3', name: '', stage: 'install', message: null, file: null }),
    )
    // One install at a time shell-side: both actions disabled, no lora label.
    expect(screen.getByText('Install')).toBeDisabled()
    expect(screen.getByText('Import file…')).toBeDisabled()
    expect(screen.queryByText('Cancel')).toBeNull()
  })

  it("surfaces a lora import error but not another family's", async () => {
    modelStatus.mockResolvedValue(status())
    render(<LoraLibrary />)
    await screen.findByText('No adapters installed')
    act(() =>
      progressCb?.({ family: 'magenta', name: 'mrt2_base', stage: 'error', message: 'no weights', file: null }),
    )
    expect(screen.queryByRole('alert')).toBeNull()
    act(() =>
      progressCb?.({ family: 'lora', name: '', stage: 'error', message: 'not a recognised SA3 LoRA', file: null }),
    )
    expect(screen.getByRole('alert')).toHaveTextContent('not a recognised SA3 LoRA')
  })
})
