import { writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

const [output, duration = '60'] = process.argv.slice(2)
if (!output || !Number.isFinite(+duration) || +duration < 1 || +duration > 120) throw Error('usage: node measure-live-tail.mjs <output> [seconds:1..120]')
const base = 'http://127.0.0.1:18998'
const topicsResponse = await fetch(base + '/state/topics?offset=0&limit=1')
if (!topicsResponse.ok) throw Error('topic discovery failed: ' + topicsResponse.status)
const topics = (await topicsResponse.json()).topics
const topic = topics?.[0]
if (!topic) throw Error('no real topic available for detail validation')
const groupId = topic.groupId ?? topic.conversationId
if (!groupId) throw Error('topic group identity missing')
const routes = ['/health', '/state/groups?summary=true', '/state/tasks?offset=0&limit=50', `/state/topics/${encodeURIComponent(topic.topicId)}?groupId=${encodeURIComponent(groupId)}`]
const records = [], start = performance.now()
while (performance.now() - start < +duration * 1000) {
  await Promise.all(routes.map(async (path, index) => {
    const at = performance.now()
    try {
      const response = await fetch(base + path, { signal: AbortSignal.timeout(15000) })
      const headersMs = performance.now() - at
      await response.json()
      records.push({ route: index === 3 ? '/state/topics/:id?groupId=:id' : path, status: response.status, startedMs: Math.round(at - start), headersMs: +headersMs.toFixed(2), ms: +(performance.now() - at).toFixed(2) })
    } catch (error) { records.push({ route: index === 3 ? '/state/topics/:id?groupId=:id' : path, error: error.name }) }
  }))
  await delay(250)
}
const summary = [...new Set(records.map(r => r.route))].map(route => {
  const rows = records.filter(r => r.route === route), times = rows.filter(r => r.ms !== undefined).map(r => r.ms).sort((a,b) => a-b)
  return { route, count: rows.length, errors: rows.filter(r => r.error || r.status !== 200).length, p50Ms: times[Math.ceil(times.length * .5)-1], p95Ms: times[Math.ceil(times.length * .95)-1], maxMs: times.at(-1), over1000: times.filter(t => t >= 1000).length, over3000: times.filter(t => t >= 3000).length }
})
const result = { durationMs: Math.round(performance.now()-start), readOnly: true, businessWrites: 0, result: summary.every(r => r.errors === 0) ? 'PASS' : 'FAIL', summary, records }
await writeFile(output, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ ...result, records: undefined }))
if (result.result !== 'PASS') process.exitCode = 1
