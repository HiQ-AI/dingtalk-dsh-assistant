import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

export async function reconcileTopic(argv, request = fetch) {
  const { values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
    check: { type: 'boolean' }, apply: { type: 'boolean' }, endpoint: { type: 'string', default: 'http://127.0.0.1:18998' },
    'source-topic': { type: 'string' }, 'target-topic': { type: 'string' }, title: { type: 'string' }, summary: { type: 'string' },
    reason: { type: 'string' }, 'expected-digest': { type: 'string' }, 'request-id': { type: 'string' },
  } })
  if (Boolean(values.check) === Boolean(values.apply)) throw new Error('必须且只能指定 --check 或 --apply')
  for (const key of ['source-topic', 'target-topic', 'title', 'summary', 'reason']) if (!values[key]?.trim()) throw new Error(`缺少 --${key}`)
  if (values.apply && (!/^[a-f0-9]{64}$/.test(values['expected-digest'] ?? '') || !values['request-id']?.trim())) throw new Error('--apply 必须提供 --check 返回的 --expected-digest 和唯一 --request-id')
  const endpoint = new URL(values.endpoint)
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw new Error('endpoint 必须是本机回环 HTTP 地址')
  const call = async (path, body) => {
    const response = await request(new URL(path, endpoint), { method: body ? 'POST' : 'GET', ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) })
    const result = await response.json()
    if (!response.ok) throw new Error(`${response.status}: ${result.error ?? '请求失败'}`)
    return result
  }
  const maintenance = await call('/runtime/maintenance')
  if (!maintenance.active || !maintenance.maintenanceId || !Number.isSafeInteger(maintenance.revision)) throw new Error('Runtime 尚未处于维护状态；本脚本不会自动进入维护')
  const input = { sourceTopicId: values['source-topic'], targetTopicId: values['target-topic'],
    topicPresentation: { title: values.title, summary: values.summary }, reason: values.reason,
    maintenanceId: maintenance.maintenanceId, maintenanceRevision: maintenance.revision }
  const checked = await call('/runtime/topics/reconcile/check', input)
  if (values.check) return checked
  if (checked.expectedDigest !== values['expected-digest']) throw new Error('检查摘要已变化；重新核对 --check 输出后再执行')
  const receipt = await call('/runtime/topics/reconcile', { ...input, expectedDigest: values['expected-digest'], requestId: values['request-id'] })
  const target = await call(`/state/workflows/topics/${encodeURIComponent(input.targetTopicId)}/context`)
  return { receipt, target }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await reconcileTopic(process.argv.slice(2)), null, 2)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
