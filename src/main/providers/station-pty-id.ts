import { parseAppSshPtyId } from './ssh-pty-id'

export const STATION_CONNECTION_PREFIX = 'station:'

export function stationConnectionId(workspaceId: string): string {
  return `${STATION_CONNECTION_PREFIX}${workspaceId}`
}

export function parseStationConnectionId(connectionId: string): { workspaceId: string } | null {
  if (!connectionId.startsWith(STATION_CONNECTION_PREFIX)) {
    return null
  }
  const workspaceId = connectionId.slice(STATION_CONNECTION_PREFIX.length)
  if (!workspaceId) {
    return null
  }
  return { workspaceId }
}

export function isStationPtyId(ptyId: string): boolean {
  const parsed = parseAppSshPtyId(ptyId)
  return parsed !== null && parseStationConnectionId(parsed.connectionId) !== null
}
