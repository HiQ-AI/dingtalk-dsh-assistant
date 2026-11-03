import { createHash } from 'node:crypto'

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const sameSet = (a, b) => a.length === b.length && new Set(a).size === a.length && new Set(b).size === b.length && a.every(item => b.includes(item))
const validRoutes = routes => routes.every(route => typeof route.messageId === 'string' && route.messageId && typeof route.source === 'string' && route.source && typeof route.topic === 'string' && route.topic)
const validActions = actions => actions.every(action => typeof action.kind === 'string' && action.kind && (action.taskId === undefined || typeof action.taskId === 'string' && action.taskId))
const containsLabels = value => value && typeof value === 'object' && Object.entries(value).some(([key, child]) => key === 'expected' || containsLabels(child))

export function validateDataset(scenarios) {
  if (!Array.isArray(scenarios) || scenarios.length === 0) throw new Error('empty_dataset')
  const ids = new Set(), families = new Map(), constructions = new Map(), inputs = new Map()
  for (const scenario of scenarios) {
    const { id, family, constructionFamily = family, split, input, expected } = scenario
    if (!id || ids.has(id) || !family || !['development', 'holdout'].includes(split) || !input || !expected) throw new Error(`invalid_scenario:${id}`)
    if (families.has(family) && families.get(family) !== split) throw new Error(`split_leakage:${family}`)
    if (!constructionFamily || (constructions.has(constructionFamily) && constructions.get(constructionFamily) !== split)) throw new Error(`construction_split_leakage:${constructionFamily}`)
    const inputDigest = digest(input)
    if (inputs.has(inputDigest) && inputs.get(inputDigest) !== split) throw new Error(`input_leakage:${id}`)
    ids.add(id); families.set(family, split); constructions.set(constructionFamily, split); inputs.set(inputDigest, split)
    if (!Array.isArray(input.messages) || !input.messages.length || !['routed', 'needs-context'].includes(expected.routeStatus) || !Array.isArray(expected.routes) || !Array.isArray(expected.actions) || !Array.isArray(expected.candidateTopicIds)) throw new Error(`invalid_contract:${id}`)
    if (!input.group?.id || !input.group?.responsibility || !Array.isArray(input.topics) || !Array.isArray(input.tasks)) throw new Error(`missing_context:${id}`)
    const localTopics = new Set(input.topics.filter(topic => topic.groupId === input.group.id).map(topic => topic.id))
    if (expected.candidateTopicIds.some(topic => !localTopics.has(topic))) throw new Error(`invalid_candidate_label:${id}`)
    if (expected.actions.some(action => action.taskId && !input.tasks.some(task => task.id === action.taskId && localTopics.has(task.topicId)))) throw new Error(`invalid_task_label:${id}`)
    if (!validRoutes(expected.routes) || !validActions(expected.actions) || new Set(expected.candidateTopicIds).size !== expected.candidateTopicIds.length) throw new Error(`invalid_labels:${id}`)
    if (new Set(input.messages.map(message => message.messageId)).size !== input.messages.length) throw new Error(`duplicate_source:${id}`)
    for (const route of expected.routes) {
      const source = input.messages.find(message => message.messageId === route.messageId)
      if (!source || !source.text?.includes(route.source)) throw new Error(`unknown_source:${id}`)
      if (route.topic !== 'new' && !route.topic.startsWith('new:') && !localTopics.has(route.topic)) throw new Error(`invalid_topic_label:${id}`)
    }
    if (containsLabels(input)) throw new Error(`embedded_labels:${id}`)
  }
  return { scenarios: scenarios.length, families: families.size, digest: digest(scenarios) }
}

export function modelInput(scenario) {
  return structuredClone(scenario.input)
}

