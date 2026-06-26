import type { StationClient, StationWebSocket } from '../station/station-client'
import { toAppSshPtyId, toRelaySshPtyId } from './ssh-pty-id'
import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from './types'

type DataCallback = (payload: { id: string; data: string }) => void
type ReplayCallback = (payload: { id: string; data: string }) => void
type ExitCallback = (payload: { id: string; code: number }) => void

const DEFAULT_CWD = '/home/station/workspace'
const DEFAULT_SHELL = 'zsh'
const SOCKET_OPEN = 1

type TrackedPty = {
  ptyId: string
  cwd: string
  title: string
}

type SerializedState = {
  workspaceId: string
  ptys: Array<TrackedPty>
}

export class StationPtyProvider implements IPtyProvider {
  private dataListeners = new Set<DataCallback>()
  private exitListeners = new Set<ExitCallback>()
  private replayListeners = new Set<ReplayCallback>()
  private sockets = new Map<string, StationWebSocket>()
  private trackedPtys = new Map<string, TrackedPty>()
  private pendingWrites = new Map<string, Promise<void>>()
  private writeGenerations = new Map<string, number>()
  private streamOpenGenerations = new Map<string, number>()
  private terminatingPtys = new Set<string>()
  private terminatingClosePromises = new Map<string, Promise<void>>()
  private disposed = false

  constructor(
    private readonly connectionId: string,
    private readonly workspaceId: string,
    private readonly client: StationClient
  ) {}

  hasPty(id: string): boolean {
    let appId: string
    try {
      appId = this.toAppPtyId(this.toRawPtyId(id))
    } catch {
      return false
    }
    return this.trackedPtys.has(appId) && !this.terminatingPtys.has(appId)
  }

  async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    if (opts.sessionId) {
      const appId = this.toAppPtyId(this.toRawPtyId(opts.sessionId))
      const tracked = {
        ptyId: this.toRawPtyId(opts.sessionId),
        cwd: opts.cwd ?? this.trackedPtys.get(appId)?.cwd ?? DEFAULT_CWD,
        title: this.trackedPtys.get(appId)?.title ?? 'orca-shell'
      }
      await this.openAndTrackPty(appId, tracked)
      return {
        id: appId,
        pid: null,
        isReattach: true
      }
    }

