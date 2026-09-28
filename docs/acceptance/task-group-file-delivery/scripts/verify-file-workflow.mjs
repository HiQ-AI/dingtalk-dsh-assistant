import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { inflateSync, crc32 } from 'node:zlib'
import { createTaskArtifactFiles } from '../../../../packages/dingtalk-dsh-assistant/task-artifact-files.js'
import { createTaskGroupFileAdapter, createTaskGroupFileDeliveryWorkflow } from '../../../../packages/dingtalk-dsh-assistant/task-group-file-delivery.js'
import { createDwsAdapter } from '../../../../packages/dingtalk-dsh-assistant/dws-adapter.js'
import { createNodeDwsRunner } from '../../../../packages/dingtalk-dsh-assistant/dws-runner.js'
import { openExecutionStore } from '../../../../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../../../../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { createExecutionDelivery } from '../../../../packages/dingtalk-dsh-assistant/execution-delivery.js'
import { createExecutionController } from '../../../../packages/dingtalk-dsh-assistant/execution-controller.js'

const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
const modes = args.filter(value => ['--check', '--mock', '--execute'].includes(value))
if (modes.length !== 1) throw new Error('Exactly one of --check/--mock/--execute required')
const mode = modes[0]
const profile = option('--profile') ?? (mode === '--mock' ? 'mock-profile' : undefined)
const groupId = option('--group-id') ?? (mode === '--mock' ? 'mock-group' : undefined), groupName = option('--group') ?? (mode === '--mock' ? 'mock-test-group' : undefined)
if (!profile || !groupId || !groupName) throw new Error('--profile/--group/--group-id required for live operations')
const formats = (option('--formats') ?? 'md,sql,png').split(',')
const caseName = option('--case') ?? 'three-files'
if (!/^[a-z][a-z0-9-]{0,31}$/u.test(caseName)) throw new Error('CASE_INVALID')
const evidenceDirectory = resolve(option('--directory') ?? 'docs/acceptance/task-group-file-delivery/round-2')
const fixtureBytes = {
 md: Buffer.from('# 文件交付工作流验收测试\n\n仅用于三文件持久效果验收，请勿建立业务任务。\n标识：task-group-file-delivery-runtime-20260928\n'),
 sql: Buffer.from('-- 文件交付工作流验收测试：附件交付，不执行数据库变更。\nSELECT 1 AS file_delivery_fixture;\n'),
 png: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOQy7vzHwAEfgJodQLI1QAAAABJRU5ErkJggg==', 'base64'),
}
function verifyPng(bytes) {
 assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
 const compressed = []
 let width, height, offset = 8
 while (offset < bytes.length) {
   const size = bytes.readUInt32BE(offset), type = bytes.subarray(offset + 4, offset + 8).toString(), data = bytes.subarray(offset + 8, offset + 8 + size)
   assert.equal(bytes.readUInt32BE(offset + size + 8), crc32(bytes.subarray(offset + 4, offset + size + 8)))
   if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); assert.equal(data[8], 8); assert.equal(data[9], 6) }
   if (type === 'IDAT') compressed.push(data)
   offset += size + 12
 }
 assert.equal(offset, bytes.length); assert.equal(width, 1); assert.equal(height, 1)
 const decoded = inflateSync(Buffer.concat(compressed))
 assert.deepEqual([...decoded], [0, 30, 110, 220, 255])
 return { valid: true, width, height, crcVerified: true, idatDecoded: true, decodedBytes: decoded.length }
}
verifyPng(fixtureBytes.png)
const safe = value => JSON.parse(JSON.stringify(value, (key, item) => /token|secret|url/iu.test(key) ? '[redacted]' : key === 'profile' ? 'bound-test-profile' : item))
async function checkGroup() {
 const runner = createNodeDwsRunner({ cwd: process.cwd() })
 const result = await runner.run(['chat', '+chat-search', '--query', groupName, '--page-all', '--profile', profile, '--format', 'json'])
 assert.equal(result.exitCode, 0)
 const response = JSON.parse(result.stdout)
 assert.equal(response.complete, true); assert.equal(response.hasMore, false); assert.equal(response.failedCount, 0)
 assert.equal(response.chats.length, 1); assert.equal(response.chats[0].name, groupName); assert.equal(response.chats[0].openConversationId, groupId)
 return { check: 'PASS', groupName, groupId, profile, writes: 0 }
}
if (mode === '--check') { console.log(JSON.stringify(await checkGroup())); process.exit(0) }

