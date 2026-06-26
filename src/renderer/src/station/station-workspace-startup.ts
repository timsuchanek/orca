import { upsertStationWorkspaceIntoRendererState } from './station-workspace-attach'
import { useAppStore } from '@/store'

type StationWorkspaceStartupFailure = {
  workspaceId: string
  message: string
}

export type PersistedStationWorkspacesForStartup = Awaited<
  ReturnType<typeof window.api.stationWorkspace.list>
>

export async function listPersistedStationWorkspaces(): Promise<{
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

export function logStationStartupFailures(failures: StationWorkspaceStartupFailure[]): void {
  for (const failure of failures) {
    console.warn(
      `Station workspace startup restore skipped ${failure.workspaceId}: ${failure.message}`
    )
  }
}

export async function hydratePersistedStationWorkspaceState(
  prelistedWorkspaces?: PersistedStationWorkspacesForStartup
): Promise<{
  registered: string[]
  failed: StationWorkspaceStartupFailure[]
}> {
  const listed = prelistedWorkspaces
    ? { workspaces: prelistedWorkspaces, failed: [] }
    : await listPersistedStationWorkspaces()
  const { workspaces, failed: listFailures } = listed
  const registered: string[] = []
  const failed = [...listFailures]
  for (const workspace of workspaces) {
    try {
      upsertStationWorkspaceIntoRendererState({
        workspaceId: workspace.workspaceId,
        name: workspace.name
      })
      registered.push(workspace.workspaceId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failed.push({ workspaceId: workspace.workspaceId, message })
    }
  }
  return {
    registered,
    failed
  }
}

export async function rehydratePersistedStationWorkspaces(
  prelistedWorkspaces?: PersistedStationWorkspacesForStartup,
  options?: {
    rendererStateHydrated?: boolean
  }
): Promise<{
  registered: string[]
  failed: StationWorkspaceStartupFailure[]
}> {
  const listed = prelistedWorkspaces
    ? { workspaces: prelistedWorkspaces, failed: [] }
    : await listPersistedStationWorkspaces()
  const { workspaces, failed: listFailures } = listed
  if (listFailures.length > 0) {
    return {
      registered: [],
      failed: listFailures
    }
  }
  const results = await Promise.allSettled(
    workspaces.map(async (workspace) => {
      try {
        if (!options?.rendererStateHydrated) {
          upsertStationWorkspaceIntoRendererState({
            workspaceId: workspace.workspaceId,
            name: workspace.name
          })
        }
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
    prelistedWorkspaces?: PersistedStationWorkspacesForStartup
    rendererStateHydrated?: boolean
  }
): Promise<void> {
  const restoreResult = await rehydratePersistedStationWorkspaces(options?.prelistedWorkspaces, {
    rendererStateHydrated: options?.rendererStateHydrated
  })
  logStationStartupFailures(restoreResult.failed)
  await window.api.app.awaitFirstWindowStartupServices()
  options?.onBeforeReconnect?.()
  await useAppStore.getState().reconnectPersistedTerminals(signal)
}
