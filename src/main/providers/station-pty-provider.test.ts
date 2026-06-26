import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StationClient, StationWebSocket, StationWorkspacePty } from '../station/station-client'
import { stationConnectionId } from './station-pty-id'
import { StationPtyProvider } from './station-pty-provider'

type MockStationClient = Pick<
  StationClient,
  'createPty' | 'openPtyStream' | 'resizePty' | 'closePty' | 'getPtyStatus'
>

class FakeWebSocket implements StationWebSocket {
  readonly send = vi.fn()
  readonly close = vi.fn()
  readonly on = vi.fn(
    ((event: string, listener: (...args: unknown[]) => void) => {
      this.listeners.push([event, listener])
      return this as unknown as StationWebSocket
    }) as unknown as StationWebSocket['on']
  )
  readyState: 0 | 1 | 2 | 3 = 1
  private readonly listeners: Array<[string, (...args: unknown[]) => void]> = []

  emit(event: string, ...args: unknown[]): void {
    for (const [registeredEvent, listener] of this.listeners) {
      if (registeredEvent === event) {
        listener(...args)
      }
    }
  }
}

function createClient(socket: FakeWebSocket): MockStationClient {
  return {
    createPty: vi.fn().mockResolvedValue({
      pty: {
        workspace_id: 'ws_123',
        pty_id: 'pty_123',
        process_id: '456',
        station_link: 'station://workspace/ws_123/pty/pty_123',
        name: 'orca-shell',
        cwd: '/home/station/workspace',
        argv: ['zsh'],
        observed_status: 'running'
      },
      handle: {
        pty_id: 'pty_123',
        process_id: '456',
        reused: false
      }
    }),
    openPtyStream: vi.fn().mockResolvedValue(socket),
    resizePty: vi.fn().mockResolvedValue(undefined),
    closePty: vi.fn().mockResolvedValue(undefined),
    getPtyStatus: vi.fn().mockResolvedValue({ pty_id: 'pty_123', status: 'running' })
  }
}

function trackedPty(
  overrides: Partial<StationWorkspacePty> = {}
): StationWorkspacePty & { pty_id: string } {
  return {
    workspace_id: 'ws_123',
    pty_id: 'pty_123',
    process_id: '456',
    station_link: 'station://workspace/ws_123/pty/pty_123',
    name: 'orca-shell',
    cwd: '/home/station/workspace',
    argv: ['zsh'],
    observed_status: 'running',
    ...overrides
  }
}

function deferredPromise<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  return { promise, resolve, reject }
}

