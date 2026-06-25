import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadStationCredentials,
  stationBearerToken,
  type StationCredentials
} from './station-config'

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function writeStationFiles(
  stationHome: string,
  values: Partial<StationCredentials> & {
    configToml?: string
    credentialsToml?: string
  } = {}
): void {
  mkdirSync(stationHome, { recursive: true })
  writeFileSync(
    join(stationHome, 'config.toml'),
    values.configToml ?? `api_base_url = "${values.apiBaseUrl ?? 'http://127.0.0.1:18080'}"\n`,
    'utf-8'
  )
  writeFileSync(
    join(stationHome, 'credentials.toml'),
    values.credentialsToml ??
      [
        `device_token_id = "${values.deviceTokenId ?? 'dtok_default'}"`,
        `device_token_secret = "${values.deviceTokenSecret ?? 'default-secret'}"`,
        ''
      ].join('\n'),
    'utf-8'
  )
}

const createdDirs: string[] = []
const ORIGINAL_STATION_HOME = process.env.STATION_HOME

afterEach(() => {
  process.env.STATION_HOME = ORIGINAL_STATION_HOME
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('loadStationCredentials', () => {
  it('prefers STATION_HOME over the default ~/.station directory', () => {
    const fakeHome = makeTempDir('orca-station-home-')
    const overriddenStationHome = makeTempDir('orca-station-override-')
    createdDirs.push(fakeHome, overriddenStationHome)
    writeStationFiles(join(fakeHome, '.station'), {
      apiBaseUrl: 'http://127.0.0.1:19999',
      deviceTokenId: 'dtok_wrong',
      deviceTokenSecret: 'wrong-secret'
    })
    writeStationFiles(overriddenStationHome, {
      apiBaseUrl: 'http://127.0.0.1:18080',
      deviceTokenId: 'dtok_override',
      deviceTokenSecret: 'override-secret'
    })
    process.env.STATION_HOME = overriddenStationHome

    expect(loadStationCredentials(fakeHome)).toEqual({
      apiBaseUrl: 'http://127.0.0.1:18080',
      deviceTokenId: 'dtok_override',
      deviceTokenSecret: 'override-secret'
    })
  })

  it('reads ~/.station when STATION_HOME is unset', () => {
    const fakeHome = makeTempDir('orca-station-default-')
    createdDirs.push(fakeHome)
    writeStationFiles(join(fakeHome, '.station'), {
      apiBaseUrl: 'http://127.0.0.1:18081',
      deviceTokenId: 'dtok_default_home',
      deviceTokenSecret: 'home-secret'
    })
    delete process.env.STATION_HOME

    expect(loadStationCredentials(fakeHome)).toEqual({
      apiBaseUrl: 'http://127.0.0.1:18081',
      deviceTokenId: 'dtok_default_home',
      deviceTokenSecret: 'home-secret'
    })
  })

  it('mentions the missing file path without leaking token values', () => {
    const stationHome = makeTempDir('orca-station-missing-')
    createdDirs.push(stationHome)
    mkdirSync(stationHome, { recursive: true })
    writeFileSync(
      join(stationHome, 'credentials.toml'),
      'device_token_id = "dtok_visible"\n',
      'utf-8'
    )
    process.env.STATION_HOME = stationHome

    let thrown: unknown
    try {
      loadStationCredentials('/unused-home')
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(Error)
    const message = (thrown as Error).message
    expect(message).toContain(join(stationHome, 'config.toml'))
    expect(message).not.toContain('dtok_visible')
    expect(message).not.toContain('redacted-test-secret')
  })
})

describe('stationBearerToken', () => {
  it('matches the Station CLI bearer token format', () => {
    expect(
      stationBearerToken({
        apiBaseUrl: 'http://127.0.0.1:18080',
        deviceTokenId: 'dtok_test',
        deviceTokenSecret: 'secret'
      })
    ).toBe('dtok_test:secret')
  })
})