async function runWorkflow({ live, root }) {
 const files = createTaskArtifactFiles({ root: join(root, 'files') }), taskId = `${live ? 'task-live' : 'task-mock'}-${caseName}`
 const descriptors = []
 for (const format of formats) { const bytes = fixtureBytes[format]; if (!bytes) throw new Error("FORMAT_INVALID"); descriptors.push(await files.register({ taskId, requirementRevision: 1,
   producer: { runId: 'test-producer', nodeRunId: `producer-${format}`, outputRef: `fixture:${format}` }, role: format,
   fileName: `工作流文件交付测试 ${caseName} ${format}.${format}`, bytes })) }
 let sends = 0, pngDecoded
 const mockRecords = new Map()
 const messageAdapter = createTaskGroupFileAdapter({ files, profile,
   canDisclose: async ({ prepared }) => prepared.taskId === taskId && prepared.groupId === groupId && prepared.profile === profile,
   createAdapter: ({ directory, profile }) => {
     if (live) {
       const adapter = createDwsAdapter({ enabled: true, writesAuthorized: true, profile,
         runner: createNodeDwsRunner({ cwd: directory, runTimeoutMs: 120000 }) })
       return { ...adapter, sendGroupFile: async request => { sends++; return adapter.sendGroupFile(request) },
         readMessageFile: async request => { const result = await adapter.readMessageFile(request)
           if (result.resourceRef.name?.endsWith('.png')) pngDecoded = verifyPng(Buffer.from(result.data))
           return result } }
     }
     return { sendGroupFile: async request => { sends++; const row = descriptors.find(file => file.fileName === request.fileName)
       const openTaskId = `mock-task-${row.role}`; mockRecords.set(openTaskId, row); return { sendReceipt: { openTaskId } } },
       querySendStatus: async openTaskId => ({ result: { sendStatus: 'SUCCESS' }, messageRef: { openConversationId: groupId, openMessageId: `mock-message-${mockRecords.get(openTaskId).role}` } }),
       readMessageFile: async ({ groupId, messageId, expected }) => ({ ...expected,
         message: { conversationId: groupId, messageId }, resourceRef: { type: 'fileId', resourceId: `resource-${messageId}` } }) }
   } })
 const store = await openExecutionStore({ dbPath: join(root, 'control.db'), instanceId: 'file-workflow-acceptance', initialize: true })
 const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
 const grant = async ({ prepared }) => prepared?.groupId === groupId && prepared?.profile === profile && prepared?.taskId === taskId
   ? { principalId: profile, authorizationRef: 'user-authorized-test-group-20260928' } : null
 const delivery = createExecutionDelivery({ store, artifacts, messageAdapter, authorize: async () => null, authorizeMessage: grant })
 const workflow = createTaskGroupFileDeliveryWorkflow({ files, messageAdapter })
 const controller = createExecutionController({ store, artifacts, delivery, workflows: [workflow] })
 const runId = `file-delivery-${caseName}`
 try {
   await controller.createRun({ commandId: 'create-live-file-test', taskId, runId, workflowId: workflow.id,
     input: { files: descriptors, requirementRevision: 1, profile, groupId } })
   let state = await controller.whenIdle(runId), recoveries = 0
   const deadline = Date.now() + 60000
   while (state.run.status === 'waiting' && Date.now() < deadline) {
     const effects = await store.query({ kind: 'effect.list', runId })
     let unknown = false
     for (const effect of effects.filter(item => item.state === 'unknown')) if ((await delivery.reconcile(effect.effectId)).state !== 'succeeded') unknown = true
     if (unknown) { await delay(1000); continue }
     await controller.recover({ commandId: `recover-${++recoveries}`, runId })
     state = await controller.whenIdle(runId)
   }
   const effects = await store.query({ kind: 'effect.list', runId })
   const evidence = { checkedAt: new Date().toISOString(), mode: live ? 'live' : 'mock', runStatus: state.run.status,
     nodes: state.nodes.map(node => ({ nodeId: node.nodeId, status: node.status, waitReason: node.waitReason })), sends, recoveries,
     ...(pngDecoded ? { pngDecoded } : {}),
     effects: effects.map(effect => ({ effectId: effect.effectId, state: effect.state, action: effect.definition.action,
       artifact: effect.definition.payload.artifact, observation: safe(effect.result?.result) })) }
   if (state.run.status === 'succeeded') evidence.output = await artifacts.read(state.nodes.at(-1).outputRef)
   if (live) await writeFile(join(evidenceDirectory, 'workflow-result.json'), JSON.stringify(safe(evidence), null, 2) + '\n')
   assert.equal(state.run.status, 'succeeded', JSON.stringify(evidence))
   assert.equal(effects.length, formats.length); assert.equal(sends, formats.length); assert.ok(effects.every(effect => effect.state === 'succeeded'))
   assert.equal(evidence.output.deliveryStatus, 'files_verified')
   assert.deepEqual(evidence.output.receipts.map(item => item.result.role), formats)
   return evidence
 } finally { await controller.close(); await store.close() }
}

const mockRoot = await mkdtemp(join(tmpdir(), 'dsh-file-workflow-mock-'))
try { const result = await runWorkflow({ live: false, root: mockRoot }); console.log(JSON.stringify({ mock: 'PASS', sends: result.sends, runStatus: result.runStatus, effectStates: result.effects.map(item => item.state), roles: result.output.receipts.map(item => item.result.role), deliveryStatus: result.output.deliveryStatus })) }
finally { await rm(mockRoot, { recursive: true, force: true }) }
if (mode === '--mock') process.exit(0)
await checkGroup()
await mkdir(evidenceDirectory, { recursive: true })
const markerPath = join(evidenceDirectory, 'workflow-started.json')
try { await readFile(markerPath); throw new Error('PRIOR_WORKFLOW_MAY_HAVE_SENT_RECONCILE_ONLY_NO_RERUN') } catch (error) { if (error.code !== 'ENOENT') throw error }
const liveRoot = await mkdtemp(join(tmpdir(), 'dsh-file-workflow-live-'))
await writeFile(markerPath, JSON.stringify({ startedAt: new Date().toISOString(), groupId, profile: 'bound-test-profile',
  reason: 'Retain temporary DB for unknown reconciliation; marker prevents new live sends on rerun' }, null, 2), { flag: 'wx' })
try {
 const result = await runWorkflow({ live: true, root: liveRoot })
 console.log(JSON.stringify({ live: 'PASS', runStatus: result.runStatus, sends: result.sends,
   files: result.output.receipts.map(item => safe(item.result)) }))
 await rm(liveRoot, { recursive: true, force: true })
} catch (error) { console.error(`Live temporary runtime retained for reconciliation: ${liveRoot}`); throw error }
