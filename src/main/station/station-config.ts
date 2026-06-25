import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export type StationCredentials = {
  apiBaseUrl: string
  deviceTokenId: string
  deviceTokenSecret: string
}

const STATION_HOME_ENV = 'STATION_HOME'
const ASSIGNMENT_RE = /^\s*([a-z0-9_]+)\s*=\s*"([^"]*)"\s*(?:#.*)?$/i

export function loadStationCredentials(home = homedir()): StationCredentials {
  const stationHome = resolveStationHome(home)
  const configPath = join(stationHome, 'config.toml')
  const credentialsPath = join(stationHome, 'credentials.toml')
  const config = parseTomlAssignments(readRequiredFile(configPath, 'config'), configPath)
  const credentials = parseTomlAssignments(
    readRequiredFile(credentialsPath, 'credentials'),
    credentialsPath
  )

  return {
    apiBaseUrl: readRequiredValue(config, 'api_base_url', configPath),
    deviceTokenId: readRequiredValue(credentials, 'device_token_id', credentialsPath),
    deviceTokenSecret: readRequiredValue(credentials, 'device_token_secret', credentialsPath)
  }
}

export function stationBearerToken(credentials: StationCredentials): string {
  return `${credentials.deviceTokenId}:${credentials.deviceTokenSecret}`
}

function resolveStationHome(home: string): string {
  const override = process.env[STATION_HOME_ENV]?.trim()
  return override && override.length > 0 ? override : join(home, '.station')
}

function readRequiredFile(path: string, label: string): string {
  try {
    return readFileSync(path, 'utf-8')
  } catch (error) {
    const detail = error instanceof Error && error.message ? `: ${error.message}` : ''
    throw new Error(`Could not read Station ${label} file at ${path}${detail}`)
  }
}

function parseTomlAssignments(text: string, path: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(ASSIGNMENT_RE)
    if (!match) {
      continue
    }
    values.set(match[1], match[2])
  }
  if (values.size === 0) {
    throw new Error(`Could not parse Station config values from ${path}`)
  }
  return values
}

function readRequiredValue(values: Map<string, string>, key: string, path: string): string {
  const value = values.get(key)?.trim()
  if (!value) {
    throw new Error(`Missing Station ${key} in ${path}`)
  }
  return value
}
