import { createHash } from 'node:crypto'
import { coordinationRole, coordinationTools } from '../../../../packages/dingtalk-dsh-assistant/coordination-sessions.js'

const requests = [{ requestId: 'coord-route-evaluation' }, { requestId: 'coord-decision-evaluation' }, { requestId: 'coord-summary-evaluation' }, { requestId: 'coord-decision-evaluation', trigger: 'task-facts' }, { requestId: 'evaluation-review', kind: 'completion' }]
const allowed = new Set(['model_content_read', ...requests.flatMap(request => coordinationTools(coordinationRole(request), request))].filter(name => !['read', 'glob', 'grep', 'skill'].includes(name)))

export function redactCredential(text, credential, json = false) {
  if (!credential) return text
  const value = json ? JSON.stringify(credential).slice(1, -1) : credential
  return text.split(value).join('[REDACTED]')
}

export function redactCredentialValue(value, credential) {
  return JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'string'
    ? redactCredential(redactCredential(item, credential), credential, true) : item))
}

export function installEvaluationIsolation(ctx) {
  const denied = []
  ctx.tools.guard(exec => {
    if (allowed.has(exec.name)) return undefined
    denied.push(exec.name)
    return 'evaluation_tool_forbidden'
  })
  ctx.on('agent/created', ({ agent }) => {
    const deny = ['read', 'glob', 'grep', 'skill', 'write', 'edit', 'pwsh', 'bash'].filter(name => agent.ctx.tools.get(name))
    if (deny.length) agent.ctx.tools.restrict({ deny })
  })
  return { denied, allowed }
}

export function installBoundedTopicGuard(ctx, { groupId, targetTopicId }) {
  ctx.tools.guard(execution => {
    const topicId = execution.arguments?.topicId
    if (execution.name !== 'group_topic_context_get' || topicId === targetTopicId) return undefined
    const session = execution.agent?.session
    const events = session?.snapshotEvents?.() ?? []
    const seeds = events.filter(event => event.type === 'plugin:dingtalk/coordination')
    if (seeds.length !== 1) return 'bounded_historical_topic_details_unavailable'
    const seed = seeds[0].data
    if (seed?.groupId !== groupId || !['route', 'decision'].includes(seed.role) || typeof seed.requestId !== 'string') return 'bounded_historical_topic_details_unavailable'
    const suffix = createHash('sha256').update(`${groupId}:${seed.requestId}`).digest('hex').slice(0, 24)
    if (!new RegExp(`^session-coordination-${suffix}-[a-f0-9]{8}$`).test(String(session.id))) return 'bounded_historical_topic_details_unavailable'
    const messages = session.deriveMessages()
    if (topicId === undefined) {
      if (seed.role === 'route') return undefined
      let boundTopicId
      for (const message of messages) if (message.role === 'user' && message.source?.kind === 'coordinator') {
        for (const part of message.content ?? []) {
          if (part.type !== 'text' || !part.text.startsWith('[GROUP_TOPIC_DECISION]\nTopic 请求：')) continue
          try {
            const envelope = JSON.parse(part.text.slice('[GROUP_TOPIC_DECISION]\nTopic 请求：'.length).split('\n')[0])
            if (envelope.requestId === seed.requestId) boundTopicId = envelope.topicId
          } catch {}
        }
      }
      return boundTopicId === targetTopicId ? undefined : 'bounded_historical_topic_details_unavailable'
    }
    if (seed.role !== 'route') return 'bounded_historical_topic_details_unavailable'
    const refs = new Set()
    const add = topics => {
      if (!Array.isArray(topics)) return
      for (const topic of topics) if (topic.topicId === targetTopicId && typeof topic.shortRef === 'string') refs.add(topic.shortRef)
    }
    const calls = new Map()
    for (const message of messages) {
      if (message.role === 'user' && message.source?.kind === 'coordinator') {
        for (const part of message.content ?? []) {
          if (part.type !== 'text' || !part.text.startsWith('[GROUP_TOPIC_ROUTE]\n')) continue
          const marker = '\nTopic 请求：', start = part.text.indexOf(marker)
          if (start < 0) continue
          try {
            const envelope = JSON.parse(part.text.slice(start + marker.length).split('\n')[0])
            if (envelope.requestId !== seed.requestId) continue
            for (const topics of [envelope.topics, envelope.relatedTopics, envelope.recalledTopics]) add(topics)
          } catch {}
        }
      }
      for (const block of message.content ?? []) if (block.type === 'tool-call') calls.set(block.id, block.name)
      if (message.role === 'tool' && !message.isError && calls.get(message.toolCallId) === 'group_topic_list') {
        try { add(JSON.parse((message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')).topics) } catch {}
      }
    }
    return refs.has(topicId) ? undefined : 'bounded_historical_topic_details_unavailable'
  })
}

export function isolatedEffects() {
  const notifications = []
  const readbacks = []
  const ownerAttempts = []
  const emptyCancels = []
  return {
    notifications,
    readbacks,
    ownerAttempts,
    emptyCancels,
    notificationAdapter: {
      async send(notification) {
        notifications.push(structuredClone(notification))
        return { messageId: `isolated-notification-${notifications.length}` }
      },
      async readback(notification) { readbacks.push(structuredClone(notification)); return { messageId: notification.ack.messageId, visible: true } },
    },
    taskSessions: {
      async run(input) { ownerAttempts.push(input); throw new Error('evaluation_owner_forbidden') },
      async cancel(input) { emptyCancels.push(input) },
      async close() {},
    },
  }
}
