import { upsertStationWorkspaceIntoRendererState } from './station-workspace-attach'
import { useAppStore } from '@/store'

type StationWorkspaceStartupFailure = {
  workspaceId: string
  message: string
}

async function listPersistedStationWorkspaces(): Promise<{
  workspaces: Awaited<ReturnType<typeof window.api.stationWorkspace.list>>
  failed: StationWorkspaceStartupFailure[]
}> {
  try {
    return {
      workspaces: await window.api.stationWorkspace.list(),
      failed: []
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      workspaces: [],
      failed: [{ workspaceId: '*', message }]
    }
  }
}

function logStationStartupFailures(failures: StationWorkspaceStartupFailure[]): void {
  for (const failure of failures) {
    console.warn(
      `Station workspace startup restore skipped ${failure.workspaceId}: ${failure.message}`
    )
  }
}

export async function hydratePersistedStationWorkspaceState(): Promise<{
  registered: string[]
  failed: StationWorkspaceStartupFailure[]
}> {
  const { workspaces, failed } = await listPersistedStationWorkspaces()
  for (const workspace of workspaces) {
    upsertStationWorkspaceIntoRendererState({
      workspaceId: workspace.workspaceId,
      name: workspace.name
    })
  }
  return {
    registered: workspaces.map((workspace) => workspace.workspaceId),
    failed
  }
}

export async function rehydratePersistedStationWorkspaces(): Promise<{
  registered: string[]
  failed: StationWorkspaceStartupFailure[]
}> {
  const { workspaces, failed: listFailures } = await listPersistedStationWorkspaces()
  if (listFailures.length > 0) {
    return {
      registered: [],
      failed: listFailures
    }
  }
  const results = await Promise.allSettled(
    workspaces.map(async (workspace) => {
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
  const restoreResult = await rehydratePersistedStationWorkspaces()
  logStationStartupFailures(restoreResult.failed)
  await window.api.app.awaitFirstWindowStartupServices()
  options?.onBeforeReconnect?.()
  await useAppStore.getState().reconnectPersistedTerminals(signal)
}
