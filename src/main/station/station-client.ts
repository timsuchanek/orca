import WebSocket from 'ws'

export type StationWorkspacePtyStatus = 'running' | 'exited' | 'missing' | 'unknown'

export type StationWorkspacePty = {
  workspace_id: string
  pty_id: string
  process_id: string
  station_link: string
  name: string
  cwd: string
  argv: string[]
  observed_status?: StationWorkspacePtyStatus | null
  exit_code?: number | null
  kind?: string
  created_at?: string
  updated_at?: string
}

export type StationCreatePtyResponse = {
  pty: StationWorkspacePty
  handle: { pty_id: string; process_id: string; reused: boolean }
}

export type StationPtyStatusResponse = {
  pty_id: string
  status: 'running' | 'exited' | 'missing'
  exit_code?: number | null
}

export type StationCreatePtyRequest = {
  name: string
  argv: string[]
  env?: Record<string, string>
  cwd?: string | null
  rows: number
  cols: number
}

export type StationWorkspaceSummary = {
  id: string
  account_id: string
  name: string
  lifecycle: string
  tombstoned: boolean
  provider_kind?: string | null
  provider_ref?: string | null
  provider_observed?: string | null
  repository_display?: string | null
}

export type StationWorkspaceSourceState = {
  repository_display: string
  remote_url: string
  branch?: string | null
  primary_worktree_path: string
}

export type StationWorkspaceSourceResponse = {
  source: StationWorkspaceSourceState | null
  project_signals?: Record<string, unknown> | null
}

export type StationWorkspaceSshRoute = {
  workspace_id: string
  station_link: string
  host_alias: string
  host: string
  port: number
  user: string
  identities_only: boolean
  ssh_ready: boolean
  route_kind: string
}

export type StationWorkspaceInspectResponse = {
  workspace: StationWorkspaceSummary
  source: StationWorkspaceSourceResponse
  ssh_route?: StationWorkspaceSshRoute | null
  routes: Array<Record<string, unknown>>
  services: Array<Record<string, unknown>>
  agents: Array<Record<string, unknown>>
  ptys: StationWorkspacePty[]
}

export type StationWebSocket = Pick<WebSocket, 'send' | 'close' | 'readyState' | 'on'>
export type StationWebSocketConstructor = new (
  url: string,
  options?: { headers?: Record<string, string> }
) => StationWebSocket

type StationStreamInfo = {
  url: string
  bearer_token: string
}

export class StationClient {
  private readonly baseUrl: string
  private readonly webSocketCtor: StationWebSocketConstructor

