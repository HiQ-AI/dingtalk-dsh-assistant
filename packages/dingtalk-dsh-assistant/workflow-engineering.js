import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { executionDigest, executionError } from './execution-artifacts.js'
import { defineExecutionWorkflow } from './execution-controller.js'
import { createManagedWorkspaces } from './execution-workspace.js'
import { createManagedEdits } from './execution-edit.js'
import { createGitDelivery } from './execution-git.js'
import { createGithubPullRequests } from './execution-pr.js'
import { createVerificationJobCheck } from './execution-check-job.js'
import { createEngineeringTaskWorkflow, createEngineeringDirectWorkflow, createEngineeringScopedWorkflow, createEngineeringPatchWorkflow } from './task-workflow.js'
import { freezeCandidate, readCandidate } from './execution-candidate.js'

const exec = promisify(execFile)
const fail = code => { throw executionError(code) }
const text = (value, code) => { if (typeof value !== 'string' || !value.trim()) fail(code); return value }
const git = async (directory, args) => (await exec('git', ['-C', directory, ...args], { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 })).stdout.trim()
const githubName = remote => /^https:\/\/github\.com\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+?)(?:\.git)?$/.exec(remote)?.[1]
  ?? /^(?:git@github\.com:|ssh:\/\/git@github\.com\/)([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+?)(?:\.git)?$/.exec(remote)?.[1]

/** 可信Host仓库白名单→每次任务的持久固定定义。启动配置不来自消息/模型。 */
export function createEngineeringRegistry({ repositories = [], ownerActorId, modelConfig, author, ghCommand }) {
  text(ownerActorId, 'ENGINEERING_OWNER_REQUIRED')
  if (!Array.isArray(repositories) || typeof modelConfig !== 'function') fail('ENGINEERING_REGISTRY_CONFIG_INVALID')
  const configs = new Map(), routes = new Map(), preparing = new Map(), snapshots = new Map()
  for (const source of repositories) {
    const config = structuredClone(source)
    const fixedPaths = Array.isArray(config.editablePaths) && config.editablePaths.length > 0
    if (fixedPaths === !!config.discovery) fail('ENGINEERING_SCOPE_MODE_REQUIRED')
    config.editablePaths ??= []
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(config.id ?? '') || configs.has(config.id)
      || !isAbsolute(config.sourceRepository ?? '') || !isAbsolute(config.managedRoot ?? '') || !config.remote || !config.baseRef
      || config.baseRef.startsWith('-') || /[\s\0]/.test(config.baseRef) || !Array.isArray(config.editablePaths) || config.editablePaths.length > 32
      || config.editablePaths.some(path => typeof path !== 'string' || !path || /[\\:\0\r\n]/.test(path) || path.split('/').some(part => !part || ['.', '..', '.git'].includes(part.toLowerCase())))
      || !Array.isArray(config.checks) || !config.checks.length) fail('ENGINEERING_REPOSITORY_INVALID')
    if (config.discovery && (!Array.isArray(config.discovery.allowedPrefixes) || !config.discovery.allowedPrefixes.length || config.discovery.allowedPrefixes.some(prefix => typeof prefix !== 'string' || (prefix !== '' && (!prefix.endsWith('/') || /[\\:\0\r\n]/.test(prefix) || prefix.slice(0, -1).split('/').some(part => !part || ['.', '..', '.git'].includes(part.toLowerCase()))))))) fail('ENGINEERING_DISCOVERY_CONFIG_INVALID')
    config.githubRepository = config.githubRepository ?? githubName(config.remote)
    if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(config.githubRepository ?? '')) fail('ENGINEERING_GITHUB_REPOSITORY_REQUIRED')
    config.baseBranch = config.baseBranch ?? (config.baseRef.startsWith('refs/heads/') ? config.baseRef.slice(11) : /^(?:origin\/|refs\/remotes\/)/.test(config.baseRef) ? null : config.baseRef)
    if (typeof config.baseBranch !== 'string' || !config.baseBranch || config.baseBranch.startsWith('-') || /[\s\0]/.test(config.baseBranch)) fail('ENGINEERING_BASE_BRANCH_REQUIRED')
    // 配置校验发生在任何消息进入前；真正执行时仍重新校验适配器。
    config.checks.forEach(check => createVerificationJobCheck({ ...check, root: join(config.managedRoot, 'checks') }))
    if (config.purpose !== undefined && (typeof config.purpose !== 'string' || !config.purpose.trim())) fail('ENGINEERING_REPOSITORY_INVALID')
    if (config.routingTerms !== undefined && (!Array.isArray(config.routingTerms) || config.routingTerms.some(term => typeof term !== 'string' || !term.trim()))) fail('ENGINEERING_REPOSITORY_INVALID')
    // 路由说明只用于接纳前判断，不改变既有任务冻结的执行配置摘要。
    const { purpose, routingTerms, ...executionConfig } = config
    configs.set(config.id, { config, digest: executionDigest({ config: executionConfig, ghCommand: ghCommand ?? null, author: author ?? null }) })
  }
  let store
  async function build(record, { allowDefinitionMigration = false } = {}) {
    const saved = record.config, entry = configs.get(saved.repoId)
    if (saved.kind !== 'engineering' || saved.registryVersion !== '1' || !entry || saved.repositoryDigest !== entry.digest || saved.ownerActorId !== ownerActorId) fail('ENGINEERING_DEFINITION_CONFIG_DRIFT')
    const config = entry.config
    await mkdir(config.managedRoot, { recursive: true })
    const baseWorkspaceAdapter = await createManagedWorkspaces({ root: config.managedRoot, sourceRepository: config.sourceRepository })
    const previousEffects = async generation => (await store.query({ kind: 'effect.list', runId: saved.runId })).filter(effect => effect.generation < generation && effect.state === 'succeeded')
    const previousPush = async generation => (await previousEffects(generation)).filter(effect => effect.definition.action === 'push').sort((a, b) => b.generation - a.generation)[0]?.definition.payload
    const workspaceFor = async ({ generation, baseCommit }) => {
      const prior = await previousPush(generation)
      if (!prior) {
        if (baseCommit !== saved.input.baseCommit) fail('ENGINEERING_DERIVED_BASE_INVALID')
        return baseWorkspaceAdapter
      }
      if (baseCommit !== prior.commitId) fail('ENGINEERING_DERIVED_BASE_INVALID')
      return createManagedWorkspaces({ root: config.managedRoot, sourceRepository: prior.repository })
    }
    const workspaceAdapter = Object.fromEntries(['prepare', 'execute', 'reconcile'].map(method => [method, async value => (await workspaceFor(value))[method](value)]))
    const editAdapter = createManagedEdits({ workspaceAdapter })
    const canonicalRoot = await realpath(config.managedRoot)
    const allowedRepository = repository => {
      if (!repository.startsWith(canonicalRoot + (process.platform === 'win32' ? '\\' : '/'))) fail('ENGINEERING_DELIVERY_SCOPE_INVALID')
      // gitAdapterFor只由本定义的受信节点调用；派发时再次核run+generation目录。
      return repository
    }
    const gitAdapterFor = repository => createGitDelivery({ repository: allowedRepository(repository), remote: config.remote, branch: saved.head, author: saved.author })
    const generationFor = async repository => {
      const state = await store.query({ kind: 'run', runId: saved.runId })
      for (let generation = 1; generation <= (state.run?.generation ?? 1); generation++) if (repository === join(canonicalRoot, `ws-${executionDigest({ runId: saved.runId, generation })}`, 'repository')) return generation
      fail('ENGINEERING_DELIVERY_SCOPE_INVALID')
    }
    const prAdapterFor = async repository => {
      const generation = await generationFor(repository)
      const prior = (await previousEffects(generation)).filter(effect => effect.definition.action === 'pr').sort((a, b) => b.generation - a.generation)[0]
      return createGithubPullRequests({ repository: allowedRepository(repository), repo: config.githubRepository, base: config.baseBranch, head: saved.head,
        ...(prior ? { previousOperationKey: prior.definition.payload.operationKey } : {}), ...(ghCommand ? { ghCommand } : {}) })
    }
    const prepareGeneration = async ({ input, runId, generation }) => {
      if (runId !== saved.runId) fail('ENGINEERING_DELIVERY_SCOPE_INVALID')
      const prior = await previousPush(generation)
      const expectedRemoteSha = prior?.commitId ?? null
      const remote = await git(config.sourceRepository, ['ls-remote', '--refs', '--', config.remote, `refs/heads/${saved.head}`])
      if ((remote.split(/\s/)[0] || null) !== expectedRemoteSha) fail('GIT_REMOTE_CONFLICT')
      if (prior) {
        if (await git(prior.repository, ['rev-parse', prior.commitId]) !== prior.commitId) fail('ENGINEERING_DERIVED_BASE_INVALID')
        const oldPr = (await previousEffects(generation)).filter(effect => effect.definition.action === 'pr').sort((a, b) => b.generation - a.generation)[0]
        if (oldPr) {
          const oldAdapter = await prAdapterFor(oldPr.definition.payload.repository)
          const observed = await oldAdapter.reconcile(oldPr.definition.payload, { allowHeadChange: true })
          if (observed.status !== 'succeeded' || observed.state !== 'OPEN') fail('ENGINEERING_PREVIOUS_PR_NOT_OPEN')
        }
      }
      return { ...input, baseCommit: prior?.commitId ?? saved.input.baseCommit, expectedRemoteSha }
    }
    const checks = config.checks.map(check => createVerificationJobCheck({ ...check, root: join(config.managedRoot, 'checks') }))
    const workflowFactory = !config.discovery ? createEngineeringTaskWorkflow
      : record.definitionVersion === '6' ? createEngineeringDirectWorkflow
        : record.definitionVersion === '7' ? createEngineeringScopedWorkflow
          : !record.definitionVersion || record.definitionVersion === '8' ? createEngineeringPatchWorkflow : createEngineeringTaskWorkflow
    const workflow = workflowFactory({ workflowId: record.workflowId, provider: saved.provider, model: saved.model, reasoningEffort: saved.reasoningEffort,
      workspaceAdapter, editAdapter, checks, prepareGeneration, adapterIdentity: saved.repositoryDigest, discovery: config.discovery,
      deliveryPlan: { identity: executionDigest(saved), gitAdapterFor, prAdapterFor, date: saved.date, title: saved.title, body: saved.body, commitMessage: saved.title, expectedRemoteSha: null } })
    const definition = defineExecutionWorkflow(workflow)
    if (record.digest && definition.digest !== record.digest && !allowDefinitionMigration) fail('ENGINEERING_DEFINITION_DRIFT')
    routes.set(saved.runId, { record: { ...record, digest: definition.digest, definitionVersion: workflow.version }, workflow, workspaceAdapter, editAdapter, gitAdapterFor, prAdapterFor, root: canonicalRoot })
    return { workflow, definition }
  }
  function route(prepared) {
    const found = [...routes.values()].filter(item => (!prepared.runId || item.record.config.runId === prepared.runId)
      && (prepared.directory ?? prepared.repository) === join(item.root, `ws-${executionDigest({ runId: item.record.config.runId, generation: prepared.generation })}`, 'repository'))
    if (found.length !== 1) fail('ENGINEERING_DELIVERY_SCOPE_INVALID')
    return found[0]
  }
  async function repositoryInspect(binding, args, signal, input) {
    const item = routes.get(binding.runId), saved = item?.record.config, config = configs.get(saved?.repoId)?.config
    if (!saved || !config?.discovery || !['6', '7', '8'].includes(item.record.definitionVersion) || binding.taskId !== saved.taskId) fail('ENGINEERING_READ_SCOPE_INVALID')
    const { operation, query = '', path, offset = 0, limit = operation === 'read' ? 8000 : 100 } = args
    if (!['list', 'search', 'read'].includes(operation) || !Number.isSafeInteger(offset) || offset < 0
      || !Number.isSafeInteger(limit) || limit < 1 || limit > (operation === 'read' ? 16000 : 200)
      || typeof query !== 'string' || query.length > 256
      || (path !== undefined && (typeof path !== 'string' || /[\\:\0\r\n]/.test(path) || path.split('/').some(part => ['.', '..', '.git'].includes(part.toLowerCase()))))) fail('ENGINEERING_READ_ARGUMENT_INVALID')
    const key = `${binding.runId}:${binding.generation}:${binding.inputDigest}`
    let snapshot = snapshots.get(key)
    if (!snapshot) {
      const state = await store.query({ kind: 'run', runId: binding.runId })
      if (state.run.generation !== binding.generation || state.run.workflowDigest !== item.record.digest) fail('ENGINEERING_READ_STALE')
      const workspace = await item.workspaceAdapter.prepare({ runId: binding.runId, generation: binding.generation,
        requirementDigest: binding.requirementDigest, baseCommit: input.baseCommit })
      if ((await item.workspaceAdapter.reconcile(workspace)).status !== 'succeeded') fail('WORKSPACE_CURRENT_IDENTITY_UNCONFIRMED')
      snapshot = await readCandidate(await freezeCandidate({ repository: workspace.directory, baseCommit: input.baseCommit,
        generation: binding.generation, requirementDigest: binding.requirementDigest }))
      snapshots.set(key, snapshot)
      if (snapshots.size > 8) snapshots.delete(snapshots.keys().next().value)
    }
    signal?.throwIfAborted()
    const allowed = value => config.discovery.allowedPrefixes.some(prefix => value.startsWith(prefix))
    const files = snapshot.files.filter(file => allowed(file.path) && (operation === 'read' || !path || file.path.startsWith(path)))
    if (operation === 'read') {
      const file = files.find(file => file.path === path)
      if (!file) fail('ENGINEERING_READ_PATH_INVALID')
      const bytes = await snapshot.readFile(path), content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      const text = content.slice(offset, offset + limit)
      return { path, text, expectedHash: createHash('sha256').update(bytes).digest('hex'), offset, nextOffset: offset + text.length < content.length ? offset + text.length : null, totalChars: content.length }
    }
    const matches = []
    for (const file of files) {
      signal?.throwIfAborted()
      if (operation === 'list' ? file.path.toLowerCase().includes(query.toLowerCase())
        : (await snapshot.readFile(file.path)).toString('utf8').toLowerCase().includes(query.toLowerCase())) matches.push(file.path)
    }
    return { paths: matches.slice(offset, offset + limit), total: matches.length, nextOffset: offset + limit < matches.length ? offset + limit : null }
  }
  const deliveryOptions = {
    workspaceAdapter: { execute: prepared => route(prepared).workspaceAdapter.execute(prepared), reconcile: prepared => route(prepared).workspaceAdapter.reconcile(prepared) },
    editAdapter: { execute: prepared => route(prepared).editAdapter.execute(prepared), reconcile: prepared => route(prepared).editAdapter.reconcile(prepared) },
    adapter: Object.fromEntries(['executeCommit', 'reconcileCommit', 'executePush', 'reconcilePush'].map(method => [method, async prepared => (await route(prepared).gitAdapterFor(prepared.repository))[method](prepared)])),
    prAdapter: { execute: async prepared => (await route(prepared).prAdapterFor(prepared.repository)).execute(prepared), reconcile: async prepared => (await route(prepared).prAdapterFor(prepared.repository)).reconcile(prepared) },
    async authorize({ binding, prepared }) {
      const item = route(prepared), saved = item.record.config
      if (binding.runId !== saved.runId || binding.taskId !== saved.taskId || saved.ownerActorId !== ownerActorId) fail('ENGINEERING_EFFECT_NOT_AUTHORIZED')
      return { principalId: ownerActorId, authorizationRef: `task-grant:${executionDigest({ taskId: saved.taskId, sourceCommandId: saved.sourceCommandId, ownerActorId })}` }
    },
  }
  async function prepareTask(action, info, controller) {
    if (!store) fail('ENGINEERING_REGISTRY_NOT_RESTORED')
    if (info.run.actorId !== ownerActorId && info.authorizedGroupRequest !== true) fail('WORKFLOW_ACTION_FORBIDDEN')
    const taskId = text(action.taskId, 'WORKFLOW_TASK_ID_REQUIRED'), commandId = text(info.commandId, 'WORKFLOW_COMMAND_REQUIRED')
    const workflowId = `task-engineering-${executionDigest(commandId).slice(0, 40)}`, runId = `run-${executionDigest(commandId).slice(0, 40)}`
    const request = text(action.arguments.objective, 'WORKFLOW_OBJECTIVE_REQUIRED')
    const repoId = text(action.arguments.repositoryId, 'ENGINEERING_REPOSITORY_REQUIRED'), entry = configs.get(repoId)
    if (!entry) fail('ENGINEERING_REPOSITORY_NOT_ADMITTED')
    const matches = [...configs.values()].filter(item => item.config.routingTerms?.some(term => request.includes(term)))
    if (matches.length === 1 && matches[0].config.id !== repoId) fail('ENGINEERING_REPOSITORY_SCOPE_MISMATCH')
    const constraints = [...new Set([...(action.constraints ?? []), ...(info.unit.constraints ?? []), ...(info.unit.sharedConstraints ?? [])])]
    if (constraints.length > 32 || constraints.some(item => typeof item !== 'string') || Buffer.byteLength(request) > 12000) fail('ENGINEERING_INPUT_LIMIT')
    const fingerprint = executionDigest({ taskId, request, constraints, repoId })
    let item = routes.get(runId)
    if (!item) {
      const config = entry.config, baseCommit = await git(config.sourceRepository, ['rev-parse', '--verify', `${config.baseRef}^{commit}`])
      if (!/^[a-f0-9]{40}$/.test(baseCommit)) fail('ENGINEERING_BASE_INVALID')
      const selected = modelConfig(), selectedAuthor = author ?? { name: await git(config.sourceRepository, ['config', 'user.name']), email: await git(config.sourceRepository, ['config', 'user.email']) }
      const saved = { kind: 'engineering', registryVersion: '1', repoId, repositoryDigest: entry.digest, runId, taskId, sourceCommandId: commandId, ownerActorId,
        fingerprint, provider: selected.provider, model: selected.model, ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }), input: { request, constraints, baseCommit, editablePaths: entry.config.editablePaths },
        head: `codex/task-${executionDigest(commandId).slice(0, 24)}`, date: `${Math.floor(Date.now() / 1000)} +0000`,
        title: request.replace(/[\r\n\0]+/g, ' ').slice(0, 120), body: `## 任务\n\n${request}\n\n## 约束\n\n${constraints.map(value => `- ${value}`).join('\n') || '无额外约束'}\n\n## 验证配置\n\n${config.checks.map(check => `- ${check.id} / ${check.version}`).join('\n')}`, author: selectedAuthor }
      const { definition } = await build({ workflowId, config: saved })
      item = routes.get(runId)
      try { await store.command({ id: `workflow:${definition.digest}`, kind: 'workflow.register', args: item.record }) }
      catch (error) { routes.delete(runId); throw error }
    }
    if (item.record.config.fingerprint !== fingerprint) fail('ENGINEERING_TASK_COMMAND_CONFLICT')
    controller.registerWorkflow(item.workflow)
    return { taskId, runId, workflowId, input: structuredClone(item.record.config.input) }
  }
  async function reissueTask({ taskId, repositoryId, requestId }, controller, artifacts) {
    text(taskId, 'WORKFLOW_TASK_ID_REQUIRED'); text(repositoryId, 'ENGINEERING_REPOSITORY_REQUIRED')
    text(requestId, 'WORKFLOW_REQUEST_ID_REQUIRED')
    const entry = configs.get(repositoryId)
    if (!entry?.config.discovery) fail('ENGINEERING_REPOSITORY_NOT_ADMITTED')
    const runs = await store.query({ kind: 'run.list', taskId, limit: 200 })
    const run = runs.find(item => !['succeeded', 'failed', 'cancelled'].includes(item.status))
    if (!run) fail('ENGINEERING_TASK_NOT_REISSUABLE')
    const state = await store.query({ kind: 'run', runId: run.runId }), prior = routes.get(run.runId)
    if (!prior || prior.record.config.taskId !== taskId) fail('ENGINEERING_TASK_NOT_REISSUABLE')
    if (prior.record.config.reissueRequestId === requestId && prior.record.config.repoId === repositoryId) return { taskId, runId: run.runId, generation: state.run.generation, repositoryId }
    const saved = prior.record.config, baseCommit = await git(entry.config.sourceRepository, ['rev-parse', '--verify', `${entry.config.baseRef}^{commit}`])
    const matches = [...configs.values()].filter(item => item.config.routingTerms?.some(term => saved.input.request.includes(term)))
    if (matches.length === 1 && matches[0].config.id !== repositoryId) fail('ENGINEERING_REPOSITORY_SCOPE_MISMATCH')
    if (!/^[a-f0-9]{40}$/.test(baseCommit)) fail('ENGINEERING_BASE_INVALID')
    const input = { ...saved.input, baseCommit, editablePaths: entry.config.editablePaths }
    const nextConfig = { ...saved, repoId: repositoryId, repositoryDigest: entry.digest, input,
      fingerprint: executionDigest({ taskId, request: input.request, constraints: input.constraints, repoId: repositoryId }), reissueRequestId: requestId,
      body: `## 任务\n\n${input.request}\n\n## 约束\n\n${input.constraints.map(value => `- ${value}`).join('\n') || '无额外约束'}\n\n## 验证配置\n\n${entry.config.checks.map(check => `- ${check.id} / ${check.version}`).join('\n')}` }
    const workflowId = `task-engineering-reissue-${executionDigest([run.runId, requestId]).slice(0, 40)}`
    const record = { workflowId, config: nextConfig, definitionVersion: '8' }
    let next
    try {
      next = await build(record)
      const requirement = await artifacts.put(input), first = next.workflow.nodes[0]
      const firstInput = await artifacts.put({ workflowDigest: next.definition.digest, nodeId: first.id, nodeVersion: first.version,
        requirementRef: requirement.ref, data: input })
      await store.command({ id: `workflow:${next.definition.digest}`, kind: 'workflow.register', args: { ...record, digest: next.definition.digest } })
      await store.command({ id: `reissue-repository:${run.runId}:${next.definition.digest}`, kind: 'run.workflow.reissue-repository', args: {
        runId: run.runId, expectedRevision: state.run.revision, fromDigest: state.run.workflowDigest,
        toDigest: next.definition.digest, toWorkflowId: workflowId, requirementRef: requirement.ref,
        inputRef: firstInput.ref, inputDigest: firstInput.digest,
        nodes: next.workflow.nodes.map((node, index) => ({ nodeId: node.id, nodeVersion: node.version, executor: node.executor,
          inputRef: index ? null : firstInput.ref, inputDigest: index ? null : firstInput.digest })),
      } })
    } catch (error) { routes.set(run.runId, prior); throw error }
    controller.registerWorkflow(next.workflow)
    await controller.recover({ commandId: `reissue-drive:${run.runId}:${next.definition.digest}`, runId: run.runId })
    return { taskId, runId: run.runId, generation: state.run.generation + 1, repositoryId }
  }
  return {
    deliveryOptions,
    repositoryInspect,
    async restore(controlStore, artifacts) {
      store = controlStore
      const result = []
      for (const record of await store.query({ kind: 'workflow.list' })) {
        if (record.config?.kind !== 'engineering') continue
        const state = await store.query({ kind: 'run', runId: record.config.runId })
        // 旧定义保留在账中供审计；只有当前运行绑定的定义需要恢复。
        if (state.run && state.run.workflowDigest !== record.digest) continue
        if (state.run && ['succeeded', 'failed', 'cancelled'].includes(state.run.status) && ['3', '4'].includes(record.definitionVersion)) continue
        const { workflow, definition } = await build(record, { allowDefinitionMigration: ['3', '4'].includes(record.definitionVersion) && !!state.run })
        if (record.definitionVersion === '5' && state.run?.generation === 1 && record.config?.repoId
          && configs.get(record.config.repoId)?.config.discovery
          && state.nodes.some(node => node.nodeId === 'apply-changes' && node.status === 'waiting' && node.drained && node.waitReason?.reference === 'EDIT_PREPARED_INVALID')) {
          const directRecord = { ...record, definitionVersion: '6' }
          const direct = await build(directRecord, { allowDefinitionMigration: true })
          const requirement = await artifacts.read(state.run.requirementRef)
          const first = direct.workflow.nodes[0]
          const input = await artifacts.put({ workflowDigest: direct.definition.digest, nodeId: first.id, nodeVersion: first.version,
            requirementRef: state.run.requirementRef, data: requirement })
          await store.command({ id: `workflow:${direct.definition.digest}`, kind: 'workflow.register', args: {
            ...directRecord, digest: direct.definition.digest,
          } })
          await store.command({ id: `replan-direct:${state.run.runId}:${direct.definition.digest}`, kind: 'run.workflow.replan-direct', args: {
            runId: state.run.runId, expectedRevision: state.run.revision, fromDigest: record.digest, toDigest: direct.definition.digest,
            inputRef: input.ref, inputDigest: input.digest,
            nodes: direct.workflow.nodes.map((node, index) => ({ nodeId: node.id, nodeVersion: node.version, executor: node.executor,
              inputRef: index ? null : input.ref, inputDigest: index ? null : input.digest })),
          } })
          result.push(direct.workflow)
          continue
        }
        if (definition.digest !== record.digest) {
          if (!artifacts || !['3', '4'].includes(record.definitionVersion) || workflow.version !== '5') fail('ENGINEERING_DEFINITION_DRIFT')
          if (record.definitionVersion === '4') {
            const read = state.nodes.find(node => node.nodeId === 'read-files')
            if (!read || read.status !== 'waiting' || !['controller-restarted', 'TASK_CONTEXT_TOO_LARGE'].includes(read.waitReason?.reference)) fail('ENGINEERING_DEFINITION_DRIFT')
            const oldInput = await artifacts.read(read.inputRef)
            if (executionDigest(oldInput) !== read.inputDigest || oldInput.workflowDigest !== record.digest || oldInput.nodeVersion !== '1'
              || oldInput.nodeId !== 'read-files' || oldInput.requirementRef !== state.run.requirementRef) fail('ENGINEERING_MIGRATION_INPUT_INVALID')
            const next = await artifacts.put({ ...oldInput, workflowDigest: definition.digest, nodeVersion: '2' })
            await store.command({ id: `workflow:${definition.digest}`, kind: 'workflow.register', args: {
              ...record, digest: definition.digest, definitionVersion: workflow.version,
            } })
            if (!read.drained) {
              const evidence = await artifacts.put({ kind: 'exclusive-controller-recovery', nodeRunId: read.nodeRunId, fromDigest: record.digest })
              await store.command({ id: `drained:${read.nodeRunId}:${read.leaseEpoch}`, kind: 'node.drained', args: {
                runId: state.run.runId, nodeId: 'read-files', generation: read.generation, leaseEpoch: read.leaseEpoch, evidenceRef: evidence.ref,
              } })
            }
            const current = await store.query({ kind: 'run', runId: record.config.runId })
            await store.command({ id: `migrate-read:${record.config.runId}:${definition.digest}`, kind: 'run.workflow.migrate-read', args: {
              runId: current.run.runId, expectedRevision: current.run.revision, fromDigest: record.digest, toDigest: definition.digest,
              nodeRunId: read.nodeRunId, inputRef: next.ref, inputDigest: next.digest,
            } })
            result.push(workflow)
            continue
          }
          const index = state.nodes.find(node => node.nodeId === 'index-files')
          if (!index || index.status !== 'waiting' || !['ENGINEERING_INDEX_CAPACITY_EXCEEDED', 'controller-restarted'].includes(index.waitReason?.reference)) fail('ENGINEERING_DEFINITION_DRIFT')
          const oldInput = await artifacts.read(index.inputRef)
          if (executionDigest(oldInput) !== index.inputDigest || oldInput.workflowDigest !== record.digest || oldInput.nodeVersion !== '1'
            || oldInput.nodeId !== 'index-files' || oldInput.requirementRef !== state.run.requirementRef) fail('ENGINEERING_MIGRATION_INPUT_INVALID')
          const next = await artifacts.put({ ...oldInput, workflowDigest: definition.digest, nodeVersion: '2' })
          await store.command({ id: `workflow:${definition.digest}`, kind: 'workflow.register', args: {
            ...record, digest: definition.digest, definitionVersion: workflow.version,
          } })
          if (!index.drained) {
            const evidence = await artifacts.put({ kind: 'exclusive-controller-recovery', nodeRunId: index.nodeRunId, fromDigest: record.digest })
            await store.command({ id: `drained:${index.nodeRunId}:${index.leaseEpoch}`, kind: 'node.drained', args: {
              runId: state.run.runId, nodeId: 'index-files', generation: index.generation, leaseEpoch: index.leaseEpoch, evidenceRef: evidence.ref,
            } })
          }
          const current = await store.query({ kind: 'run', runId: record.config.runId })
          await store.command({ id: `migrate-index:${record.config.runId}:${definition.digest}`, kind: 'run.workflow.migrate-index', args: {
            runId: current.run.runId, expectedRevision: current.run.revision, fromDigest: record.digest, toDigest: definition.digest,
            nodeRunId: index.nodeRunId, inputRef: next.ref, inputDigest: next.digest,
          } })
        } else if (record.definitionVersion === '5' && state.nodes.find(node => node.nodeId === 'index-files')?.waitReason?.reference === 'EXECUTION_BUDGET_EXHAUSTED') {
          await store.command({ id: `index-budget:${record.config.runId}:${definition.digest}`, kind: 'run.workflow.index-budget', args: {
            runId: record.config.runId, workflowDigest: definition.digest,
          } })
        } else if (record.definitionVersion === '5') {
          const index = state.nodes.find(node => node.nodeId === 'index-files')
          if (index?.status === 'ready'
            && (await store.query({ kind: 'receipt', commandId: `claim:${index.nodeRunId}:${index.leaseEpoch + 1}` }))?.result?.status === 'budget_exhausted') {
            await store.command({ id: `index-budget-lease:${record.config.runId}:${definition.digest}`, kind: 'run.workflow.index-budget-lease', args: {
              runId: record.config.runId, workflowDigest: definition.digest,
            } })
          }
        }
        result.push(workflow)
      }
      return result
    },
    prepareTask(action, info, controller) {
      const key = info.commandId, digest = executionDigest({ action, info }), prior = preparing.get(key)
      if (prior) return prior.digest === digest ? prior.promise : Promise.reject(executionError('ENGINEERING_TASK_COMMAND_CONFLICT'))
      const promise = prepareTask(action, info, controller).finally(() => preparing.delete(key))
      preparing.set(key, { digest, promise }); return promise
    },
    reissueTask,
    availableWorkflows: () => [...configs.values()].map(({ config }) => ({ id: 'task-engineering', repositoryId: config.id, editablePaths: [...config.editablePaths], ...(config.discovery ? { discovery: structuredClone(config.discovery) } : {}), purpose: config.purpose ?? '仅在配置范围内选择及修改文件，按固定检查验证并提交PR' })),
  }
}
