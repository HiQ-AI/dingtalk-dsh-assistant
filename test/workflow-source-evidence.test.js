import assert from 'node:assert/strict'
import test from 'node:test'
import { readUploadedSourceEvidence } from '../packages/dingtalk-dsh-assistant/workflow-source-evidence.js'

const commit = 'a'.repeat(40), sha256 = 'b'.repeat(64), artifactId = 'c'.repeat(32)
const log = text => ({ step_id: 17, data: Buffer.from(text).toString('base64') })
const proof = `uploaded source prepared commit=${commit.slice(0, 12)} sha256=${sha256}`
function fixture() {
  const pipeline = { number: 23, event: 'manual', commit,
    variables: { SOURCE_PACKAGE_ID: artifactId, SOURCE_PACKAGE_SHA256: sha256,
      SOURCE_COMMIT_SHA: commit, SOURCE_PACKAGE_DOWNLOAD_TOKEN: 'private-download-token' },
    workflows: [{ children: [{ id: 17, name: 'prepare-uploaded-source', state: 'success', exit_code: 0 }] }] }
  const logs = [log('preparing uploaded source'), { step_id: 17, data: null }, log(`${proof}\n`)]
  const calls = []
  return { pipeline, logs, calls, readStepLogs: async id => { calls.push(id); return logs } }
}

test('实际源码准备日志绑定完整提交和包摘要，输出不包含认证变量', async () => {
  const input = fixture()
  const result = await readUploadedSourceEvidence(input)
  assert.deepEqual(result, { commitSha: commit, sha256, artifactId,
    evidenceRef: `woodpecker-source:23:17:${artifactId}:${sha256}` })
  assert.deepEqual(input.calls, [17])
  assert.equal(JSON.stringify(result).includes('private-download-token'), false)
})

test('普通 Cron 和不带源码包的 manual 构建不额外读取日志', async () => {
  for (const event of ['cron', 'manual']) {
    const input = fixture()
    input.pipeline.event = event
    delete input.pipeline.variables
    input.pipeline.workflows[0].children = [{ id: 18, name: 'clone-source', state: 'success', exit_code: 0 }]
    assert.equal(await readUploadedSourceEvidence(input), undefined)
    assert.deepEqual(input.calls, [])
  }
})

test('明确跳过且未开始的 clone 可以确认源码包消费', async () => {
  const input = fixture()
  input.pipeline.workflows[0].children.push({ id: 18, name: 'clone-source', state: 'skipped', started: 0, exit_code: 0 })
  assert.equal((await readUploadedSourceEvidence(input)).sha256, sha256)
})

test('变量缺失、提交漂移、格式错误和非 manual 事件在读日志前拒绝', async () => {
  for (const mutate of [
    input => { delete input.pipeline.variables },
    input => { delete input.pipeline.variables.SOURCE_PACKAGE_ID },
    input => { input.pipeline.variables.SOURCE_COMMIT_SHA = 'd'.repeat(40) },
    input => { input.pipeline.variables.SOURCE_PACKAGE_ID = '../private-download-token' },
    input => { input.pipeline.variables.SOURCE_PACKAGE_SHA256 = 'sha256:' + sha256 },
    input => { input.pipeline.event = 'cron' },
    input => { input.pipeline.number = 0 },
  ]) {
    const input = fixture(); mutate(input)
    await assert.rejects(readUploadedSourceEvidence(input), { message: 'WOODPECKER_SOURCE_PACKAGE_UNCONFIRMED' })
    assert.deepEqual(input.calls, [])
  }
})

test('prepare 必须唯一成功；clone 已执行、状态未知或跳过状态与开始时间冲突均拒绝', async () => {
  for (const mutate of [
    input => { input.pipeline.workflows = [] },
    input => { input.pipeline.workflows.push(structuredClone(input.pipeline.workflows[0])) },
    input => { input.pipeline.workflows[0].children[0].state = 'skipped' },
    input => { input.pipeline.workflows[0].children[0].exit_code = 1 },
    ...['success', 'running', 'failure', 'unknown'].map(state => input => {
      input.pipeline.workflows[0].children.push({ id: 18, name: 'clone-source', state, exit_code: 0 })
    }),
    input => { input.pipeline.workflows[0].children.push({ id: 18, name: 'clone-source', state: 'skipped', started: 1700000000 }) },
  ]) {
    const input = fixture(); mutate(input)
    await assert.rejects(readUploadedSourceEvidence(input), { message: 'WOODPECKER_SOURCE_PREPARATION_UNCONFIRMED' })
    assert.deepEqual(input.calls, [])
  }
})

test('只接受该 prepare 的规范 Base64 UTF-8 日志，不回显原始内容', async () => {
  for (const badRow of [null, { step_id: 18, data: log(proof).data }, { step_id: 17, data: 'private-download-token' },
    { step_id: 17, data: 'AB==' }, { step_id: 17, data: Buffer.from([0xff]).toString('base64') },
    { step_id: 17, data: 23 }]) {
    const input = fixture(); input.logs.push(badRow)
    await assert.rejects(readUploadedSourceEvidence(input), { message: 'WOODPECKER_SOURCE_LOG_INVALID' })
  }
  await assert.rejects(readUploadedSourceEvidence({ ...fixture(), readStepLogs: async () => 'private-download-token' }),
    { message: 'WOODPECKER_SOURCE_LOG_INVALID' })
})

test('缺少、重复或摘要/提交不符的消费日志不构成证明', async () => {
  for (const logs of [[], [log('prepare succeeded')], [log(proof), log(proof)],
    [log(proof.replace(sha256, 'd'.repeat(64)))], [log(proof.replace(commit.slice(0, 12), 'd'.repeat(12)))]]) {
    await assert.rejects(readUploadedSourceEvidence({ ...fixture(), readStepLogs: async () => logs }),
      { message: 'WOODPECKER_SOURCE_LOG_UNCONFIRMED' })
  }
})

test('日志读取错误不泄漏底层响应或认证信息', async () => {
  await assert.rejects(readUploadedSourceEvidence({ ...fixture(), readStepLogs: async () => {
    throw Error('private-download-token')
  } }), { message: 'WOODPECKER_SOURCE_LOG_READ_FAILED' })
})