  constructor(
    private readonly opts: {
      baseUrl: string
      bearerToken: string
      WebSocketCtor?: StationWebSocketConstructor
    }
  ) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.webSocketCtor = opts.WebSocketCtor ?? (WebSocket as unknown as StationWebSocketConstructor)
  }

  inspectWorkspace(workspaceId: string): Promise<StationWorkspaceInspectResponse> {
    return this.requestJson<StationWorkspaceInspectResponse>(
      'GET',
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/inspect`
    ).then(validateInspectWorkspaceResponse)
  }

  createPty(
    workspaceId: string,
    request: StationCreatePtyRequest
  ): Promise<StationCreatePtyResponse> {
    return this.requestJson<StationCreatePtyResponse>(
      'POST',
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/ptys`,
      request
    ).then(validateCreatePtyResponse)
  }

  async resizePty(workspaceId: string, ptyId: string, cols: number, rows: number): Promise<void> {
    await this.request('POST', this.ptyPath(workspaceId, ptyId, 'resize'), {
      cols,
      rows
    })
  }

  async closePty(workspaceId: string, ptyId: string): Promise<void> {
    await this.request('DELETE', this.ptyPath(workspaceId, ptyId))
  }

  getPtyStatus(workspaceId: string, ptyId: string): Promise<StationPtyStatusResponse> {
    return this.requestJson<StationPtyStatusResponse>(
      'GET',
      this.ptyPath(workspaceId, ptyId, 'status')
    ).then(validatePtyStatusResponse)
  }

  getPtyStreamInfo(workspaceId: string, ptyId: string): Promise<StationStreamInfo> {
    return this.requestJson<StationStreamInfo>(
      'GET',
      this.ptyPath(workspaceId, ptyId, 'stream-info')
    )
  }

  async openPtyStream(workspaceId: string, ptyId: string): Promise<StationWebSocket> {
    const info = await this.getPtyStreamInfo(workspaceId, ptyId)
    if (typeof info?.url !== 'string' || info.url.length === 0) {
      throw new Error('Station PTY stream-info response missing url')
    }
    if (!isWebSocketUrl(info.url)) {
      throw new Error('Station PTY stream-info response had invalid websocket url')
    }
    if (typeof info.bearer_token !== 'string' || info.bearer_token.trim().length === 0) {
      throw new Error('Station PTY stream-info response missing bearer_token')
    }
    try {
      return new this.webSocketCtor(info.url, {
        headers: { Authorization: `Bearer ${info.bearer_token}` }
      })
    } catch (error) {
      const message = sanitizeStationErrorMessage(
        stationErrorMessage(error),
        [this.opts.bearerToken, info.bearer_token]
      )
      throw new Error(`Station PTY stream open failed: ${message}`)
    }
  }

  private async requestJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.request(method, path, body)
    try {
      return (await response.json()) as T
    } catch {
      throw new Error('Station response was not valid JSON')
    }
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    let response: Response
    try {
      response = await fetch(this.endpoint(path), {
        method,
        headers: this.headers(body !== undefined),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      })
    } catch (error) {
      const message = sanitizeStationErrorMessage(
        stationErrorMessage(error),
        [this.opts.bearerToken]
      )
      throw new Error(`Station request failed: ${message}`)
    }

    if (response.ok) {
      return response
    }

    const rawBody = await response.text().catch(() => '')
    const sanitizedBody = sanitizeStationErrorMessage(rawBody || response.statusText, [
      this.opts.bearerToken
    ])
    throw new Error(`Station request failed with status ${response.status}: ${sanitizedBody}`)
  }

  private endpoint(path: string): string {
    return `${this.baseUrl}/${path.replace(/^\/+/, '')}`
  }

  private headers(hasJsonBody: boolean): Record<string, string> {
    return {
      ...(hasJsonBody ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${this.opts.bearerToken}`
    }
  }

  private ptyPath(workspaceId: string, ptyId: string, suffix?: string): string {
    const encodedWorkspaceId = encodeURIComponent(workspaceId)
    const encodedPtyId = encodeURIComponent(ptyId)
    const base = `/v1/workspaces/${encodedWorkspaceId}/pty/${encodedPtyId}`
    return suffix ? `${base}/${suffix}` : base
  }
}

function stationErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  try {
    return String(error)
  } catch {
    return '[unprintable error]'
  }
}

function validatePtyStatusResponse(response: StationPtyStatusResponse): StationPtyStatusResponse {
  if (!isRecord(response) || typeof response.pty_id !== 'string' || response.pty_id.length === 0) {
    throw new Error('Station PTY status response was invalid')
  }
  if (!['running', 'exited', 'missing'].includes(response.status)) {
    throw new Error('Station PTY status response had invalid status')
  }
  return response
}

function validateCreatePtyResponse(response: StationCreatePtyResponse): StationCreatePtyResponse {
  if (
    !isRecord(response) ||
    !isRecord(response.pty) ||
    typeof response.pty.pty_id !== 'string' ||
    response.pty.pty_id.length === 0 ||
    !Array.isArray(response.pty.argv) ||
    typeof response.pty.cwd !== 'string'
  ) {
    throw new Error('Station create PTY response was invalid')
  }
  if (!isRecord(response.handle) || response.handle.pty_id !== response.pty.pty_id) {
    throw new Error('Station create PTY response handle did not match pty')
  }
  return response
}

function validateInspectWorkspaceResponse(
  response: StationWorkspaceInspectResponse
): StationWorkspaceInspectResponse {
  if (
    !isRecord(response) ||
    !isRecord(response.workspace) ||
    typeof response.workspace.id !== 'string' ||
    response.workspace.id.length === 0 ||
    typeof response.workspace.name !== 'string' ||
    response.workspace.name.length === 0 ||
    !isRecord(response.source) ||
    !Array.isArray(response.routes) ||
    !Array.isArray(response.services) ||
    !Array.isArray(response.agents) ||
    !Array.isArray(response.ptys)
  ) {
    throw new Error('Station inspect workspace response was invalid')
  }
  return response
}

function sanitizeStationErrorMessage(message: string, secrets: string[]): string {
  return redactKnownSecrets(
    message
      .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"'},\]]+/gi, '$1[REDACTED]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
      .replace(/("device_token_id"\s*:\s*")[^"]*"/gi, '$1[REDACTED]"')
      .replace(/("device_token_secret"\s*:\s*")[^"]*"/gi, '$1[REDACTED]"')
      .replace(/("bearer_token"\s*:\s*")[^"]*"/gi, '$1[REDACTED]"'),
    secrets
  )
}

function redactKnownSecrets(message: string, secrets: string[]): string {
  let sanitized = message
  for (const secret of secrets) {
    if (!secret) {
      continue
    }
    sanitized = sanitized.split(secret).join('[REDACTED]')
  }
  return sanitized
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isWebSocketUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      (url.protocol === 'ws:' || url.protocol === 'wss:') &&
      url.username.length === 0 &&
      url.password.length === 0
    )
  } catch {
    return false
  }
}
