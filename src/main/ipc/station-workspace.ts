import { ipcMain, type BrowserWindow } from 'electron'
import { StationPtyProvider } from '../providers/station-pty-provider'
import { isStationConnectionId, stationConnectionId } from '../providers/station-pty-id'
import { StationClient } from '../station/station-client'
import { loadStationCredentials, stationBearerToken } from '../station/station-config'
import type { Store } from '../persistence'
import type { StationWorkspaceRecord } from '../../shared/types'
import {
  clearProviderPtyState,
  deletePtyOwnership,
  registerSshPtyProvider,
  unregisterSshPtyProvider
} from './pty'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

const STATION_WORKSPACE_CWD = '/home/station/workspace'
const STATION_WORKSPACE_CHANNELS = [
  'stationWorkspace:attach',
  'stationWorkspace:detach',
  'stationWorkspace:list',
  'stationWorkspace:save',
  'stationWorkspace:remove'
] as const

type StationWorkspaceAttachResult = {
  connectionId: string
  workspaceId: string
  name: string
  repositoryDisplay?: string | null
  cwd: string
}

type ActiveStationWorkspace = {
  connectionId: string
  provider: StationPtyProvider
  metadata: StationWorkspaceAttachResult
  unsubscribeEvents: () => void
}

const activeStationWorkspaces = new Map<string, ActiveStationWorkspace>()
const stationProviderStartupByConnectionId = new Map<string, Promise<void>>()

