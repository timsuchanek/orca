import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalLayoutSnapshot, WorkspaceSessionState } from '../../../shared/types'
import { stationConnectionId } from '../../../shared/station-connection-id'
import { createTestStore, makeTab, makeTabGroup, makeUnifiedTab } from '../store/slices/store-test-helpers'

type MockTransport = {
  attach: ReturnType<typeof vi.fn>
  connect: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  getPtyId: ReturnType<typeof vi.fn>
  sendInput: ReturnType<typeof vi.fn>
}

const LEAF_ID = '11111111-1111-4111-8111-111111111111'

let currentStore: ReturnType<typeof createTestStore>
let createdTransportOptions: Record<string, unknown>[]
let queuedTransport: MockTransport | null

vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn()
  }
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => currentStore.getState(),
    setState: (partial: Record<string, unknown>) => currentStore.setState(partial as never),
    subscribe: (listener: (state: ReturnType<typeof currentStore.getState>) => void) =>
      currentStore.subscribe(listener)
  }
}))

vi.mock('../components/terminal-pane/pty-transport', () => ({
  createIpcPtyTransport: vi.fn((options: Record<string, unknown>) => {
    createdTransportOptions.push(options)
    if (!queuedTransport) {
      throw new Error('No queued transport')
    }
    return queuedTransport
  })
}))

vi.mock('../components/terminal-pane/remote-runtime-pty-transport', () => ({
  createRemoteRuntimePtyTransport: vi.fn((_environmentId: string, options: Record<string, unknown>) => {
    createdTransportOptions.push(options)
    if (!queuedTransport) {
      throw new Error('No queued transport')
    }
    return queuedTransport
  })
}))

async function flushAsyncTicks(count = 10): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve()
  }
}

function createMockTransport(): MockTransport {
  let ptyId: string | null = null
  return {
    attach: vi.fn(({ existingPtyId }: { existingPtyId: string }) => {
      ptyId = existingPtyId
    }),
    connect: vi.fn().mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
      ptyId = sessionId ?? 'pty-new'
      return { id: ptyId, replay: 'restored-station-output' }
    }),
    resize: vi.fn(),
    getPtyId: vi.fn(() => ptyId),
    sendInput: vi.fn(() => true)
  }
}

function createPane() {
  const container = new EventTarget() as EventTarget & { dataset: Record<string, string> }
  container.dataset = {}
  return {
    id: 1,
    leafId: LEAF_ID,
    stablePaneId: LEAF_ID,
    terminal: {
      cols: 120,
      rows: 40,
      element: {},
      buffer: { active: { type: 'normal', viewportY: 0, baseY: 0, cursorY: 0 } },
      modes: { bracketedPasteMode: false },
      options: { ignoreBracketedPasteMode: false },
      write: vi.fn(),
      resize: vi.fn(),
      clear: vi.fn(),
      scrollToBottom: vi.fn(),
      scrollToLine: vi.fn(),
      scrollLines: vi.fn(),
      paste: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onResize: vi.fn(() => ({ dispose: vi.fn() })),
      onTitleChange: vi.fn(() => ({ dispose: vi.fn() })),
      hasSelection: vi.fn(() => false),
      parser: {
        registerCsiHandler: vi.fn(() => ({ dispose: vi.fn() })),
        registerOscHandler: vi.fn(() => ({ dispose: vi.fn() }))
      }
    },
    container,
    fitAddon: { fit: vi.fn() }
  }
}

function createManager() {
  return {
    setPaneGpuRendering: vi.fn(),
    markPaneHasComplexScriptOutput: vi.fn(),
    rebuildPaneWebgl: vi.fn(),
    getPanes: vi.fn(() => [{ id: 1, leafId: LEAF_ID }]),
    closePane: vi.fn(),
    getActivePane: vi.fn(() => null)
  }
}

