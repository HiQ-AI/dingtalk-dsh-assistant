import { nativeLifecycle, nativeLifecycleTimeout, nativeTemporaryDirectory as mkdtemp, nativeRemove as rm } from "./native-lifecycle.js"
import { lifecycleStages } from "./lifecycle-stages.js"
import testRunner from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createServer } from 'node:net'
import { get as httpGet } from 'node:http'
import { createHash } from 'node:crypto'
import * as resident from "../../packages/dingtalk-dsh-assistant/resident.js"
import { available, reason, nativeShell, nativeTaskHost, nativeVerificationTeam, latestInput, modelToolValues, topicTaskCalls, waitUntil } from "./task-session-native-host.js"
import { inspectSession } from "../../packages/dingtalk-dsh-assistant/session-persistence.js"
import { taskSessionLogRoot } from "../../packages/dingtalk-dsh-assistant/task-session-persistence.js"
import { retireTaskContext } from "../../packages/dingtalk-dsh-assistant/task-session.js"
import { openDynamicTaskStore } from "../../packages/dingtalk-dsh-assistant/dynamic-task-store.js"
import { openTaskSessionService } from "../../packages/dingtalk-dsh-assistant/task-session-service.js"
import { taskNotificationRecovery } from "../../packages/dingtalk-dsh-assistant/notification-delivery.js"
import { DatabaseSync } from 'node:sqlite'
import { openTaskResidentRuntime } from "../../packages/dingtalk-dsh-assistant/task-resident-runtime.js"






import { projectTaskNotification } from "../../packages/dingtalk-dsh-assistant/task-message-projections.js"
import { findSessionLog, requestSystemText } from "./session-persistence.js"

const call = (name, args) => ({ name, args })
const test = (name, options, run) => testRunner(name, { ...options, ...(!available ? { skip: reason } : {}) }, run)
const decision = (action, summary) => call('task_session_submit', { decision: { action, summary, evidence: ['实际文件和进程输出已核验'], limitations: [] } })









// The real Windows shell and three independent verification sessions exceed the old 15s budget.


// The scripted coordinator obeys the same required-read contract as a real model.


function requiredDecisionRead(request, input) {
  for (const source of input.sources ?? []) if (source.textFile && source.readRequired) {
    const alreadyLocated = request.messages.filter(message => message.role === 'tool').some(message =>
      (message.content ?? []).some(part => part.type === 'text' && part.text.includes(source.textFile)))
    if (!alreadyLocated) return call('read', { file_path: source.textFile, offset: 1, limit: 1 })
  }
  const refs = new Set()
  function visit(value) {
    if (!value || typeof value !== 'object') return
    if (value.contentRef) refs.add(value.contentRef)
    else for (const child of Object.values(value)) visit(child)
  }
  if (input.task?.readRequired) { visit(input.task.objective); visit(input.task.requirements) }
  for (const source of input.sources ?? []) if (source.readRequired) { visit(source.text); visit(source.body); visit(source.quote) }
  for (const execution of input.executions ?? []) if (execution.readRequired) { visit(execution.input?.objective); visit(execution.stageProgress) }
  const pages = modelToolValues(request)
  for (const ref of refs) {
    const textPages = pages.filter(page => page.contentRef === ref && page.format === 'text')
    if (!textPages.some(page => page.nextOffset === null)) return call('model_content_read', { contentRef: ref, offset: textPages.at(-1)?.nextOffset ?? 0, limit: 16000 })
  }
}

const message = { groupId: 'native-group', messageId: 'native-message-1', senderOpenDingTalkId: 'native-user', senderName: '真实用户', text: '测试助手，分别生成 alpha 和 beta 的文件并用终端验证，再汇总结论。', occurredAt: '2026-10-13T10:00:00Z', timestamp: '2026-10-13T10:00:00Z' }

async function nativeCase(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix)), hosts = []
  t.after(async () => { try { for (const host of hosts.toReversed()) await host.close() } finally { await rm(root, { recursive: true, force: true }) } })
  return { root, async host(decide, options) { const host = await nativeTaskHost(root, decide, options); hosts.push(host); return host } }
}











// Full baseline and current native runs need about 140s for 32 generations and independent verification.

export { DatabaseSync, assert, available, basename, call, createHash, createServer, decision, findSessionLog, httpGet, inspectSession, join, latestInput, lifecycleStages, message, mkdir, mkdtemp, modelToolValues, nativeCase, nativeLifecycle, nativeLifecycleTimeout, nativeShell, nativeTaskHost, nativeVerificationTeam, openDynamicTaskStore, openTaskResidentRuntime, openTaskSessionService, projectTaskNotification, readFile, readdir, reason, requestSystemText, requiredDecisionRead, resident, retireTaskContext, rm, taskNotificationRecovery, taskSessionLogRoot, test, testRunner, tmpdir, topicTaskCalls, waitUntil, writeFile }
