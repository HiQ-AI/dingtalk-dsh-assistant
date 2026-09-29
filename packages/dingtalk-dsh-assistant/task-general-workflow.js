import { executionDigest, executionError } from './execution-artifacts.js'
import { lstat, open, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

/** 只允许 Host 预先列出的工作区文件；读取后重新打开核验，拒绝符号链接逃逸。 */
export function createGeneralFileReadCapability({ root, readablePaths }) {
  if (typeof root !== 'string' || !isAbsolute(root) || !Array.isArray(readablePaths)
    || !readablePaths.length || readablePaths.some(path => typeof path !== 'string' || !path || isAbsolute(path)
      || path.split(/[\\/]/u).some(part => part === '..' || part === '.' || !part))) throw executionError('GENERAL_FILE_CONFIG_INVALID')
  const permitted = new Set(readablePaths)
  const within = (base, target) => { const rel = relative(base, target); return rel && rel !== '..' && !rel.startsWith(`..\\`) && !rel.startsWith('../') && !isAbsolute(rel) }
  async function load(path) {
    const base = await realpath(root), requested = resolve(base, path)
    if (!within(base, requested)) throw executionError('GENERAL_FILE_SCOPE_DENIED')
    const segments = relative(base, requested).split(/[\\/]/u)
    let cursor = base
    for (const segment of segments) {
      cursor = resolve(cursor, segment)
      if ((await lstat(cursor)).isSymbolicLink()) throw executionError('GENERAL_FILE_SCOPE_DENIED')
    }
    const target = await realpath(requested)
    if (!within(base, target)) throw executionError('GENERAL_FILE_SCOPE_DENIED')
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const opened = await handle.stat(), current = await lstat(target)
      if (!opened.isFile() || opened.dev !== current.dev || opened.ino !== current.ino) throw executionError('GENERAL_FILE_SCOPE_DENIED')
      if (opened.size > 12000) throw executionError('GENERAL_FILE_CAPACITY')
      const data = await handle.readFile()
      const after = await lstat(target)
      if (after.dev !== opened.dev || after.ino !== opened.ino || data.length > 12000) throw executionError('GENERAL_FILE_SCOPE_DENIED')
      const content = new TextDecoder('utf-8', { fatal: true }).decode(data)
      return { path, content, digest: executionDigest(content) }
    } finally { await handle.close() }
  }
  return {
    id: 'read-approved-file', effectClass: 'read', identity: `read-approved-file-v1:${executionDigest({ root, readablePaths: [...permitted].sort() })}`,
    description: '读取受信 Host 在当前任务作用域明确列出的 UTF-8 文件，最多 12 KiB',
    authorize: async ({ input, scope }) => typeof input.path === 'string' && permitted.has(input.path)
      && Array.isArray(scope.readableFiles) && scope.readableFiles.includes(input.path),
    execute: async ({ input }) => load(input.path),
    async verify({ input, scope, output }) {
      if (!await this.authorize({ input, scope })) return { passed: false }
      const fresh = await load(input.path)
      return { passed: executionDigest(fresh) === executionDigest(output), outputDigest: executionDigest(fresh), sourceRefs: [`file:${fresh.path}:${fresh.digest}`] }
    },
  }
}

/** 文件适配器只由 Host 注入；Task Owner 无法指定输出根目录或最终文件名。 */
export function createGeneralMarkdownWriteCapability({ fileAdapter }) {
  if (typeof fileAdapter?.prepare !== 'function' || typeof fileAdapter?.reconcile !== 'function')
    throw executionError('GENERAL_MARKDOWN_ADAPTER_REQUIRED')
  return {
    id: 'write-task-markdown', effectClass: 'file.write', identity: 'write-task-markdown-v1',
    description: '在当前任务专属目录新建 Markdown 文件并独立读回；参数仅含 content，不支持指定路径或覆盖',
    authorize: async ({ input, scope }) => scope?.writeMarkdown === true
      && input && Object.keys(input).length === 1 && typeof input.content === 'string'
      && !!input.content.trim() && Buffer.byteLength(input.content, 'utf8') <= 12000,
    prepare: ({ input, binding }) => fileAdapter.prepare({ input, binding }),
    async verify({ prepared, output }) {
      const observation = await fileAdapter.reconcile(prepared)
      return { passed: observation.status === 'succeeded'
          && executionDigest(observation) === executionDigest(output),
        outputDigest: executionDigest(observation),
        sourceRefs: observation.status === 'succeeded' ? [observation.evidenceRef] : [] }
    },
  }
}

