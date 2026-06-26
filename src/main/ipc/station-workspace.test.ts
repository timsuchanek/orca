import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stationConnectionId } from '../providers/station-pty-id'

const {
  handleMock,
  removeHandlerMock,
  loadStationCredentialsMock,
  stationBearerTokenMock,
  inspectWorkspaceMock,
  stationClientCtorMock,
  registerSshPtyProviderMock,
  unregisterSshPtyProviderMock,
  clearProviderPtyStateMock,
  deletePtyOwnershipMock,
  stationProviderInstances,
  stationListProcessesMock,
  destroyWorkspaceMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  loadStationCredentialsMock: vi.fn(),
  stationBearerTokenMock: vi.fn(),
  inspectWorkspaceMock: vi.fn(),
  stationClientCtorMock: vi.fn(),
  registerSshPtyProviderMock: vi.fn(),
  unregisterSshPtyProviderMock: vi.fn(),
  clearProviderPtyStateMock: vi.fn(),
  deletePtyOwnershipMock: vi.fn(),
  stationProviderInstances: [] as unknown[],
  stationListProcessesMock: vi.fn(),
  destroyWorkspaceMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock,
    removeHandler: removeHandlerMock
  }
}))

vi.mock('../station/station-config', () => ({
  loadStationCredentials: loadStationCredentialsMock,
  stationBearerToken: stationBearerTokenMock
}))

vi.mock('../station/station-client', () => ({
  StationClient: class MockStationClient {
    readonly inspectWorkspace = inspectWorkspaceMock
    readonly destroyWorkspace = destroyWorkspaceMock

    constructor(args: unknown) {
      stationClientCtorMock(args)
    }
  }
}))

vi.mock('../providers/station-pty-provider', () => ({
  StationPtyProvider: class MockStationPtyProvider {
    private readonly dataListeners = new Set<(payload: { id: string; data: string }) => void>()
    private readonly replayListeners = new Set<(payload: { id: string; data: string }) => void>()
    private readonly exitListeners = new Set<(payload: { id: string; code: number }) => void>()

    constructor(
      readonly connectionId: string,
      readonly workspaceId: string,
      readonly client: unknown
    ) {
      stationProviderInstances.push(this)
    }

    onData(callback: (payload: { id: string; data: string }) => void): () => void {
      this.dataListeners.add(callback)
      return () => this.dataListeners.delete(callback)
    }

    onReplay(callback: (payload: { id: string; data: string }) => void): () => void {
      this.replayListeners.add(callback)
      return () => this.replayListeners.delete(callback)
    }

    onExit(callback: (payload: { id: string; code: number }) => void): () => void {
      this.exitListeners.add(callback)
      return () => this.exitListeners.delete(callback)
    }

    listProcesses(): Promise<Array<{ id: string; cwd: string; title: string }>> {
      return stationListProcessesMock()
    }

    dispose(): void {}

    emitData(payload: { id: string; data: string }): void {
      for (const callback of this.dataListeners) {
        callback(payload)
      }
    }

    emitReplay(payload: { id: string; data: string }): void {
      for (const callback of this.replayListeners) {
        callback(payload)
      }
    }

    emitExit(payload: { id: string; code: number }): void {
      for (const callback of this.exitListeners) {
        callback(payload)
      }
    }
  }
}))

vi.mock('./pty', () => ({
  registerSshPtyProvider: registerSshPtyProviderMock,
  unregisterSshPtyProvider: unregisterSshPtyProviderMock,
  clearProviderPtyState: clearProviderPtyStateMock,
  deletePtyOwnership: deletePtyOwnershipMock
}))

import {
  registerStationWorkspaceHandlers,
  resetStationWorkspaceHandlersForTests
} from './station-workspace'

function inspectResponse(
  providerObserved: string | null = 'live',
  workspaceOverrides: Record<string, unknown> = {}
) {
  return {
    workspace: {
      id: 'ws_123',
      account_id: 'acct_123',
      name: 'expand-runtime',
      lifecycle: 'Running',
      tombstoned: false,
      provider_kind: 'e2b',
      provider_observed: providerObserved,
      repository_display: 'github.com/expandai/expand',
      ...workspaceOverrides
    },
    source: {
      source: {
        repository_display: 'github.com/expandai/expand',
        remote_url: 'https://github.com/expandai/expand.git',
        branch: 'main',
        primary_worktree_path: '/home/station/workspace'
      },
      project_signals: null
    },
    ssh_route: null,
    routes: [],
    services: [],
    agents: [],
    ptys: []
  }
}

function latestProvider(): {
  dispose: () => void
  emitData: (payload: { id: string; data: string }) => void
  emitReplay: (payload: { id: string; data: string }) => void
  emitExit: (payload: { id: string; code: number }) => void
} {
  const provider = stationProviderInstances.at(-1)
  if (!provider) {
    throw new Error('missing Station PTY provider instance')
  }
  return provider as {
    dispose: () => void
    emitData: (payload: { id: string; data: string }) => void
    emitReplay: (payload: { id: string; data: string }) => void
    emitExit: (payload: { id: string; code: number }) => void
  }
}

