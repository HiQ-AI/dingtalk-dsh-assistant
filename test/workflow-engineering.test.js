import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createEngineeringRegistry } from '../packages/dingtalk-dsh-assistant/workflow-engineering.js'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { defineExecutionWorkflow } from '../packages/dingtalk-dsh-assistant/execution-controller.js'
import { executionDigest } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'

test('工程registry按Task冻结配置，重启重建同digest，模型变化不改历史，owner/目录/argv不由消息提升', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-engineering-registry-')), source = join(directory, 'source'), root = join(directory, 'managed')
  await mkdir(source); await mkdir(root)
  const exec = promisify(execFile), git = async (...args) => (await exec('git', ['-C', source, ...args], { windowsHide: true })).stdout.trim()
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.invalid')
  await writeFile(join(source, 'value.txt'), 'old'); await git('add', 'value.txt'); await git('commit', '-m', 'base')
  const options = { dbPath: join(directory, 'control.db'), instanceId: 'registry', initialize: true }
  const store = await openExecutionStore(options); t.after(() => store.close())
  const config = { ownerActorId: 'owner', modelConfig: () => ({ provider: 'test', model: 'v1', reasoningEffort: 'low' }), repositories: [{
    id: 'project', sourceRepository: source, managedRoot: root, remote: 'https://github.com/test/repo.git', baseRef: 'main', editablePaths: ['value.txt'],
    checks: [{ id: 'fixed', version: '1', executable: process.execPath, args: ['-e', 'process.exit(0)'] }],
  }] }
  const registry = createEngineeringRegistry(config), admitted = []
  await registry.restore(store)
  const controller = { registerWorkflow: workflow => admitted.push(defineExecutionWorkflow(workflow).digest) }
  const action = { taskId: 'task', constraints: ['I节点新增限制'], arguments: { repositoryId: 'project', objective: '修改value', sourceRepository: 'C:/ignored', checks: ['malicious'] } }
  const info = { commandId: 'command', run: { actorId: 'owner' }, unit: { constraints: [], sharedConstraints: [] } }
  const prepared = await registry.prepareTask(action, info, controller)
  assert.deepEqual(prepared.input.editablePaths, ['value.txt'])
  assert.deepEqual(prepared.input.constraints, ['I节点新增限制'])
  assert.deepEqual(await registry.prepareTask(action, info, controller), prepared)
  assert.equal(admitted[0], admitted[1])
  const [record] = await store.query({ kind: 'workflow.list' })
  assert.equal(record.config.provider, 'test'); assert.equal(record.config.model, 'v1')
  assert.equal(record.config.reasoningEffort, 'low')
  assert.equal(record.config.input.baseCommit, await git('rev-parse', 'HEAD'))
  assert.equal(record.config.head, `codex/task-${executionDigest(info.commandId).slice(0, 24)}`)
  await store.close()
  const reopened = await openExecutionStore({ ...options, initialize: false }); t.after(() => reopened.close())
  const second = createEngineeringRegistry({ ...config, modelConfig: () => ({ provider: 'other', model: 'v2' }) })
  assert.equal(defineExecutionWorkflow((await second.restore(reopened))[0]).digest, record.digest)
  assert.deepEqual(await second.prepareTask(action, info, controller), prepared)
  await assert.rejects(second.prepareTask(action, { ...info, run: { actorId: 'outsider' } }, controller), { code: 'WORKFLOW_ACTION_FORBIDDEN' })
  await assert.rejects(second.prepareTask({ ...action, arguments: { ...action.arguments, repositoryId: 'unlisted' } }, info, controller), { code: 'ENGINEERING_REPOSITORY_NOT_ADMITTED' })
  const effect = { runId: prepared.runId, generation: 1, directory: join(root, `ws-${executionDigest({ runId: prepared.runId, generation: 1 })}`, 'repository') }
  assert.equal((await second.deliveryOptions.authorize({ binding: { runId: prepared.runId, taskId: 'task' }, prepared: effect })).principalId, 'owner')
  await assert.rejects(second.deliveryOptions.authorize({ binding: { runId: prepared.runId, taskId: 'other-task' }, prepared: effect }), { code: 'ENGINEERING_EFFECT_NOT_AUTHORIZED' })
  await assert.rejects(second.deliveryOptions.authorize({ binding: { runId: prepared.runId, taskId: 'task' }, prepared: { ...effect, directory: source } }), { code: 'ENGINEERING_DELIVERY_SCOPE_INVALID' })
  const changed = createEngineeringRegistry({ ...config, repositories: [{ ...config.repositories[0], editablePaths: ['another.txt'] }] })
  await assert.rejects(changed.restore(reopened), { code: 'ENGINEERING_DEFINITION_CONFIG_DRIFT' })
})

