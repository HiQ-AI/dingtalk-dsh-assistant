import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { redactCredential } from './first-reply-isolation.mjs'

const configPath = resolve('docs/tmp/semantic-latency/provider-e1def16e-b85f-44a3-a7b0-91c8b598c222.json')
const profilePath = 'D:/dsh_home/profiles/web/package.json'
const profile = createRequire(profilePath)
const config = JSON.parse(await readFile(configPath, 'utf8'))
const ref = config.providerConfig.apiKeyEnv
if (config.provider !== 'cortex-gateway' || config.model !== 'cortex-cowork' || config.reasoningEffort !== 'low' || typeof ref !== 'string') throw new Error('evaluation_config_invalid')

if (process.argv[2] === '--child-preflight') {
  const native = await import('../../../../test/fixtures/task-session-native-host.js')
  const root = await mkdtemp(join(tmpdir(), 'first-reply-credential-'))
  let host, resolved = false, cleanup = false
  try {
    host = await native.nativeTaskHost(root, () => { throw new Error('model_call_forbidden') }, { resident: true, nativeProfile: native.loadNativeTestProfile(profilePath) })
    resolved = !!(await host.ctx.get('credentials').resolve(ref))?.value
  } catch { process.exitCode = 1 }
  finally {
    try { await host?.close(); cleanup = true } catch { process.exitCode = 1 }
    try { await rm(root, { recursive: true, force: true }) } catch { cleanup = false; process.exitCode = 1 }
  }
  console.log(JSON.stringify({ credentialResolved: resolved, cleanupCompleted: cleanup, modelCalls: 0 }))
  if (!resolved || !cleanup) process.exitCode = 1
} else {
  if (process.argv[2] !== '--preflight' && process.argv[2] !== '--run') throw new Error('evaluation_mode_required')
  let value
  try {
    const credentials = profile('@deepseek-ai/dsh-credentials-local')
    const spec = credentials.resolveSpec({ dshHome: 'D:/dsh_home', watch: false })
    const parsed = credentials.parseCredentialsDocument(await readFile(spec.filename, 'utf8'), spec.filename)
    value = parsed.refs.get(ref)
  } catch { console.error('credential_document_read_failed'); process.exit(1) }
  if (typeof value !== 'string' || !value.length) { console.error('credential_reference_unavailable'); process.exit(1) }
  const childArgs = process.argv[2] === '--preflight' ? [process.argv[1], '--child-preflight'] : [resolve('docs/acceptance/topic-routing-quality/scripts/first-reply-provider.mjs'), ...process.argv.slice(3)]
  const child = spawn(process.execPath, childArgs, { env: { ...process.env, [ref]: value }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const secret = value
  value = undefined
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', text => { stdout += text })
  child.stderr.on('data', text => { stderr += text })
  child.on('error', () => { console.error('evaluation_child_start_failed'); process.exitCode = 1 })
  child.on('close', (code, signal) => {
    const redact = text => redactCredential(redactCredential(text, secret), secret, true)
    process.stdout.write(redact(stdout)); process.stderr.write(redact(stderr))
    stdout = ''; stderr = ''
    process.exitCode = signal || code === null ? 1 : code
  })
}