function createDeps(worktreeId: string, ptyId = 'station-session-1') {
  return {
    tabId: 'tab-1',
    worktreeId,
    cwd: `/station/${worktreeId}`,
    startup: null,
    restoredLeafId: LEAF_ID,
    restoredPtyIdByLeafId: { [LEAF_ID]: ptyId },
    paneTransportsRef: { current: new Map() },
    paneMode2031Ref: { current: new Map() },
    paneKittyKeyboardModesRef: { current: new Map() },
    paneLastThemeModeRef: { current: new Map() },
    replayingPanesRef: { current: new Map() },
    isActiveRef: { current: true },
    isVisibleRef: { current: true },
    onPtyExitRef: { current: vi.fn() },
    onPtyErrorRef: { current: vi.fn() },
    clearTabPtyId: vi.fn(),
    consumeSuppressedPtyExit: vi.fn(() => false),
    updateTabTitle: vi.fn(),
    setRuntimePaneTitle: vi.fn(),
    clearRuntimePaneTitle: vi.fn(),
    updateTabPtyId: vi.fn(),
    markWorktreeUnread: vi.fn(),
    markTerminalTabUnread: vi.fn(),
    markTerminalPaneUnread: vi.fn(),
    clearWorktreeUnread: vi.fn(),
    clearTerminalTabUnread: vi.fn(),
    clearTerminalPaneUnread: vi.fn(),
    dispatchNotification: vi.fn(),
    onShowSessionRestoredBanner: vi.fn(),
    setCacheTimerStartedAt: vi.fn(),
    syncPanePtyLayoutBinding: vi.fn(),
    clearExitedPanePtyLayoutBinding: vi.fn()
  }
}

