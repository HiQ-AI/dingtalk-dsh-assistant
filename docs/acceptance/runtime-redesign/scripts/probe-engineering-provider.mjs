import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify, parseArgs } from 'node:util'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { openExecutionStore } from '../../../../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../../../../packages/dingtalk-dsh-assistant/execution-artifacts.js'
import { openWorkflowService } from '../../../../packages/dingtalk-dsh-assistant/workflow-service.js'
import { createMessageModel } from '../../../../packages/dingtalk-dsh-assistant/message-model.js'

const { values } = parseArgs({ options: { profile: { type: 'string' }, output: { type: 'string' } } })
if (!values.profile || !values.output) throw new Error('profile and output required')
const output = resolve(values.output), directory = join(dirname(output), `engineering-${Date.now()}`)
await mkdir(directory, { recursive: true })
const require = createRequire(join(resolve(values.profile), 'package.json'))
const imported = name => import(pathToFileURL(require.resolve(name)).href)
const { Context } = await imported('@deepseek-ai/cordis'), { LlmRuntime } = await imported('@deepseek-ai/dsh-llm')
const provider = await imported('dsh-codex-connect')
const config = await fetch('http://127.0.0.1:18998/state/agent-config').then(response => response.json())
if (config.provider !== 'openai-codex' || config.model !== 'gpt-6-sol' || config.reasoningEffort !== 'low') throw new Error('live model selection mismatch')
const ctx = new Context(), rows = [], requests = [], startedAt = Date.now()
new LlmRuntime(ctx)
provider.apply(ctx, { ...provider.DEFAULT_OPENAI_CODEX_SETTINGS, enableProxy: Boolean(config.proxyUrl), ...(config.proxyUrl ? { proxyUrl: config.proxyUrl } : {}) })
ctx.on('llm/stream', (options, next) => (async function* () {
  const system = JSON.stringify(options.system ?? ''), start = Date.now()
  const stage = /纯净消息流程([SRI])节点/.exec(system)?.[1] ?? (system.includes('工程文件选择节点') ? 'select-files' : system.includes('工程文件修改节点') ? 'propose-changes' : 'unidentified')
  const record = { stage, provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort, startedAt: new Date(start).toISOString() }
  requests.push(record)
  try { for await (const chunk of next()) { if (chunk.type === 'usage') record.usage = chunk.usage; yield chunk } }
  catch (error) { record.error = error.code ?? error.name; throw error }
  finally { record.elapsedMs = Date.now() - start }
})())
for (const [pkg, symbol] of [['dsh-agent', 'AgentRegistry'], ['dsh-session', 'SessionStore'], ['dsh-session-projection', 'SessionProjectionRegistry']]) new (await imported(`@deepseek-ai/${pkg}`))[symbol](ctx)
new (await imported('@deepseek-ai/dsh-system-prompt')).SystemPrompt(ctx, { includeRuntimeContext: false, includeHarnessIdentity: false })
new (await imported('@deepseek-ai/dsh-tools')).ToolRuntime(ctx)
new (await imported('@deepseek-ai/dsh-agent-loop')).AgentLoop(ctx, { agents: [], maxParallelToolCalls: 1 })
new (await imported('@deepseek-ai/dsh-session-persistence-jsonl')).JsonlSessionPersistence(ctx, { root: join(directory, 'sessions'), packChunks: false, compression: 'none', writeBatchMaxDelayMs: 1 })
const exec = promisify(execFile), source = join(directory, 'source'), remote = join(directory, 'remote.git'), managedRoot = join(directory, 'managed')
const git = async (cwd, args) => (await exec('git', ['-C', cwd, ...args], { windowsHide: true })).stdout.trim()
await mkdir(join(source, 'src'), { recursive: true }); await mkdir(managedRoot)
await git(source, ['init', '-b', 'main']); await git(source, ['config', 'user.name', 'Isolated Test']); await git(source, ['config', 'user.email', 'isolated@example.invalid'])
await writeFile(join(source, 'src/greeting.txt'), 'hello\n'); await git(source, ['add', '.']); await git(source, ['commit', '-m', 'isolated base'])
await exec('git', ['init', '--bare', remote], { windowsHide: true })
const ghScript = join(directory, 'fake-gh.cjs'), ghState = join(directory, 'fake-pr.json')
await writeFile(ghScript, `const fs=require('node:fs'),cp=require('node:child_process'); const [file,remote,...args]=process.argv.slice(2);const state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):null;const value=x=>args[args.indexOf(x)+1];const refs=()=>cp.execFileSync('git',['ls-remote',remote],{encoding:'utf8'}).trim().split(/\\s+/);if(args[0]==='api')console.log(JSON.stringify({object:{sha:refs()[0]}}));else if(args[1]==='list')console.log(JSON.stringify(state?[state]:[]));else if(args[1]==='view')console.log(JSON.stringify(state));else if(args[1]==='create'){fs.writeFileSync(file,JSON.stringify({number:1,url:'https://github.com/isolated/fixture/pull/1',state:'OPEN',headRefOid:refs()[0],headRefName:value('--head'),baseRefName:value('--base'),body:fs.readFileSync(value('--body-file'),'utf8')}));process.exit(1)}else process.exit(2);`)
const dbPath = join(directory, 'control.db'), artifactDirectory = join(directory, 'artifacts'), instanceId = 'live-engineering-isolated'
const init = await openExecutionStore({ dbPath, instanceId, initialize: true }); await init.close()
await openExecutionArtifacts({ directory: artifactDirectory, initialize: true })
const judge = createMessageModel({ llm: ctx.llm, modelConfig: { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort } })
let service, outcome, failure
try {
  service = await openWorkflowService({ ctx,
    config: { dbPath, artifactDirectory, instanceId, groupIds: ['isolated-engineering'], ownerActorId: 'synthetic-owner', repositories: [{ id: 'fixture', sourceRepository: source, managedRoot, remote, githubRepository: 'isolated/fixture', baseRef: 'main', baseBranch: 'main', discovery: { allowedPrefixes: ['src/'] }, checks: [{ id: 'content-check', version: '1', executable: process.execPath, args: ['-e', "const f=require('node:fs');if(f.readFileSync('src/greeting.txt','utf8').trim()!=='hello workflow'||f.readFileSync('src/result.txt','utf8').trim()!=='done')process.exit(2);console.log('PASS greeting and result exact content')"] }] }] },
    engineeringGhCommand: { executable: process.execPath, args: [ghScript, ghState, remote] },
    legacy: { getAgentConfig: () => config, getGroup: () => ({ messages: [], responsibility: '仅处理本次隔离工程测试，不接触业务系统。' }) },
    judge: async args => { const start = Date.now(); const response = await judge(args); rows.push({ stage: args.stage, elapsedMs: Date.now() - start, usage: response.usage, output: response.output }); return response },
  })
  const accepted = await service.ingest({ groupId: 'isolated-engineering', messageId: 'synthetic-engineering-1', senderOpenDingTalkId: 'synthetic-owner', text: '请为工程仓库 fixture 创建一个工程任务：将 src/greeting.txt 的内容改成 hello workflow，并新建 src/result.txt，内容为 done。只修改 src/，完成固定检查后提交 PR。' })
  rows.push({ stage: 'receive', elapsedMs: Date.now() - startedAt, accepted })
  const processed = await service.messages.process(accepted.runId)
  for (const command of processed.commands) if (command.result?.runId) await service.execution.controller.whenIdle(command.result.runId)
  const tasks = await service.tasks(), message = await service.state(accepted.runId)
  outcome = { tasks, message }
  const taskState = tasks.length === 1 ? await service.execution.controller.state(tasks[0].taskRunId) : null
  const final = taskState?.nodes.at(-1)?.outputRef ? await service.execution.artifacts.read(taskState.nodes.at(-1).outputRef) : null
  outcome.final = final
  if (tasks.length !== 1 || tasks[0].state !== 'completed' || final?.deliveryStatus !== 'pr_verified') throw Object.assign(new Error('engineering pipeline did not complete'), { code: 'ENGINEERING_PIPELINE_INCOMPLETE' })
  const [effect] = (await service.execution.store.query({ kind: 'effect.list', runId: tasks[0].taskRunId })).filter(item => item.definition.action === 'workspace')
  const files = []
  for (const path of ['src/greeting.txt', 'src/result.txt']) {
    const bytes = await readFile(join(effect.definition.payload.directory, path))
    files.push({ path, text: bytes.toString('utf8'), sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  outcome.files = files
  outcome.sourceUnchanged = (await readFile(join(source, 'src/greeting.txt'), 'utf8')) === 'hello\n'
  outcome.remoteRefs = await git(source, ['ls-remote', remote])
  outcome.fakePr = JSON.parse(await readFile(ghState, 'utf8'))
} catch (error) { failure = { code: error.code ?? error.name, message: error.message }; process.exitCode = 1 }
finally {
  await service?.close(); await ctx.fiber.dispose()
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const events = db.prepare('SELECT command_id,kind,payload,created_at FROM execution_events ORDER BY seq').all()
  const nodes = db.prepare('SELECT node_run_id,node_id,status FROM execution_nodes WHERE current=1 ORDER BY position').all()
  const timings = nodes.map(node => {
    const claim = events.find(event => event.kind === 'node.claim' && JSON.parse(event.payload).binding?.nodeRunId === node.node_run_id)
    const commit = events.find(event => event.kind === 'node.commit' && event.command_id?.includes(node.node_run_id))
    return { nodeId: node.node_id, status: node.status, startedAt: claim?.created_at, committedAt: commit?.created_at, elapsedMs: claim && commit ? Date.parse(commit.created_at) - Date.parse(claim.created_at) : null }
  }); db.close()
  const report = { actualProvider: true, provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort, git: 'isolated local repositories', github: 'fake CLI local JSON only', externalBusinessEffects: false, elapsedMs: Date.now() - startedAt, directory, failure, rows, requests, timings, outcome }
  await writeFile(output, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ output, failure, elapsedMs: report.elapsedMs, requests, timings, files: outcome?.files, tasks: outcome?.tasks?.map(task => ({ state: task.state, result: task.result, waitingReason: task.waitingReason })) }))
}
