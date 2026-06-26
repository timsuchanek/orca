import {
  STATION_CONNECTION_PREFIX,
  isStationConnectionId,
  parseStationConnectionId,
  stationConnectionId
} from '../../shared/station-connection-id'
import { parseAppSshPtyId } from './ssh-pty-id'

export {
  STATION_CONNECTION_PREFIX,
  isStationConnectionId,
  parseStationConnectionId,
  stationConnectionId
}

export function isStationPtyId(ptyId: string): boolean {
  const parsed = parseAppSshPtyId(ptyId)
  return parsed !== null && parseStationConnectionId(parsed.connectionId) !== null
}
