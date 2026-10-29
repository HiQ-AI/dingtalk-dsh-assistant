import test from 'node:test'
import assert from 'node:assert/strict'
import { createObserverAlertPages } from '../packages/dingtalk-dsh-assistant/observer-alert-pages.js'
import { hasRestartIsolation, isolationDigest } from '../packages/dingtalk-dsh-assistant/native-restart-isolation.js'
import { restartFixture } from './fixtures/native-restart-isolation.js'

function audited(acknowledged = true) {
 const f = restartFixture(acknowledged)
 f.operation.id = f.operation.operationId
 // Synthetic counterpart of the persisted Windows scope probe; no private logs or identifiers.
 const provenance = { kind: 'native-windows-restart-probe', historicalJobObjectIdentity: 'unavailable', isolationBasis: 'bounded-producer-exclusion' }
 const isolation = { ...f.receipt, kind: 'native-source-scope-isolation', issuer: 'native-windows-scope-evidence-v1',
  sourceScopeQuiescent: true, durableSourceExclusion: true, activeSourceCount: 0, provenance, provenanceDigest: isolationDigest(provenance) }
 isolation.binding.operationDigest = isolationDigest(f.operation)
 const proof = { kind: 'native-host-restart-isolated', ...isolation.binding, observations: [{ sequence: 1 }], isolation }
 f.operation.recoverySettlement = { kind: 'host-restart-isolated', exitStatus: 'unknown', noReplay: true, partialEffectsPossible: true,
  operatorSourceId: 'synthetic-operator', humanRequestId: 'synthetic-human', proof }
 assert.equal(hasRestartIsolation(f.operation), true)
 return f.operation
}
function alerts(operation, extras = {}) {
 return createObserverAlertPages({ failures: new Map(), tasks: new Map(), operations: new Map([[operation.id, operation]]), notifications: new Map(), ...extras })
}

for (const acknowledged of [true, false]) test(`audited ${acknowledged ? 'acknowledged' : 'missing-result'} restart is not an active alert and preserves history`, async () => {
 const operation = audited(acknowledged), before = structuredClone(operation), pages = alerts(operation)
 assert.deepEqual(pages.all(), [])
 assert.equal((await pages.page()).total, 0)
 assert.deepEqual(operation, before)
 assert.equal(operation.state, 'unknown'); assert.equal(operation.result, null); assert.equal(operation.job.status, 'running')
})

const invalid = {
 'no audit': o => { delete o.recoverySettlement },
 'wrong recovery reason': o => { o.recoveryReason = 'other' },
 'missing operator confirmation': o => { delete o.recoverySettlement.operatorSourceId },
 'missing investigation evidence': o => { o.recoverySettlement.proof.observations = [] },
 'scope not drained': o => { o.recoverySettlement.proof.isolation.sourceScopeQuiescent = false },
 'remaining source': o => { o.recoverySettlement.proof.isolation.activeSourceCount = 1 },
 'writers not excluded': o => { o.recoverySettlement.proof.isolation.externalWritersExcluded = false },
 'invalid provenance digest': o => { o.recoverySettlement.proof.isolation.provenanceDigest = 'stale' },
 'stale operation digest': o => { o.recoverySettlement.proof.operationDigest = 'stale' },
 'foreign task binding': o => { o.recoverySettlement.proof.taskId = 'other' },
 'replay not forbidden': o => { o.recoverySettlement.noReplay = false },
}
for (const [name, mutate] of Object.entries(invalid)) test(`unknown remains active: ${name}`, async () => {
 const operation = audited(); mutate(operation)
 const before = structuredClone(operation), pages = alerts(operation)
 assert.equal(pages.all().length, 1)
 assert.equal((await pages.page()).total, 1)
 assert.deepEqual(operation, before)
})

test('audit transition refreshes pagination without suppressing independent unknown or notification failures', async () => {
 const operation = audited(), audit = operation.recoverySettlement
 delete operation.recoverySettlement
 const other = { id: 'other', operationId: 'other', state: 'unknown' }
 const pages = alerts(operation, { operations: new Map([[operation.id, operation], [other.id, other]]),
  notifications: new Map([['notice', { id: 'notice', state: 'unknown' }]]) })
 assert.equal((await pages.page()).total, 3)
 operation.recoverySettlement = audit
 const page = await pages.page()
 assert.equal(page.total, 2)
 assert.deepEqual(pages.all().map(x => x.alertId).sort(), ['notification:notice', 'operation:other'])
})
