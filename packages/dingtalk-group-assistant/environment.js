import { access } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

async function findExecutable(name) {
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const file of process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, `${name}.ps1`, name] : [name]) {
      const candidate = join(directory, file)
      try { await access(candidate); return candidate } catch {}
    }
  }
  return undefined
}

export async function inspectEnvironment({ runner, profile }) {
  const executable = await findExecutable('dws')
  let authentication = { authenticated: false, tokenValid: false }
  if (executable !== undefined) {
    const result = await runner.run(['auth', 'status', '--profile', profile, '--format', 'json'])
    if (result.exitCode === 0) {
      try {
        const status = JSON.parse(result.stdout)
        authentication = {
          authenticated: status.authenticated === true,
          tokenValid: status.token_valid === true,
          organization: status.corp_name,
          user: status.user_name,
          expiresAt: status.expires_at,
        }
      } catch { authentication.error = 'dws_auth_status_invalid_json' }
    } else authentication.error = result.stderr || `exit_${result.exitCode}`
  }
  return { dws: { installed: executable !== undefined, executable, ...authentication } }
}
