import { readFile } from 'node:fs/promises'

const RELEASES_URL = 'https://api.github.com/repos/HiQ-AI/dingtalk-dsh-assistant/releases/latest'
const CHANGELOG_URL = 'https://github.com/HiQ-AI/dingtalk-dsh-assistant/blob/main/CHANGELOG.md'
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

let currentVersion
let cachedResult
let cachedAt = 0

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(value)
  if (match === null) return undefined
  return { numbers: match.slice(1, 4).map(Number), prerelease: match[4] }
}

export function isNewerVersion(candidate, current) {
  const left = parseVersion(candidate)
  const right = parseVersion(current)
  if (left === undefined || right === undefined) return false
  for (let index = 0; index < left.numbers.length; index += 1) {
    if (left.numbers[index] !== right.numbers[index]) return left.numbers[index] > right.numbers[index]
  }
  if (left.prerelease === right.prerelease) return false
  if (left.prerelease === undefined) return true
  if (right.prerelease === undefined) return false
  return left.prerelease.localeCompare(right.prerelease, 'en', { numeric: true }) > 0
}

export async function readCurrentVersion() {
  if (currentVersion === undefined) {
    const packageUrl = new URL('./package.json', import.meta.url)
    currentVersion = JSON.parse(await readFile(packageUrl, 'utf8')).version
  }
  return currentVersion
}

export async function checkForUpdates({ fetchImpl = fetch, now = Date.now(), force = false } = {}) {
  const version = await readCurrentVersion()
  if (!force && cachedResult !== undefined && now - cachedAt < CACHE_TTL_MS) return cachedResult
  try {
    const response = await fetchImpl(RELEASES_URL, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `dingtalk-dsh-assistant/${version}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (response.status === 404) {
      cachedResult = { currentVersion: version, latestVersion: null, updateAvailable: false, releaseUrl: null, changelogUrl: CHANGELOG_URL, checkedAt: new Date(now).toISOString() }
    } else {
      if (!response.ok) throw new Error(`github_releases_http_${response.status}`)
      const release = await response.json()
      const latestVersion = typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/u, '') : null
      cachedResult = {
        currentVersion: version,
        latestVersion,
        updateAvailable: latestVersion === null ? false : isNewerVersion(latestVersion, version),
        releaseUrl: typeof release.html_url === 'string' ? release.html_url : null,
        changelogUrl: CHANGELOG_URL,
        checkedAt: new Date(now).toISOString(),
      }
    }
    cachedAt = now
    return cachedResult
  } catch (error) {
    return {
      currentVersion: version,
      latestVersion: null,
      updateAvailable: false,
      releaseUrl: null,
      changelogUrl: CHANGELOG_URL,
      checkedAt: new Date(now).toISOString(),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
