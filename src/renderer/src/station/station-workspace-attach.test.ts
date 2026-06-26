import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  setState: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: mocks.getState,
    setState: mocks.setState
  }
}))

import {
  attachStationWorkspaceToStore,
  upsertStationWorkspaceIntoRendererState
} from './station-workspace-attach'

describe('upsertStationWorkspaceIntoRendererState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', {})
  })

  it('registers the Station repo/worktree in renderer state and returns synthetic ids', () => {
    const state = {
      repos: [],
      worktreesByRepo: {},
      tabsByWorktree: {},
      activeGroupIdByWorktree: {},
      activeRepoId: null,
      activeWorktreeId: null,
      activeView: 'home'
    }

    mocks.getState.mockReturnValue(state)

    const result = upsertStationWorkspaceIntoRendererState({
      workspaceId: 'ws_1234567890',
      name: 'Demo Workspace'
    })

    expect(mocks.setState).toHaveBeenCalledWith({
      repos: [
        expect.objectContaining({
          id: 'station:ws_1234567890',
          displayName: 'Demo Workspace',
          connectionId: 'station:ws_1234567890'
        })
      ],
      worktreesByRepo: {
        'station:ws_1234567890': [
          expect.objectContaining({
            id: 'station://workspace/ws_1234567890',
            repoId: 'station:ws_1234567890',
            displayName: 'Demo Workspace'
          })
        ]
      }
    })
    expect(result).toEqual({
      repoId: 'station:ws_1234567890',
      worktreeId: 'station://workspace/ws_1234567890',
      displayName: 'Demo Workspace'
    })
  })
})

