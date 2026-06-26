// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  state: {
    activeModal: 'attach-station-workspace',
    modalData: { workspaceId: '  ws_123  ' },
    closeModal: vi.fn()
  },
  attachStationWorkspaceToStore: vi.fn(),
  focusTerminalTabSurface: vi.fn(),
  toastError: vi.fn(),
  mountedRef: { current: true }
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    {
      getState: () => mocks.state
    }
  )
}))

vi.mock('@/hooks/useMountedRef', () => ({
  useMountedRef: () => mocks.mountedRef
}))

vi.mock('@/station/station-workspace-attach', () => ({
  attachStationWorkspaceToStore: mocks.attachStationWorkspaceToStore
}))

vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: mocks.focusTerminalTabSurface
}))

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError
  }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children: React.ReactNode }) => (
    <button {...props}>{children}</button>
  )
}))

vi.mock('@/components/ui/input', () => ({
  Input: ({
    value,
    onChange,
    ...props
  }: React.InputHTMLAttributes<HTMLInputElement> & { value?: string }) => (
    <input
      {...props}
      value={value}
      onChange={onChange}
    />
  )
}))

let root: Root | null = null
let container: HTMLDivElement | null = null

async function renderDialog(): Promise<void> {
  if (!container) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  }

  const { default: AttachStationWorkspaceDialog } = await import('./AttachStationWorkspaceDialog')

  await act(async () => {
    root?.render(<AttachStationWorkspaceDialog />)
  })
}

function clickButton(label: string): void {
  const button = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.includes(label)
  )
  if (!button) {
    throw new Error(`Button not found: ${label}`)
  }
  button.click()
}

describe('AttachStationWorkspaceDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.activeModal = 'attach-station-workspace'
    mocks.state.modalData = { workspaceId: '  ws_123  ' }
    mocks.mountedRef.current = true
    mocks.attachStationWorkspaceToStore.mockResolvedValue({
      workspaceId: 'ws_123',
      repoId: 'station:ws_123',
      worktreeId: 'station://workspace/ws_123',
      openedTabId: 'opened-tab'
    })
  })

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount()
      })
    }
    root = null
    container?.remove()
    container = null
    document.body.innerHTML = ''
  })

  it('attaches through the shared helper, closes the modal, and focuses the opened tab', async () => {
    await renderDialog()

    expect(document.body.textContent).toContain('Attach Station Workspace')

    await act(async () => {
      clickButton('Attach Workspace')
    })

    expect(mocks.attachStationWorkspaceToStore).toHaveBeenCalledWith({
      workspaceId: 'ws_123',
      activate: true,
      openInitialTerminal: true,
      persist: true
    })
    expect(mocks.state.closeModal).toHaveBeenCalledTimes(1)
    expect(mocks.focusTerminalTabSurface).toHaveBeenCalledWith('opened-tab')
  })

  it('skips terminal focus when the helper does not open a tab', async () => {
    mocks.attachStationWorkspaceToStore.mockResolvedValueOnce({
      workspaceId: 'ws_123',
      repoId: 'station:ws_123',
      worktreeId: 'station://workspace/ws_123',
      openedTabId: null
    })

    await renderDialog()

    await act(async () => {
      clickButton('Attach Workspace')
    })

    expect(mocks.state.closeModal).toHaveBeenCalledTimes(1)
    expect(mocks.focusTerminalTabSurface).not.toHaveBeenCalled()
  })
})
