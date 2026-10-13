import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)))
const baseCommit = '44646d2056375b32ebf2ed2f7812d946473f9722'
const output = join(root, 'docs/tmp/workflow-dashboard')
const execute = promisify(execFile)
await mkdir(output, { recursive: true })
const directory = await mkdtemp(join(output, 'v25-frozen-'))
const names = ['workflow-engineering.js', 'task-workflow.js', 'execution-controller.js']
const sources = {}
for (const name of names) {
  const relative = `packages/dingtalk-dsh-assistant/${name}`
  const { stdout } = await execute('git', ['show', `${baseCommit}:${relative}`], { cwd: root, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
  sources[name] = createHash('sha256').update(stdout).digest('hex')
  const rewritten = stdout.replace(/from (['"])(\.\/[^'"]+)\1/g, (_, quote, target) => {
    const basename = target.slice(2)
    const location = names.includes(basename) ? join(directory, basename) : join(root, 'packages/dingtalk-dsh-assistant', basename)
    return `from ${quote}${pathToFileURL(location).href}${quote}`
  })
  await writeFile(join(directory, name), rewritten)
}
await writeFile(join(directory, 'package.json'), JSON.stringify({type:'module'}))
const { createEngineeringRegistry } = await import(pathToFileURL(join(directory, 'workflow-engineering.js')).href)
const { defineExecutionWorkflow } = await import(pathToFileURL(join(directory, 'execution-controller.js')).href)
const { openExecutionStore } = await import(pathToFileURL(join(root, 'packages/dingtalk-dsh-assistant/execution-store.js')).href)
const source = join(directory, 'source'), remote = join(directory, 'remote.git')
await mkdir(source)
const git = async (...args) => (await execute('git', ['-C', source, ...args], {windowsHide:true})).stdout.trim()
await git('init', '-b', 'main')
await git('config', 'user.name', 'Test')
await git('config', 'user.email', 'test@example.invalid')
await writeFile(join(source, 'value.txt'), 'base')
await git('add', '.')
await git('commit', '-m', 'base')
await git('init', '--bare', remote)
await git('push', remote, 'HEAD:refs/heads/main', 'HEAD:refs/heads/feature/uat2-base')
const command = { executable: process.execPath, args: ['-e', 'process.exit(0)'] }
const serialOptions = { ownerActorId:'owner', author:{name:'Test',email:'test@example.invalid'}, repositories:[{
  id:'repo', sourceRepository:source, managedRoot:join(directory,'managed'), remote, baseRef:'main', githubRepository:'example/repo', editablePaths:['value.txt'],
  localAcceptance:{version:'baseline-v25',sharedDataProfilePath:join(directory,'profile.json'),prepareSteps:[],service:{...command,args:[...command.args,'127.0.0.1','{port}'],readyPath:'/'},scenarios:[{id:'value',description:'registration baseline',...command}],cleanup:command,verifyCleanup:command},
  checks:[{id:'check',version:'1',...command}]
}] }
const options = {...serialOptions, modelConfig:()=>({provider:'test',model:'test'})}
const store = await openExecutionStore({dbPath:join(directory,'control.db'),instanceId:'v25-baseline',initialize:true})
let workflow
try {
  const registry=createEngineeringRegistry(options)
  await registry.restore(store)
  await registry.prepareTask({taskId:'baseline-original',arguments:{repositoryId:'repo',uatEnvironment:'uat2',objective:'修改代码'}},{commandId:'v25-baseline-original',run:{actorId:'owner'},unit:{}},{registerWorkflow(value){workflow=value}})
  const record=(await store.query({kind:'workflow.list'}))[0]
  assert.equal(record.definitionVersion,'25')
  assert.equal(defineExecutionWorkflow(workflow).digest,record.digest)
  const restored=await createEngineeringRegistry(options).restore(store)
  assert.equal(restored.length,1)
  assert.equal(defineExecutionWorkflow(restored[0]).digest,record.digest)
  const checkpoint = {capturedAt:new Date().toISOString(),baseCommit,sources,directory,options:serialOptions,record,digest:record.digest,nodes:workflow.nodes.map(node=>({id:node.id,version:node.version,executor:node.executor,allowedTools:node.allowedTools??[],rulesDigest:node.rulesDigest??null}))}
  const checkpointPath=join(output,'v25-frozen-baseline.json')
  await writeFile(checkpointPath,JSON.stringify(checkpoint,null,2))
  const confirmed=JSON.parse(await readFile(checkpointPath,'utf8'))
  assert.equal(confirmed.digest,record.digest)
  console.log(JSON.stringify({checkpointPath,directory,digest:record.digest,version:record.definitionVersion,nodes:workflow.nodes.length,baselineRestore:'PASS'},null,2))
} finally { await store.close() }
