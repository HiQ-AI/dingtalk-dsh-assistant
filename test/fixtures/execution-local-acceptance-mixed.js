import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { freezeCandidate } from '../../packages/dingtalk-dsh-assistant/execution-candidate.js'
import { createLocalAcceptanceRunner, acceptanceProcessTree, acceptanceProcessesAlive } from '../../packages/dingtalk-dsh-assistant/execution-local-acceptance.js'

const exec = promisify(execFile)
const windows = { skip: process.platform !== 'win32', timeout: 180000 }




// 全部“数据”仅保存在临时目录；就绪和业务操作仅访问本测试启动的回环服务。
const fixtureScript = `
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {appendFile,writeFile,readFile,mkdir} from 'node:fs/promises';
const role=process.argv[2], trace=process.env.ACCEPTANCE_TRACE;
let raw=''; for await(const chunk of process.stdin) raw+=chunk;
const input=JSON.parse(raw), params=input.case?.parameters??input.plan?.cases[0]?.parameters??{};
await appendFile(trace,JSON.stringify({role,pid:process.pid,namespace:input.namespace,temp:process.env.TEMP,tmp:process.env.TMP,tmpdir:process.env.TMPDIR,evidenceRoot:input.evidenceRoot})+'\\n');
if(role==='prepare'&&params.mutatePrepare)await appendFile('fixture.mjs','\\n// changed by build');
if(role==='prepare'&&params.generated){await mkdir('target');await writeFile('target/generated.txt','build artifact');}
if(role==='prepare'&&params.extraSource){await mkdir('src');await writeFile('src/evil.js','new unverified source');}
if(role==='scenario'&&params.mutateScenario)await appendFile('fixture.mjs','\\n// changed during scenario');
if(role==='service'||role==='service-child') {
 if(role==='service'&&params.wrongPid) {
  const child=spawn(process.execPath,[process.argv[1],'service-child',...process.argv.slice(3)],{stdio:['pipe','inherit','inherit'],windowsHide:true});child.stdin.end(JSON.stringify(input));
  setInterval(()=>{},1000);
 } else {
  const start=Date.now();
  const server=createServer(async(request,response)=>{const waiting=request.url==='/ready'&&Date.now()-start<(params.readyDelayMs??0);if(params.readyDelayMs&&request.url==='/ready')await appendFile(trace,JSON.stringify({role:'ready-probe',waiting})+'\\n');response.writeHead(waiting?503:200,{'content-type':'application/json'});response.end(JSON.stringify({actual:'actual-value'}))});
  server.listen(Number(process.argv[4]),process.argv[3]);
 }
} else if(role==='scenario') {
 const response=await fetch(input.baseUrl+'/result'); const body=await response.json();
 if(input.services?.dataset) { const backend=await (await fetch(input.services.dataset.baseUrl+'/result')).json(); if(backend.actual!==body.actual)process.exit(5); }
 if(params.hang) await new Promise(()=>setInterval(()=>{},1000));
 console.log(JSON.stringify({namespace:input.namespace,baseUrl:input.baseUrl,actual:params.mismatch?'wrong-value':body.actual,...(params.largeOutput?{diagnostic:'x'.repeat(100000)}:{})}));
} else if(role==='cleanup') {
 if(params.cleanupFailure) process.exit(3);
 if(!params.mutatePrepare&&!params.extraSource){const response=await fetch(input.baseUrl+'/cleanup'); if(!response.ok) process.exit(4);}
 await writeFile(trace+'.cleaned',input.namespace);
} else if(role==='verify') {
 let stopped=false;try{await fetch(input.baseUrl+'/ready')}catch{stopped=true}
 for(const service of Object.values(input.services??{})){try{await fetch(service.baseUrl+'/ready');stopped=false}catch{}}
 const cleaned=await readFile(trace+'.cleaned','utf8');
 console.log(JSON.stringify({namespace:input.namespace,empty:stopped&&cleaned===input.namespace&&!params.dirty,...(params.readonly?{mode:'read-only',createdResources:0}:{})}));
}
`
async function setup(t, parameters = {}, companion = false, taskFiles = false) {
  const directory = await mkdtemp(join(tmpdir(), 'local-acceptance-test-')), source = join(directory, 'source'), trace = join(directory, 'trace.jsonl')
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('local-acceptance-test-'))
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  })
  await mkdir(source)
  await writeFile(join(source, 'fixture.mjs'), fixtureScript)
  await writeFile(trace, '')
  for (const args of [['init', '-q'], ['config', 'user.name', 'Acceptance Test'], ['config', 'user.email', 'acceptance@example.invalid'], ['add', '.'], ['commit', '-qm', 'fixture']]) await exec('git', args, { cwd: source })
  const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: source })
  const candidate = await freezeCandidate({ repository: source, baseCommit: stdout.trim(), generation: 1, requirementDigest: 'a'.repeat(64) })
  const profile = join(directory, 'profile.json')
  await writeFile(profile, JSON.stringify({ environment: 'uat', env: { ACCEPTANCE_TRACE: trace, ACCEPTANCE_SECRET: 'fixture-private-secret' } }))
  const command = role => ({ executable: process.execPath, args: ['fixture.mjs', role] })
  const config = { version: 'fixture-1', generatedOutputDirectories: ['target'], sharedDataProfilePath: profile, prepareSteps: [command('prepare')],
    service: { ...command('service'), args: ['fixture.mjs', 'service', '127.0.0.1', '{port}'], readyPath: '/ready' },
    scenarios: [{ ...command('scenario'), id: 'fixture', description: '仅本机回环服务及临时文件' }],
    cleanup: command('cleanup'), verifyCleanup: command('verify') }
  if (companion) {
    const artifactPath = join(directory, 'trusted-backend.mjs'); await writeFile(artifactPath, fixtureScript)
    config.companionServices = [{ id: 'dataset', executable: process.execPath, args: [artifactPath, 'service', '127.0.0.1', '{port}'], readyPath: '/ready', artifactPath,
      artifactSha256: createHash('sha256').update(fixtureScript).digest('hex') }]
  }
  const options = { root: join(directory, 'runs'), config, ...(taskFiles ? { tempRoot: join(directory, 'task-tmp') } : {}) }, runner = taskFiles ? (await import('../../packages/dingtalk-dsh-assistant/execution-task-local-acceptance.js')).createTaskLocalAcceptanceRunner(options) : createLocalAcceptanceRunner(options)
  const request = { candidate, plan: { cases: [{ criterionId: 'criterion-1', scenarioId: 'fixture', steps: ['读取本地业务结果'], expected: 'actual-value', parameters }] },
    taskId: 'fixture-task', runId: 'fixture-run', generation: 1, uatEnvironment: 'uat4' }
  return { options, runner, prepared: await runner.prepare(request), trace, directory, request,
    events: async () => (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
}



































export { assert, mkdtemp, mkdir, writeFile, readFile, rm, lstat, tmpdir, join, dirname, basename, resolve, execFile, promisify, createHash, freezeCandidate, createLocalAcceptanceRunner, acceptanceProcessTree, acceptanceProcessesAlive, exec, windows, fixtureScript, setup }
