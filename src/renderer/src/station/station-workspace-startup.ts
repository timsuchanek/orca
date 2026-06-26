import { upsertStationWorkspaceIntoRendererState } from './station-workspace-attach'
import { useAppStore } from '@/store'

type StationWorkspaceStartupFailure = {
  workspaceId: string
  message: string
}

export async function rehydratePersistedStationWorkspaces(): Promise<{
  registered: string[]
  failed: StationWorkspaceStartupFailure[]
}> {
  let persistedWorkspaces: Awaited<ReturnType<typeof window.api.stationWorkspace.list>>
  try {
    persistedWorkspaces = await window.api.stationWorkspace.list()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      registered: [],
      failed: [{ workspaceId: '*', message }]
    }
  }
  const results = await Promise.allSettled(
    persistedWorkspaces.map(async (workspace) => {
      try {
        upsertStationWorkspaceIntoRendererState({
          workspaceId: workspace.workspaceId,
          name: workspace.name
        })
        await window.api.stationWorkspace.attach({
          workspaceId: workspace.workspaceId
        })
        return workspace.workspaceId
      } catch (error) {
        throw {
          workspaceId: workspace.workspaceId,
          cause: error
        }
      }
    })
  )

  const registered: string[] = []
  const failed: StationWorkspaceStartupFailure[] = []

  for (const result of results) {
    if (result.status === 'fulfilled') {
      registered.push(result.value)
      continue
    }
    const reason = result.reason
    const workspaceId =
      typeof reason === 'object' &&
      reason !== null &&
      'workspaceId' in reason &&
      typeof reason.workspaceId === 'string'
        ? reason.workspaceId
        : 'unknown'
    const cause =
      typeof reason === 'object' && reason !== null && 'cause' in reason ? reason.cause : reason
    const message = cause instanceof Error ? cause.message : String(cause)
    failed.push({ workspaceId, message })
  }

  return { registered, failed }
}

export async function restorePersistedStationWorkspaceTerminals(
  signal?: AbortSignal,
  options?: {
    onBeforeReconnect?: () => void
  }
): Promise<void> {
  await rehydratePersistedStationWorkspaces()
  await window.api.app.awaitFirstWindowStartupServices()
  options?.onBeforeReconnect?.()
  await useAppStore.getState().reconnectPersistedTerminals(signal)
}
