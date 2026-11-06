import { nativeLifecycle, nativeLifecycleTimeout, nativeTemporaryDirectory as mkdtemp, nativeRemove as rm } from "./native-lifecycle.js"
import testRunner from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, rmdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { taskDirectories } from "../../packages/dingtalk-dsh-assistant/session-workspaces.js"
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveTopicMessages } from "../../packages/dingtalk-dsh-assistant/store.js"
import { openDynamicTaskStore } from "../../packages/dingtalk-dsh-assistant/dynamic-task-store.js"
import { openTaskSessionService } from "../../packages/dingtalk-dsh-assistant/task-session-service.js"
import { groupReplyScopeInstructions } from "../../packages/dingtalk-dsh-assistant/group-message.js"
import { taskIndexPage } from "../../packages/dingtalk-dsh-assistant/task-topic-coordinator.js"
import { fingerprint } from "../../packages/dingtalk-dsh-assistant/topic-model.js"
import { buildReplyReviewCandidates } from "../../packages/dingtalk-dsh-assistant/decision.js"
import { projectTaskNotification } from "../../packages/dingtalk-dsh-assistant/task-message-projections.js"
import { available, reason, nativeTaskHost, latestInput, waitUntil, modelToolValues, topicTaskCalls, scriptedRouteSilences } from "./task-session-native-host.js"

const call = (name, args) => ({ name, args: name === 'group_decision_submit' ? { ...args, decision: { ...args.decision, topicUpdate: { summary: '围绕原始事项持续核对，当前结论以任务真实进展为准。' } } } : args })
function decisionSummaryRead(request, input) {
  if (input.summaryContext?.section !== 'summary') return
  const pages = modelToolValues(request).filter(value => value.requestId === input.requestId && value.section === 'summary')
  const last = pages.at(-1)
  if (last && !last.hasMore) return
  return call('group_decision_context_get', { requestId: input.requestId, section: 'summary', offset: last?.nextOffset ?? 0 })
}
function envelope(request, prefix) {
  for (const message of request.messages.toReversed().filter(item => item.role === 'user')) for (const part of message.content ?? []) {
    if (part.type !== 'text' || !(part.text.startsWith(prefix) || prefix === '[GROUP_TOPIC_ROUTE]' && part.text.startsWith('[GROUP_TOPIC_ROUTE_UPDATE]'))) continue
    const line = part.text.split('\n').find(value => value.startsWith('Topic 请求：'))
    if (line) {
      const value = JSON.parse(line.slice('Topic 请求：'.length))
      if (prefix === '[GROUP_TOPIC_ROUTE]' && part.text.startsWith('[GROUP_TOPIC_ROUTE_UPDATE]')) {
        const original = request.messages.filter(item => item.role === 'user').flatMap(item => item.content ?? []).filter(item => item.type === 'text' && item.text.startsWith('[GROUP_TOPIC_ROUTE]'))
          .map(item => item.text.split('\n').find(text => text.startsWith('Topic 请求：'))).filter(Boolean)
          .map(text => JSON.parse(text.slice('Topic 请求：'.length))).find(item => item.requestId === value.requestId)
        return { ...original, ...value }
      }
      return value
    }
  }
  throw new Error(`Missing native ${prefix} request`)
}
function jsonValues(value) {
  if (!value || typeof value !== 'object') return []
  const values = [value]
  for (const child of Object.values(value)) {
    if (typeof child === 'string') { try { values.push(...jsonValues(JSON.parse(child))) } catch {} }
    else if (typeof child === 'object') values.push(...jsonValues(child))
  }
  return values
}
const message = (messageId, text) => ({ groupId: 'native-group', messageId, senderOpenDingTalkId: 'native-user', senderName: '真实用户', sourceKind: 'dingtalk', text,
  occurredAt: '2026-10-13T10:00:00Z', timestamp: '2026-10-13T10:00:00Z' })







































async function extraHost(t, prefix, decide) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  let host
  t.after(async () => { try { await host?.close() } finally { await rm(root, { recursive: true, force: true }) } })
  host = await nativeTaskHost(root, decide)
  return host
}





















// Prompt assertions check the guidance delivered to the model. Scripted choices
// below verify the real context/action pipeline, not free-running model semantics.






// The model decisions are scripted; this exercises the native context and task pipeline.

export { assert, available, buildReplyReviewCandidates, call, createHash, decisionSummaryRead, envelope, extraHost, fingerprint, groupReplyScopeInstructions, join, jsonValues, latestInput, message, mkdir, mkdtemp, modelToolValues, nativeLifecycle, nativeLifecycleTimeout, nativeTaskHost, openDynamicTaskStore, openTaskSessionService, projectTaskNotification, readFile, reason, resolveTopicMessages, rm, rmdir, scriptedRouteSilences, taskDirectories, taskIndexPage, testRunner, tmpdir, topicTaskCalls, waitUntil }
