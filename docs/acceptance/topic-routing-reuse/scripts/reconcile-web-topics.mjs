const [mode, expectedDigest] = process.argv.slice(2)
if (!['--check', '--apply'].includes(mode)) throw new Error('require --check or --apply')
if (mode === '--apply' && !/^[a-f0-9]{64}$/.test(expectedDigest ?? '')) throw new Error('explicit checked digest required')
const groupId = 'cidq+PGRQW098/2Qh23wrl/ZQ=='
const post = async (suffix, body) => {
  const response = await fetch('http://127.0.0.1:18998/runtime/task-topics/reconcile' + suffix, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(JSON.stringify({ status: response.status, result }))
  return result
}
const check = await post('/check', { groupId })
if (mode === '--check') console.log(JSON.stringify(check, null, 2))
else {
  if (check.expectedDigest !== expectedDigest) throw new Error('checked topic plan changed')
  if (check.transfers.length !== 4 || new Set(check.transfers.map(item => item.targetTopicId)).size !== 2) throw new Error('expected four legacy continuations in two existing matters')
  console.log(JSON.stringify(await post('', { groupId, requestId: 'repair-web-continuation-topics-20261015-v1', expectedDigest }), null, 2))
}
