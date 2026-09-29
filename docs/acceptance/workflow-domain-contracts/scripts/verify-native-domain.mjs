import assert from 'node:assert/strict'
import { parseArgs } from 'node:util'
import { createRequire } from 'node:module'
import { readFile, mkdir, writeFile, access } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { values } = parseArgs({ options: { profile: { type: 'string' }, output: { type: 'string' },
  check: { type: 'boolean' }, run: { type: 'boolean' } } })
assert.ok(isAbsolute(values.profile ?? '') && isAbsolute(values.output ?? ''))
assert.notEqual(values.check === true, values.run === true)
const profile = resolve(values.profile), output = resolve(values.output)
const requireProfile = createRequire(join(profile, 'package.json'))
const load = name => import(pathToFileURL(requireProfile.resolve(name)))
const installed = join(profile, 'node_modules/@zzusp/dingtalk-dsh-assistant')
const plugin = name => import(pathToFileURL(join(installed, name)))
let stage = 'preflight', ctx
try {
  await access(join(installed, 'task-general-workflow.js'))
  await assert.rejects(access(output), error => error.code === 'ENOENT')
  const [{ Context }, { LlmRuntime }, codex, general, artifactModule, controllerModule, storeModule, contractsModule, ownerModule, investigationModule, fileModule, deliveryModule] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-llm'), load('dsh-codex-connect'), plugin('task-general-workflow.js'),
    plugin('execution-artifacts.js'), plugin('execution-controller.js'), plugin('execution-store.js'),
    plugin('task-workflow-contracts.js'), plugin('task-owner-controller.js'), plugin('agent-work.js'),
    plugin('task-markdown-file.js'), plugin('execution-delivery.js'),
  ])
  if (values.check) {
    console.log(JSON.stringify({ mode: 'check', writes: 0, installed, provider: 'openai-codex', outputExists: false }))
  } else {
    stage = 'native-provider'
    const response = await fetch('http://127.0.0.1:18998/state/agent-config', { signal: AbortSignal.timeout(10000) })
    assert.equal(response.status, 200)
    const configured = await response.json()
    const model = { provider: configured.provider, model: configured.model,
      ...(configured.reasoningEffort ? { reasoningEffort: configured.reasoningEffort } : {}) }
    assert.equal(model.provider, 'openai-codex')
    assert.ok(model.model)
    ctx = new Context()
    new LlmRuntime(ctx)
    // 使用已安装提供商的默认传输配置与现有登录，模型取正式实例当前配置。
    const provider = ctx.plugin(codex, codex.Config(structuredClone(codex.DEFAULT_OPENAI_CODEX_SETTINGS)))
    await provider.inertia
    assert.ok(ctx.llm.listProviders().some(item => item.id === model.provider))
    await mkdir(output)
    const { executionDigest, openExecutionArtifacts } = artifactModule
    const checks = [], results = []
    const native = general.createDomainAcceptanceCheck({ llm: ctx.llm, modelConfig: model })
    const check = async input => {
      const result = await native(input)
      checks.push({ criteria: input.acceptanceCriteria, result })
      assert.ok(['satisfied', 'unsatisfied', 'unverified'].includes(result.status)
        && result.reason === undefined && result.criteria.length === input.acceptanceItems.length,
      '需要完整逐项语义判断，不能将协议异常当作拒绝反例通过；证据不足是合法的未验证判断')
      return result
    }
    for (const valid of [false, true]) {
      stage = valid ? 'saved-document' : 'unrelated-note'
      const root = join(output, stage), taskId = valid ? 'saved-document' : 'unrelated-note'
      await mkdir(root)
      const dbPath = join(root, 'control.sqlite')
      const store = await storeModule.openExecutionStore({ dbPath, instanceId: taskId, initialize: true })
      const artifacts = await openExecutionArtifacts({ directory: join(root, 'artifacts'), initialize: true })
      let owner, controller
      try {
        const criterion = valid ? '调查记录已保存为 Markdown 文档' : '生产故障已修复并验证不再复现'
        const goal = { request: valid ? '调查故障并保存 Markdown 文档' : '修复生产故障并保存 Markdown 文档',
          acceptanceCriteria: [criterion], acceptanceItems: [{ itemId: 'acceptance-1', criterion }], constraints: [], scope: {} }
        const investigation = { outcome: 'completed', summary: '故障仍在，尚未修复', evidenceRefs: ['source-note'],
          limitations: ['未实施生产修复'], question: '', findings: [{ kind: 'fact', statement: '故障仍在', evidenceRefs: ['source-note'] }],
          openItems: [{ description: criterion, reason: '尚未实施', evidenceRefs: [] }],
          criterionReviews: [{ itemId: 'acceptance-1', status: 'insufficient_evidence', reason: '尚未实施', evidenceRefs: [] }] }
        const contract = investigationModule.createInvestigationWorkflow({ provider: model.provider, model: model.model,
          allowedTools: [], capabilityIdentity: 'local-smoke-fixture',
          verifyResult: async ({ result }) => investigationModule.validateAgentWorkResult(result, { sourceRefs: ['source-note'] }) }).ownerContract
        const investigationWorkflow = { id: 'smoke-investigation', version: '1', ownerContract: contract,
          nodes: [{ id: 'report', version: '1', executor: 'code', allowedEffects: ['pure'], inputSchema: { type: 'object' },
            outputSchema: { type: 'object' }, mapInput: ({ requirement }) => requirement, execute: async () => investigation }] }
        const fileAdapter = fileModule.createTaskMarkdownFileAdapter({ root: join(root, 'files') })
        const write = general.createGeneralCapabilityStepWorkflow({ capabilities: [general.createGeneralMarkdownWriteCapability({ fileAdapter })],
          completionCheck: check, completionIdentity: 'deployed-native-smoke-v1' })
        const delivery = deliveryModule.createExecutionDelivery({ store, artifacts, fileAdapter, authorize: async () => null,
          authorizeFile: async ({ binding, prepared }) => binding.taskId === prepared.taskId
            ? { principalId: 'local-smoke', authorizationRef: 'local-smoke-write' } : null })
        controller = controllerModule.createExecutionController({ store, artifacts, delivery, workflows: [investigationWorkflow, write] })
        await controller.createTaskPlan({ commandId: 'create', taskId, stages: [
          { stageId: 'investigate', workflowId: investigationWorkflow.id, input: goal }, { stageId: 'save', workflowId: write.id }] })
        let plan = await controller.advanceTaskPlan(taskId)
        await controller.whenIdle(plan.stages[0].runId)
        plan = await controller.advanceTaskPlan(taskId)
        assert.equal(plan.stages[0].status, 'succeeded')
        const content = '# 调查记录\n\n故障仍在，未进行生产修复。\n'
        await controller.bindTaskStageInput({ commandId: 'bind-save', taskId, planRevision: plan.task.planRevision,
          stageId: 'save', predecessorOutputRef: plan.stages[0].outputRef,
          input: { capabilityId: 'write-task-markdown', input: { content }, scope: { writeMarkdown: true }, expectedEvidence: '独立回读已保存文档' } })
        plan = await controller.advanceTaskPlan(taskId)
        await controller.whenIdle(plan.stages[1].runId)
        plan = await controller.advanceTaskPlan(taskId)
        assert.ok(plan.stages.every(item => item.status === 'succeeded'))
        const written = await artifacts.read(plan.stages[1].outputRef)
        assert.equal(await readFile(written.output.result.path, 'utf8'), content)
        assert.equal(written.verification.outputDigest, executionDigest(written.output))
        const helpers = contractsModule.createTaskWorkflowContracts({ store, artifacts, controller })
        owner = ownerModule.createTaskOwnerController({ ctx: {}, store, artifacts, controller, modelConfig: () => model,
          advanceTask: async () => { throw Error('SMOKE_MUST_NOT_ADVANCE_AFTER_SUCCESS') },
          authorizeStages: async () => false,
          authorizeCompletion: async ({ decision }) => helpers.authorizeCompletion({ taskId, decision, requirement: goal, plan: await controller.taskPlan(taskId) }),
          readDeliveryManifest: helpers.readDeliveryManifest,
          sessionRunner: { async run({ input, onSessionBound, onCandidate }) {
            await onSessionBound()
            const ref = input.stages.at(-1).outputRef
            const decision = { action: 'complete', summary: valid ? '调查记录已保存' : '故障已修复', evidenceRefs: [ref],
              assessments: input.acceptanceItems.map(item => ({ itemId: item.itemId, status: 'satisfied', evidenceRefs: [ref] })) }
            await onCandidate(decision)
            return { status: 'submitted', decision }
          }, async close() {} },
        })
        const initial = await owner.ensure({ taskId, sourceKey: 'local-smoke', criteria: goal.acceptanceCriteria, origin: {} })
        await store.command({ id: 'bind-goal', kind: 'task.requirement.bind-legacy', args: { taskId,
          expectedRequirementRevision: 1, requirementRef: (await artifacts.put(goal)).ref, sessionId: initial.sessionId,
          criteria: goal.acceptanceCriteria, sourceKey: 'local-smoke', eventKey: 'bind-goal' } })
        if (valid) {
          await owner.drive(taskId)
          assert.deepEqual(await owner.applyPending(), [])
        }
        else await assert.rejects(owner.drive(taskId), { code: 'TASK_OWNER_COMPLETION_UNVERIFIED' })
        const ownerState = await store.query({ kind: 'task.owner', taskId })
        assert.equal(ownerState.decision?.action === 'complete', valid)
        if (valid) assert.equal(ownerState.applicationStatus, 'applied')
        const saved = await store.query({ kind: 'task.owner.delivery-manifest', taskId })
        if (valid) {
          assert.ok(saved?.ref)
          const manifest = await artifacts.read(saved.ref)
          assert.equal(manifest.businessValidation.status, 'accepted')
          assert.equal(manifest.businessValidation.items.length, 1)
          assert.match(manifest.businessValidation.items[0].validators[0].policyDigest, /^[a-f0-9]{64}$/)
        } else assert.equal(saved, null)
        results.push({ case: stage, passed: true, completed: valid, savedFileVerified: true, manifestRef: saved?.ref ?? null })
        await owner.close(); owner = null
        await controller.close(); controller = null
        await store.close()
        const reopened = await storeModule.openExecutionStore({ dbPath, instanceId: taskId })
        try {
          assert.deepEqual(await reopened.query({ kind: 'task.owner.delivery-manifest', taskId }), saved)
          assert.deepEqual(await reopened.query({ kind: 'task.owner', taskId }), ownerState)
        }
        finally { await reopened.close() }
      } finally { await owner?.close(); await controller?.close(); await store.close() }
    }
    assert.equal(checks.length, 2)
    const report = { installed, model, providerSettings: 'installed-defaults', results, checks, realProvider: true, ownerAndInvestigation: 'fixed-candidates',
      isolatedStorage: true, externalMessages: 0, businessDatabaseCalls: 0 }
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
  }
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', stage, code: error.code ?? error.name,
    assertion: error instanceof assert.AssertionError ? error.message : undefined }))
  process.exitCode = 1
} finally { await ctx?.fiber.dispose() }