    const response = await this.client.createPty(this.workspaceId, {
      name: opts.command ? `orca-${opts.command}` : 'orca-shell',
      argv: [DEFAULT_SHELL],
      cwd: opts.cwd ?? DEFAULT_CWD,
      env: opts.env ?? {},
      rows: opts.rows,
      cols: opts.cols
    })
    const ptySessionId = response.pty.pty_id
    if (typeof ptySessionId !== 'string' || ptySessionId.length === 0) {
      throw new Error('Station PTY create response missing pty_id')
    }
    const appId = this.toAppPtyId(ptySessionId)
    const tracked = {
      ptyId: ptySessionId,
      cwd: opts.cwd ?? response.pty.cwd ?? DEFAULT_CWD,
      title: response.pty.name || (opts.command ? `orca-${opts.command}` : 'orca-shell')
    }
    try {
      await this.openStream(appId, tracked)
    } catch (error) {
      await this.closeSpawnedPty(ptySessionId)
      throw error
    }
    this.trackPty(appId, tracked)
    return {
      id: appId,
      pid: parseStationPid(response.handle.process_id)
    }
  }

  async attach(id: string): Promise<void> {
    const rawPtyId = this.toRawPtyId(id)
    const appId = this.toAppPtyId(rawPtyId)
    if (this.terminatingPtys.has(appId)) {
      return
    }
    if (!this.trackedPtys.has(appId)) {
      const tracked = {
        ptyId: rawPtyId,
        cwd: DEFAULT_CWD,
        title: 'orca-shell'
      }
      await this.openAndTrackPty(appId, tracked)
      return
    }
    await this.openStream(appId)
  }

  write(id: string, data: string): void {
    const appId = this.toAppPtyId(this.toRawPtyId(id))
    if (this.terminatingPtys.has(appId)) {
      return
    }
    const socket = this.sockets.get(appId)
    if (!socket || socket.readyState !== SOCKET_OPEN) {
      this.queueWriteAfterReconnect(appId, Buffer.from(data, 'utf8'))
      return
    }
    socket.send(Buffer.from(data, 'utf8'))
  }

  resize(id: string, cols: number, rows: number): void {
    const appId = this.toAppPtyId(this.toRawPtyId(id))
    if (this.terminatingPtys.has(appId)) {
      return
    }
    const tracked = this.trackedPtys.get(appId)
    if (!tracked) {
      return
    }
    const ptyId = tracked.ptyId
    void this.client.resizePty(this.workspaceId, ptyId, cols, rows).catch((error) => {
      console.error('[station-pty] resize failed', error)
    })
  }

  async shutdown(id: string, opts: { immediate?: boolean; keepHistory?: boolean }): Promise<void> {
    const appId = this.toAppPtyId(this.toRawPtyId(id))
    const tracked = this.trackedPtys.get(appId)
    if (!tracked) {
      return
    }

    if (opts.immediate) {
      const terminatingClose = this.terminatingClosePromises.get(appId)
      if (terminatingClose) {
        return terminatingClose
      }
      this.terminatingPtys.add(appId)
      this.pendingWrites.delete(appId)
      this.writeGenerations.set(appId, this.writeGeneration(appId) + 1)
      const closePromise = this.closeTrackedPty(appId, tracked.ptyId)
      this.terminatingClosePromises.set(appId, closePromise)
      return closePromise
    }

    if (this.terminatingPtys.has(appId)) {
      return
    }
    this.detachLocalPty(appId)
  }

  async sendSignal(_id: string, _signal: string): Promise<void> {
    throw new Error('Station PTY signals are not supported in v0')
  }

  async getCwd(id: string): Promise<string> {
    return this.trackedPtys.get(this.toAppPtyId(this.toRawPtyId(id)))?.cwd ?? DEFAULT_CWD
  }

  async getInitialCwd(id: string): Promise<string> {
    return this.getCwd(id)
  }

  async clearBuffer(_id: string): Promise<void> {
    return undefined
  }

  acknowledgeDataEvent(_id: string, _charCount: number): void {}

  async hasChildProcesses(id: string): Promise<boolean> {
    const appId = this.toAppPtyId(this.toRawPtyId(id))
    return this.trackedPtys.has(appId) && !this.terminatingPtys.has(appId)
  }

  async getForegroundProcess(_id: string): Promise<string | null> {
    return null
  }

  async serialize(ids: string[]): Promise<string> {
    const ptys = ids
      .map((id) => {
        const appId = this.toAppPtyId(this.toRawPtyId(id))
        if (this.terminatingPtys.has(appId)) {
          return undefined
        }
        return this.trackedPtys.get(appId)
      })
      .filter((pty): pty is TrackedPty => pty !== undefined)
    return JSON.stringify({
      workspaceId: this.workspaceId,
      ptys
    } satisfies SerializedState)
  }

  async revive(state: string): Promise<void> {
    const parsed = parseSerializedState(state, this.workspaceId)
    const revivedAppIds: string[] = []
    try {
      for (const entry of parsed.ptys) {
        const appId = this.toAppPtyId(entry.ptyId)
        await this.openAndTrackPty(appId, {
          ptyId: entry.ptyId,
          cwd: entry.cwd || DEFAULT_CWD,
          title: entry.title || 'orca-shell'
        })
        revivedAppIds.push(appId)
      }
    } catch (error) {
      for (const appId of revivedAppIds) {
        this.detachLocalPty(appId)
      }
      throw error
    }
  }

  async listProcesses(): Promise<{ id: string; cwd: string; title: string }[]> {
    return Array.from(this.trackedPtys.entries()).map(([id, tracked]) => ({
      id,
      cwd: tracked.cwd,
      title: tracked.title
    }))
  }

  async getDefaultShell(): Promise<string> {
    return DEFAULT_SHELL
  }

  async getProfiles(): Promise<{ name: string; path: string }[]> {
    return []
  }

  onData(callback: DataCallback): () => void {
    this.dataListeners.add(callback)
    return () => this.dataListeners.delete(callback)
  }

  onReplay(callback: ReplayCallback): () => void {
    this.replayListeners.add(callback)
    return () => this.replayListeners.delete(callback)
  }

  onExit(callback: ExitCallback): () => void {
    this.exitListeners.add(callback)
    return () => this.exitListeners.delete(callback)
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.pendingWrites.clear()
    this.writeGenerations.clear()
    this.streamOpenGenerations.clear()
    this.terminatingPtys.clear()
    this.terminatingClosePromises.clear()
    for (const socket of this.sockets.values()) {
      socket.close()
    }
    this.sockets.clear()
    this.trackedPtys.clear()
    this.dataListeners.clear()
    this.replayListeners.clear()
    this.exitListeners.clear()
  }

  private toRawPtyId(id: string): string {
    return toRelaySshPtyId(this.connectionId, id)
  }

  private toAppPtyId(ptyId: string): string {
    return toAppSshPtyId(this.connectionId, ptyId)
  }

  private trackPty(appId: string, tracked: TrackedPty): void {
    this.trackedPtys.set(appId, tracked)
  }

  private requireTrackedPty(appId: string): TrackedPty {
    const tracked = this.trackedPtys.get(appId)
    if (!tracked) {
      throw new Error(`Unknown Station PTY "${appId}"`)
    }
    return tracked
  }

  private async closeTrackedPty(appId: string, ptyId: string): Promise<void> {
    try {
      await this.client.closePty(this.workspaceId, ptyId)
    } catch (error) {
      this.terminatingPtys.delete(appId)
      throw error
    } finally {
      this.terminatingClosePromises.delete(appId)
    }
    this.detachLocalPty(appId)
    this.emitExit({ id: appId, code: 0 })
  }

  private async openAndTrackPty(appId: string, tracked: TrackedPty): Promise<void> {
    const socket = await this.openStream(appId, tracked)
    if (this.disposed) {
      socket.close()
      throw new Error('Station PTY provider disposed')
    }
    this.trackPty(appId, tracked)
  }

  private async openStream(
    appId: string,
    tracked = this.requireTrackedPty(appId)
  ): Promise<StationWebSocket> {
    if (this.disposed) {
      throw new Error('Station PTY provider disposed')
    }
    const priorSocket = this.sockets.get(appId)
    const generation = (this.streamOpenGenerations.get(appId) ?? 0) + 1
    this.streamOpenGenerations.set(appId, generation)
    const socket = await this.client.openPtyStream(this.workspaceId, tracked.ptyId)
    if (this.disposed) {
      socket.close()
      throw new Error('Station PTY provider disposed')
    }
    if (this.streamOpenGenerations.get(appId) !== generation) {
      socket.close()
      throw new Error('Station PTY stream open superseded')
    }
    socket.on('message', (payload) => {
      if (this.disposed || this.sockets.get(appId) !== socket || !this.trackedPtys.has(appId)) {
        return
      }
      const data = decodeStationMessage(payload)
      if (data === null) {
        return
      }
      this.emitData({ id: appId, data })
    })
    socket.on('close', () => {
      if (this.sockets.get(appId) === socket) {
        this.sockets.delete(appId)
        void this.emitExitIfRemotePtyStopped(appId, tracked.ptyId)
      }
    })
    socket.on('error', (error) => {
      console.error('[station-pty] stream transport error', {
        id: appId,
        error: sanitizeStationPtyTransportError(error)
      })
    })
    this.sockets.set(appId, socket)
    if (priorSocket && priorSocket !== socket && priorSocket.readyState === SOCKET_OPEN) {
      priorSocket.close()
    }
    return socket
  }

  private async emitExitIfRemotePtyStopped(appId: string, ptyId: string): Promise<void> {
    if (
      this.disposed ||
      !this.trackedPtys.has(appId) ||
      this.sockets.has(appId) ||
      this.terminatingPtys.has(appId)
    ) {
      return
    }
    let status: Awaited<ReturnType<StationClient['getPtyStatus']>>
    try {
      status = await this.client.getPtyStatus(this.workspaceId, ptyId)
    } catch (error) {
      console.error('[station-pty] status after stream close failed', {
        id: appId,
        error: sanitizeStationPtyTransportError(error)
      })
      return
    }
    if (
      this.disposed ||
      !this.trackedPtys.has(appId) ||
      this.sockets.has(appId) ||
      this.terminatingPtys.has(appId)
    ) {
      return
    }
    if (status.status !== 'exited' && status.status !== 'missing') {
      return
    }
    this.sockets.delete(appId)
    this.trackedPtys.delete(appId)
    this.emitExit({ id: appId, code: status.exit_code ?? 0 })
  }

  private async closeSpawnedPty(ptyId: string): Promise<void> {
    try {
      await this.client.closePty(this.workspaceId, ptyId)
    } catch {
      // Best-effort cleanup: preserve the original openStream error for callers.
    }
  }

  private emitData(payload: { id: string; data: string }): void {
    for (const callback of this.dataListeners) {
      try {
        callback(payload)
      } catch (error) {
        console.error('[station-pty] data listener failed', {
          id: payload.id,
          error: sanitizeStationPtyTransportError(error)
        })
      }
    }
  }

  private emitExit(payload: { id: string; code: number }): void {
    for (const callback of this.exitListeners) {
      try {
        callback(payload)
      } catch (error) {
        console.error('[station-pty] exit listener failed', {
          id: payload.id,
          error: sanitizeStationPtyTransportError(error)
        })
      }
    }
  }

  private detachLocalPty(appId: string): void {
    this.pendingWrites.delete(appId)
    this.writeGenerations.delete(appId)
    const socket = this.sockets.get(appId)
    this.sockets.delete(appId)
    this.trackedPtys.delete(appId)
    this.streamOpenGenerations.delete(appId)
    this.terminatingPtys.delete(appId)
    this.terminatingClosePromises.delete(appId)
    socket?.close()
  }

  private queueWriteAfterReconnect(appId: string, payload: Buffer): void {
    const prior = this.pendingWrites.get(appId) ?? Promise.resolve()
    const generation = this.writeGeneration(appId)
    const next = prior
      .then(async () => {
        if (
          this.disposed ||
          !this.trackedPtys.has(appId) ||
          this.terminatingPtys.has(appId) ||
          this.writeGeneration(appId) !== generation
        ) {
          return
        }
        let socket = this.sockets.get(appId)
        if (!socket || socket.readyState !== SOCKET_OPEN) {
          await this.openStream(appId)
          socket = this.sockets.get(appId)
        }
        if (
          this.disposed ||
          !this.trackedPtys.has(appId) ||
          this.terminatingPtys.has(appId) ||
          this.writeGeneration(appId) !== generation
        ) {
          this.sockets.get(appId)?.close()
          this.sockets.delete(appId)
          return
        }
        if (!socket || socket.readyState !== SOCKET_OPEN) {
          throw new Error(`Station PTY stream is not open for ${appId}`)
        }
        socket.send(payload)
      })
      .catch((error) => {
        if (isStationPtyStreamOpenSupersededError(error)) {
          return
        }
        console.error('[station-pty] queued write failed', {
          id: appId,
          error: sanitizeStationPtyTransportError(error)
        })
      })
      .finally(() => {
        if (this.pendingWrites.get(appId) === next) {
          this.pendingWrites.delete(appId)
        }
      })
    this.pendingWrites.set(appId, next)
  }

  private writeGeneration(appId: string): number {
    return this.writeGenerations.get(appId) ?? 0
  }
}