describe('registerStationWorkspaceHandlers', () => {
  const handlers = new Map<string, (_event: unknown, args: unknown) => Promise<unknown>>()
  const mainWindow = {
    isDestroyed: vi.fn(() => false),
    webContents: {
      send: vi.fn()
    }
  }
  const runtime = {
    onPtyData: vi.fn(() => 7),
    onPtyExit: vi.fn()
  }

  beforeEach(() => {
    resetStationWorkspaceHandlersForTests()
    handlers.clear()
    stationProviderInstances.length = 0
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    loadStationCredentialsMock.mockReset()
    stationBearerTokenMock.mockReset()
    inspectWorkspaceMock.mockReset()
    stationClientCtorMock.mockReset()
    registerSshPtyProviderMock.mockReset()
    unregisterSshPtyProviderMock.mockReset()
    clearProviderPtyStateMock.mockReset()
    deletePtyOwnershipMock.mockReset()
    stationListProcessesMock.mockReset()
    stationListProcessesMock.mockResolvedValue([
      { id: 'ssh:station%3Aws_123@@pty_1', cwd: '/tmp/one', title: 'orca-shell' }
    ])
    destroyWorkspaceMock.mockReset()
    mainWindow.isDestroyed.mockReturnValue(false)
    mainWindow.webContents.send.mockReset()
    runtime.onPtyData.mockReset()
    runtime.onPtyData.mockReturnValue(7)
    runtime.onPtyExit.mockReset()
    handleMock.mockImplementation((channel: string, handler: (_e: unknown, args: unknown) => Promise<unknown>) => {
      handlers.set(channel, handler)
    })
    loadStationCredentialsMock.mockReturnValue({
      apiBaseUrl: 'http://127.0.0.1:18080',
      deviceTokenId: 'dtok_test',
      deviceTokenSecret: 'station-secret'
    })
    stationBearerTokenMock.mockReturnValue('dtok_test:station-secret')
    inspectWorkspaceMock.mockResolvedValue(inspectResponse())
  })

  it('registers a Station provider and forwards PTY data to runtime and the renderer', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_717_171_717_000)
    registerStationWorkspaceHandlers(mainWindow as never, runtime as never)

    const result = await handlers.get('stationWorkspace:attach')!(null, { workspaceId: 'ws_123' })

    expect(stationClientCtorMock).toHaveBeenCalledWith({
      baseUrl: 'http://127.0.0.1:18080',
      bearerToken: 'dtok_test:station-secret'
    })
    expect(inspectWorkspaceMock).toHaveBeenCalledWith('ws_123')
    expect(registerSshPtyProviderMock).toHaveBeenCalledWith(
      stationConnectionId('ws_123'),
      expect.anything()
    )
    expect(result).toEqual({
      connectionId: stationConnectionId('ws_123'),
      workspaceId: 'ws_123',
      name: 'expand-runtime',
      repositoryDisplay: 'github.com/expandai/expand',
      cwd: '/home/station/workspace'
    })

    latestProvider().emitData({
      id: 'ssh:station%3Aws_123@@pty_1',
      data: 'hello'
    })

    expect(runtime.onPtyData).toHaveBeenCalledWith(
      'ssh:station%3Aws_123@@pty_1',
      'hello',
      1_717_171_717_000
    )
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
      id: 'ssh:station%3Aws_123@@pty_1',
      data: 'hello',
      seq: 7,
      rawLength: 5
    })
  })

  it('trims pasted Station workspace ids before attaching', async () => {
    registerStationWorkspaceHandlers(mainWindow as never, runtime as never)

    const result = await handlers.get('stationWorkspace:attach')!(null, {
      workspaceId: '  ws_123\n'
    })

    expect(inspectWorkspaceMock).toHaveBeenCalledWith('ws_123')
    expect(registerSshPtyProviderMock).toHaveBeenCalledWith(
      stationConnectionId('ws_123'),
      expect.anything()
    )
    expect(result).toMatchObject({
      connectionId: stationConnectionId('ws_123'),
      workspaceId: 'ws_123'
    })
  })

  it('forwards Station PTY exit events and detaches without leaving event wiring active', async () => {
    registerStationWorkspaceHandlers(mainWindow as never, runtime as never)
    await handlers.get('stationWorkspace:attach')!(null, { workspaceId: 'ws_123' })

    const provider = latestProvider()
    const disposeSpy = vi.spyOn(provider, 'dispose')
    provider.emitExit({ id: 'ssh:station%3Aws_123@@pty_1', code: 17 })

    expect(clearProviderPtyStateMock).toHaveBeenCalledWith('ssh:station%3Aws_123@@pty_1')
    expect(deletePtyOwnershipMock).toHaveBeenCalledWith('ssh:station%3Aws_123@@pty_1')
    expect(runtime.onPtyExit).toHaveBeenCalledWith('ssh:station%3Aws_123@@pty_1', 17)
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:exit', {
      id: 'ssh:station%3Aws_123@@pty_1',
      code: 17
    })

    await handlers.get('stationWorkspace:detach')!(null, { workspaceId: 'ws_123' })
    expect(unregisterSshPtyProviderMock).toHaveBeenCalledWith(stationConnectionId('ws_123'))
    expect(disposeSpy).toHaveBeenCalledTimes(1)
    expect(clearProviderPtyStateMock).toHaveBeenCalledWith('ssh:station%3Aws_123@@pty_1')
    expect(deletePtyOwnershipMock).toHaveBeenCalledWith('ssh:station%3Aws_123@@pty_1')
    expect(destroyWorkspaceMock).not.toHaveBeenCalled()

    mainWindow.webContents.send.mockClear()
    runtime.onPtyData.mockClear()
    provider.emitData({ id: 'ssh:station%3Aws_123@@pty_1', data: 'after-detach' })

    expect(runtime.onPtyData).not.toHaveBeenCalled()
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()
  })

  it('notifies runtime about active Station PTYs during detach', async () => {
    registerStationWorkspaceHandlers(mainWindow as never, runtime as never)
    await handlers.get('stationWorkspace:attach')!(null, { workspaceId: 'ws_123' })

    await handlers.get('stationWorkspace:detach')!(null, { workspaceId: 'ws_123' })

    expect(runtime.onPtyExit).toHaveBeenCalledWith('ssh:station%3Aws_123@@pty_1', 0)
  })

  it('detaches and unregisters when active Station PTY listing fails', async () => {
    stationListProcessesMock.mockRejectedValueOnce(new Error('station list failed'))
    registerStationWorkspaceHandlers(mainWindow as never, runtime as never)
    await handlers.get('stationWorkspace:attach')!(null, { workspaceId: 'ws_123' })

    const provider = latestProvider()
    const disposeSpy = vi.spyOn(provider, 'dispose')

    await expect(
      handlers.get('stationWorkspace:detach')!(null, { workspaceId: 'ws_123' })
    ).resolves.toBeUndefined()

    expect(unregisterSshPtyProviderMock).toHaveBeenCalledWith(stationConnectionId('ws_123'))
    expect(disposeSpy).toHaveBeenCalledTimes(1)

    await handlers.get('stationWorkspace:attach')!(null, { workspaceId: 'ws_123' })

    expect(stationProviderInstances).toHaveLength(2)
  })

  it('rejects missing Station credentials without registering a provider', async () => {
    loadStationCredentialsMock.mockImplementation(() => {
      throw new Error(
        'Could not read Station credentials file at /tmp/station-test/credentials.toml'
      )
    })
    registerStationWorkspaceHandlers(mainWindow as never, runtime as never)

    await expect(
      handlers.get('stationWorkspace:attach')!(null, { workspaceId: 'ws_123' })
    ).rejects.toThrow('/tmp/station-test/credentials.toml')
    expect(registerSshPtyProviderMock).not.toHaveBeenCalled()
  })

  it('rejects attach when Station reports a missing or dead provider', async () => {
    inspectWorkspaceMock.mockResolvedValue(inspectResponse('dead'))
    registerStationWorkspaceHandlers(mainWindow as never, runtime as never)

    await expect(
      handlers.get('stationWorkspace:attach')!(null, { workspaceId: 'ws_123' })
    ).rejects.toThrow('provider is dead')
    expect(registerSshPtyProviderMock).not.toHaveBeenCalled()
  })

  it('rejects attach when Station reports a tombstoned workspace', async () => {
    inspectWorkspaceMock.mockResolvedValue(
      inspectResponse('live', { lifecycle: 'Destroyed', tombstoned: true })
    )
    registerStationWorkspaceHandlers(mainWindow as never, runtime as never)

    await expect(
      handlers.get('stationWorkspace:attach')!(null, { workspaceId: 'ws_123' })
    ).rejects.toThrow('workspace is destroyed')
    expect(registerSshPtyProviderMock).not.toHaveBeenCalled()
  })

  it('redacts Station device token values from attach errors', async () => {
    inspectWorkspaceMock.mockRejectedValue(
      new Error(
        'Authorization: Bearer dtok_test:station-secret {"device_token_id":"dtok_test","device_token_secret":"station-secret"}'
      )
    )
    registerStationWorkspaceHandlers(mainWindow as never, runtime as never)

    await expect(
      handlers.get('stationWorkspace:attach')!(null, { workspaceId: 'ws_123' })
    ).rejects.toThrow('[REDACTED]')

    await handlers
      .get('stationWorkspace:attach')!(null, { workspaceId: 'ws_123' })
      .catch((error: Error) => {
        expect(error.message).not.toContain('dtok_test')
        expect(error.message).not.toContain('station-secret')
      })
  })

  it('handles unprintable Station attach errors without replacing them with stringify failures', async () => {
    inspectWorkspaceMock.mockRejectedValue({
      toString: () => {
        throw new Error('stringify failed')
      }
    })
    registerStationWorkspaceHandlers(mainWindow as never, runtime as never)

    await expect(
      handlers.get('stationWorkspace:attach')!(null, { workspaceId: 'ws_123' })
    ).rejects.toThrow('[unprintable error]')
    expect(registerSshPtyProviderMock).not.toHaveBeenCalled()
  })
})
