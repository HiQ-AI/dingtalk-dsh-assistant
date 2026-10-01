import { executionDigest, executionError } from './execution-artifacts.js'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

const correctable = new Set(['QUERY_ARGUMENT_INVALID','QUERY_NOT_FOUND','QUERY_LIMIT_INVALID','QUERY_TIMEOUT','QUERY_SCOPE_DENIED','QUERY_CAPACITY'])
export const classifyAgentQueryError = error => correctable.has(error?.code) ? 'correctable' : 'fatal'
const fail = code => { throw executionError(code) }
export function agentEvidenceBinding(binding) {
  const message = binding?.kind === 'message-unit'
  const keys = message ? ['kind','runId','unitId','inputVersion','inputDigest','sessionId','leaseEpoch'] : ['taskId','runId','nodeRunId','generation','inputDigest','sessionId','leaseEpoch']
  if (binding?.kind !== undefined && !['task-node','message-unit'].includes(binding.kind)) fail('QUERY_BINDING_INVALID')
  const result = Object.fromEntries(keys.filter(key => binding?.[key] !== undefined).map(key => [key,binding[key]]))
  result.kind = message ? 'message-unit' : 'task-node'
  if (!Number.isSafeInteger(result.leaseEpoch) || result.leaseEpoch < 1) fail('QUERY_BINDING_INVALID')
  if (!result.runId || !result.sessionId || !result.inputDigest || (message ? !result.unitId || !Number.isInteger(result.inputVersion) : !result.taskId || !result.nodeRunId || !Number.isInteger(result.generation))) fail('QUERY_BINDING_INVALID')
  return result
}

/** 只安装已注册只读能力；scope/归属来自 Host，模型不能自行扩大。 */
export function createAgentQueryTools({ capabilities, resolveScope, artifacts }) {
  if (!Array.isArray(capabilities) || typeof resolveScope !== 'function' || typeof artifacts?.put !== 'function') fail('QUERY_CONFIG_INVALID')
  const selected = capabilities.filter(capability => capability.effectClass === 'read')
  if (new Set(selected.map(c => c.id)).size !== selected.length) fail('QUERY_CONFIG_INVALID')
  return selected.map(capability => {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(capability.id) || !capability.identity || !capability.parameters
      || ['authorize','execute','verify'].some(key => typeof capability[key] !== 'function')) fail('QUERY_CONFIG_INVALID')
    return {
      name: capability.id, description: capability.description, parameters: capability.parameters,
      classifyError: classifyAgentQueryError,
      async execute({ binding, input, args, signal }) {
        signal?.throwIfAborted()
        const execution = agentEvidenceBinding(binding)
        if (validateJsonSchemaValue(capability.parameters, args).length) fail('QUERY_ARGUMENT_INVALID')
        const scope = structuredClone(await resolveScope({ binding, input }))
        if (!scope || await capability.authorize({ input: args, scope, binding }) !== true) fail('QUERY_SCOPE_DENIED')
        const scopeDigest = executionDigest(scope)
        const output = await capability.execute({ input: args, scope, binding, signal })
        signal?.throwIfAborted()
        const verification = await capability.verify({ input: args, scope, binding, output, signal })
        if (verification?.passed !== true || !Array.isArray(verification.sourceRefs) || !verification.sourceRefs.length) fail('QUERY_VERIFICATION_FAILED')
        // 执行期间撤销权限或输入换代时不交付旧结果。
        if (executionDigest(await resolveScope({ binding, input })) !== scopeDigest) fail('QUERY_SCOPE_CHANGED')
        const evidence = { kind: 'agent-query-evidence', execution, scopeDigest, capabilityId: capability.id,
          capabilityIdentity: capability.identity, inputDigest: executionDigest(args), result: output, verification: { sourceRefs: verification.sourceRefs, outputDigest: executionDigest(output) },
          observedAt: new Date().toISOString() }
        const stored = await artifacts.put(evidence, execution.kind === 'message-unit' ? undefined : { taskId: execution.taskId, reference: binding.inputRef })
        return { evidenceRef: stored.ref, result: output, sourceRefs: verification.sourceRefs }
      },
    }
  })
}

/** Host 从持久执行历史重建允许身份，绝不以部分字段匹配代替精确归属。 */
export async function verifyAgentEvidence({ artifacts, refs, binding, allowedBindings = [], scope }) {
  if (!Array.isArray(refs) || refs.length > 100 || new Set(refs).size !== refs.length) fail('QUERY_EVIDENCE_INVALID')
  const identities = [binding, ...allowedBindings].filter(Boolean).map(value => executionDigest(agentEvidenceBinding(value)))
  if (!identities.length) fail('QUERY_BINDING_INVALID')
  const scopeDigest = executionDigest(scope), sourceRefs = new Set()
  for (const ref of refs) {
    const evidence = await artifacts.read(ref)
    if (evidence?.kind !== 'agent-query-evidence' || !identities.includes(executionDigest(evidence.execution))
      || evidence.scopeDigest !== scopeDigest || !evidence.verification?.sourceRefs?.length
      || evidence.verification.outputDigest !== executionDigest(evidence.result)) fail('QUERY_EVIDENCE_INVALID')
    for (const source of evidence.verification.sourceRefs) sourceRefs.add(source)
  }
  return { sourceRefs: [...sourceRefs] }
}
export async function verifyAgentQueryEvidence({ refs, binding, input, resolveScope, artifacts, allowedBindings }) {
  return verifyAgentEvidence({ refs, binding, artifacts, allowedBindings, scope: await resolveScope({binding,input}) })
}