const string = { type: 'string' }
const object = { type: 'object' }

export function createGeneralCapabilityStageContract() {
  return { id: 'task-general-capability', version: '1', requiredOutputs: ['general-capability-result'],
    async prepare({ stage, decision, continuation, requirement, plan, handoff }) {
      const step = stage.capabilityStep ?? continuation?.ownerStep
        ?? decision?.planChange?.stages?.[0]?.capabilityStep ?? decision?.appendStages?.[0]?.capabilityStep
      if (!step) throw executionError('GENERAL_STEP_NOT_BOUND')
      return { input: { capabilityId: step.capabilityId, input: step.input,
        scope: { ...requirement.scope, predecessorOutputRef: handoff?.outputRef ?? null,
          ...(['write-task-file', 'import-task-file'].includes(step.capabilityId)
            ? { requirementRevision: plan.task.requirementRevision } : {}) }, expectedEvidence: step.expectedEvidence } }
    } }
}
/** Task Owner 选定一步后使用的受信执行载体；本流程不做全局规划或最终报告。 */
function createWriteCapabilityStep({ capabilities }) {
  if (!Array.isArray(capabilities)) throw executionError('GENERAL_CONFIG_INVALID')
  const byId = new Map()
  for (const capability of capabilities) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(capability.id ?? '') || byId.has(capability.id)
      || typeof capability.identity !== 'string' || !capability.identity
      || capability.effectClass !== 'file.write'
      || typeof capability.authorize !== 'function'
      || typeof capability.prepare !== 'function'
      || typeof capability.verify !== 'function') throw executionError('GENERAL_CAPABILITY_INVALID')
    byId.set(capability.id, capability)
  }
  const rulesDigest = executionDigest([...byId.values()].map(item => ({ id: item.id, identity: item.identity })))
  const inputSchema = { type: 'object', properties: {
    capabilityId: string, input: object, scope: object, expectedEvidence: string,
  }, required: ['capabilityId', 'input', 'scope', 'expectedEvidence'], additionalProperties: false }
  const outputSchema = { type: 'object', properties: {
    capabilityId: string, inputDigest: string, output: object, verification: object,
  }, required: ['capabilityId', 'inputDigest', 'output', 'verification'], additionalProperties: false }
  return { id: 'task-general-capability', version: '4', nodes: [{
    id: 'execute', version: '3', executor: 'code', allowedEffects: ['file.write'],
    inputSchema, outputSchema, mapInput: ({ requirement }) => requirement, rulesDigest,
    async execute({ input: request, signal, perform, runId, taskId, nodeRunId, generation, requirementDigest }) {
      const capability = byId.get(request.capabilityId)
      if (!capability) throw executionError('GENERAL_CAPABILITY_UNAVAILABLE')
      if (!request.expectedEvidence.trim() || Buffer.byteLength(JSON.stringify(request), 'utf8') > 16000)
        throw executionError('GENERAL_STEP_INVALID')
      const { input, scope } = request
      if (await capability.authorize({ input, scope }) !== true) throw executionError('GENERAL_SCOPE_NOT_ADMITTED')
      const binding = { runId, taskId, nodeRunId, generation, requirementDigest }
      const prepared = capability.prepare({ input, scope, binding })
      const output = await perform({ action: 'file', prepared })
      const verification = await capability.verify({ input, scope, output,
        expectedEvidence: request.expectedEvidence, signal, prepared })
      if (!output || typeof output !== 'object' || Array.isArray(output)
        || !verification || typeof verification !== 'object' || verification.passed !== true
        || verification.outputDigest !== executionDigest(output)
        || !Array.isArray(verification.sourceRefs) || !verification.sourceRefs.length
        || verification.sourceRefs.some(ref => typeof ref !== 'string' || !ref.trim())
        || Buffer.byteLength(JSON.stringify({ output, verification }), 'utf8') > 32000)
        throw executionError('GENERAL_EVIDENCE_UNVERIFIED')
      return { capabilityId: request.capabilityId,
        inputDigest: executionDigest({ capabilityId: request.capabilityId, input, scope }), output, verification }
    },
  }] }
}

