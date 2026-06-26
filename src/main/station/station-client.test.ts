import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  StationClient,
  type StationCreatePtyRequest,
  type StationWebSocketConstructor,
  type StationWorkspaceInspectResponse
} from './station-client'

class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  readonly send = vi.fn()
  readonly close = vi.fn()
  readonly on = vi.fn<(event: string, listener: (...args: unknown[]) => void) => FakeWebSocket>(
    () => this
  )
  readonly readyState = 0

  constructor(
    readonly url: string,
    readonly options?: { headers?: Record<string, string> }
  ) {
    FakeWebSocket.instances.push(this)
  }
}

const ORIGINAL_FETCH = globalThis.fetch

function okJsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

function inspectResponse(): StationWorkspaceInspectResponse {
  return {
    workspace: {
      id: 'ws_123',
      account_id: 'acct_123',
      name: 'expand-runtime',
      lifecycle: 'Running',
      tombstoned: false,
      provider_kind: 'e2b',
      provider_observed: 'live',
      repository_display: 'github.com/expandai/expand'
    },
    source: {
      source: {
        repository_display: 'github.com/expandai/expand',
        remote_url: 'https://github.com/expandai/expand.git',
        branch: 'main',
        primary_worktree_path: '/home/station/workspace'
      },
      project_signals: null
    },
    ssh_route: null,
    routes: [],
    services: [],
    agents: [],
    ptys: []
  }
}

describe('StationClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    FakeWebSocket.instances = []
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH
  })

  it('sends HTTP requests with the Station device bearer token', async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse(inspectResponse()))
    const client = new StationClient({
      baseUrl: 'http://127.0.0.1:18080///',
      bearerToken: 'dtok_test:secret'
    })

    await expect(client.inspectWorkspace('ws_123')).resolves.toEqual(inspectResponse())
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:18080/v1/workspaces/ws_123/inspect',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer dtok_test:secret'
        })
      })
    )
  })

  it('creates tracked PTYs through the Station workspace ptys endpoint', async () => {
    fetchMock.mockResolvedValueOnce(
      okJsonResponse({
        pty: {
          workspace_id: 'ws_123',
          pty_id: 'pty_123',
          process_id: 'proc_123',
          station_link: 'station://workspace/ws_123/pty/pty_123',
          name: 'shell',
          cwd: '/home/station/workspace',
          argv: ['zsh'],
          observed_status: 'running'
        },
        handle: {
          pty_id: 'pty_123',
          process_id: 'proc_123',
          reused: false
        }
      })
    )
    const client = new StationClient({
      baseUrl: 'http://127.0.0.1:18080',
      bearerToken: 'dtok_test:secret'
    })
    const request: StationCreatePtyRequest = {
      name: 'shell',
      argv: ['zsh'],
      env: {},
      cwd: '/home/station/workspace',
      rows: 40,
      cols: 120
    }

    await client.createPty('ws_123', request)

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:18080/v1/workspaces/ws_123/ptys',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(request),
        headers: expect.objectContaining({
          Authorization: 'Bearer dtok_test:secret'
        })
      })
    )
  })

  it('posts resize requests to the tracked PTY resize route', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    const client = new StationClient({
      baseUrl: 'http://127.0.0.1:18080',
      bearerToken: 'dtok_test:secret'
    })

    await client.resizePty('ws_123', 'pty_123', 120, 40)

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:18080/v1/workspaces/ws_123/pty/pty_123/resize',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ cols: 120, rows: 40 })
      })
    )
  })

  it('closes PTYs with DELETE /v1/workspaces/:workspace_id/pty/:pty_id', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    const client = new StationClient({
      baseUrl: 'http://127.0.0.1:18080',
      bearerToken: 'dtok_test:secret'
    })

    await client.closePty('ws_123', 'pty_123')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:18080/v1/workspaces/ws_123/pty/pty_123',
      expect.objectContaining({ method: 'DELETE' })
    )
  })

  it('uses the stream-info bearer token for the PTY WebSocket instead of the device token', async () => {
    fetchMock.mockResolvedValueOnce(
      okJsonResponse({
        url: 'ws://127.0.0.1:18080/v1/pty/pty_123/stream',
        bearer_token: 'stream-secret-token'
      })
    )
    const client = new StationClient({
      baseUrl: 'http://127.0.0.1:18080',
      bearerToken: 'dtok_test:secret',
      WebSocketCtor: FakeWebSocket as unknown as StationWebSocketConstructor
    })

    const socket = await client.openPtyStream('ws_123', 'pty_123')

    expect(socket).toBeInstanceOf(FakeWebSocket)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:18080/v1/workspaces/ws_123/pty/pty_123/stream-info',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer dtok_test:secret'
        })
      })
    )
    expect(FakeWebSocket.instances[0]?.url).toBe('ws://127.0.0.1:18080/v1/pty/pty_123/stream')
    expect(FakeWebSocket.instances[0]?.options?.headers?.Authorization).toBe(
      'Bearer stream-secret-token'
    )
    expect(FakeWebSocket.instances[0]?.options?.headers?.Authorization).not.toContain(
      'dtok_test:secret'
    )
  })

  it('rejects malformed stream-info responses before opening a WebSocket', async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ url: '', bearer_token: '' }))
    const client = new StationClient({
      baseUrl: 'http://127.0.0.1:18080',
      bearerToken: 'dtok_test:secret',
      WebSocketCtor: FakeWebSocket as unknown as StationWebSocketConstructor
    })

    await expect(client.openPtyStream('ws_123', 'pty_123')).rejects.toThrow(
      'Station PTY stream-info response missing url'
    )

    expect(FakeWebSocket.instances).toEqual([])
  })

  it('throws a Station-specific error for invalid JSON responses', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('{not-json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    const client = new StationClient({
      baseUrl: 'http://127.0.0.1:18080',
      bearerToken: 'dtok_test:secret'
    })

    await expect(client.inspectWorkspace('ws_123')).rejects.toThrow(
      'Station response was not valid JSON'
    )
  })

  it('throws sanitized non-2xx response errors with the status code', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        'Authorization: Bearer dtok_test:secret {"device_token_id":"dtok_test","device_token_secret":"super-secret","bearer_token":"stream-secret"}',
        { status: 502, statusText: 'Bad Gateway' }
      )
    )
    const client = new StationClient({
      baseUrl: 'http://127.0.0.1:18080',
      bearerToken: 'dtok_test:secret'
    })

    let thrown: unknown
    try {
      await client.inspectWorkspace('ws_123')
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    const message = (thrown as Error).message
    expect(message).toContain('502')
    expect(message).toContain('[REDACTED]')
    expect(message).not.toContain('dtok_test:secret')
    expect(message).not.toContain('super-secret')
    expect(message).not.toContain('stream-secret')
  })
})