describe('attachStationWorkspaceToStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not activate or open a terminal when both flags are false', async () => {
    const setActiveRepo = vi.fn()
    const setActiveView = vi.fn()
    const setActiveWorktree = vi.fn()
    const openNewTerminalTabInActiveWorkspace = vi.fn()

    mocks.getState.mockReturnValue({
      repos: [],
      worktreesByRepo: {},
      tabsByWorktree: {},
      activeGroupIdByWorktree: {},
      activeRepoId: 'other-repo',
      activeWorktreeId: 'other-worktree',
      activeView: 'home',
      setActiveRepo,
      setActiveView,
      setActiveWorktree,
      openNewTerminalTabInActiveWorkspace
    })

    vi.stubGlobal('window', {
      api: {
        stationWorkspace: {
          attach: vi.fn().mockResolvedValue({
            connectionId: 'station:ws_trimmed',
            workspaceId: 'ws_trimmed',
            name: 'Trimmed Workspace',
            repositoryDisplay: 'repo/name',
            cwd: '/home/station/workspace'
          }),
          save: vi.fn()
        }
      }
    })

    await expect(
      attachStationWorkspaceToStore({
        workspaceId: '  ws_trimmed  ',
        activate: false,
        openInitialTerminal: false,
        persist: false
      })
    ).resolves.toEqual({
      workspaceId: 'ws_trimmed',
      repoId: 'station:ws_trimmed',
      worktreeId: 'station://workspace/ws_trimmed',
      openedTabId: null
    })

    expect(window.api.stationWorkspace.attach).toHaveBeenCalledWith({
      workspaceId: 'ws_trimmed'
    })
    expect(setActiveRepo).not.toHaveBeenCalled()
    expect(setActiveView).not.toHaveBeenCalled()
    expect(setActiveWorktree).not.toHaveBeenCalled()
    expect(openNewTerminalTabInActiveWorkspace).not.toHaveBeenCalled()
  })

  it('rejects opening an initial terminal without activating the workspace', async () => {
    const setActiveRepo = vi.fn()
    const setActiveView = vi.fn()
    const setActiveWorktree = vi.fn()
    const openNewTerminalTabInActiveWorkspace = vi.fn()
    const attach = vi.fn()

    mocks.getState.mockReturnValue({
      repos: [],
      worktreesByRepo: {},
      tabsByWorktree: {},
      activeGroupIdByWorktree: {},
      activeRepoId: 'other-repo',
      activeWorktreeId: 'other-worktree',
      activeView: 'home',
      setActiveRepo,
      setActiveView,
      setActiveWorktree,
      openNewTerminalTabInActiveWorkspace
    })

    vi.stubGlobal('window', {
      api: {
        stationWorkspace: {
          attach,
          save: vi.fn()
        }
      }
    })

    await expect(
      attachStationWorkspaceToStore({
        workspaceId: 'ws_invalid',
        activate: false,
        openInitialTerminal: true,
        persist: false
      })
    ).rejects.toThrow(
      'attachStationWorkspaceToStore requires activate=true when openInitialTerminal=true'
    )

    expect(attach).not.toHaveBeenCalled()
    expect(setActiveRepo).not.toHaveBeenCalled()
    expect(setActiveView).not.toHaveBeenCalled()
    expect(setActiveWorktree).not.toHaveBeenCalled()
    expect(openNewTerminalTabInActiveWorkspace).not.toHaveBeenCalled()
  })

  it('opens one terminal, activates the workspace, and returns the diffed tab id', async () => {
    const setActiveRepo = vi.fn()
    const setActiveView = vi.fn()
    const setActiveWorktree = vi.fn()
    const setTabCustomTitle = vi.fn()
    const openNewTerminalTabInActiveWorkspace = vi.fn(async () => {
      state.tabsByWorktree['station://workspace/ws_opened'] = [
        { id: 'existing-tab' },
        { id: 'opened-tab' }
      ]
    })

    const state = {
      repos: [],
      worktreesByRepo: {},
      tabsByWorktree: {
        'station://workspace/ws_opened': [{ id: 'existing-tab' }]
      },
      activeGroupIdByWorktree: {
        'station://workspace/ws_opened': 'group-1'
      },
      activeRepoId: 'other-repo',
      activeWorktreeId: 'other-worktree',
      activeView: 'home',
      setActiveRepo,
      setActiveView,
      setActiveWorktree,
      setTabCustomTitle,
      openNewTerminalTabInActiveWorkspace
    }

    mocks.getState.mockImplementation(() => state)

    vi.stubGlobal('window', {
      api: {
        stationWorkspace: {
          attach: vi.fn().mockResolvedValue({
            connectionId: 'station:ws_opened',
            workspaceId: 'ws_opened',
            name: 'Opened Workspace',
            repositoryDisplay: 'repo/name',
            cwd: '/home/station/workspace'
          }),
          save: vi.fn()
        }
      }
    })

    await expect(
      attachStationWorkspaceToStore({
        workspaceId: 'ws_opened',
        activate: true,
        openInitialTerminal: true,
        persist: false
      })
    ).resolves.toEqual({
      workspaceId: 'ws_opened',
      repoId: 'station:ws_opened',
      worktreeId: 'station://workspace/ws_opened',
      openedTabId: 'opened-tab'
    })

    expect(setActiveRepo).toHaveBeenCalledWith('station:ws_opened')
    expect(setActiveView).toHaveBeenCalledWith('terminal')
    expect(setActiveWorktree).toHaveBeenCalledWith('station://workspace/ws_opened')
    expect(openNewTerminalTabInActiveWorkspace).toHaveBeenCalledTimes(1)
    expect(openNewTerminalTabInActiveWorkspace).toHaveBeenCalledWith('group-1')
    expect(setTabCustomTitle).toHaveBeenCalledWith('opened-tab', 'Opened Workspace')
  })

  it('persists the attached workspace metadata when requested', async () => {
    const save = vi.fn()

    mocks.getState.mockReturnValue({
      repos: [],
      worktreesByRepo: {},
      tabsByWorktree: {},
      activeGroupIdByWorktree: {},
      activeRepoId: null,
      activeWorktreeId: null,
      activeView: 'home',
      setActiveRepo: vi.fn(),
      setActiveView: vi.fn(),
      setActiveWorktree: vi.fn(),
      openNewTerminalTabInActiveWorkspace: vi.fn()
    })

    vi.stubGlobal('window', {
      api: {
        stationWorkspace: {
          attach: vi.fn().mockResolvedValue({
            connectionId: 'station:ws_persisted',
            workspaceId: 'ws_persisted',
            name: 'Persisted Workspace',
            repositoryDisplay: 'repo/name',
            cwd: '/home/station/workspace'
          }),
          save
        }
      }
    })

    await attachStationWorkspaceToStore({
      workspaceId: 'ws_persisted',
      activate: false,
      openInitialTerminal: false,
      persist: true
    })

    expect(save).toHaveBeenCalledWith({
      workspaceId: 'ws_persisted',
      name: 'Persisted Workspace',
      repositoryDisplay: 'repo/name'
    })
  })
})
