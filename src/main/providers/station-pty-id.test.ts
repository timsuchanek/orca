import { describe, expect, it } from 'vitest'
import { toAppSshPtyId, toRelaySshPtyId } from './ssh-pty-id'
import {
  STATION_CONNECTION_PREFIX,
  isStationPtyId,
  parseStationConnectionId,
  stationConnectionId
} from './station-pty-id'

describe('station-pty-id', () => {
  it('builds and parses Station connection ids', () => {
    const connectionId = stationConnectionId('ws_123')

    expect(connectionId).toBe(`${STATION_CONNECTION_PREFIX}ws_123`)
    expect(parseStationConnectionId(connectionId)).toEqual({ workspaceId: 'ws_123' })
  })

  it('returns null for non-Station connection ids', () => {
    expect(parseStationConnectionId('ssh:conn-1')).toBeNull()
    expect(parseStationConnectionId(`${STATION_CONNECTION_PREFIX}`)).toBeNull()
  })

  it('recognizes Station PTY ids routed through the SSH app id shape', () => {
    const connectionId = stationConnectionId('ws/123')
    const appPtyId = toAppSshPtyId(connectionId, 'pty_123')

    expect(appPtyId).toBe('ssh:station%3Aws%2F123@@pty_123')
    expect(isStationPtyId(appPtyId)).toBe(true)
    expect(toRelaySshPtyId(connectionId, appPtyId)).toBe('pty_123')
  })

  it('rejects non-Station PTY ids', () => {
    expect(isStationPtyId('ssh:conn-1@@pty_123')).toBe(false)
    expect(isStationPtyId('pty_123')).toBe(false)
  })
})