describe('StationPtyProvider', () => {
  let socket: FakeWebSocket
  let client: MockStationClient
  let provider: StationPtyProvider
  let connectionId: string

  beforeEach(() => {
    socket = new FakeWebSocket()
    client = createClient(socket)
    connectionId = stationConnectionId('ws_123')
    provider = new StationPtyProvider(
      connectionId,
      'ws_123',
      client as unknown as StationClient
    )
  })

  it('spawns a tracked Station PTY and returns a namespaced app id', async () => {
    const result = await provider.spawn({ cols: 120, rows: 40, env: { FOO: 'bar' } })

    expect(client.createPty).toHaveBeenCalledWith('ws_123', {
      name: 'orca-shell',
      argv: ['zsh'],
      cwd: '/home/station/workspace',
      env: { FOO: 'bar' },
      rows: 40,
      cols: 120
    })
    expect(client.openPtyStream).toHaveBeenCalledWith('ws_123', 'pty_123')
    expect(result).toEqual({
      id: 'ssh:station%3Aws_123@@pty_123',
      pid: 456
    })
  })

  it('spawns the shell even when the renderer provides startup command text', async () => {
    await provider.spawn({ cols: 80, rows: 24, command: 'codex \"do work\"' })

    expect(client.createPty).toHaveBeenCalledWith('ws_123', {
      name: 'orca-codex \"do work\"',
      argv: ['zsh'],
      cwd: '/home/station/workspace',
      env: {},
      rows: 24,
      cols: 80
    })
  })

  it('returns null pid when Station process ids are not safe integers', async () => {
    vi.mocked(client.createPty).mockResolvedValueOnce({
      pty: trackedPty({ process_id: 'proc_123' }),
      handle: {
        pty_id: 'pty_123',
        process_id: 'proc_123',
        reused: false
      }
    })

    const result = await provider.spawn({ cols: 80, rows: 24 })

    expect(result.pid).toBeNull()
  })

  it('reattaches an existing session without creating a new PTY', async () => {
    const result = await provider.spawn({
      cols: 80,
      rows: 24,
      sessionId: 'ssh:station%3Aws_123@@pty_existing'
    })

    expect(client.createPty).not.toHaveBeenCalled()
    expect(client.openPtyStream).toHaveBeenCalledWith('ws_123', 'pty_existing')
    expect(result).toEqual({
      id: 'ssh:station%3Aws_123@@pty_existing',
      pid: null,
      isReattach: true
    })
  })

  it('writes bytes over the Station WebSocket', async () => {
    const { id } = await provider.spawn({ cols: 80, rows: 24 })

    provider.write(id, 'echo hello')

    expect(socket.send).toHaveBeenCalledWith(Buffer.from('echo hello', 'utf8'))
  })

  it('throws when writing to a PTY whose socket is not open', async () => {
    const { id } = await provider.spawn({ cols: 80, rows: 24 })
    socket.readyState = 0

    expect(() => provider.write(id, 'echo hello')).toThrow('Station PTY stream is not open')
    expect(socket.send).not.toHaveBeenCalled()
  })

  it('calls Station HTTP resize with Station row and col ordering', async () => {
    const { id } = await provider.spawn({ cols: 80, rows: 24 })

    provider.resize(id, 132, 55)

    expect(client.resizePty).toHaveBeenCalledWith('ws_123', 'pty_123', 132, 55)
  })

  it('forwards binary data messages to Orca listeners with the app id', async () => {
    const handler = vi.fn()
    provider.onData(handler)
    const { id } = await provider.spawn({ cols: 80, rows: 24 })

    socket.emit('message', Buffer.from('hello from station', 'utf8'), true)

    expect(handler).toHaveBeenCalledWith({ id, data: 'hello from station' })
  })

  it('registers replay listeners even though V0 does not emit replay frames', () => {
    const handler = vi.fn()
    const unsubscribe = provider.onReplay(handler)

    unsubscribe()

    expect(handler).not.toHaveBeenCalled()
  })

  it('does not treat socket close as process exit unless shutdown initiated it', async () => {
    const handler = vi.fn()
    provider.onExit(handler)
    await provider.spawn({ cols: 80, rows: 24 })

    socket.emit('close')

    expect(handler).not.toHaveBeenCalled()
  })

  it('emits exit when Station closes the stream because the remote PTY exited', async () => {
    const handler = vi.fn()
    provider.onExit(handler)
    const { id } = await provider.spawn({ cols: 80, rows: 24 })
    vi.mocked(client.getPtyStatus).mockResolvedValueOnce({
      pty_id: 'pty_123',
      status: 'exited',
      exit_code: 17
    })

    socket.emit('close')
    await vi.waitFor(() => expect(handler).toHaveBeenCalledWith({ id, code: 17 }))

    expect(await provider.listProcesses()).toEqual([])
  })

  it('immediate shutdown closes only the tracked PTY and emits exit for that PTY', async () => {
    const exitHandler = vi.fn()
    provider.onExit(exitHandler)
    const first = await provider.spawn({ cols: 80, rows: 24, cwd: '/tmp/one' })

    const secondSocket = new FakeWebSocket()
    vi.mocked(client.createPty).mockResolvedValueOnce({
      pty: trackedPty({
        pty_id: 'pty_456',
        process_id: '789',
        name: 'orca-zsh',
        cwd: '/tmp/two'
      }),
      handle: {
        pty_id: 'pty_456',
        process_id: '789',
        reused: false
      }
    })
    vi.mocked(client.openPtyStream).mockResolvedValueOnce(secondSocket)
    const second = await provider.spawn({ cols: 100, rows: 30, command: 'zsh', cwd: '/tmp/two' })

    await provider.shutdown(first.id, { immediate: true })

    expect(client.closePty).toHaveBeenCalledWith('ws_123', 'pty_123')
    expect(socket.close).toHaveBeenCalledTimes(1)
    expect(client.closePty).not.toHaveBeenCalledWith('ws_123', 'pty_456')
    expect(await provider.listProcesses()).toEqual([
      { id: second.id, cwd: '/tmp/two', title: 'orca-zsh' }
    ])
    expect(exitHandler).toHaveBeenCalledWith({ id: first.id, code: 0 })
  })

  it('preserves tracked state and suppresses exit when immediate remote close fails', async () => {
    const exitHandler = vi.fn()
    provider.onExit(exitHandler)
    const { id } = await provider.spawn({ cols: 80, rows: 24, cwd: '/tmp/one' })

    vi.mocked(client.closePty).mockRejectedValueOnce(new Error('close failed'))

    await expect(provider.shutdown(id, { immediate: true })).rejects.toThrow('close failed')

    expect(socket.close).toHaveBeenCalledTimes(1)
    expect(await provider.listProcesses()).toEqual([])
    expect(exitHandler).not.toHaveBeenCalled()
  })

  it('attach reopens a Station stream for an untracked Station app PTY id', async () => {
    const id = 'ssh:station%3Aws_123@@pty_existing'

    await provider.attach(id)

    expect(client.openPtyStream).toHaveBeenCalledWith('ws_123', 'pty_existing')
    expect(provider.hasPty(id)).toBe(true)
    expect(await provider.listProcesses()).toEqual([
      { id, cwd: '/home/station/workspace', title: 'orca-shell' }
    ])
  })

  it('ignores stale socket close events after reopen during explicit shutdown', async () => {
    const exitHandler = vi.fn()
    provider.onExit(exitHandler)
    const { id } = await provider.spawn({ cols: 80, rows: 24 })

    const reopenedSocket = new FakeWebSocket()
    vi.mocked(client.openPtyStream).mockResolvedValueOnce(reopenedSocket)
    await provider.attach(id)

    const closeRequest = deferredPromise<void>()
    vi.mocked(client.closePty).mockReturnValueOnce(closeRequest.promise)
    const shutdownPromise = provider.shutdown(id, { immediate: true })

    socket.emit('close')
    closeRequest.resolve(undefined)

    await shutdownPromise

    expect(reopenedSocket.close).toHaveBeenCalledTimes(1)
    expect(exitHandler).toHaveBeenCalledWith({ id, code: 0 })
  })

  it('keeps PTY state intact when the Station socket emits an error', async () => {
    const exitHandler = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    provider.onExit(exitHandler)
    const { id } = await provider.spawn({ cols: 80, rows: 24, cwd: '/tmp/one' })

    socket.emit(
      'error',
      new Error('Station stream transport failed: Authorization: Bearer secret-token')
    )

    expect(exitHandler).not.toHaveBeenCalled()
    expect(provider.hasPty(id)).toBe(true)
    expect(await provider.listProcesses()).toEqual([{ id, cwd: '/tmp/one', title: 'orca-shell' }])

    provider.write(id, 'echo hello')
    await provider.attach(id)
    await provider.shutdown(id, { immediate: true })

    expect(socket.send).toHaveBeenCalledWith(Buffer.from('echo hello', 'utf8'))
    expect(client.openPtyStream).toHaveBeenCalledTimes(2)
    expect(client.closePty).toHaveBeenCalledWith('ws_123', 'pty_123')
    expect(consoleError).toHaveBeenCalledWith(
      '[station-pty] stream transport error',
      expect.objectContaining({
        id,
        error: 'Station stream transport failed: Authorization: Bearer [REDACTED]'
      })
    )
    expect(
      consoleError.mock.calls.some((call) =>
        call.some((value) => String(value).includes('secret-token'))
      )
    ).toBe(false)
    consoleError.mockRestore()
  })

  it('serializes known PTY ids and revive reopens their streams', async () => {
    const first = await provider.spawn({ cols: 80, rows: 24, cwd: '/tmp/one' })
    const secondSocket = new FakeWebSocket()
    vi.mocked(client.createPty).mockResolvedValueOnce({
      pty: trackedPty({
        pty_id: 'pty_456',
        process_id: '789',
        name: 'orca-bash',
        cwd: '/tmp/two'
      }),
      handle: {
        pty_id: 'pty_456',
        process_id: '789',
        reused: false
      }
    })
    vi.mocked(client.openPtyStream).mockResolvedValueOnce(secondSocket)
    const second = await provider.spawn({ cols: 100, rows: 30, command: 'bash', cwd: '/tmp/two' })

    const state = await provider.serialize([first.id, second.id])

    await provider.shutdown(first.id, { immediate: true })
    await provider.shutdown(second.id, { immediate: true })
    await provider.revive(state)

    expect(await provider.listProcesses()).toEqual([
      { id: first.id, cwd: '/tmp/one', title: 'orca-shell' },
      { id: second.id, cwd: '/tmp/two', title: 'orca-bash' }
    ])
    expect(client.openPtyStream).toHaveBeenCalledWith('ws_123', 'pty_123')
    expect(client.openPtyStream).toHaveBeenCalledWith('ws_123', 'pty_456')
  })

  it('returns shell metadata and no-op behaviors required by the provider interface', async () => {
    const { id } = await provider.spawn({ cols: 80, rows: 24, cwd: '/tmp/one' })

    await expect(provider.getCwd(id)).resolves.toBe('/tmp/one')
    await expect(provider.getInitialCwd(id)).resolves.toBe('/tmp/one')
    await expect(provider.clearBuffer(id)).resolves.toBeUndefined()
    expect(() => provider.acknowledgeDataEvent(id, 10)).not.toThrow()
    await expect(provider.hasChildProcesses(id)).resolves.toBe(true)
    await expect(provider.getForegroundProcess(id)).resolves.toBeNull()
    await expect(provider.getDefaultShell()).resolves.toBe('zsh')
    await expect(provider.getProfiles()).resolves.toEqual([])
  })

  it('rejects PTY signals in v0', async () => {
    const { id } = await provider.spawn({ cols: 80, rows: 24 })

    await expect(provider.sendSignal(id, 'SIGINT')).rejects.toThrow(
      'Station PTY signals are not supported in v0'
    )
  })

  it('never logs bearer tokens from Station errors', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(client.openPtyStream).mockRejectedValueOnce(
      new Error('Station PTY stream open failed: Bearer [REDACTED]')
    )

    await expect(provider.spawn({ cols: 80, rows: 24 })).rejects.toThrow(
      'Station PTY stream open failed: Bearer [REDACTED]'
    )

    expect(client.closePty).toHaveBeenCalledWith('ws_123', 'pty_123')
    expect(provider.hasPty('ssh:station%3Aws_123@@pty_123')).toBe(false)
    expect(await provider.listProcesses()).toEqual([])
    expect(
      consoleError.mock.calls.some((call) => call.some((value) => String(value).includes('secret')))
    ).toBe(false)
    consoleError.mockRestore()
  })

  it('dispose closes active Station streams, clears tracked PTYs, and skips remote close', async () => {
    const dataHandler = vi.fn()
    const exitHandler = vi.fn()
    provider.onData(dataHandler)
    provider.onExit(exitHandler)

    const first = await provider.spawn({ cols: 80, rows: 24, cwd: '/tmp/one' })
    const secondSocket = new FakeWebSocket()
    vi.mocked(client.createPty).mockResolvedValueOnce({
      pty: trackedPty({
        pty_id: 'pty_456',
        process_id: '789',
        name: 'orca-zsh',
        cwd: '/tmp/two'
      }),
      handle: {
        pty_id: 'pty_456',
        process_id: '789',
        reused: false
      }
    })
    vi.mocked(client.openPtyStream).mockResolvedValueOnce(secondSocket)
    const second = await provider.spawn({ cols: 100, rows: 30, command: 'zsh', cwd: '/tmp/two' })

    provider.dispose()

    expect(socket.close).toHaveBeenCalledTimes(1)
    expect(secondSocket.close).toHaveBeenCalledTimes(1)
    expect(client.closePty).not.toHaveBeenCalled()
    expect(provider.hasPty(first.id)).toBe(false)
    expect(provider.hasPty(second.id)).toBe(false)
    expect(await provider.listProcesses()).toEqual([])

    socket.emit('message', Buffer.from('after-dispose', 'utf8'), true)
    secondSocket.emit('close')

    expect(dataHandler).not.toHaveBeenCalled()
    expect(exitHandler).not.toHaveBeenCalled()
  })

  it('uses Station PTY Session id as app id after create', async () => {
    vi.mocked(client.createPty).mockResolvedValueOnce({
      pty: {
        workspace_id: 'ws_123',
        pty_id: 'pty_019efcab63117a93ac4ab54dcae3c910',
        process_id: 'proc_1',
        station_link: 'station://workspace/ws_123/pty/pty_019efcab63117a93ac4ab54dcae3c910',
        name: 'orca-shell',
        cwd: '/home/station/workspace',
        argv: ['zsh'],
        observed_status: 'running'
      },
      handle: {
        pty_id: '019efcab-6311-7a93-ac4a-b54dcae3c910',
        process_id: 'proc_1',
        reused: false
      }
    })

    const result = await provider.spawn({ rows: 40, cols: 120 })

    expect(result.id).toBe('ssh:station%3Aws_123@@pty_019efcab63117a93ac4ab54dcae3c910')
    expect(client.openPtyStream).toHaveBeenCalledWith(
      'ws_123',
      'pty_019efcab63117a93ac4ab54dcae3c910'
    )
  })

  it('detaches on non-immediate shutdown without closing Station PTY Session', async () => {
    vi.mocked(client.createPty).mockResolvedValueOnce({
      pty: {
        workspace_id: 'ws_123',
        pty_id: 'pty_019efcab63117a93ac4ab54dcae3c910',
        process_id: 'proc_1',
        station_link: 'station://workspace/ws_123/pty/pty_019efcab63117a93ac4ab54dcae3c910',
        name: 'orca-shell',
        cwd: '/home/station/workspace',
        argv: ['zsh'],
        observed_status: 'running'
      },
      handle: {
        pty_id: '019efcab-6311-7a93-ac4a-b54dcae3c910',
        process_id: 'proc_1',
        reused: false
      }
    })
    const result = await provider.spawn({ rows: 40, cols: 120 })

    await provider.shutdown(result.id, { immediate: false })

    expect(client.closePty).not.toHaveBeenCalled()
    expect(socket.close).toHaveBeenCalled()
  })

  it('terminates on immediate shutdown by closing Station PTY Session', async () => {
    vi.mocked(client.createPty).mockResolvedValueOnce({
      pty: {
        workspace_id: 'ws_123',
        pty_id: 'pty_019efcab63117a93ac4ab54dcae3c910',
        process_id: 'proc_1',
        station_link: 'station://workspace/ws_123/pty/pty_019efcab63117a93ac4ab54dcae3c910',
        name: 'orca-shell',
        cwd: '/home/station/workspace',
        argv: ['zsh'],
        observed_status: 'running'
      },
      handle: {
        pty_id: '019efcab-6311-7a93-ac4a-b54dcae3c910',
        process_id: 'proc_1',
        reused: false
      }
    })
    const result = await provider.spawn({ rows: 40, cols: 120 })

    await provider.shutdown(result.id, { immediate: true })

    expect(client.closePty).toHaveBeenCalledWith(
      'ws_123',
      'pty_019efcab63117a93ac4ab54dcae3c910'
    )
  })
})