function createDeferredPromise(): {
  promise: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
} {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

export function awaitStationProviderStartup(
  connectionId: string | null | undefined
): Promise<void> | undefined {
  if (!isStationConnectionId(connectionId)) {
    return undefined
  }
  return stationProviderStartupByConnectionId.get(connectionId)
}

export function wireStationPtyEvents(args: {
  provider: StationPtyProvider
  mainWindow: BrowserWindow
  runtime?: OrcaRuntimeService
}): () => void {
  const unsubs = [
    args.provider.onData((payload) => {
      const seq = args.runtime?.onPtyData(payload.id, payload.data, Date.now())
      if (!args.mainWindow.isDestroyed()) {
        args.mainWindow.webContents.send('pty:data', {
          ...payload,
          ...(typeof seq === 'number' ? { seq, rawLength: payload.data.length } : {})
        })
      }
    }),
    args.provider.onReplay((payload) => {
      if (!args.mainWindow.isDestroyed()) {
        args.mainWindow.webContents.send('pty:replay', payload)
      }
    }),
    args.provider.onExit((payload) => {
      clearProviderPtyState(payload.id)
      deletePtyOwnership(payload.id)
      args.runtime?.onPtyExit(payload.id, payload.code)
      if (!args.mainWindow.isDestroyed()) {
        args.mainWindow.webContents.send('pty:exit', payload)
      }
    })
  ]
  return () => {
    for (const unsubscribe of unsubs) {
      unsubscribe()
    }
  }
}

export function registerStationWorkspaceHandlers(
  mainWindow: BrowserWindow,
  runtime?: OrcaRuntimeService,
  store?: Pick<
    Store,
    'getStationWorkspaces' | 'upsertStationWorkspace' | 'removeStationWorkspace'
  >
): void {
  for (const channel of STATION_WORKSPACE_CHANNELS) {
    ipcMain.removeHandler(channel)
  }

  for (const active of activeStationWorkspaces.values()) {
    active.unsubscribeEvents()
    active.unsubscribeEvents = wireStationPtyEvents({
      provider: active.provider,
      mainWindow,
      runtime
    })
  }

  ipcMain.handle('stationWorkspace:attach', async (_event, rawArgs: unknown) => {
    const { workspaceId } = parseWorkspaceArgs(rawArgs)
    const connectionId = stationConnectionId(workspaceId)
    const existing = activeStationWorkspaces.get(workspaceId)
    if (existing) {
      registerSshPtyProvider(existing.connectionId, existing.provider)
      return existing.metadata
    }
    const startupDeferred = createDeferredPromise()
    stationProviderStartupByConnectionId.set(connectionId, startupDeferred.promise)

    let knownSecrets: string[] = []
    try {
      const credentials = loadStationCredentials()
      const bearerToken = stationBearerToken(credentials)
      knownSecrets = [bearerToken, credentials.deviceTokenId, credentials.deviceTokenSecret]

      const client = new StationClient({
        baseUrl: credentials.apiBaseUrl,
        bearerToken
      })
      const inspected = await client.inspectWorkspace(workspaceId)
      const lifecycle = inspected.workspace.lifecycle.trim().toLowerCase()
      if (inspected.workspace.tombstoned || lifecycle === 'destroyed') {
        throw new Error(`Station workspace "${workspaceId}" workspace is destroyed`)
      }
      const providerObserved = inspected.workspace.provider_observed?.trim().toLowerCase()
      if (providerObserved === 'missing' || providerObserved === 'dead') {
        throw new Error(`Station workspace "${workspaceId}" provider is ${providerObserved}`)
      }

      if (!isStationConnectionId(connectionId)) {
        throw new Error(`Invalid Station connection id for workspace "${workspaceId}"`)
      }

      const provider = new StationPtyProvider(connectionId, workspaceId, client)
      registerSshPtyProvider(connectionId, provider)

      const metadata: StationWorkspaceAttachResult = {
        connectionId,
        workspaceId,
        name: inspected.workspace.name,
        repositoryDisplay:
          inspected.workspace.repository_display ?? inspected.source.source?.repository_display ?? null,
        cwd: STATION_WORKSPACE_CWD
      }
      activeStationWorkspaces.set(workspaceId, {
        connectionId,
        provider,
        metadata,
        unsubscribeEvents: wireStationPtyEvents({
          provider,
          mainWindow,
          runtime
        })
      })
      startupDeferred.resolve()
      return metadata
    } catch (error) {
      startupDeferred.reject(error)
      throw sanitizeStationAttachError(error, knownSecrets)
    } finally {
      if (stationProviderStartupByConnectionId.get(connectionId) === startupDeferred.promise) {
        stationProviderStartupByConnectionId.delete(connectionId)
      }
    }
  })

  ipcMain.handle('stationWorkspace:detach', async (_event, rawArgs: unknown) => {
    const { workspaceId } = parseWorkspaceArgs(rawArgs)
    const active = activeStationWorkspaces.get(workspaceId)
    if (!active) {
      return
    }
    try {
      const activePtyIds = (await active.provider.listProcesses()).map((pty) => pty.id)
      for (const ptyId of activePtyIds) {
        clearProviderPtyState(ptyId)
        deletePtyOwnership(ptyId)
        runtime?.onPtyExit(ptyId, 0)
      }
    } catch {
      // Detach must still tear down the local provider even if Station cannot list PTYs.
    } finally {
      active.unsubscribeEvents()
      unregisterSshPtyProvider(active.connectionId)
      active.provider.dispose()
      activeStationWorkspaces.delete(workspaceId)
    }
  })

  ipcMain.handle('stationWorkspace:list', async () => {
    const records = requireStationWorkspaceStore(store).getStationWorkspaces()
    return records.map(sanitizeStationWorkspaceRecord).sort(compareStationWorkspaceRecords)
  })

  ipcMain.handle('stationWorkspace:save', async (_event, rawArgs: unknown) => {
    const parsed = parseWorkspaceSaveArgs(rawArgs)
    const stationStore = requireStationWorkspaceStore(store)
    const now = Date.now()
    const existing = stationStore
      .getStationWorkspaces()
      .find((record) => record.workspaceId === parsed.workspaceId)
    return stationStore.upsertStationWorkspace({
      workspaceId: parsed.workspaceId,
      name: parsed.name,
      repositoryDisplay: parsed.repositoryDisplay,
      addedAt: existing?.addedAt ?? now,
      updatedAt: now
    })
  })

  ipcMain.handle('stationWorkspace:remove', async (_event, rawArgs: unknown) => {
    const { workspaceId } = parseWorkspaceArgs(rawArgs)
    return requireStationWorkspaceStore(store).removeStationWorkspace(workspaceId)
  })
}

export function resetStationWorkspaceHandlersForTests(): void {
  for (const active of activeStationWorkspaces.values()) {
    active.unsubscribeEvents()
    unregisterSshPtyProvider(active.connectionId)
    active.provider.dispose()
  }
  activeStationWorkspaces.clear()
  stationProviderStartupByConnectionId.clear()
}

function parseWorkspaceArgs(value: unknown): { workspaceId: string } {
  if (!value || typeof value !== 'object') {
    throw new Error('Station workspace id is required')
  }
  const workspaceId = (value as { workspaceId?: unknown }).workspaceId
  if (typeof workspaceId !== 'string' || workspaceId.trim().length === 0) {
    throw new Error('Station workspace id is required')
  }
  return { workspaceId: workspaceId.trim() }
}

function parseWorkspaceSaveArgs(value: unknown): {
  workspaceId: string
  name: string
  repositoryDisplay?: string | null
} {
  const { workspaceId } = parseWorkspaceArgs(value)
  if (!value || typeof value !== 'object') {
    throw new Error('Station workspace payload is required')
  }

  const { name, repositoryDisplay } = value as {
    name?: unknown
    repositoryDisplay?: unknown
  }

  if (typeof name !== 'string') {
    throw new Error('Station workspace name is required')
  }
  if (repositoryDisplay !== undefined && repositoryDisplay !== null && typeof repositoryDisplay !== 'string') {
    throw new Error('Station workspace repository display must be a string or null')
  }

  const trimmedName = name.trim()
  return {
    workspaceId,
    name: trimmedName.length > 0 ? trimmedName : defaultStationWorkspaceName(workspaceId),
    repositoryDisplay
  }
}

function defaultStationWorkspaceName(workspaceId: string): string {
  return `Station ${workspaceId.slice(0, 8)}`
}

function requireStationWorkspaceStore(
  store: Pick<Store, 'getStationWorkspaces' | 'upsertStationWorkspace' | 'removeStationWorkspace'> | undefined
): Pick<Store, 'getStationWorkspaces' | 'upsertStationWorkspace' | 'removeStationWorkspace'> {
  if (!store) {
    throw new Error('Station workspace persistence store is not configured')
  }
  return store
}

function compareStationWorkspaceRecords(
  left: StationWorkspaceRecord,
  right: StationWorkspaceRecord
): number {
  if (left.updatedAt !== right.updatedAt) {
    return right.updatedAt - left.updatedAt
  }
  return left.name.localeCompare(right.name)
}

function sanitizeStationWorkspaceRecord(record: StationWorkspaceRecord): StationWorkspaceRecord {
  return {
    workspaceId: record.workspaceId,
    name: record.name,
    repositoryDisplay: record.repositoryDisplay,
    addedAt: record.addedAt,
    updatedAt: record.updatedAt
  }
}

function sanitizeStationAttachError(error: unknown, knownSecrets: string[]): Error {
  const message = stationAttachErrorMessage(error)
  return new Error(redactKnownSecrets(redactBearerTokens(message), knownSecrets))
}

function stationAttachErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  try {
    return String(error)
  } catch {
    return '[unprintable error]'
  }
}

function redactBearerTokens(message: string): string {
  return message
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"'},\]]+/gi, '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/("device_token_id"\s*:\s*")[^"]*"/gi, '$1[REDACTED]"')
    .replace(/("device_token_secret"\s*:\s*")[^"]*"/gi, '$1[REDACTED]"')
    .replace(/("bearer_token"\s*:\s*")[^"]*"/gi, '$1[REDACTED]"')
}

function redactKnownSecrets(message: string, knownSecrets: string[]): string {
  let sanitized = message
  for (const secret of knownSecrets) {
    if (!secret) {
      continue
    }
    sanitized = sanitized.split(secret).join('[REDACTED]')
  }
  return sanitized
}
