import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm, stat, open } from 'node:fs/promises'
import { join, resolve, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { gunzipSync } from 'node:zlib'
import yaml from 'js-yaml'
import { sourceUploadTarget, uploadUatSource } from '../packages/dingtalk-dsh-assistant/workflow-source-upload.js'

const execFile = promisify(execFileCallback)
const target = { repository: 'HiQ-AI/dataset', branch: 'feature/uat3-base' }
const pipeline = () => ({ skip_clone: true,
  when: [{ event: 'cron', branch: 'feature/uat*-base', cron: 'dataset-uat*-poll' },
    { event: 'manual', branch: 'feature/uat*-base' }],
  steps: [{ name: 'prepare-uploaded-source', when: [{ event: 'manual', evaluate: 'SOURCE_PACKAGE_ID != ""' }] },
    { name: 'clone-source', when: [{ event: 'cron' }, { event: 'manual', evaluate: 'SOURCE_PACKAGE_ID == ""' }] }] })
const validReceipt = (url, options) => {
  const parts = new URL(url).pathname.split('/')
  return { project: parts[4], pipeline: parts[6], environment: parts[8], commit: parts[10],
    sha256: options.headers['X-Artifact-SHA256'], artifact_id: 'b'.repeat(32), woodpecker_pipeline: 71 }
}

async function fixture(t, { config = pipeline(), missingYaml = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-source-fixture-'))
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('dsh-source-fixture-'))
    await rm(directory, { recursive: true, force: true })
  })
  const git = async args => (await execFile('git', ['-C', directory, ...args], { windowsHide: true })).stdout.trim()
  await git(['init', '--initial-branch=feature/uat3-base'])
  await mkdir(join(directory, '.woodpecker'))
  if (!missingYaml) {
    for (const project of ['dataset', 'dataset-web'])
      await writeFile(join(directory, '.woodpecker', `${project}-uat.yaml`), yaml.dump(config))
  }
  await writeFile(join(directory, 'payload.txt'), 'committed payload\n')
  await git(['add', '.'])
  await git(['-c', 'user.name=UAT fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'])
  const commitSha = await git(['rev-parse', 'HEAD'])
  await writeFile(join(directory, 'payload.txt'), 'uncommitted payload must stay private')
  await writeFile(join(directory, 'local-secret.txt'), 'untracked secret must stay private')
  const calls = [], requests = []
  const execFileImpl = async (command, args, options) => {
    calls.push({ command, args: [...args], options })
    if (args[2] === 'fetch') args = args.map(value => value.startsWith('https://github.com/') ? directory : value)
    return execFile(command, args, options)
  }
  const fetchImpl = async (url, options) => {
    requests.push({ url, options })
    return { status: 201, json: async () => validReceipt(url, options) }
  }
  const input = { target, commitSha, githubToken: 'github-fixture-secret', sourceUploadToken: 'upload-fixture-secret',
    execFileImpl, fetchImpl, beforeUpload: async () => {} }
  return { input, calls, requests, assertClean: async () => {
    for (const path of new Set(calls.map(call => call.args[1])))
      await assert.rejects(stat(path), { code: 'ENOENT' })
  } }
}

test('源码上传只承接固定仓库 UAT 分支，生产和其他目标保留原路由', () => {
  assert.deepEqual(sourceUploadTarget(target), { project: 'dataset', pipeline: 'dataset-uat',
    environment: 'uat3', configPath: '.woodpecker/dataset-uat.yaml' })
  assert.equal(sourceUploadTarget({ repository: 'HiQ-AI/other', branch: target.branch }), null)
  for (const branch of ['main', 'feature/uat0-base', 'feature/uat10-base', 'refs/tags/v1', 'feature/uat3-base\n'])
    assert.equal(sourceUploadTarget({ ...target, branch }), null)
  assert.equal(sourceUploadTarget(null), null)
})

