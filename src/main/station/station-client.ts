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
    )
  }

  createPty(
    workspaceId: string,
    request: StationCreatePtyRequest
  ): Promise<StationCreatePtyResponse> {
    return this.requestJson<StationCreatePtyResponse>(
      'POST',
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/ptys`,
      request
    )
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

  getPtyStreamInfo(workspaceId: string, ptyId: string): Promise<StationStreamInfo> {
    return this.requestJson<StationStreamInfo>(
      'GET',
      this.ptyPath(workspaceId, ptyId, 'stream-info')
    )
  }

  async openPtyStream(workspaceId: string, ptyId: string): Promise<StationWebSocket> {
    const info = await this.getPtyStreamInfo(workspaceId, ptyId)
    try {
      return new this.webSocketCtor(info.url, {
        headers: { Authorization: `Bearer ${info.bearer_token}` }
      })
    } catch (error) {
      const message = sanitizeStationErrorMessage(
        error instanceof Error ? error.message : String(error),
        [this.opts.bearerToken, info.bearer_token]
      )
      throw new Error(`Station PTY stream open failed: ${message}`)
    }
  }

  private async requestJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.request(method, path, body)
    return (await response.json()) as T
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
        error instanceof Error ? error.message : String(error),
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