test('工程交付后补充：固定分支祖先条件续写、PR原位修订且新代读取旧代结果', { timeout: 120000 }, async t => {
  const { readFile } = await import('node:fs/promises')
  const { openExecutionArtifacts } = await import('../packages/dingtalk-dsh-assistant/execution-artifacts.js')
  const { createExecutionController } = await import('../packages/dingtalk-dsh-assistant/execution-controller.js')
  const { createExecutionDelivery } = await import('../packages/dingtalk-dsh-assistant/execution-delivery.js')
  const directory = await mkdtemp(join(tmpdir(), 'dsh-revision-')), source = join(directory,'source'), root=join(directory,'managed'), remote=join(directory,'remote.git'), script=join(directory,'gh.cjs'), stateFile=join(directory,'pr.json')
  await mkdir(source); await mkdir(root)
  const exec=promisify(execFile), git=async (repo,...args)=>(await exec('git',['-C',repo,...args],{windowsHide:true})).stdout.trim()
  await git(source,'init','-b','main');await git(source,'config','user.name','Test');await git(source,'config','user.email','test@example.invalid')
  await writeFile(join(source,'value.txt'),'old');await git(source,'add','.');await git(source,'commit','-m','base');await exec('git',['init','--bare',remote])
  const head=`codex/task-${executionDigest('revision-command').slice(0,24)}`
  await writeFile(script,`const fs=require('node:fs'),cp=require('node:child_process');const [file,remote,head,...args]=process.argv.slice(2);let s=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):null;const sha=()=>cp.execFileSync('git',['ls-remote',remote,'refs/heads/'+head],{encoding:'utf8'}).trim().split(/\\s+/)[0];const value=x=>args[args.indexOf(x)+1];if(s)s.headRefOid=sha();if(args[0]==='api')console.log(JSON.stringify({object:{sha:sha()}}));else if(args[1]==='list')console.log(JSON.stringify(s?[s]:[]));else if(args[1]==='view')console.log(JSON.stringify(s));else if(['create','edit'].includes(args[1])){s={number:1,url:'https://github.com/test/repo/pull/1',state:'OPEN',headRefOid:sha(),headRefName:head,baseRefName:'main',body:fs.readFileSync(value('--body-file'),'utf8'),title:value('--title'),creates:(s?.creates??0)+(args[1]==='create'?1:0),edits:(s?.edits??0)+(args[1]==='edit'?1:0)};fs.writeFileSync(file,JSON.stringify(s));process.exit(1)}else process.exit(2)`)
  const store=await openExecutionStore({dbPath:join(directory,'control.db'),instanceId:'revision',initialize:true}),artifacts=await openExecutionArtifacts({directory:join(directory,'artifacts'),initialize:true});t.after(()=>store.close())
  const registry=createEngineeringRegistry({ownerActorId:'owner',modelConfig:()=>({provider:'test',model:'test'}),author:{name:'Test',email:'test@example.invalid'},ghCommand:{executable:process.execPath,args:[script,stateFile,remote,head]},repositories:[{id:'repo',sourceRepository:source,managedRoot:root,remote,githubRepository:'test/repo',baseRef:'main',editablePaths:['value.txt'],checks:[{id:'check',version:'1',executable:process.execPath,args:['-e',"if(!['one','two'].includes(require('node:fs').readFileSync('value.txt','utf8')))process.exit(1)"]}]}]})
  await registry.restore(store)
  const reached=Promise.withResolvers(),release=Promise.withResolvers();let firstCommit
  const sessions={async run({input,onSessionBound,onResult}){await onSessionBound();assert.equal(input.files[0].text,input.request==='first'?'old':'one');onResult({changes:[{path:'value.txt',expectedHash:input.files[0].expectedHash,content:input.request==='first'?'one':'two'}]})},async cancel(){},async close(){}}
  const controller=createExecutionController({store,artifacts,sessions,delivery:createExecutionDelivery({store,artifacts,...registry.deliveryOptions}),workflows:[],changeQuietMs:0,maxChangeDelayMs:0});t.after(()=>controller.close())
  const prepared=await registry.prepareTask({taskId:'task',arguments:{repositoryId:'repo',objective:'first'}},{commandId:'revision-command',run:{actorId:'owner'},unit:{}},{registerWorkflow(workflow){const node=workflow.nodes.at(-1),original=node.execute;node.execute=async args=>{const result=await original(args);if(args.generation===1){firstCommit=result.commitId;reached.resolve();await release.promise}return result};controller.registerWorkflow(workflow)}})
  await controller.createRun({commandId:'create',...prepared})
  await reached.promise
  await controller.changeInput({commandId:'revise',runId:prepared.runId,inputId:'revision',sourceKey:'revision',input:{...prepared.input,request:'second'}});release.resolve()
  const state=await controller.whenIdle(prepared.runId)
  assert.equal(state.run.status,'succeeded',JSON.stringify(await controller.state(prepared.runId)));assert.equal(state.run.generation,2)
  const result=await artifacts.read(state.nodes.at(-1).outputRef),pr=JSON.parse(await readFile(stateFile,'utf8'))
  assert.notEqual(result.commitId,firstCommit);assert.equal(await git(remote,'rev-parse',result.commitId+'^'),firstCommit)
  assert.equal(await git(remote,'show',result.commitId+':value.txt'),'two');assert.equal(pr.creates,1);assert.equal(pr.edits,1);assert.equal(pr.title,'second');assert.match(pr.body,/second/)
  assert.equal(await readFile(join(source,'value.txt'),'utf8'),'old')
})
