import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, posix, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'

const execFile = promisify(execFileCallback)
const fail = code => { throw new Error(code) }
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024

export function sourceUploadTarget(target) {
  if (!['HiQ-AI/dataset', 'HiQ-AI/dataset-web'].includes(target?.repository)) return null
  const match = /^feature\/(uat[1-9])-base$/.exec(target?.branch ?? '')
  if (!match) return null
  const project = target.repository.split('/')[1], pipeline = `${project}-uat`
  return { project, pipeline, environment: match[1], configPath: `.woodpecker/${pipeline}.yaml` }
}

function pipelineSupportsUpload(source, branch) {
  let config
  try { config = yaml.load(source, { schema: yaml.JSON_SCHEMA }) } catch { return false }
  if (config?.skip_clone !== true || !Array.isArray(config.steps)) return false
  const rules = value => Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : []
  const conditionValid = value => value === undefined || typeof value === 'string'
    || Array.isArray(value) && value.every(item => typeof item === 'string')
  const matches = (value, expected, glob = false) => value === undefined ||
    (typeof value === 'string' ? [value] : Array.isArray(value) ? value : [])
      .some(item => typeof item === 'string' && (glob ? posix.matchesGlob(expected, item) : item === expected))
  const manualRules = value => {
    const entries = rules(value)
    if (entries.some(rule => !rule || typeof rule !== 'object' || Array.isArray(rule)
      || !conditionValid(rule.event) || !conditionValid(rule.branch))) return null
    return entries.filter(rule => matches(rule.event, 'manual', true) && matches(rule.branch, branch, true))
  }
  const allowed = (rule, keys) => Object.keys(rule).every(key => keys.includes(key))
  if (!manualRules(config.when)?.some(rule => rule.event !== undefined && rule.branch !== undefined
    && allowed(rule, ['event', 'branch']))) return false
  for (const [name, expression] of [['prepare-uploaded-source', 'SOURCE_PACKAGE_ID != ""'],
    ['clone-source', 'SOURCE_PACKAGE_ID == ""']]) {
    const steps = config.steps.filter(step => step?.name === name)
    if (steps.length !== 1) return false
    const applicable = manualRules(steps[0].when)
    if (!applicable?.length || applicable.some(rule => !allowed(rule, ['event', 'branch', 'evaluate'])
      || rule.evaluate !== expression || name === 'prepare-uploaded-source' && rule.event === undefined)) return false
  }
  return true
}

/** 仅上传已核验 UAT 分支的已提交对象；不执行目标仓脚本，也不回退 Cron。 */
export async function uploadUatSource({ target, commitSha, githubToken, sourceUploadToken,
  fetchImpl = fetch, execFileImpl = execFile, beforeUpload } = {}) {
  const upload = sourceUploadTarget(target)
  if (!upload || !/^[a-f0-9]{40}$/.test(commitSha ?? '') || typeof beforeUpload !== 'function')
    fail('SOURCE_UPLOAD_INPUT_INVALID')
  if (typeof githubToken !== 'string' || !githubToken.trim()
    || typeof sourceUploadToken !== 'string' || !sourceUploadToken.trim()) fail('SOURCE_UPLOAD_CREDENTIAL_MISSING')
  const directory = await mkdtemp(join(tmpdir(), 'dsh-uat-source-'))
  // 不继承调用进程的 Git 目录、对象库、配置或凭据选项，避免越出临时仓。
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')))
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${githubToken}`).toString('base64')}`,
    GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: process.platform === 'win32' ? 'NUL' : '/dev/null' })
  const git = async args => {
    try {
      return (await execFileImpl('git', ['-C', directory, ...args],
        { env, windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 })).stdout.trim()
    } catch { fail('SOURCE_UPLOAD_GIT_FAILED') }
  }
  try {
    await git(['init', '--bare', '--template='])
    await git(['fetch', '--depth=1', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--',
      `https://github.com/${target.repository}.git`, `refs/heads/${target.branch}:refs/heads/source-upload`])
    if (await git(['rev-parse', 'refs/heads/source-upload^{commit}']) !== commitSha) fail('SOURCE_UPLOAD_BRANCH_MOVED')
    const source = await git(['show', `${commitSha}:${upload.configPath}`])
    if (!pipelineSupportsUpload(source, target.branch)) fail('SOURCE_UPLOAD_PIPELINE_UNSUPPORTED')
    const archivePath = join(directory, 'source.tar.gz')
    await git(['archive', '--format=tar.gz', `--output=${archivePath}`, commitSha])
    const size = (await stat(archivePath)).size
    if (size <= 0 || size > MAX_ARCHIVE_BYTES) fail('SOURCE_UPLOAD_ARCHIVE_SIZE_INVALID')
    const body = await readFile(archivePath), sha256 = createHash('sha256').update(body).digest('hex')
    // 耗时取源码完成后，Host 再检查分支漂移和等价构建，紧接着只发一次 PUT。
    await beforeUpload()
    const url = `https://woodpecker.hiqdat.dev/source-upload/v1/projects/${upload.project}/pipelines/${upload.pipeline}`
      + `/environments/${upload.environment}/commits/${commitSha}`
    let response
    try {
      response = await fetchImpl(url, { method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(180000),
        headers: { Authorization: `Bearer ${sourceUploadToken}`, 'Content-Type': 'application/gzip',
          'Content-Length': String(body.length), 'X-Artifact-SHA256': sha256 }, body })
    } catch { fail('SOURCE_UPLOAD_REQUEST_UNCONFIRMED') }
    if (response?.redirected) fail('SOURCE_UPLOAD_REDIRECT_REJECTED')
    if (response?.status !== 201) fail(`SOURCE_UPLOAD_HTTP_${Number.isInteger(response?.status) ? response.status : 'INVALID'}`)
    let receipt
    try { receipt = await response.json() } catch { fail('SOURCE_UPLOAD_RESPONSE_INVALID') }
    if (!receipt || receipt.project !== upload.project || receipt.pipeline !== upload.pipeline
      || receipt.environment !== upload.environment || receipt.commit !== commitSha || receipt.sha256 !== sha256
      || typeof receipt.artifact_id !== 'string' || !/^[a-f0-9]{32}$/.test(receipt.artifact_id)
      || !Number.isSafeInteger(receipt.woodpecker_pipeline) || receipt.woodpecker_pipeline < 1)
      fail('SOURCE_UPLOAD_RECEIPT_MISMATCH')
    return { evidenceRef: `woodpecker-source-upload:${upload.project}:${upload.environment}:${commitSha}:${receipt.artifact_id}:${sha256}:${receipt.woodpecker_pipeline}`,
      pipelineNumber: receipt.woodpecker_pipeline, artifactId: receipt.artifact_id, sha256, commitSha }
  } finally {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('dsh-uat-source-'))
      fail('SOURCE_UPLOAD_TEMP_PATH_INVALID')
    await rm(directory, { recursive: true, force: true })
  }
}
