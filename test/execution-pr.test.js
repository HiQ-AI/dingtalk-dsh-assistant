import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createGithubPullRequests } from '../packages/dingtalk-dsh-assistant/execution-pr.js'
import { createVerificationJobCheck } from '../packages/dingtalk-dsh-assistant/execution-check-job.js'

test('PR create ACK丢失后list+view独立回读，重试不重复创建，head变更拒绝', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-pr-test-')), script = join(directory, 'gh.cjs'), state = join(directory, 'state.json')
  await writeFile(state, JSON.stringify({ count: 0, sha: 'a'.repeat(40), pr: null }))
  await writeFile(script, `const fs=require('node:fs'); const [file,...args]=process.argv.slice(2); const s=JSON.parse(fs.readFileSync(file));
const value=x=>args[args.indexOf(x)+1];
if(args[0]==='api') console.log(JSON.stringify({object:{sha:s.sha}}));
else if(args[1]==='list') console.log(JSON.stringify(s.pr?[s.pr]:[]));
else if(args[1]==='view') console.log(JSON.stringify(s.pr));
else if(args[1]==='create'){s.count++;s.pr={number:1,url:'https://github.com/test/repo/pull/1',state:'OPEN',headRefOid:s.sha,headRefName:'codex/test',baseRefName:'main',body:fs.readFileSync(value('--body-file'),'utf8')};fs.writeFileSync(file,JSON.stringify(s));process.exit(1)}else process.exit(2);`)
  const adapter = createGithubPullRequests({ repository: directory, repo: 'test/repo', base: 'main', head: 'codex/test', ghCommand: { executable: process.execPath, args: [script, state] } })
  const prepared = adapter.prepare({ runId: 'run', generation: 1, requirementDigest: 'b'.repeat(64), commitId: 'a'.repeat(40), title: 'Title', body: 'Body' })
  const result = await adapter.execute(prepared)
  assert.equal(result.status, 'succeeded'); assert.equal(result.number, 1)
  assert.equal((await adapter.execute(prepared)).status, 'succeeded')
  let saved = JSON.parse(await readFile(state, 'utf8')); assert.equal(saved.count, 1)
  saved.pr.headRefOid = 'c'.repeat(40); await writeFile(state, JSON.stringify(saved))
  await assert.rejects(adapter.reconcile(prepared), { code: 'PR_RESULT_CONFLICT' })
})

test('受信验证job只跑固定argv并记录真实exit和日志，失败不能通过', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-check-test-'))
  const snapshot = { candidateDigest: 'a'.repeat(64), files: [{ path: 'value.txt', mode: '100644' }], readFile: async () => Buffer.from('expected') }
  const check = createVerificationJobCheck({ id: 'verify', version: '1', root, executable: process.execPath, args: ['-e', "const fs=require('node:fs'); if(fs.readFileSync('value.txt','utf8')!=='expected')process.exit(2);console.log('real check passed')"] })
  const result = await check.run(snapshot), log = JSON.parse(result.log)
  assert.equal(result.passed, true); assert.equal(log.exitCode, 0); assert.match(log.steps[0].stdout, /real check passed/); assert.equal(log.steps[0].stdoutEncoding, 'utf8')
  const failed = await createVerificationJobCheck({ id: 'negative', version: '1', root, executable: process.execPath, args: ['-e', 'process.exit(3)'] }).run(snapshot)
  assert.equal(failed.passed, false); assert.equal(JSON.parse(failed.log).exitCode, 3)
  const stepped = await createVerificationJobCheck({ id: 'steps', version: '1', root, steps: [
    { executable: process.execPath, args: ['-e', "require('node:fs').writeFileSync('dependency.txt','ready')"] },
    { executable: process.execPath, args: ['-e', "if(require('node:fs').readFileSync('dependency.txt','utf8')!=='ready')process.exit(4)"] },
  ] }).run(snapshot)
  assert.equal(stepped.passed, true); assert.deepEqual(JSON.parse(stepped.log).steps.map(step => step.exitCode), [0, 0])
})

test('验证取消和超时均终止真实父子进程，后续step不执行', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-check-cancel-'))
  for (const mode of ['cancel', 'timeout']) {
    const pidFile = join(root, `${mode}.json`), forbidden = join(root, `${mode}-later.txt`)
    const code = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000)`
    const abort = new AbortController()
    const check = createVerificationJobCheck({ id: mode, version: '1', root, timeoutMs: mode === 'timeout' ? 1200 : 30000, steps: [
      { executable: process.execPath, args: ['-e', code] },
      { executable: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(forbidden)},'bad')`] },
    ] })
    const started = Date.now(), promise = check.run({candidateDigest:'a'.repeat(64),files:[]},{signal:abort.signal})
    let pids
    for(let i=0;i<100;i++){try{pids=JSON.parse(await readFile(pidFile,'utf8'));break}catch{await new Promise(r=>setTimeout(r,20))}}
    assert.ok(pids)
    if(mode==='cancel')abort.abort()
    const result=await promise
    assert.equal(result.passed,false);assert.equal(JSON.parse(result.log).reason,mode==='cancel'?'cancelled':'timeout')
    assert.ok(Date.now()-started<10000)
    for(const pid of pids)assert.throws(()=>process.kill(pid,0))
    await assert.rejects(readFile(forbidden),{code:'ENOENT'})
  }
})

