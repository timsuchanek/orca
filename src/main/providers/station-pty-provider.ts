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

  constructor(
    private readonly connectionId: string,
    private readonly workspaceId: string,
    private readonly client: StationClient
  ) {}

  hasPty(id: string): boolean {
    return this.trackedPtys.has(id)
  }

  async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    if (opts.sessionId) {
      const appId = this.toAppPtyId(this.toRawPtyId(opts.sessionId))
      this.trackPty(appId, {
        ptyId: this.toRawPtyId(opts.sessionId),
        cwd: opts.cwd ?? this.trackedPtys.get(appId)?.cwd ?? DEFAULT_CWD,
        title: this.trackedPtys.get(appId)?.title ?? 'orca-shell'
      })
      await this.openStream(appId)
      return {
        id: appId,
        pid: null,
        isReattach: true
      }
    }

    const response = await this.client.createPty(this.workspaceId, {
      name: opts.command ? `orca-${opts.command}` : 'orca-shell',
      argv: [opts.command ?? DEFAULT_SHELL],
      cwd: opts.cwd ?? DEFAULT_CWD,
      env: opts.env ?? {},
      rows: opts.rows,
      cols: opts.cols
    })
    const appId = this.toAppPtyId(response.handle.pty_id)
    const tracked = {
      ptyId: response.handle.pty_id,
      cwd: opts.cwd ?? response.pty.cwd ?? DEFAULT_CWD,
      title: response.pty.name || (opts.command ? `orca-${opts.command}` : 'orca-shell')
    }
    try {
      await this.openStream(appId, tracked)
    } catch (error) {
      await this.closeSpawnedPty(response.handle.pty_id)
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
    if (!this.trackedPtys.has(appId)) {
      this.trackPty(appId, {
        ptyId: rawPtyId,
        cwd: DEFAULT_CWD,
        title: 'orca-shell'
      })
    }
    await this.openStream(appId)
  }

  write(id: string, data: string): void {
    const appId = this.toAppPtyId(this.toRawPtyId(id))
    const socket = this.sockets.get(appId)
    if (!socket || socket.readyState !== SOCKET_OPEN) {
      throw new Error(`Station PTY stream is not open for ${appId}`)
    }
    socket.send(Buffer.from(data, 'utf8'))
  }

  resize(id: string, cols: number, rows: number): void {
    const appId = this.toAppPtyId(this.toRawPtyId(id))
    const ptyId = this.requireTrackedPty(appId).ptyId
    void this.client.resizePty(this.workspaceId, ptyId, cols, rows).catch((error) => {
      console.error('[station-pty] resize failed', error)
    })
  }

  async shutdown(id: string, _opts: { immediate?: boolean; keepHistory?: boolean }): Promise<void> {
    const appId = this.toAppPtyId(this.toRawPtyId(id))
    const tracked = this.requireTrackedPty(appId)
    await this.client.closePty(this.workspaceId, tracked.ptyId)

    const socket = this.sockets.get(appId)
    this.sockets.delete(appId)
    this.trackedPtys.delete(appId)
    socket?.close()
    this.emitExit({ id: appId, code: 0 })
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

  async hasChildProcesses(_id: string): Promise<boolean> {
    return true
  }

  async getForegroundProcess(_id: string): Promise<string | null> {
    return null
  }

  async serialize(ids: string[]): Promise<string> {
    const ptys = ids
      .map((id) => this.trackedPtys.get(this.toAppPtyId(this.toRawPtyId(id))))
      .filter((pty): pty is TrackedPty => pty !== undefined)
    return JSON.stringify({
      workspaceId: this.workspaceId,
      ptys
    } satisfies SerializedState)
  }

  async revive(state: string): Promise<void> {
    const parsed = JSON.parse(state) as Partial<SerializedState>
    if (parsed.workspaceId && parsed.workspaceId !== this.workspaceId) {
      throw new Error(
        `Station PTY state belongs to workspace "${parsed.workspaceId}", expected "${this.workspaceId}"`
      )
    }
    for (const entry of parsed.ptys ?? []) {
      const appId = this.toAppPtyId(entry.ptyId)
      this.trackPty(appId, {
        ptyId: entry.ptyId,
        cwd: entry.cwd || DEFAULT_CWD,
        title: entry.title || 'orca-shell'
      })
      await this.openStream(appId)
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

  private async openStream(appId: string, tracked = this.requireTrackedPty(appId)): Promise<void> {
    const priorSocket = this.sockets.get(appId)
    if (priorSocket && priorSocket.readyState === SOCKET_OPEN) {
      priorSocket.close()
    }
    const socket = await this.client.openPtyStream(this.workspaceId, tracked.ptyId)
    socket.on('message', (payload) => {
      const data = decodeStationMessage(payload)
      if (data === null) {
        return
      }
      this.emitData({ id: appId, data })
    })
    socket.on('close', () => {
      if (this.sockets.get(appId) === socket) {
        this.sockets.delete(appId)
      }
    })
    socket.on('error', (error) => {
      console.error('[station-pty] stream transport error', {
        id: appId,
        error: sanitizeStationPtyTransportError(error)
      })
    })
    this.sockets.set(appId, socket)
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
      callback(payload)
    }
  }

  private emitExit(payload: { id: string; code: number }): void {
    for (const callback of this.exitListeners) {
      callback(payload)
    }
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

function sanitizeStationPtyTransportError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"'},\]]+/gi, '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/("bearer_token"\s*:\s*")[^"]*"/gi, '$1[REDACTED]"')
}
