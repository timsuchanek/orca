import { useAppStore } from '@/store'
import { upsertStationWorkspaceState } from '@/store/slices/worktrees'

export function upsertStationWorkspaceIntoRendererState(args: {
  workspaceId: string
  name: string
}): {
  repoId: string
  worktreeId: string
  displayName: string
} {
  const currentState = useAppStore.getState()
  const nextState = upsertStationWorkspaceState(currentState, args)
  useAppStore.setState({
    repos: nextState.repos,
    worktreesByRepo: nextState.worktreesByRepo
  })
  return {
    repoId: nextState.repo.id,
    worktreeId: nextState.worktree.id,
    displayName: nextState.worktree.displayName
  }
}

export function saveStationWorkspaceRecord(args: {
  workspaceId: string
  name: string
  repositoryDisplay?: string | null
}) {
  return window.api.stationWorkspace.save(args)
}

export async function attachStationWorkspaceToStore(args: {
  workspaceId: string
  activate: boolean
  openInitialTerminal: boolean
  persist: boolean
}): Promise<{
  workspaceId: string
  repoId: string
  worktreeId: string
  openedTabId: string | null
}> {
  if (args.openInitialTerminal && !args.activate) {
    throw new Error(
      'attachStationWorkspaceToStore requires activate=true when openInitialTerminal=true'
    )
  }

  const workspaceId = args.workspaceId.trim()
  const attached = await window.api.stationWorkspace.attach({ workspaceId })

  if (args.persist) {
    await saveStationWorkspaceRecord({
      workspaceId,
      name: attached.name,
      repositoryDisplay: attached.repositoryDisplay
    })
  }

  const { repoId, worktreeId } = upsertStationWorkspaceIntoRendererState({
    workspaceId,
    name: attached.name
  })

  if (!args.openInitialTerminal) {
    return {
      workspaceId,
      repoId,
      worktreeId,
      openedTabId: null
    }
  }

  const state = useAppStore.getState()
  if (args.activate) {
    if (state.activeRepoId !== repoId) {
      state.setActiveRepo(repoId)
    }
    if (state.activeView !== 'terminal') {
      state.setActiveView('terminal')
    }
    state.setActiveWorktree(worktreeId)
  }

  const beforeTabIds = new Set((useAppStore.getState().tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id))
  await useAppStore
    .getState()
    .openNewTerminalTabInActiveWorkspace(useAppStore.getState().activeGroupIdByWorktree[worktreeId] ?? '')
  const afterTabs = useAppStore.getState().tabsByWorktree[worktreeId] ?? []
  const openedTabId = afterTabs.find((tab) => !beforeTabIds.has(tab.id))?.id ?? null

  return {
    workspaceId,
    repoId,
    worktreeId,
    openedTabId
  }
}