test('检查分步预算分别生效且总预算不可被后续step重置', async () => {
  const root=await mkdtemp(join(tmpdir(),'dsh-step-budget-')),snapshot={candidateDigest:'a'.repeat(64),files:[]}
  const step=(delay,timeoutMs)=>({executable:process.execPath,args:['-e',`setTimeout(()=>{},${delay})`],timeoutMs})
  const cases=[
    {id:'first',timeoutMs:5000,steps:[step(1600,500),step(1,500)],count:1,scope:'step'},
    {id:'second',timeoutMs:5000,steps:[step(40,1500),step(1600,500)],count:2,scope:'step'},
    {id:'total',timeoutMs:1000,steps:[step(200,2000),step(2000,2000)],count:2,scope:'check'},
  ]
  for(const item of cases){
    const result=await createVerificationJobCheck({...item,version:'1',root}).run(snapshot),log=JSON.parse(result.log)
    assert.equal(result.passed,false);assert.equal(log.steps.length,item.count);assert.equal(log.reason,'timeout');assert.equal(log.timeoutScope,item.scope)
    assert.equal(log.steps.at(-1).timeoutScope,item.scope)
    for(const value of log.steps){assert.ok(Number.isFinite(Date.parse(value.startedAt)));assert.ok(value.elapsedMs>0);assert.ok(value.budgetMs>0);assert.ok(value.budgetMs<=value.timeoutMs)}
    if(item.id==='second'){assert.equal(log.steps[0].exitCode,0);assert.equal(log.steps[0].timeoutScope,null);assert.equal(log.steps[1].budgetMs,500)}
    if(item.id==='total')assert.ok(log.steps[1].budgetMs<1000)
  }
  assert.throws(()=>createVerificationJobCheck({id:'bad-total',version:'1',root,timeoutMs:2400001,steps:[step(1,100)]}),{code:'VERIFY_JOB_CONFIG_INVALID'})
  assert.throws(()=>createVerificationJobCheck({id:'bad-step',version:'1',root,timeoutMs:2400000,steps:[step(1,1800001)]}),{code:'VERIFY_JOB_CONFIG_INVALID'})
  assert.ok(createVerificationJobCheck({id:'declared',version:'1',root,timeoutMs:2400000,steps:[step(1,600000),step(1,1800000)]}))
})

test('20KB真实控制字符与最坏文本转义日志有界无损，末步输出不在顶层重复', async () => {
  const root=await mkdtemp(join(tmpdir(),'dsh-output-bound-')),snapshot={candidateDigest:'a'.repeat(64),files:[]}
  const binary=await createVerificationJobCheck({id:'control',version:'1',root,executable:process.execPath,args:['-e',"process.stdout.write(Buffer.alloc(10000,0));process.stderr.write(Buffer.alloc(10000,1));process.exitCode=3"]}).run(snapshot)
  assert.equal(binary.passed,false);assert.ok(Buffer.byteLength(binary.log)<=65536)
  const log=JSON.parse(binary.log),step=log.steps[0]
  assert.equal(log.exitCode,3);assert.equal(log.stdout,undefined);assert.equal(log.stderr,undefined)
  assert.equal(step.outputBytes,20000);assert.equal(step.stdoutEncoding,'base64');assert.equal(step.stderrEncoding,'base64')
  assert.deepEqual(Buffer.from(step.stdout,'base64'),Buffer.alloc(10000,0));assert.deepEqual(Buffer.from(step.stderr,'base64'),Buffer.alloc(10000,1))
  const raw='"\\'.repeat(10000)
  const text=await createVerificationJobCheck({id:'escaped',version:'1',root,executable:process.execPath,args:['-e','process.stdout.write(String.fromCharCode(34,92).repeat(10000))']}).run(snapshot)
  assert.equal(text.passed,true);assert.ok(Buffer.byteLength(text.log)<=65536)
  assert.equal(Buffer.from(JSON.parse(text.log).steps[0].stdout,'base64').toString(),raw);assert.equal(JSON.parse(text.log).steps[0].stdoutEncoding,'base64')
})

test('实际约27KB安装构建输出通过；32KiB边界无损，超限仍停止并拒绝通过', async () => {
  const root=await mkdtemp(join(tmpdir(),'dsh-32k-output-')),snapshot={candidateDigest:'a'.repeat(64),files:[]}
  const command=code=>({executable:process.execPath,args:['-e',code]})
  const real=await createVerificationJobCheck({id:'measured',version:'1',root,steps:[command('process.stdout.write(Buffer.alloc(1178,105))'),command('process.stdout.write(Buffer.alloc(22823,98));process.stderr.write(Buffer.alloc(2533,119))')]}).run(snapshot)
  const realLog=JSON.parse(real.log);assert.equal(real.passed,true);assert.equal(realLog.steps.reduce((n,s)=>n+s.outputBytes,0),26534);assert.ok(Buffer.byteLength(real.log)<65536)
  const limit=await createVerificationJobCheck({id:'boundary',version:'1',root,steps:[command('process.stdout.write(String.fromCharCode(34,92).repeat(16384))')]}).run(snapshot)
  assert.equal(limit.passed,true);assert.ok(Buffer.byteLength(limit.log)<65536)
  const step=JSON.parse(limit.log).steps[0];assert.equal(step.outputBytes,32768);assert.equal(step.stdoutEncoding,'base64');assert.equal(Buffer.from(step.stdout,'base64').toString(),String.fromCharCode(34,92).repeat(16384))
  const over=await createVerificationJobCheck({id:'over',version:'1',root,steps:[command('process.stdout.write(Buffer.alloc(32769,120));setInterval(()=>{},1000)'),command('console.log("must not execute")')]}).run(snapshot)
  assert.equal(over.passed,false);assert.equal(JSON.parse(over.log).reason,'output_limit');assert.equal(JSON.parse(over.log).steps.length,1);assert.ok(Buffer.byteLength(over.log)<65536)
})
