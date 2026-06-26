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

  it('reports tracked Station PTYs from raw and app-facing identifiers', async () => {
    const { id } = await provider.spawn({ cols: 80, rows: 24 })

    expect(provider.hasPty(id)).toBe(true)
    expect(provider.hasPty('pty_123')).toBe(true)
  })

  it('writes bytes over the Station WebSocket', async () => {
    const { id } = await provider.spawn({ cols: 80, rows: 24 })

    provider.write(id, 'echo hello')

    expect(socket.send).toHaveBeenCalledWith(Buffer.from('echo hello', 'utf8'))
  })

  it('reopens the Station stream when writing to a tracked PTY whose socket is not open', async () => {
    const { id } = await provider.spawn({ cols: 80, rows: 24 })
    socket.readyState = 0
    const reopenedSocket = new FakeWebSocket()
    vi.mocked(client.openPtyStream).mockResolvedValueOnce(reopenedSocket)

    provider.write(id, 'echo hello')

    expect(socket.send).not.toHaveBeenCalled()
    await vi.waitFor(() =>
      expect(reopenedSocket.send).toHaveBeenCalledWith(Buffer.from('echo hello', 'utf8'))
    )
    expect(client.openPtyStream).toHaveBeenCalledTimes(2)
    expect(client.openPtyStream).toHaveBeenLastCalledWith('ws_123', 'pty_123')
  })

  it('preserves write order while a Station stream reconnect is pending', async () => {
    const { id } = await provider.spawn({ cols: 80, rows: 24 })
    socket.readyState = 0
    const reconnect = deferredPromise<StationWebSocket>()
    const reopenedSocket = new FakeWebSocket()
    vi.mocked(client.openPtyStream).mockReturnValueOnce(reconnect.promise)

    provider.write(id, 'first')
    provider.write(id, 'second')

    await vi.waitFor(() => expect(client.openPtyStream).toHaveBeenCalledTimes(2))
    reconnect.resolve(reopenedSocket)
    await vi.waitFor(() =>
      expect(reopenedSocket.send).toHaveBeenNthCalledWith(2, Buffer.from('second', 'utf8'))
    )

    expect(reopenedSocket.send).toHaveBeenNthCalledWith(1, Buffer.from('first', 'utf8'))
    expect(client.openPtyStream).toHaveBeenCalledTimes(2)
  })

  it('ignores stale close events from a replaced Station stream', async () => {
    const exitHandler = vi.fn()
    provider.onExit(exitHandler)
    const { id } = await provider.spawn({ cols: 80, rows: 24, cwd: '/tmp/one' })
    socket.readyState = 0
    const reopenedSocket = new FakeWebSocket()
    vi.mocked(client.openPtyStream).mockResolvedValueOnce(reopenedSocket)
    vi.mocked(client.getPtyStatus).mockResolvedValueOnce({
      pty_id: 'pty_123',
      status: 'exited',
      exit_code: 9
    })

    provider.write(id, 'after reconnect')
    await vi.waitFor(() => expect(reopenedSocket.send).toHaveBeenCalled())
    socket.emit('close')

    expect(client.getPtyStatus).not.toHaveBeenCalled()
    expect(exitHandler).not.toHaveBeenCalled()
    expect(provider.hasPty(id)).toBe(true)
    expect(await provider.listProcesses()).toEqual([{ id, cwd: '/tmp/one', title: 'orca-shell' }])
  })

  it('ignores stale data events from a replaced Station stream', async () => {
    const dataHandler = vi.fn()
    provider.onData(dataHandler)
    const { id } = await provider.spawn({ cols: 80, rows: 24, cwd: '/tmp/one' })
    const reopenedSocket = new FakeWebSocket()
    vi.mocked(client.openPtyStream).mockResolvedValueOnce(reopenedSocket)

    await provider.attach(id)
    socket.emit('message', Buffer.from('stale-output', 'utf8'), true)
    reopenedSocket.emit('message', Buffer.from('fresh-output', 'utf8'), true)

    expect(dataHandler).toHaveBeenCalledTimes(1)
    expect(dataHandler).toHaveBeenCalledWith({ id, data: 'fresh-output' })
  })

  it('ignores late data events after local detach', async () => {
    const dataHandler = vi.fn()
    provider.onData(dataHandler)
    const { id } = await provider.spawn({ cols: 80, rows: 24, cwd: '/tmp/one' })

    await provider.shutdown(id, { immediate: false })
    socket.emit('message', Buffer.from('late-output', 'utf8'), true)

    expect(dataHandler).not.toHaveBeenCalled()
  })

  it('does not resurrect a detached Station PTY when a queued write reconnect completes late', async () => {
    const { id } = await provider.spawn({ cols: 80, rows: 24 })
    socket.readyState = 0
    const reconnect = deferredPromise<StationWebSocket>()
    const reopenedSocket = new FakeWebSocket()
    vi.mocked(client.openPtyStream).mockReturnValueOnce(reconnect.promise)

    provider.write(id, 'late write')
    await vi.waitFor(() => expect(client.openPtyStream).toHaveBeenCalledTimes(2))
    await provider.shutdown(id, { immediate: false })
    reconnect.resolve(reopenedSocket)
    await vi.waitFor(() => expect(reopenedSocket.close).toHaveBeenCalledTimes(1))

    expect(reopenedSocket.send).not.toHaveBeenCalled()
    expect(await provider.listProcesses()).toEqual([])
  })

  it('drops queued writes when provider is disposed before reconnect completes', async () => {
    const { id } = await provider.spawn({ cols: 80, rows: 24 })
    socket.readyState = 0
    const reconnect = deferredPromise<StationWebSocket>()
    const reopenedSocket = new FakeWebSocket()
    vi.mocked(client.openPtyStream).mockReturnValueOnce(reconnect.promise)

    provider.write(id, 'late write')
    await vi.waitFor(() => expect(client.openPtyStream).toHaveBeenCalledTimes(2))
    provider.dispose()
    reconnect.resolve(reopenedSocket)
    await vi.waitFor(() => expect(reopenedSocket.close).toHaveBeenCalledTimes(1))

    expect(reopenedSocket.send).not.toHaveBeenCalled()
    expect(await provider.listProcesses()).toEqual([])
  })

  it('drops queued writes quietly when a manual attach supersedes reconnect', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { id } = await provider.spawn({ cols: 80, rows: 24 })
    socket.readyState = 0
    const queuedReconnect = deferredPromise<StationWebSocket>()
    const queuedSocket = new FakeWebSocket()
    const attachedSocket = new FakeWebSocket()
    vi.mocked(client.openPtyStream)
      .mockReturnValueOnce(queuedReconnect.promise)
      .mockResolvedValueOnce(attachedSocket)

    provider.write(id, 'stale input')
    await vi.waitFor(() => expect(client.openPtyStream).toHaveBeenCalledTimes(2))
    await provider.attach(id)
    queuedReconnect.resolve(queuedSocket)
    await vi.waitFor(() => expect(queuedSocket.close).toHaveBeenCalledTimes(1))

    expect(queuedSocket.send).not.toHaveBeenCalled()
    expect(attachedSocket.send).not.toHaveBeenCalled()
    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('drops queued writes once explicit terminate has been requested even if close fails', async () => {
    const { id } = await provider.spawn({ cols: 80, rows: 24, cwd: '/tmp/one' })
    socket.readyState = 0
    const reconnect = deferredPromise<StationWebSocket>()
    const reopenedSocket = new FakeWebSocket()
    vi.mocked(client.openPtyStream).mockReturnValueOnce(reconnect.promise)
    vi.mocked(client.closePty).mockRejectedValueOnce(new Error('close failed'))

    provider.write(id, 'stale input')
    await vi.waitFor(() => expect(client.openPtyStream).toHaveBeenCalledTimes(2))
    await expect(provider.shutdown(id, { immediate: true })).rejects.toThrow('close failed')
    reconnect.resolve(reopenedSocket)
    await Promise.resolve()
    await Promise.resolve()

    expect(reopenedSocket.send).not.toHaveBeenCalled()
    expect(await provider.listProcesses()).toEqual([{ id, cwd: '/tmp/one', title: 'orca-shell' }])
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

  it('emits one exit when explicit terminate races with stream-close status', async () => {
    const handler = vi.fn()
    provider.onExit(handler)
    const { id } = await provider.spawn({ cols: 80, rows: 24 })
    const closeRequest = deferredPromise<void>()
    const status = deferredPromise<{ pty_id: string; status: 'exited'; exit_code: number }>()
    vi.mocked(client.closePty).mockReturnValueOnce(closeRequest.promise)
    vi.mocked(client.getPtyStatus).mockReturnValueOnce(status.promise)

    const shutdownPromise = provider.shutdown(id, { immediate: true })
    await vi.waitFor(() => expect(client.closePty).toHaveBeenCalledWith('ws_123', 'pty_123'))
    socket.emit('close')
    expect(client.getPtyStatus).not.toHaveBeenCalled()
    status.resolve({ pty_id: 'pty_123', status: 'exited', exit_code: 17 })
    await Promise.resolve()
    await Promise.resolve()
    closeRequest.resolve(undefined)
    await shutdownPromise

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({ id, code: 0 })
    expect(await provider.listProcesses()).toEqual([])
  })

  it('ignores writes while explicit terminate is in flight', async () => {
    const { id } = await provider.spawn({ cols: 80, rows: 24 })
    const closeRequest = deferredPromise<void>()
    vi.mocked(client.closePty).mockReturnValueOnce(closeRequest.promise)

    const shutdownPromise = provider.shutdown(id, { immediate: true })
    await vi.waitFor(() => expect(client.closePty).toHaveBeenCalledWith('ws_123', 'pty_123'))
    provider.write(id, 'late input')
    closeRequest.resolve(undefined)
    await shutdownPromise

    expect(socket.send).not.toHaveBeenCalled()
    expect(client.openPtyStream).toHaveBeenCalledTimes(1)
  })

  it('ignores resize while explicit terminate is in flight', async () => {
    const { id } = await provider.spawn({ cols: 80, rows: 24 })
    const closeRequest = deferredPromise<void>()
    vi.mocked(client.closePty).mockReturnValueOnce(closeRequest.promise)

    const shutdownPromise = provider.shutdown(id, { immediate: true })
    await vi.waitFor(() => expect(client.closePty).toHaveBeenCalledWith('ws_123', 'pty_123'))
    provider.resize(id, 132, 55)
    closeRequest.resolve(undefined)
    await shutdownPromise

    expect(client.resizePty).not.toHaveBeenCalled()
  })

  it('ignores late resize after local detach', async () => {
    const { id } = await provider.spawn({ cols: 80, rows: 24 })

    await provider.shutdown(id, { immediate: false })

    expect(() => provider.resize(id, 132, 55)).not.toThrow()
    expect(client.resizePty).not.toHaveBeenCalled()
  })

  it('treats duplicate local detach as a no-op', async () => {
    const exitHandler = vi.fn()
    provider.onExit(exitHandler)
    const { id } = await provider.spawn({ cols: 80, rows: 24 })

    await provider.shutdown(id, { immediate: false })
    await expect(provider.shutdown(id, { immediate: false })).resolves.toBeUndefined()

    expect(client.closePty).not.toHaveBeenCalled()
    expect(exitHandler).not.toHaveBeenCalled()
    expect(await provider.listProcesses()).toEqual([])
  })

  it('deduplicates duplicate explicit terminate while remote close is pending', async () => {
    const exitHandler = vi.fn()
    provider.onExit(exitHandler)
    const { id } = await provider.spawn({ cols: 80, rows: 24 })
    const closeRequest = deferredPromise<void>()
    vi.mocked(client.closePty).mockReturnValueOnce(closeRequest.promise)

    const firstShutdown = provider.shutdown(id, { immediate: true })
    await vi.waitFor(() => expect(client.closePty).toHaveBeenCalledWith('ws_123', 'pty_123'))
    const secondShutdown = provider.shutdown(id, { immediate: true })
    closeRequest.resolve(undefined)
    await firstShutdown
    await expect(secondShutdown).resolves.toBeUndefined()

    expect(client.closePty).toHaveBeenCalledTimes(1)
    expect(exitHandler).toHaveBeenCalledTimes(1)
    expect(exitHandler).toHaveBeenCalledWith({ id, code: 0 })
    expect(await provider.listProcesses()).toEqual([])
  })

  it('shares close failure with duplicate explicit terminate callers', async () => {
    const exitHandler = vi.fn()
    provider.onExit(exitHandler)
    const { id } = await provider.spawn({ cols: 80, rows: 24, cwd: '/tmp/one' })
    const closeRequest = deferredPromise<void>()
    vi.mocked(client.closePty).mockReturnValueOnce(closeRequest.promise)

    const firstShutdown = provider.shutdown(id, { immediate: true })
    await vi.waitFor(() => expect(client.closePty).toHaveBeenCalledWith('ws_123', 'pty_123'))
    const secondShutdown = provider.shutdown(id, { immediate: true })
    closeRequest.reject(new Error('close failed'))

    await expect(firstShutdown).rejects.toThrow('close failed')
    await expect(secondShutdown).rejects.toThrow('close failed')
    expect(client.closePty).toHaveBeenCalledTimes(1)
    expect(exitHandler).not.toHaveBeenCalled()
    expect(await provider.listProcesses()).toEqual([{ id, cwd: '/tmp/one', title: 'orca-shell' }])
  })

  it('keeps explicit terminate authoritative when a local detach races with it', async () => {
    const exitHandler = vi.fn()
    provider.onExit(exitHandler)
    const { id } = await provider.spawn({ cols: 80, rows: 24, cwd: '/tmp/one' })
    const closeRequest = deferredPromise<void>()
    vi.mocked(client.closePty).mockReturnValueOnce(closeRequest.promise)

    const firstShutdown = provider.shutdown(id, { immediate: true })
    await vi.waitFor(() => expect(client.closePty).toHaveBeenCalledWith('ws_123', 'pty_123'))
    await provider.shutdown(id, { immediate: false })
    const secondShutdown = provider.shutdown(id, { immediate: true })
    closeRequest.reject(new Error('close failed'))

    await expect(firstShutdown).rejects.toThrow('close failed')
    await expect(secondShutdown).rejects.toThrow('close failed')
    expect(client.closePty).toHaveBeenCalledTimes(1)
    expect(exitHandler).not.toHaveBeenCalled()
    expect(await provider.listProcesses()).toEqual([{ id, cwd: '/tmp/one', title: 'orca-shell' }])
  })

  it('omits terminating Station PTYs from serialized pane state', async () => {
    const { id } = await provider.spawn({ cols: 80, rows: 24, cwd: '/tmp/one' })
    const closeRequest = deferredPromise<void>()
    vi.mocked(client.closePty).mockReturnValueOnce(closeRequest.promise)

    const shutdownPromise = provider.shutdown(id, { immediate: true })
    await vi.waitFor(() => expect(client.closePty).toHaveBeenCalledWith('ws_123', 'pty_123'))
    const state = await provider.serialize([id])
    closeRequest.resolve(undefined)
    await shutdownPromise

    expect(JSON.parse(state)).toEqual({
      workspaceId: 'ws_123',
      ptys: []
    })
  })

  it('ignores attach while explicit terminate is in flight', async () => {
    const { id } = await provider.spawn({ cols: 80, rows: 24 })
    const closeRequest = deferredPromise<void>()
    vi.mocked(client.closePty).mockReturnValueOnce(closeRequest.promise)

    const shutdownPromise = provider.shutdown(id, { immediate: true })
    await vi.waitFor(() => expect(client.closePty).toHaveBeenCalledWith('ws_123', 'pty_123'))
    await provider.attach(id)
    closeRequest.resolve(undefined)
    await shutdownPromise

    expect(client.openPtyStream).toHaveBeenCalledTimes(1)
    expect(await provider.listProcesses()).toEqual([])
  })

  it('ignores remote exit status that resolves after local detach', async () => {
    const handler = vi.fn()
    provider.onExit(handler)
    const { id } = await provider.spawn({ cols: 80, rows: 24, cwd: '/tmp/one' })
    const status = deferredPromise<{ pty_id: string; status: 'exited'; exit_code: number }>()
    vi.mocked(client.getPtyStatus).mockReturnValueOnce(status.promise)

    socket.emit('close')
    await vi.waitFor(() => expect(client.getPtyStatus).toHaveBeenCalledWith('ws_123', 'pty_123'))
    await provider.shutdown(id, { immediate: false })
    status.resolve({ pty_id: 'pty_123', status: 'exited', exit_code: 17 })
    await Promise.resolve()
    await Promise.resolve()

    expect(handler).not.toHaveBeenCalled()
    expect(await provider.listProcesses()).toEqual([])
  })

  it('ignores stale exit status when a replacement stream is already attached', async () => {
    const handler = vi.fn()
    const dataHandler = vi.fn()
    provider.onExit(handler)
    provider.onData(dataHandler)
    const { id } = await provider.spawn({ cols: 80, rows: 24, cwd: '/tmp/one' })
    const status = deferredPromise<{ pty_id: string; status: 'exited'; exit_code: number }>()
    const replacementSocket = new FakeWebSocket()
    vi.mocked(client.getPtyStatus).mockReturnValueOnce(status.promise)
    vi.mocked(client.openPtyStream).mockResolvedValueOnce(replacementSocket)

    socket.emit('close')
    await vi.waitFor(() => expect(client.getPtyStatus).toHaveBeenCalledWith('ws_123', 'pty_123'))
    await provider.attach(id)
    status.resolve({ pty_id: 'pty_123', status: 'exited', exit_code: 17 })
    await Promise.resolve()
    await Promise.resolve()
    replacementSocket.emit('message', Buffer.from('fresh-output', 'utf8'), true)

    expect(handler).not.toHaveBeenCalled()
    expect(provider.hasPty(id)).toBe(true)
    expect(await provider.listProcesses()).toEqual([{ id, cwd: '/tmp/one', title: 'orca-shell' }])
    expect(dataHandler).toHaveBeenCalledWith({ id, data: 'fresh-output' })
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

  it('keeps multiple Station PTYs isolated across writes, resize, output, reconnect, and shutdown', async () => {
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
        name: 'orca-second',
        cwd: '/tmp/two'
      }),
      handle: {
        pty_id: 'pty_456',
        process_id: '789',
        reused: false
      }
    })
    vi.mocked(client.openPtyStream).mockResolvedValueOnce(secondSocket)
    const second = await provider.spawn({ cols: 100, rows: 30, command: 'second', cwd: '/tmp/two' })

    provider.write(first.id, 'first-input')
    provider.write(second.id, 'second-input')
    provider.resize(first.id, 132, 55)
    provider.resize(second.id, 90, 20)
    socket.emit('message', Buffer.from('first-output', 'utf8'), true)
    secondSocket.emit('message', Buffer.from('second-output', 'utf8'), true)
    secondSocket.readyState = 0
    const reopenedSecondSocket = new FakeWebSocket()
    vi.mocked(client.openPtyStream).mockResolvedValueOnce(reopenedSecondSocket)
    provider.write(second.id, 'second-after-reconnect')
    await vi.waitFor(() =>
      expect(reopenedSecondSocket.send).toHaveBeenCalledWith(
        Buffer.from('second-after-reconnect', 'utf8')
      )
    )

    await provider.shutdown(first.id, { immediate: true })

    expect(socket.send).toHaveBeenCalledWith(Buffer.from('first-input', 'utf8'))
    expect(secondSocket.send).toHaveBeenCalledWith(Buffer.from('second-input', 'utf8'))
    expect(client.resizePty).toHaveBeenCalledWith('ws_123', 'pty_123', 132, 55)
    expect(client.resizePty).toHaveBeenCalledWith('ws_123', 'pty_456', 90, 20)
    expect(dataHandler).toHaveBeenCalledWith({ id: first.id, data: 'first-output' })
    expect(dataHandler).toHaveBeenCalledWith({ id: second.id, data: 'second-output' })
    expect(client.closePty).toHaveBeenCalledWith('ws_123', 'pty_123')
    expect(client.closePty).not.toHaveBeenCalledWith('ws_123', 'pty_456')
    expect(exitHandler).toHaveBeenCalledWith({ id: first.id, code: 0 })
    expect(provider.hasPty(first.id)).toBe(false)
    expect(provider.hasPty(second.id)).toBe(true)
    expect(await provider.listProcesses()).toEqual([
      { id: second.id, cwd: '/tmp/two', title: 'orca-second' }
    ])
  })

  it('keeps the PTY retryable when immediate remote close fails', async () => {
    const exitHandler = vi.fn()
    provider.onExit(exitHandler)
    const { id } = await provider.spawn({ cols: 80, rows: 24, cwd: '/tmp/one' })

    vi.mocked(client.closePty).mockRejectedValueOnce(new Error('close failed'))

    await expect(provider.shutdown(id, { immediate: true })).rejects.toThrow('close failed')

    expect(socket.close).not.toHaveBeenCalled()
    expect(await provider.listProcesses()).toEqual([
      { id, cwd: '/tmp/one', title: 'orca-shell' }
    ])
    expect(exitHandler).not.toHaveBeenCalled()

    await provider.shutdown(id, { immediate: true })

    expect(client.closePty).toHaveBeenNthCalledWith(1, 'ws_123', 'pty_123')
    expect(client.closePty).toHaveBeenNthCalledWith(2, 'ws_123', 'pty_123')
    expect(socket.close).toHaveBeenCalledTimes(1)
    expect(await provider.listProcesses()).toEqual([])
    expect(exitHandler).toHaveBeenCalledWith({ id, code: 0 })
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

  it('does not track an untracked PTY when attach cannot open its Station stream', async () => {
    const id = 'ssh:station%3Aws_123@@pty_unreachable'
    vi.mocked(client.openPtyStream).mockRejectedValueOnce(new Error('station is asleep'))

    await expect(provider.attach(id)).rejects.toThrow('station is asleep')

    expect(provider.hasPty(id)).toBe(false)
    expect(await provider.listProcesses()).toEqual([])
  })

  it('does not track an attached PTY when provider is disposed before stream open completes', async () => {
    const id = 'ssh:station%3Aws_123@@pty_slow_attach'
    const streamOpen = deferredPromise<StationWebSocket>()
    const openedSocket = new FakeWebSocket()
    vi.mocked(client.openPtyStream).mockReturnValueOnce(streamOpen.promise)

    const attachPromise = provider.attach(id)
    await vi.waitFor(() => expect(client.openPtyStream).toHaveBeenCalledWith('ws_123', 'pty_slow_attach'))
    provider.dispose()
    streamOpen.resolve(openedSocket)

    await expect(attachPromise).rejects.toThrow('Station PTY provider disposed')
    expect(openedSocket.close).toHaveBeenCalledTimes(1)
    expect(provider.hasPty(id)).toBe(false)
    expect(await provider.listProcesses()).toEqual([])
  })

  it('keeps the existing Station stream alive when reattach fails to open a replacement', async () => {
    const dataHandler = vi.fn()
    provider.onData(dataHandler)
    const { id } = await provider.spawn({ cols: 80, rows: 24, cwd: '/tmp/one' })
    vi.mocked(client.openPtyStream).mockRejectedValueOnce(new Error('replacement failed'))

    await expect(provider.attach(id)).rejects.toThrow('replacement failed')

    expect(socket.close).not.toHaveBeenCalled()
    expect(provider.hasPty(id)).toBe(true)
    expect(await provider.listProcesses()).toEqual([{ id, cwd: '/tmp/one', title: 'orca-shell' }])
    socket.emit('message', Buffer.from('still-live', 'utf8'), true)
    provider.write(id, 'after-failed-reattach')

    expect(dataHandler).toHaveBeenCalledWith({ id, data: 'still-live' })
    expect(socket.send).toHaveBeenCalledWith(Buffer.from('after-failed-reattach', 'utf8'))
  })

  it('keeps the newest Station stream when concurrent reattach attempts resolve out of order', async () => {
    const dataHandler = vi.fn()
    provider.onData(dataHandler)
    const { id } = await provider.spawn({ cols: 80, rows: 24, cwd: '/tmp/one' })
    const slowOpen = deferredPromise<StationWebSocket>()
    const fastOpen = deferredPromise<StationWebSocket>()
    const slowSocket = new FakeWebSocket()
    const fastSocket = new FakeWebSocket()
    vi.mocked(client.openPtyStream)
      .mockReturnValueOnce(slowOpen.promise)
      .mockReturnValueOnce(fastOpen.promise)

    const slowAttach = provider.attach(id)
    await vi.waitFor(() => expect(client.openPtyStream).toHaveBeenCalledTimes(2))
    const fastAttach = provider.attach(id)
    await vi.waitFor(() => expect(client.openPtyStream).toHaveBeenCalledTimes(3))

    fastOpen.resolve(fastSocket)
    await fastAttach
    slowOpen.resolve(slowSocket)
    await expect(slowAttach).rejects.toThrow('Station PTY stream open superseded')

    expect(socket.close).toHaveBeenCalledTimes(1)
    expect(slowSocket.close).toHaveBeenCalledTimes(1)
    expect(fastSocket.close).not.toHaveBeenCalled()
    slowSocket.emit('message', Buffer.from('slow-stale', 'utf8'), true)
    fastSocket.emit('message', Buffer.from('fast-current', 'utf8'), true)
    provider.write(id, 'after-concurrent-attach')

    expect(dataHandler).toHaveBeenCalledTimes(1)
    expect(dataHandler).toHaveBeenCalledWith({ id, data: 'fast-current' })
    expect(fastSocket.send).toHaveBeenCalledWith(Buffer.from('after-concurrent-attach', 'utf8'))
    expect(slowSocket.send).not.toHaveBeenCalled()
  })

  it('keeps one stream when concurrent untracked attach attempts resolve out of order', async () => {
    const dataHandler = vi.fn()
    provider.onData(dataHandler)
    const id = 'ssh:station%3Aws_123@@pty_restore_race'
    const slowOpen = deferredPromise<StationWebSocket>()
    const fastOpen = deferredPromise<StationWebSocket>()
    const slowSocket = new FakeWebSocket()
    const fastSocket = new FakeWebSocket()
    vi.mocked(client.openPtyStream)
      .mockReturnValueOnce(slowOpen.promise)
      .mockReturnValueOnce(fastOpen.promise)

    const slowAttach = provider.attach(id)
    await vi.waitFor(() =>
      expect(client.openPtyStream).toHaveBeenCalledWith('ws_123', 'pty_restore_race')
    )
    const fastAttach = provider.attach(id)
    await vi.waitFor(() => expect(client.openPtyStream).toHaveBeenCalledTimes(2))

    fastOpen.resolve(fastSocket)
    await fastAttach
    slowOpen.resolve(slowSocket)
    await expect(slowAttach).rejects.toThrow('Station PTY stream open superseded')

    expect(slowSocket.close).toHaveBeenCalledTimes(1)
    expect(fastSocket.close).not.toHaveBeenCalled()
    slowSocket.emit('message', Buffer.from('slow-stale', 'utf8'), true)
    fastSocket.emit('message', Buffer.from('fast-current', 'utf8'), true)
    provider.write(id, 'after-untracked-race')

    expect(provider.hasPty(id)).toBe(true)
    expect(dataHandler).toHaveBeenCalledTimes(1)
    expect(dataHandler).toHaveBeenCalledWith({ id, data: 'fast-current' })
    expect(fastSocket.send).toHaveBeenCalledWith(Buffer.from('after-untracked-race', 'utf8'))
    expect(slowSocket.send).not.toHaveBeenCalled()
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

  it('rolls back revived PTY state when one persisted stream cannot reopen', async () => {
    const state = JSON.stringify({
      workspaceId: 'ws_123',
      ptys: [
        { ptyId: 'pty_restore_1', cwd: '/tmp/one', title: 'one' },
        { ptyId: 'pty_restore_2', cwd: '/tmp/two', title: 'two' }
      ]
    })
    const firstSocket = new FakeWebSocket()
    vi.mocked(client.openPtyStream)
      .mockResolvedValueOnce(firstSocket)
      .mockRejectedValueOnce(new Error('second stream failed'))

    await expect(provider.revive(state)).rejects.toThrow('second stream failed')

    expect(firstSocket.close).toHaveBeenCalledTimes(1)
    expect(provider.hasPty('ssh:station%3Aws_123@@pty_restore_1')).toBe(false)
    expect(provider.hasPty('ssh:station%3Aws_123@@pty_restore_2')).toBe(false)
    expect(await provider.listProcesses()).toEqual([])
  })

  it('rolls back revived PTY state when provider is disposed during persisted stream reopen', async () => {
    const state = JSON.stringify({
      workspaceId: 'ws_123',
      ptys: [
        { ptyId: 'pty_restore_1', cwd: '/tmp/one', title: 'one' },
        { ptyId: 'pty_restore_2', cwd: '/tmp/two', title: 'two' }
      ]
    })
    const firstSocket = new FakeWebSocket()
    const secondOpen = deferredPromise<StationWebSocket>()
    const secondSocket = new FakeWebSocket()
    vi.mocked(client.openPtyStream)
      .mockResolvedValueOnce(firstSocket)
      .mockReturnValueOnce(secondOpen.promise)

    const revivePromise = provider.revive(state)
    await vi.waitFor(() => expect(client.openPtyStream).toHaveBeenCalledTimes(2))
    provider.dispose()
    secondOpen.resolve(secondSocket)

    await expect(revivePromise).rejects.toThrow('Station PTY provider disposed')
    expect(firstSocket.close).toHaveBeenCalledTimes(1)
    expect(secondSocket.close).toHaveBeenCalledTimes(1)
    expect(provider.hasPty('ssh:station%3Aws_123@@pty_restore_1')).toBe(false)
    expect(provider.hasPty('ssh:station%3Aws_123@@pty_restore_2')).toBe(false)
    expect(await provider.listProcesses()).toEqual([])
  })

  it('rejects malformed persisted Station PTY state before opening streams', async () => {
    await expect(provider.revive(JSON.stringify({ workspaceId: 'ws_123', ptys: 'nope' }))).rejects.toThrow(
      'Invalid Station PTY state'
    )
    await expect(
      provider.revive(
        JSON.stringify({
          workspaceId: 'ws_123',
          ptys: [{ ptyId: '', cwd: '/tmp/one', title: 'one' }]
        })
      )
    ).rejects.toThrow('Invalid Station PTY state')

    expect(client.openPtyStream).not.toHaveBeenCalled()
    expect(await provider.listProcesses()).toEqual([])
  })

  it('deduplicates repeated persisted Station PTY ids during revive', async () => {
    const state = JSON.stringify({
      workspaceId: 'ws_123',
      ptys: [
        { ptyId: 'pty_restore_1', cwd: '/tmp/one', title: 'one' },
        { ptyId: 'pty_restore_1', cwd: '/tmp/duplicate', title: 'duplicate' }
      ]
    })

    await provider.revive(state)

    expect(client.openPtyStream).toHaveBeenCalledTimes(1)
    expect(client.openPtyStream).toHaveBeenCalledWith('ws_123', 'pty_restore_1')
    expect(await provider.listProcesses()).toEqual([
      {
        id: 'ssh:station%3Aws_123@@pty_restore_1',
        cwd: '/tmp/one',
        title: 'one'
      }
    ])
  })

  it('closes a newly-created Station PTY when provider is disposed before spawn stream opens', async () => {
    const streamOpen = deferredPromise<StationWebSocket>()
    const openedSocket = new FakeWebSocket()
    vi.mocked(client.openPtyStream).mockReturnValueOnce(streamOpen.promise)

    const spawnPromise = provider.spawn({ cols: 80, rows: 24 })
    await vi.waitFor(() => expect(client.openPtyStream).toHaveBeenCalledWith('ws_123', 'pty_123'))
    provider.dispose()
    streamOpen.resolve(openedSocket)

    await expect(spawnPromise).rejects.toThrow('Station PTY provider disposed')
    expect(openedSocket.close).toHaveBeenCalledTimes(1)
    expect(client.closePty).toHaveBeenCalledWith('ws_123', 'pty_123')
    expect(provider.hasPty('ssh:station%3Aws_123@@pty_123')).toBe(false)
    expect(await provider.listProcesses()).toEqual([])
  })

  it('closes a newly-created Station PTY when provider is disposed before create completes', async () => {
    const createRequest = deferredPromise<Awaited<ReturnType<StationClient['createPty']>>>()
    vi.mocked(client.createPty).mockReturnValueOnce(createRequest.promise)

    const spawnPromise = provider.spawn({ cols: 80, rows: 24 })
    await vi.waitFor(() => expect(client.createPty).toHaveBeenCalledTimes(1))
    provider.dispose()
    createRequest.resolve({
      pty: trackedPty(),
      handle: {
        pty_id: 'pty_123',
        process_id: '456',
        reused: false
      }
    })

    await expect(spawnPromise).rejects.toThrow('Station PTY provider disposed')
    expect(client.openPtyStream).not.toHaveBeenCalled()
    expect(client.closePty).toHaveBeenCalledWith('ws_123', 'pty_123')
    expect(provider.hasPty('ssh:station%3Aws_123@@pty_123')).toBe(false)
    expect(await provider.listProcesses()).toEqual([])
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

  it('does not report child processes for detached Station PTYs', async () => {
    const { id } = await provider.spawn({ cols: 80, rows: 24 })

    await provider.shutdown(id, { immediate: false })

    await expect(provider.hasChildProcesses(id)).resolves.toBe(false)
  })

  it('does not report child processes while Station PTY terminate is in flight', async () => {
    const { id } = await provider.spawn({ cols: 80, rows: 24 })
    const closeRequest = deferredPromise<void>()
    vi.mocked(client.closePty).mockReturnValueOnce(closeRequest.promise)

    const shutdownPromise = provider.shutdown(id, { immediate: true })
    await vi.waitFor(() => expect(client.closePty).toHaveBeenCalledWith('ws_123', 'pty_123'))

    await expect(provider.hasChildProcesses(id)).resolves.toBe(false)

    closeRequest.resolve(undefined)
    await shutdownPromise
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
