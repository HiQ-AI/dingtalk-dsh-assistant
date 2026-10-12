import { executionDigest, executionError } from './execution-artifacts.js'
const object = { type: 'object' }
export function createUatSchemaMigrationTaskWorkflow({ adapter }) {
  if (!adapter?.rulesDigest) throw executionError('UAT_SCHEMA_ADAPTER_REQUIRED')
  const nodes = [
    { id: 'inspect-schema', allowedEffects: ['read'], mapInput: ({ requirement }) => requirement,
      execute: async ({ input, signal }) => { signal?.throwIfAborted(); const observation = await adapter.inspect({ phase: 'preflight', requirement: input }); return { requirement: input, observation } } },
    { id: 'prepare-migration', allowedEffects: ['read'], mapInput: ({ previousOutput }) => previousOutput,
      execute: async ({ input, runId, generation, requirementDigest }) => ({ prepared: await adapter.prepareOperation({ requirement: input.requirement, runId, generation, requirementDigest }) }) },
    { id: 'execute-migration', allowedEffects: ['external.operation'], mapInput: ({ previousOutput }) => previousOutput,
      execute: async ({ input, perform }) => ({ prepared: input.prepared, receipt: await perform({ action: 'external', prepared: input.prepared }) }) },
    { id: 'verify-schema', allowedEffects: ['read'], mapInput: ({ previousOutput }) => previousOutput,
      execute: async ({ input }) => adapter.inspect({ phase: 'migrated', prepared: input.prepared, receipt: input.receipt }) },
  ].map(node => ({ ...node, version: '1', executor: 'code', inputSchema: object, outputSchema: object,
    ...(node.allowedEffects[0] === 'read' ? { drainPolicy: 'external-process' } : {}),
    rulesDigest: executionDigest({ adapter: adapter.rulesDigest, node: node.id }) }))
  return { id: 'task-uat-schema-migration', version: '1', nodes }
}
