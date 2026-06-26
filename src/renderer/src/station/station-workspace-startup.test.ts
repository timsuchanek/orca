import { beforeEach, describe, expect, it, vi } from 'vitest'

const attachStateMocks = vi.hoisted(() => ({
  upsertStationWorkspaceIntoRendererState: vi.fn()
}))

vi.mock('./station-workspace-attach', () => ({
  upsertStationWorkspaceIntoRendererState: attachStateMocks.upsertStationWorkspaceIntoRendererState
}))

describe('rehydratePersistedStationWorkspaces', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lists persisted workspaces, upserts each one into renderer state, and awaits attach registration before returning', async () => {
    const list = vi.fn().mockResolvedValue([
      {
        workspaceId: 'ws_1',
        name: 'Workspace One',
        repositoryDisplay: 'repo/one',
        addedAt: 1,
        updatedAt: 2
      },
      {
        workspaceId: 'ws_2',
        name: 'Workspace Two',
        repositoryDisplay: 'repo/two',
        addedAt: 3,
        updatedAt: 4
      }
    ])
    const attach = vi.fn().mockImplementation(async ({ workspaceId }: { workspaceId: string }) => ({
      connectionId: `station:${workspaceId}`,
      workspaceId,
      name: workspaceId === 'ws_1' ? 'Workspace One (fresh)' : 'Workspace Two (fresh)',
      repositoryDisplay: `repo/${workspaceId}`,
      cwd: `/tmp/${workspaceId}`
    }))
    const callOrder: string[] = []

    list.mockImplementationOnce(async () => {
      callOrder.push('list')
      return [
        {
          workspaceId: 'ws_1',
          name: 'Workspace One',
          repositoryDisplay: 'repo/one',
          addedAt: 1,
          updatedAt: 2
        },
        {
          workspaceId: 'ws_2',
          name: 'Workspace Two',
          repositoryDisplay: 'repo/two',
          addedAt: 3,
          updatedAt: 4
        }
      ]
    })
    attachStateMocks.upsertStationWorkspaceIntoRendererState.mockImplementation(
      ({ workspaceId, name }: { workspaceId: string; name: string }) => {
        callOrder.push(`upsert:${workspaceId}:${name}`)
        return {
          repoId: `station:${workspaceId}`,
          worktreeId: `station://workspace/${workspaceId}`,
          displayName: name
        }
      }
    )
    attach.mockImplementation(async ({ workspaceId }: { workspaceId: string }) => {
      callOrder.push(`attach:${workspaceId}`)
      return {
        connectionId: `station:${workspaceId}`,
        workspaceId,
        name: workspaceId === 'ws_1' ? 'Workspace One (fresh)' : 'Workspace Two (fresh)',
        repositoryDisplay: `repo/${workspaceId}`,
        cwd: `/tmp/${workspaceId}`
      }
    })

    vi.stubGlobal('window', {
      api: {
        stationWorkspace: {
          list,
          attach,
          save: vi.fn(),
          remove: vi.fn(),
          detach: vi.fn()
        }
      }
    })

    const moduleUnderTest = await import('./station-workspace-startup').catch(() => null)

    expect(moduleUnderTest).not.toBeNull()
    if (!moduleUnderTest) {
      return
    }

    await expect(moduleUnderTest.rehydratePersistedStationWorkspaces()).resolves.toEqual({
      registered: ['ws_1', 'ws_2'],
      failed: []
    })

    expect(callOrder).toEqual([
      'list',
      'upsert:ws_1:Workspace One',
      'attach:ws_1',
      'upsert:ws_2:Workspace Two',
      'attach:ws_2'
    ])
  })

  it('reports failed workspace registrations with their workspace ids and messages', async () => {
    const list = vi.fn().mockResolvedValue([
      {
        workspaceId: 'ws_ok',
        name: 'Workspace Ok',
        repositoryDisplay: 'repo/ok',
        addedAt: 1,
        updatedAt: 2
      },
      {
        workspaceId: 'ws_fail',
        name: 'Workspace Fail',
        repositoryDisplay: 'repo/fail',
        addedAt: 3,
        updatedAt: 4
      }
    ])
    const attach = vi.fn().mockImplementation(async ({ workspaceId }: { workspaceId: string }) => {
      if (workspaceId === 'ws_fail') {
        throw new Error('attach failed')
      }
      return {
        connectionId: `station:${workspaceId}`,
        workspaceId,
        name: 'Workspace Ok (fresh)',
        repositoryDisplay: 'repo/ok',
        cwd: `/tmp/${workspaceId}`
      }
    })

    attachStateMocks.upsertStationWorkspaceIntoRendererState.mockReturnValue({
      repoId: 'station:any',
      worktreeId: 'station://workspace/any',
      displayName: 'ignored'
    })

    vi.stubGlobal('window', {
      api: {
        stationWorkspace: {
          list,
          attach,
          save: vi.fn(),
          remove: vi.fn(),
          detach: vi.fn()
        }
      }
    })

    const moduleUnderTest = await import('./station-workspace-startup')

    await expect(moduleUnderTest.rehydratePersistedStationWorkspaces()).resolves.toEqual({
      registered: ['ws_ok'],
      failed: [{ workspaceId: 'ws_fail', message: 'attach failed' }]
    })
  })
})