// 保留 v4 函数源码和规则摘要，运行中的历史定义仍能按原摘要恢复。
function createArtifactWriteCapabilityStep({ capabilities }) {
  const legacy = createWriteCapabilityStep({ capabilities })
  if (capabilities.some(item => item.action !== undefined && !['file', 'artifact'].includes(item.action)))
    throw executionError('GENERAL_CAPABILITY_INVALID')
  const byId = new Map(capabilities.map(item => [item.id, item]))
  return { ...legacy, version: '5', nodes: [{ ...legacy.nodes[0], version: '4',
    rulesDigest: executionDigest(capabilities.map(item => ({ id: item.id, identity: item.identity, action: item.action ?? 'file' }))),
    async execute({ input: request, signal, perform, runId, taskId, nodeRunId, generation, requirementDigest }) {
      const capability = byId.get(request.capabilityId)
      if (!capability) throw executionError('GENERAL_CAPABILITY_UNAVAILABLE')
      const action = capability.action ?? 'file'
      // JSON 控制字符最多膨胀六倍，另留原有请求元数据额度；实际内容仍由能力独立限额。
      const requestLimit = action === 'artifact' ? 65536 * 6 + 16000 : 16000
      if (typeof request.expectedEvidence !== 'string' || !request.expectedEvidence.trim()
        || Buffer.byteLength(JSON.stringify(request), 'utf8') > requestLimit)
        throw executionError('GENERAL_STEP_INVALID')
      const { input, scope } = request
      if (await capability.authorize({ input, scope }) !== true) throw executionError('GENERAL_SCOPE_NOT_ADMITTED')
      const binding = { runId, taskId, nodeRunId, generation, requirementDigest }
      const prepared = await capability.prepare({ input, scope, binding })
      if (prepared?.action !== action) throw executionError('GENERAL_ACTION_MISMATCH')
      const output = await perform({ action, prepared })
      const verification = await capability.verify({ input, scope, output,
        expectedEvidence: request.expectedEvidence, signal, prepared })
      if (!output || typeof output !== 'object' || Array.isArray(output)
        || !verification || typeof verification !== 'object' || verification.passed !== true
        || verification.outputDigest !== executionDigest(output)
        || !Array.isArray(verification.sourceRefs) || !verification.sourceRefs.length
        || verification.sourceRefs.some(ref => typeof ref !== 'string' || !ref.trim())
        || Buffer.byteLength(JSON.stringify({ output, verification }), 'utf8') > 32000)
        throw executionError('GENERAL_EVIDENCE_UNVERIFIED')
      return { capabilityId: request.capabilityId,
        inputDigest: executionDigest({ capabilityId: request.capabilityId, input, scope }), output, verification }
    },
  }] }
}

export function createGeneralCapabilityStepWorkflow({ capabilities, completionCheck, completionIdentity = 'completion-unconfigured', workflowVersion }) {
  if (!Array.isArray(capabilities)) throw executionError('GENERAL_CONFIG_INVALID')
  const version = workflowVersion ?? (capabilities.some(item => item.action === 'artifact') ? '5' : '4')
  if (!['4', '5'].includes(version)) throw executionError('GENERAL_WORKFLOW_VERSION_INVALID')
  const workflow = version === '4'
    ? createWriteCapabilityStep({ capabilities: capabilities.filter(item => item.action !== 'artifact') })
    : createArtifactWriteCapabilityStep({ capabilities })
  return { ...workflow, ownerContract: {
    id: 'general-capability-result', version: '1', rulesDigest: executionDigest({ completionIdentity }),
    async validateCompletion({ output, requirement, decision, stages, stage }) {
      if (output?.verification?.passed !== true || output.verification.outputDigest !== executionDigest(output.output)) return false
      if (stages.some(item => item.contractId !== 'general-capability-result')) return true
      if (stage.stageId !== stages[0].stage.stageId) return true
      if (typeof completionCheck !== 'function') return false
      const evidence = stages.map(item => ({ evidenceId: item.stage.outputRef, ...item.output }))
      const assessment = await completionCheck({ request: requirement.request, acceptanceCriteria: requirement.acceptanceCriteria,
        constraints: requirement.constraints, scope: requirement.scope, evidence,
        report: { summary: decision.summary, evidenceIds: decision.evidenceRefs, limitations: [] } })
      return assessment?.status === 'satisfied' && assessment.resultVerified === true
        && Array.isArray(assessment.criteria) && assessment.criteria.length === requirement.acceptanceCriteria.length
        && assessment.criteria.every((item, index) => item.criterion === requirement.acceptanceCriteria[index]
          && item.passed === true && item.evidenceIds?.length
          && item.evidenceIds.every(ref => decision.evidenceRefs.includes(ref)))
    },
  } }
}