function routePartition(routes, input) {
  const topics = new Map(), seen = new Set()
  for (const { messageId, source, topic } of routes) {
    const text = input.messages.find(message => message.messageId === messageId)?.text
    const start = text?.indexOf(source) ?? -1
    if (start < 0 || text.indexOf(source, start + 1) !== -1) return null
    const pair = JSON.stringify([messageId, source, topic])
    if (seen.has(pair)) return null
    seen.add(pair)
    if (!topics.has(topic)) topics.set(topic, new Set())
    for (let offset = start; offset < start + source.length; offset++) {
      if (!/[\s\p{P}\p{Z}]/u.test(text[offset])) topics.get(topic).add(JSON.stringify([messageId, offset]))
    }
  }
  const existing = [], created = []
  for (const [topic, sources] of topics) {
    const signature = JSON.stringify([...sources].sort())
    if (topic === 'new' || topic.startsWith('new:')) created.push(signature)
    else existing.push(JSON.stringify([topic, signature]))
  }
  return { existing: existing.sort(), created: created.sort() }
}

export function scoreScenario(scenario, observation, humanReview) {
  const wanted = scenario.expected
  if (!observation || !['routed', 'needs-context'].includes(observation.routeStatus) || !Array.isArray(observation.routes) || !Array.isArray(observation.actions) || !Array.isArray(observation.candidates)) throw new Error(`missing_observation:${scenario.id}`)
  if (!validRoutes(observation.routes) || !validActions(observation.actions) || observation.candidates.some(id => typeof id !== 'string' || !id)) throw new Error(`invalid_observation:${scenario.id}`)
  const actionKey = action => JSON.stringify([action.kind, action.taskId ?? null])
  const expectedPartition = routePartition(wanted.routes, scenario.input), observedPartition = routePartition(observation.routes, scenario.input)
  const routeCorrect = wanted.routeStatus === observation.routeStatus && expectedPartition !== null && observedPartition !== null
    && JSON.stringify(expectedPartition) === JSON.stringify(observedPartition)
  const actionKindTargetCorrect = sameSet(wanted.actions.map(actionKey), observation.actions.map(actionKey))
  const relevant = wanted.candidateTopicIds ?? []
  const recalled = relevant.filter(id => observation.candidates.includes(id)).length
  const observationDigest = digest(observation), scenarioDigest = digest(scenario)
  if (humanReview && (humanReview.observationDigest !== observationDigest || humanReview.scenarioDigest !== scenarioDigest)) throw new Error(`stale_human_review:${scenario.id}`)
  const dimensions = ['businessObject', 'deliverable', 'authorization', 'forbiddenActions']
  const review = Object.fromEntries(dimensions.map(name => {
    const item = humanReview?.dimensions?.[name] ?? { status: 'pending' }
    if (!['pending', 'pass', 'fail', 'not-applicable'].includes(item.status)
      || item.status !== 'pending' && (!item.reviewer?.trim() || !item.evidence?.trim())) throw new Error(`invalid_human_review:${scenario.id}:${name}`)
    return [name, structuredClone(item)]
  }))
  const statuses = Object.values(review).map(item => item.status)
  const semanticReview = statuses.includes('fail') ? 'fail' : statuses.includes('pending') ? 'pending' : 'reviewed'
  return { id: scenario.id, routeCorrect, actionKindTargetCorrect, candidateRecall: relevant.length ? recalled / relevant.length : null,
    candidateRelevant: relevant.length, candidateRecalled: recalled, scenarioDigest, observationDigest, semanticReview, review }
}

export function summarize(results) {
  if (!results.length) throw new Error('empty_results')
  const relevant = results.reduce((sum, row) => sum + row.candidateRelevant, 0)
  const recalled = results.reduce((sum, row) => sum + row.candidateRecalled, 0)
  return { scenarios: results.length, routeExact: results.filter(row => row.routeCorrect).length / results.length,
    actionKindTargetExact: results.filter(row => row.actionKindTargetCorrect).length / results.length, candidateRecall: relevant ? recalled / relevant : null,
    semanticReview: Object.fromEntries(['pending', 'reviewed', 'fail'].map(status => [status, results.filter(row => row.semanticReview === status).length])) }
}