test('真实 Git 浅取精确分支并归档提交对象，PUT 回执绑定全部身份和摘要', async t => {
  const f = await fixture(t)
  const signal = new AbortController().signal
  t.mock.method(AbortSignal, 'timeout', milliseconds => { assert.equal(milliseconds, 180000); return signal })
  let validated = false
  const result = await uploadUatSource({ ...f.input, beforeUpload: async () => {
    assert.equal(f.calls.at(-1).args[2], 'archive')
    assert.equal(f.requests.length, 0)
    validated = true
  }, fetchImpl: async (url, options) => {
    assert.equal(validated, true)
    return f.input.fetchImpl(url, options)
  } })
  assert.equal(result.pipelineNumber, 71)
  assert.equal(result.commitSha, f.input.commitSha)
  assert.equal(result.artifactId, 'b'.repeat(32))
  assert.equal(f.requests.length, 1)
  const { url, options } = f.requests[0]
  assert.equal(url, `https://woodpecker.hiqdat.dev/source-upload/v1/projects/dataset/pipelines/dataset-uat/environments/uat3/commits/${result.commitSha}`)
  assert.equal(options.method, 'PUT')
  assert.equal(options.redirect, 'error')
  assert.ok(options.signal instanceof AbortSignal)
  assert.equal(options.headers.Authorization, 'Bearer upload-fixture-secret')
  assert.equal(options.headers['Content-Type'], 'application/gzip')
  assert.equal(Number(options.headers['Content-Length']), options.body.length)
  assert.equal(result.sha256, createHash('sha256').update(options.body).digest('hex'))
  assert.match(result.evidenceRef, /^woodpecker-source-upload:dataset:uat3:/)
  const archive = gunzipSync(options.body).toString()
  assert.ok(archive.includes('committed payload'))
  assert.ok(!archive.includes('uncommitted payload') && !archive.includes('untracked secret'))
  const gitFetch = f.calls.find(call => call.args[2] === 'fetch')
  assert.ok(gitFetch.args.includes('--depth=1') && gitFetch.args.includes('--no-tags'))
  assert.ok(gitFetch.args.includes(`refs/heads/${target.branch}:refs/heads/source-upload`))
  assert.ok(!JSON.stringify(gitFetch.args).includes('github-fixture-secret'))
  assert.equal(gitFetch.options.env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(gitFetch.options.windowsHide, true)
  await f.assertClean()
})

test('dataset-web 的 clone 可不声明 event，但必须只在源码包 ID 为空时执行', async t => {
  const config = pipeline()
  config.steps[1].when = [{ evaluate: 'SOURCE_PACKAGE_ID == ""' }]
  const f = await fixture(t, { config })
  const result = await uploadUatSource({ ...f.input, target: { ...target, repository: 'HiQ-AI/dataset-web' } })
  assert.equal(result.pipelineNumber, 71)
  assert.ok(f.requests[0].url.includes('/projects/dataset-web/pipelines/dataset-web-uat/'))
  await f.assertClean()
})

test('缺凭据、SHA 或最终查重回调时，在 Git 与网络操作之前拒绝', async () => {
  for (const patch of [{ githubToken: '' }, { sourceUploadToken: '' }, { commitSha: 'bad' }, { beforeUpload: undefined }]) {
    let called = false
    await assert.rejects(uploadUatSource({ target, commitSha: 'a'.repeat(40), githubToken: 'x', sourceUploadToken: 'x',
      beforeUpload: async () => {}, execFileImpl: async () => { called = true }, ...patch }), /SOURCE_UPLOAD_(CREDENTIAL_MISSING|INPUT_INVALID)/)
    assert.equal(called, false)
  }
})

test('取到的真实分支 SHA 不符或最终查重拒绝时均不发送源码', async t => {
  const f = await fixture(t)
  await assert.rejects(uploadUatSource({ ...f.input, commitSha: 'a'.repeat(40) }), /SOURCE_UPLOAD_BRANCH_MOVED/)
  await assert.rejects(uploadUatSource({ ...f.input, beforeUpload: async () => { throw Error('WOODPECKER_EQUIVALENT_BUILD_EXISTS') } }),
    /WOODPECKER_EQUIVALENT_BUILD_EXISTS/)
  assert.equal(f.requests.length, 0)
  await f.assertClean()
})

test('缺少源码上传 YAML 时拒绝，不尝试上传或 Cron', async t => {
  const f = await fixture(t, { missingYaml: true })
  await assert.rejects(uploadUatSource(f.input), /SOURCE_UPLOAD_GIT_FAILED/)
  assert.equal(f.requests.length, 0)
  await f.assertClean()
})

test('不支持 manual、未禁止默认 clone 或任一 clone 规则绕过 ID 条件均拒绝', async t => {
  const changes = [
    config => { config.skip_clone = false },
    config => { config.when = [{ event: 'cron', branch: target.branch }] },
    config => { config.when[1].branch = 'feature/uat9-base' },
    config => { config.steps[0].when[0].evaluate = 'true' },
    config => { config.steps[1].when.push({ event: 'manual' }) },
    config => { config.steps[1].when.push({ event: '*' }) },
    config => { config.steps[1].when.push({ event: { exclude: 'cron' } }) },
    config => { config.steps[1].when.push({ branch: { exclude: 'main' } }) },
  ]
  for (const change of changes) {
    const config = pipeline(); change(config)
    const f = await fixture(t, { config })
    await assert.rejects(uploadUatSource(f.input), /SOURCE_UPLOAD_PIPELINE_UNSUPPORTED/)
    assert.equal(f.requests.length, 0)
    await f.assertClean()
  }
})

test('超过 64 MiB 的归档在读取上传体之前拒绝并清理', async t => {
  const f = await fixture(t)
  await assert.rejects(uploadUatSource({ ...f.input, execFileImpl: async (command, args, options) => {
    const result = await f.input.execFileImpl(command, args, options)
    if (args[2] === 'archive') {
      const file = await open(args.find(value => value.startsWith('--output=')).slice('--output='.length), 'r+')
      try { await file.truncate(64 * 1024 * 1024 + 1) } finally { await file.close() }
    }
    return result
  } }), /SOURCE_UPLOAD_ARCHIVE_SIZE_INVALID/)
  assert.equal(f.requests.length, 0)
  await f.assertClean()
})

test('Git 失败不透出认证配置，也不会重试取源码或上传', async t => {
  const f = await fixture(t)
  let attempts = 0
  await assert.rejects(uploadUatSource({ ...f.input, execFileImpl: async (command, args, options) => {
    if (args[2] === 'fetch') { attempts++; throw Error(options.env.GIT_CONFIG_VALUE_0) }
    return f.input.execFileImpl(command, args, options)
  } }), error => error.message === 'SOURCE_UPLOAD_GIT_FAILED')
  assert.equal(attempts, 1)
  assert.equal(f.requests.length, 0)
  await f.assertClean()
})

test('逐字段拒绝错误回执，每次仅一次 PUT 并清理归档', async t => {
  const f = await fixture(t)
  for (const patch of [{ project: 'other' }, { pipeline: 'dataset-tag' }, { environment: 'uat9' },
    { commit: 'c'.repeat(40) }, { sha256: 'd'.repeat(64) }, { artifact_id: '' }, { artifact_id: '../secret' },
    { woodpecker_pipeline: '71' }, { woodpecker_pipeline: 0 }]) {
    let count = 0
    await assert.rejects(uploadUatSource({ ...f.input, fetchImpl: async (url, options) => {
      count++
      return { status: 201, json: async () => ({ ...validReceipt(url, options), ...patch }) }
    } }), /SOURCE_UPLOAD_RECEIPT_MISMATCH/)
    assert.equal(count, 1)
  }
  await f.assertClean()
})

test('HTTP 冲突、超时、重定向及非法 JSON 不重试，错误不透出凭据', async t => {
  const f = await fixture(t)
  const variants = [
    [async () => ({ status: 409 }), 'SOURCE_UPLOAD_HTTP_409'],
    [async () => ({ status: 200 }), 'SOURCE_UPLOAD_HTTP_200'],
    [async () => ({ status: 302 }), 'SOURCE_UPLOAD_HTTP_302'],
    [async () => ({ status: 201, redirected: true }), 'SOURCE_UPLOAD_REDIRECT_REJECTED'],
    [async () => { throw new DOMException('upload-fixture-secret', 'TimeoutError') }, 'SOURCE_UPLOAD_REQUEST_UNCONFIRMED'],
    [async () => { throw Error('redirect upload-fixture-secret') }, 'SOURCE_UPLOAD_REQUEST_UNCONFIRMED'],
    [async () => ({ status: 201, json: async () => { throw Error('upload-fixture-secret') } }), 'SOURCE_UPLOAD_RESPONSE_INVALID'],
  ]
  for (const [respond, expected] of variants) {
    let count = 0
    await assert.rejects(uploadUatSource({ ...f.input, fetchImpl: async (...args) => { count++; return respond(...args) } }),
      error => error.message === expected && !error.message.includes('fixture-secret'))
    assert.equal(count, 1)
  }
  await f.assertClean()
})
