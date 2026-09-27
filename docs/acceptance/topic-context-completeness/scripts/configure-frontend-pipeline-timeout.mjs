import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createHostPlatformClients } from '../../../../packages/dingtalk-dsh-assistant/platform-host.js'

const fail = code => { throw Error(code) }
const commit = 'd1e447787201212140a2732b798d336965ddfaa7'
const repository = 'HiQ-AI/dataset-web'
const baseUrl = 'https://woodpecker.hiqdat.dev'
export async function configure({ apply, api, listPipelines, readBranch, reserve }) {
  const repo = await api('GET', 'repos/2')
  if (repo.id !== 2 || repo.full_name !== repository || ![10, 30].includes(repo.timeout)) fail('TIMEOUT_REPOSITORY_DRIFT')
  const permission = await api('GET', 'repos/2/permissions')
  if (permission.admin !== true) fail('TIMEOUT_REPOSITORY_ADMIN_REQUIRED')
  const pipeline = await api('GET', 'repos/2/pipelines/319')
  if (pipeline.number !== 319 || pipeline.commit !== commit || pipeline.branch !== 'feature/uat2-base'
    || pipeline.status !== 'killed' || pipeline.finished - pipeline.started !== 600) fail('TIMEOUT_FAILURE_PROOF_DRIFT')
  const scan = await listPipelines()
  if (!scan.complete || scan.pipelines.some(item => ['created', 'pending', 'running', 'blocked'].includes(item.status))) fail('TIMEOUT_PIPELINE_ACTIVE_OR_INCOMPLETE')
  if ((await readBranch()).commitSha !== commit) fail('TIMEOUT_BRANCH_DRIFT')
  if (!apply || repo.timeout === 30) return { writes: 0, ready: true, repository, previousMinutes: repo.timeout, desiredMinutes: 30, alreadyApplied: repo.timeout === 30 }
  // 固定一次变更意图；不确定结果只能重新 GET，不能自动重复 PATCH。
  await reserve({ repository, pipeline: 319, commit, previousMinutes: 10, desiredMinutes: 30 })
  await api('PATCH', 'repos/2', { timeout: 30 })
  const after = await api('GET', 'repos/2')
  if (after.id !== 2 || after.full_name !== repository || after.timeout !== 30) fail('TIMEOUT_READBACK_FAILED')
  return { writes: 1, verified: true, repository, previousMinutes: 10, timeoutMinutes: 30, pipeline: 319, commit }
}
async function main(mode) {
  if (!['--check', '--apply'].includes(mode)) fail('TIMEOUT_ARGUMENT_INVALID')
  const exec = promisify(execFile)
  const raw = await exec('kubectl', ['--kubeconfig', 'D:/baibu-agent/.secrets/k3s/kubeconfig-uat.yml', '--server', 'https://192.168.8.8:6443', '--insecure-skip-tls-verify', '--request-timeout=15s', '-n', 'db-dev', 'get', 'secret', 'woodpecker-poller-credentials', '-o', 'json'], { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 })
  const secret = JSON.parse(raw.stdout)
  const token = Buffer.from(secret.data.WOODPECKER_TOKEN, 'base64').toString('utf8')
  const api = async (method, path, body) => {
    const response = await fetch(`${baseUrl}/api/${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    if (!response.ok) fail(`TIMEOUT_API_HTTP_${response.status}`)
    return response.json()
  }
  const clients = (await createHostPlatformClients({ secretsDirectory: 'D:/baibu-agent/.secrets' })).release
  const result = await configure({ apply: mode === '--apply', api,
    listPipelines: () => clients.woodpecker.listPipelines({ baseUrl, repositoryId: 2 }),
    readBranch: () => clients.github.readBranch({ repository, branch: 'feature/uat2-base' }),
    reserve: async value => {
      const path = new URL('../round-36/frontend-timeout-change-intent.json', import.meta.url)
      await writeFile(path, JSON.stringify({ ...value, at: new Date().toISOString() }, null, 2), { flag: 'wx' })
      JSON.parse(await readFile(path, 'utf8'))
    } })
  console.log(JSON.stringify(result))
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv[2]).catch(error => {
  console.error(/^TIMEOUT_[A-Z_0-9]+$/.test(error.message) ? error.message : 'TIMEOUT_CONFIG_FAILED_READBACK_REQUIRED')
  process.exitCode = 1
})