function parseStationPid(processId: string): number | null {
  if (!/^-?\d+$/.test(processId)) {
    return null
  }
  const pid = Number(processId)
  return Number.isSafeInteger(pid) ? pid : null
}

function decodeStationMessage(payload: unknown): string | null {
  if (typeof payload === 'string') {
    return payload
  }
  if (payload instanceof Uint8Array) {
    return Buffer.from(payload).toString('utf8')
  }
  if (payload instanceof ArrayBuffer) {
    return Buffer.from(payload).toString('utf8')
  }
  return null
}

function isStationPtyStreamOpenSupersededError(error: unknown): boolean {
  return error instanceof Error && error.message === 'Station PTY stream open superseded'
}

function sanitizeStationPtyTransportError(error: unknown): string {
  let message: string
  if (error instanceof Error) {
    message = error.message
  } else {
    try {
      message = String(error)
    } catch {
      message = '[unprintable error]'
    }
  }
  return message
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"'},\]]+/gi, '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/("bearer_token"\s*:\s*")[^"]*"/gi, '$1[REDACTED]"')
}

function parseSerializedState(state: string, workspaceId: string): SerializedState {
  const parsed = JSON.parse(state) as unknown
  if (!isRecord(parsed)) {
    throw new Error('Invalid Station PTY state')
  }
  const parsedWorkspaceId = parsed.workspaceId
  if (parsedWorkspaceId !== undefined && parsedWorkspaceId !== workspaceId) {
    throw new Error(
      `Station PTY state belongs to workspace "${String(parsedWorkspaceId)}", expected "${workspaceId}"`
    )
  }
  const rawPtys = parsed.ptys
  if (rawPtys === undefined) {
    return { workspaceId, ptys: [] }
  }
  if (!Array.isArray(rawPtys)) {
    throw new Error('Invalid Station PTY state')
  }

  const ptys = new Map<string, TrackedPty>()
  for (const entry of rawPtys) {
    if (!isRecord(entry) || typeof entry.ptyId !== 'string' || entry.ptyId.length === 0) {
      throw new Error('Invalid Station PTY state')
    }
    if (!ptys.has(entry.ptyId)) {
      ptys.set(entry.ptyId, {
        ptyId: entry.ptyId,
        cwd: typeof entry.cwd === 'string' && entry.cwd.length > 0 ? entry.cwd : DEFAULT_CWD,
        title: typeof entry.title === 'string' && entry.title.length > 0 ? entry.title : 'orca-shell'
      })
    }
  }

  return { workspaceId, ptys: Array.from(ptys.values()) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