describe('restorePersistedStationWorkspaceTerminals', () => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame

  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    currentStore = createTestStore()
    createdTransportOptions = []
    queuedTransport = null
    globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    globalThis.cancelAnimationFrame = vi.fn()
  })

  afterEach(() => {
    if (originalRequestAnimationFrame) {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame
    } else {
      delete (globalThis as { requestAnimationFrame?: typeof requestAnimationFrame })
        .requestAnimationFrame
    }
    if (originalCancelAnimationFrame) {
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame
    } else {
      delete (globalThis as { cancelAnimationFrame?: typeof cancelAnimationFrame })
        .cancelAnimationFrame
    }
    delete (globalThis as { window?: unknown }).window
  })

  it('restores a persisted Station workspace through startup registration and pane reconnect without duplicate terminals', async () => {
    const workspaceId = 'ws_123'
    const repoId = stationConnectionId(workspaceId)
    const worktreeId = `station://workspace/${workspaceId}`
    const stationPtyId = 'ssh:station%3Aws_123@@pty_019efcab63117a93ac4ab54dcae3c910'
    const groupId = 'group-1'
    const terminalLayout: TerminalLayoutSnapshot = {
      root: { type: 'leaf', leafId: LEAF_ID },
      activeLeafId: LEAF_ID,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_ID]: stationPtyId }
    }
    const session: WorkspaceSessionState = {
      activeRepoId: repoId,
      activeWorktreeId: worktreeId,
      activeTabId: 'tab-1',
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab-1', worktreeId, ptyId: stationPtyId })]
      },
      terminalLayoutsByTabId: {
        'tab-1': terminalLayout
      },
      unifiedTabs: {
        [worktreeId]: [
          makeUnifiedTab({
            id: 'tab-1',
            entityId: 'tab-1',
            groupId,
            worktreeId,
            contentType: 'terminal',
            label: 'Station Shell'
          })
        ]
      },
      tabGroups: {
        [worktreeId]: [makeTabGroup({ id: groupId, worktreeId, activeTabId: 'tab-1', tabOrder: ['tab-1'] })]
      },
      activeGroupIdByWorktree: { [worktreeId]: groupId },
      tabGroupLayouts: {
        [worktreeId]: {
          type: 'leaf',
          groupId
        }
      },
      activeWorktreeIdsOnShutdown: [worktreeId]
    }

    const reconnectEvents: string[] = []
    const reconnectPersistedTerminals = currentStore.getState().reconnectPersistedTerminals
    currentStore.setState({
      reconnectPersistedTerminals: vi.fn(async (signal?: AbortSignal) => {
        reconnectEvents.push('reconnect')
        return reconnectPersistedTerminals(signal)
      })
    })

    const startupEvents: string[] = []
    let resolveAttach!: () => void
    const attachBarrier = new Promise<void>((resolve) => {
      resolveAttach = resolve
    })

    ;(globalThis as { window?: unknown }).window = {
      api: {
        stationWorkspace: {
          list: vi.fn(async () => {
            startupEvents.push('list')
            return [
              {
                workspaceId,
                name: 'Station Workspace',
                repositoryDisplay: 'acme/orca',
                addedAt: 1,
                updatedAt: 2
              }
            ]
          }),
          attach: vi.fn(async () => {
            startupEvents.push('attach:start')
            await attachBarrier
            startupEvents.push('attach:resolved')
            return {
              workspaceId,
              name: 'Station Workspace',
              repositoryDisplay: 'acme/orca',
              cwd: `/station/${workspaceId}`
            }
          }),
          save: vi.fn(),
          remove: vi.fn(),
          detach: vi.fn()
        },
        app: {
          awaitFirstWindowStartupServices: vi.fn(async () => {
            startupEvents.push('await-services')
          })
        },
        ssh: {
          connect: vi.fn(),
          needsPassphrasePrompt: vi.fn()
        },
        pty: {
          signal: vi.fn(),
          getMainBufferSnapshot: vi.fn().mockResolvedValue(null),
          getForegroundProcess: vi.fn().mockResolvedValue(null),
          hasChildProcesses: vi.fn().mockResolvedValue(false),
          ackColdRestore: vi.fn(),
          onClearBufferRequest: vi.fn(() => vi.fn()),
          onSerializeBufferRequest: vi.fn(() => vi.fn()),
          declarePendingPaneSerializer: vi.fn().mockResolvedValue(1),
          settlePaneSerializer: vi.fn().mockResolvedValue(undefined),
          clearPendingPaneSerializer: vi.fn().mockResolvedValue(undefined)
        },
        platform: {
          get: vi.fn(() => ({ platform: 'darwin', osRelease: '24.0.0' }))
        },
        notifications: {
          dispatch: vi.fn().mockResolvedValue({ delivered: true }),
          playSound: vi.fn().mockResolvedValue({ played: true })
        },
        runtime: {
          restoreTerminalFit: vi.fn().mockResolvedValue({ restored: true })
        },
        agentStatus: {
          inferInterrupt: vi.fn().mockResolvedValue(false)
        }
      }
    }

    const startupModule = await import('./station-workspace-startup')
    const persistedStationWorkspaces = await startupModule.listPersistedStationWorkspaces()
    await startupModule.hydratePersistedStationWorkspaceState(persistedStationWorkspaces.workspaces)
    currentStore.getState().hydrateWorkspaceSession(session)
    currentStore.getState().hydrateTabsSession(session)
    const startupPromise = startupModule.restorePersistedStationWorkspaceTerminals(undefined, {
      prelistedWorkspaces: persistedStationWorkspaces.workspaces,
      rendererStateHydrated: true
    })
    await flushAsyncTicks()

    expect(currentStore.getState().activeRepoId).toBe(repoId)
    expect(currentStore.getState().activeWorktreeId).toBe(worktreeId)
    expect(currentStore.getState().unifiedTabsByWorktree[worktreeId]).toEqual([
      expect.objectContaining({ id: 'tab-1', worktreeId })
    ])
    expect(currentStore.getState().groupsByWorktree[worktreeId]).toEqual([
      expect.objectContaining({ id: groupId, activeTabId: 'tab-1' })
    ])
    expect(currentStore.getState().layoutByWorktree[worktreeId]).toEqual({
      type: 'leaf',
      groupId
    })
    expect(reconnectEvents).toEqual([])
    expect(startupEvents).toEqual(['list', 'attach:start'])
    expect(currentStore.getState().repos).toEqual([
      expect.objectContaining({ id: repoId, connectionId: repoId })
    ])
    expect(currentStore.getState().worktreesByRepo[repoId]).toEqual([
      expect.objectContaining({ id: worktreeId, repoId })
    ])

    resolveAttach()
    await startupPromise

    expect(startupEvents).toEqual(['list', 'attach:start', 'attach:resolved', 'await-services'])
    expect(reconnectEvents).toEqual(['reconnect'])
    expect(currentStore.getState().tabsByWorktree[worktreeId]).toEqual([
      expect.objectContaining({ id: 'tab-1', ptyId: stationPtyId })
    ])
    expect(currentStore.getState().tabsByWorktree[worktreeId]).toHaveLength(1)
    expect(currentStore.getState().ptyIdsByTabId['tab-1']).toEqual([stationPtyId])

    queuedTransport = createMockTransport()
    const pane = createPane()
    const manager = createManager()
    const deps = createDeps(worktreeId, stationPtyId)
    const { connectPanePty } = await import('../components/terminal-pane/pty-connection')

    connectPanePty(pane as never, manager as never, deps as never)
    await flushAsyncTicks(20)

    const windowApi = (
      globalThis as unknown as {
        window: {
          api: {
            ssh: {
              connect: ReturnType<typeof vi.fn>
              needsPassphrasePrompt: ReturnType<typeof vi.fn>
            }
          }
        }
      }
    ).window.api
    expect(windowApi.ssh.needsPassphrasePrompt).not.toHaveBeenCalled()
    expect(windowApi.ssh.connect).not.toHaveBeenCalled()
    expect(createdTransportOptions[0]).toEqual(expect.objectContaining({ connectionId: repoId }))
    expect(queuedTransport.connect).toHaveBeenCalledTimes(1)
    expect(queuedTransport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: stationPtyId })
    )
    expect(currentStore.getState().tabsByWorktree[worktreeId]).toHaveLength(1)
  })
})
