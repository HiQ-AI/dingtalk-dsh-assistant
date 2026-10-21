import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { coordinationProposalSchema } from '../packages/dingtalk-dsh-assistant/independent-coordination-planner.js'

// No Host, TaskStore, credentials, write tools or sender are supplied to adapters.
// A real-model adapter must be explicitly supplied by the operator; the default
// reports missing evidence without discovering or loading local credentials.
export function compareProposal(proposal, expectations) {
  const failures = []
  for (const { path, equals, includes, absent } of expectations) {
    const value = path.split('.').reduce((v, key) => v?.[key], proposal)
    if (absent ? value !== undefined : includes !== undefined
      ? !Array.isArray(value) || !includes.every(item => value.includes(item))
      : JSON.stringify(value) !== JSON.stringify(equals)) failures.push({ path, expected: absent ? 'absent' : includes ?? equals, actual: value ?? null })
  }
  return failures
}

export async function replayLanguage({ cases, context, adapter }) {
  if (!adapter) return { status: 'not_executed', reason: 'Explicit isolated model adapter and authorized model access required',
    actualModelCalls: 0, implementationGaps: cases.filter(c => c.implementationGap).length,
    results: cases.map(c => ({ id: c.id, status: c.implementationGap ? 'implementation_gap' : 'not_executed',
      ...(c.implementationGap ? {reason:c.implementationGap} : {}) })) }
  if (!['scripted','actual-model'].includes(adapter.evidenceKind) || typeof adapter.plan !== 'function'
    || typeof adapter.identity !== 'string' || !adapter.identity.trim()) throw new Error('REPLAY_ADAPTER_CONTRACT_INVALID')
  const results = []; let adapterInvocations = 0
  for (const sample of cases) {
    if (sample.implementationGap) {
      results.push({id:sample.id,status:'implementation_gap',reason:sample.implementationGap}); continue
    }
    try {
      // Expectations are never passed to the model. Only synthetic facts and original language.
      adapterInvocations++
      const proposal = coordinationProposalSchema.parse(await adapter.plan(structuredClone({
        message: sample.message, context: { ...context, ...sample.context } })))
      const failures = compareProposal(proposal, sample.expect)
      results.push({ id: sample.id, status: failures.length ? 'failed' : 'passed', proposal, failures })
    } catch (error) { results.push({ id: sample.id, status: 'failed', error: String(error.message) }) }
  }
  return { status: 'executed', evidenceKind: adapter.evidenceKind, adapter: adapter.identity,
    // Calling an adapter is not proof that it made exactly one provider request.
    // Scripted adapters prove no model calls; real-model call accounting remains
    // unknown until a separately verified provider usage record is available.
    adapterInvocations, actualModelCalls: adapter.evidenceKind === 'actual-model' ? null : 0,
    implementationGaps: results.filter(r => r.status === 'implementation_gap').length,
    passed: results.filter(r => r.status === 'passed').length, failed: results.filter(r => r.status === 'failed').length, results }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), value = flag => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1] }
  if (args.some((v,i) => i % 2 === 0 && !['--fixtures','--adapter','--output'].includes(v)) || args.length % 2) throw new Error('REPLAY_ARGUMENT_INVALID')
  const fixtures = JSON.parse(await readFile(value('--fixtures') ?? new URL('../test/fixtures/coordination-language-cases.json', import.meta.url), 'utf8'))
  const adapter = value('--adapter') ? await import(pathToFileURL(resolve(value('--adapter'))).href) : undefined
  const report = await replayLanguage({ ...fixtures, adapter })
  const json = `${JSON.stringify(report,null,2)}\n`
  if (value('--output')) await writeFile(value('--output'), json)
  else process.stdout.write(json)
  if (report.failed) process.exitCode = 1
}
