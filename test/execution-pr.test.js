import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createGithubPullRequests } from '../packages/dingtalk-dsh-assistant/execution-pr.js'
import { createVerificationJobCheck, createBusinessAcceptanceCheck } from '../packages/dingtalk-dsh-assistant/execution-check-job.js'

test('受信旧 PR 原位改 UAT base，未知回执独立回读；身份、并发与歧义不改远端', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-pr-retarget-')), script = join(directory, 'gh.cjs'), state = join(directory, 'state.json')
  const oldKey = 'c'.repeat(64), sha = 'a'.repeat(40)
  await writeFile(script, `const fs=require('node:fs');const[file,...args]=process.argv.slice(2),s=JSON.parse(fs.readFileSync(file)),v=k=>args[args.indexOf(k)+1];
const rest=p=>({number:p.number,html_url:p.url,state:p.state.toLowerCase(),merged_at:p.state==='MERGED'?'date':null,head:{sha:p.headRefOid,ref:p.headRefName},base:{ref:p.baseRefName},body:p.body});
if(args[0]==='api'&&args.includes('--paginate'))console.log(JSON.stringify([[s.pr,...(s.extra?[{...s.pr,number:99}]:[])].map(rest)]));
else if(args[0]==='api'){if(s.race)s.pr.baseRefName='feature/foreign';fs.writeFileSync(file,JSON.stringify(s));console.log(JSON.stringify({object:{sha:s.sha}}))}
else if(args[1]==='list')console.log(JSON.stringify([s.pr,...(s.extra?[{...s.pr,number:99}]:[])]));
else if(args[1]==='view')console.log(JSON.stringify(s.pr));
else if(args[1]==='edit'){s.edits++;s.pr.baseRefName=v('--base');s.pr.body=fs.readFileSync(v('--body-file'),'utf8');if(s.afterEdit)s.pr.headRefOid='d'.repeat(40);fs.writeFileSync(file,JSON.stringify(s));process.exit(1)}
else if(args[1]==='create'){s.creates++;fs.writeFileSync(file,JSON.stringify(s));process.exit(2)}else process.exit(2);`)
  const initial = () => ({ edits: 0, creates: 0, sha, pr: { number: 371, url: 'https://github.com/test/repo/pull/371', state: 'OPEN',
    headRefOid: sha, headRefName: 'codex/old', baseRefName: 'main', body: `old\n<!-- dsh-operation:${oldKey} -->` } })
  const adapter = createGithubPullRequests({ repository: directory, repo: 'test/repo', base: 'feature/uat3-base', head: 'codex/old',
    previousPullRequest: { number: 371, repo: 'test/repo', head: 'codex/old', base: 'main', operationKey: oldKey },
    ghCommand: { executable: process.execPath, args: [script, state] } })
  const prepared = adapter.prepare({ runId: 'new-run', generation: 1, requirementDigest: 'b'.repeat(64), commitId: sha, title: '重新验收并提测', body: '本轮验证' })
  await writeFile(state, JSON.stringify(initial()))
  assert.equal((await adapter.execute(prepared)).number, 371)
  assert.equal((await adapter.execute(prepared)).status, 'succeeded')
  let saved = JSON.parse(await readFile(state, 'utf8'))
  assert.equal(saved.edits, 1); assert.equal(saved.creates, 0); assert.equal(saved.pr.baseRefName, 'feature/uat3-base')
  for (const mutate of [s => { s.pr.state = 'MERGED' }, s => { s.extra = true }, s => { s.pr.baseRefName = 'feature/uat2-base' },
    s => { s.pr.headRefOid = 'e'.repeat(40) }, s => { s.pr.body = 'untrusted' }, s => { s.race = true }]) {
    const value = initial(); mutate(value); await writeFile(state, JSON.stringify(value))
    const attempt = adapter.prepare({ ...prepared, runId: `negative-${Math.random()}` })
    await assert.rejects(adapter.execute(attempt), /PR_PREVIOUS_IDENTITY_CONFLICT|PR_IDENTITY_AMBIGUOUS/)
    saved = JSON.parse(await readFile(state, 'utf8')); assert.equal(saved.edits, 0); assert.equal(saved.creates, 0)
  }
  const changedAfter = initial(); changedAfter.afterEdit = true; await writeFile(state, JSON.stringify(changedAfter))
  await assert.rejects(adapter.execute(adapter.prepare({ ...prepared, runId: 'changed-after' })), /PR_PREVIOUS_IDENTITY_CONFLICT/)
  saved = JSON.parse(await readFile(state, 'utf8')); assert.equal(saved.edits, 1); assert.equal(saved.creates, 0)
})

test('PR create ACK丢失后list+view独立回读，重试不重复创建，head变更拒绝', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-pr-test-')), script = join(directory, 'gh.cjs'), state = join(directory, 'state.json')
  await writeFile(state, JSON.stringify({ count: 0, sha: 'a'.repeat(40), pr: null }))
  await writeFile(script, `const fs=require('node:fs'); const [file,...args]=process.argv.slice(2); const s=JSON.parse(fs.readFileSync(file));
const value=x=>args[args.indexOf(x)+1];
const rest=p=>({number:p.number,html_url:p.url,state:p.state.toLowerCase(),head:{sha:p.headRefOid,ref:p.headRefName},base:{ref:p.baseRefName},body:p.body});
if(args[0]==='api'&&args.includes('--paginate'))console.log(JSON.stringify([s.pr?[rest(s.pr)]:[]]));
else if(args[0]==='api') console.log(JSON.stringify({object:{sha:s.sha}}));
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

test('验证取消终止真实父子进程，后续step不执行', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-check-cancel-'))
  for (const mode of ['cancel', 'task-cancel']) {
    const pidFile = join(root, `${mode}.json`), forbidden = join(root, `${mode}-later.txt`)
    const code = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000)`
    const abort = new AbortController()
    const { fileURLToPath } = await import('node:url'), { createHash } = await import('node:crypto')
    const launcher = fileURLToPath(new URL('../packages/dingtalk-dsh-assistant/execution-task-command.js', import.meta.url))
    const digest = createHash('sha256').update((await readFile(launcher, 'utf8')).replace(/\r\n/g, '\n')).digest('hex')
    const check = createVerificationJobCheck({ id: mode, version: '1', root, steps: [
      { executable: process.execPath, args: mode === 'task-cancel' ? [launcher, digest, join(root, 'tmp'), process.execPath, '-e', code] : ['-e', code] },
      { executable: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(forbidden)},'bad')`] },
    ] })
    const started = Date.now(), promise = check.run({candidateDigest:'a'.repeat(64),files:[]},{signal:abort.signal})
    let pids
    for(let i=0;i<100;i++){try{pids=JSON.parse(await readFile(pidFile,'utf8'));break}catch{await new Promise(r=>setTimeout(r,20))}}
    assert.ok(pids)
    abort.abort()
    const result=await promise
    assert.equal(result.passed,false);assert.equal(JSON.parse(result.log).reason,'cancelled')
    assert.ok(Date.now()-started<10000)
    for(const pid of pids)assert.throws(()=>process.kill(pid,0))
    await assert.rejects(readFile(forbidden),{code:'ENOENT'})
  }
})

test('检查持续运行至完成，旧时间预算配置拒绝接纳', async () => {
  const root=await mkdtemp(join(tmpdir(),'dsh-continuous-check-')),snapshot={candidateDigest:'a'.repeat(64),files:[]}
  const command={executable:process.execPath,args:['-e','setTimeout(()=>{},1200)']}
  const result=await createVerificationJobCheck({id:'continuous',version:'1',root,steps:[command,command]}).run(snapshot)
  assert.equal(result.passed,true); const log=JSON.parse(result.log)
  assert.equal(log.steps.length,2); assert.ok(log.elapsedMs >= 2400)
  assert.equal(log.timeoutMs,undefined); assert.equal(log.steps[0].budgetMs,undefined)
  assert.throws(()=>createVerificationJobCheck({id:'old-total',version:'1',root,steps:[command],timeoutMs:100}),{code:'VERIFY_JOB_CONFIG_INVALID'})
  assert.throws(()=>createVerificationJobCheck({id:'old-step',version:'1',root,steps:[{...command,timeoutMs:100}]}),{code:'VERIFY_JOB_CONFIG_INVALID'})
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

test('实际约27KB安装构建输出通过；32KiB边界无损，诊断超量明确截断且不中断后续步骤', async () => {
  const root=await mkdtemp(join(tmpdir(),'dsh-32k-output-')),snapshot={candidateDigest:'a'.repeat(64),files:[]}
  const command=code=>({executable:process.execPath,args:['-e',code]})
  const real=await createVerificationJobCheck({id:'measured',version:'1',root,steps:[command('process.stdout.write(Buffer.alloc(1178,105))'),command('process.stdout.write(Buffer.alloc(22823,98));process.stderr.write(Buffer.alloc(2533,119))')]}).run(snapshot)
  const realLog=JSON.parse(real.log);assert.equal(real.passed,true);assert.equal(realLog.steps.reduce((n,s)=>n+s.outputBytes,0),26534);assert.ok(Buffer.byteLength(real.log)<65536)
  const limit=await createVerificationJobCheck({id:'boundary',version:'1',root,steps:[command('process.stdout.write(String.fromCharCode(34,92).repeat(16384))')]}).run(snapshot)
  assert.equal(limit.passed,true);assert.ok(Buffer.byteLength(limit.log)<65536)
  const step=JSON.parse(limit.log).steps[0];assert.equal(step.outputBytes,32768);assert.equal(step.stdoutEncoding,'base64');assert.equal(Buffer.from(step.stdout,'base64').toString(),String.fromCharCode(34,92).repeat(16384))
  const over=await createVerificationJobCheck({id:'over',version:'1',root,steps:[command('process.stdout.write(Buffer.alloc(200000,120))'),command('console.log("completed next step")')]}).run(snapshot)
  assert.equal(over.passed,true);const overLog=JSON.parse(over.log);assert.equal(overLog.reason,null);assert.equal(overLog.steps.length,2);assert.equal(overLog.steps[0].outputTruncated,true);assert.equal(overLog.steps[0].observedOutputBytes,200000);assert.ok(Buffer.byteLength(over.log)<65536)
})

test('PR暂态预检单次返回，恢复重试由调用方触发；发送后失败与重启只对账不重发', async () => {
  const directory=await mkdtemp(join(tmpdir(),'dsh-pr-phases-')),repository=join(directory,'repo')
  const {mkdir,readdir}=await import('node:fs/promises');await mkdir(repository)
  const script=join(directory,'gh.cjs'),state=join(directory,'state.json')
  await writeFile(script,`const fs=require('fs');const[file,...a]=process.argv.slice(2),s=JSON.parse(fs.readFileSync(file)),v=x=>a[a.indexOf(x)+1];
const rest=p=>({number:p.number,html_url:p.url,state:'open',head:{sha:p.headRefOid,ref:p.headRefName},base:{ref:p.baseRefName},body:p.body});
if(a[1]==='create'){s.sends++;s.pr={number:1,url:'https://github.com/test/repo/pull/1',state:'OPEN',headRefOid:'a'.repeat(40),headRefName:'codex/test',baseRefName:'feature/uat3-base',body:fs.readFileSync(v('--body-file'),'utf8')};fs.writeFileSync(file,JSON.stringify(s));console.error('private stderr');process.exit(1)}
s.reads++;fs.writeFileSync(file,JSON.stringify(s));if(s.fail||s.afterSendFail&&s.sends){console.error(s.auth?'HTTP 401':'TLS handshake timeout');process.exit(1)}
console.log(JSON.stringify(a.includes('--paginate')?[s.pr?[rest(s.pr)]:[]]:a[0]==='api'?{object:{sha:'a'.repeat(40)}}:s.pr));`)
  const config={repository,repo:'test/repo',base:'feature/uat3-base',head:'codex/test',ghCommand:{executable:process.execPath,args:[script,state]}}
  const adapter=createGithubPullRequests(config),prepare=runId=>adapter.prepare({runId,generation:1,requirementDigest:'b'.repeat(64),commitId:'a'.repeat(40),title:'验证',body:'完整业务结果'.repeat(30000)})
  await writeFile(state,JSON.stringify({reads:0,sends:0,fail:true}))
  const failed=prepare('preflight'),outcome=await adapter.execute(failed)
  assert.equal(outcome.status,'failed');assert.equal(outcome.reason,'PR_CONNECTION_FAILED');assert.equal(outcome.mutationAttempted,false);assert.equal(outcome.readAttempts,1)
  assert.equal(JSON.parse(await readFile(state,'utf8')).reads,1)
  await adapter.execute(failed);assert.equal(JSON.parse(await readFile(state,'utf8')).reads,2)
  const known=await createGithubPullRequests(config).reconcile(failed)
  assert.equal(known.reason,'PR_PREFLIGHT_NOT_SENT');assert.equal(known.mutationAttempted,false)
  assert.equal(JSON.parse(await readFile(state,'utf8')).reads,2)
  const proof=await createGithubPullRequests(config).recoverUnsent(failed)
  assert.equal(proof.operationKey,failed.operationKey);assert.equal(proof.preparedDigest,failed.digest);assert.equal(proof.mutationAttempted,false)
  assert.equal(JSON.parse(await readFile(proof.evidenceRef,'utf8')).preparedDigest,failed.digest)
  assert.equal(await adapter.recoverUnsent(prepare('missing')),null)
  await assert.rejects(adapter.recoverUnsent({...failed,digest:'0'.repeat(64)}),{code:'PR_PREPARED_INVALID'})
  assert.ok(!(await readdir(join(directory,'.dsh-pr-journal'))).some(name=>name.endsWith('.preflight-failed.json')))
  await writeFile(state,JSON.stringify({reads:0,sends:0,fail:true,auth:true}))
  const auth=prepare('auth');assert.equal((await adapter.execute(auth)).reason,'PR_PERMISSION_DENIED')
  await adapter.execute(auth);assert.equal(JSON.parse(await readFile(state,'utf8')).reads,1)
  assert.equal(await adapter.recoverUnsent(auth),null)
  await writeFile(state,JSON.stringify({reads:0,sends:0,afterSendFail:true}))
  const pending=failed;assert.equal((await createGithubPullRequests(config).execute(pending)).status,'unknown')
  const reopened=createGithubPullRequests(config);await reopened.execute(pending)
  assert.equal(await reopened.recoverUnsent(pending),null)
  assert.equal(JSON.parse(await readFile(state,'utf8')).sends,1)
  const saved=JSON.parse(await readFile(state,'utf8'));saved.afterSendFail=false;await writeFile(state,JSON.stringify(saved))
  assert.equal((await reopened.reconcile(pending)).status,'succeeded')
  assert.equal((await reopened.execute(pending)).status,'succeeded');assert.equal(JSON.parse(await readFile(state,'utf8')).sends,1)
  const journal=join(directory,'.dsh-pr-journal'),completed=JSON.parse(await readFile(join(journal,pending.operationKey+'.send-complete.json'),'utf8'))
  assert.equal(completed.exitCode,1);assert.equal(JSON.stringify(completed).includes('private'),false)
  await writeFile(join(journal,pending.operationKey+'.send-intent.json'),'{')
  await assert.rejects(reopened.execute(pending),{code:'PR_JOURNAL_INVALID'})
  await assert.rejects(reopened.recoverUnsent(pending),{code:'PR_JOURNAL_INVALID'})
  assert.equal(JSON.parse(await readFile(state,'utf8')).sends,1)
})

test('任务检查命令真实写入任务tmp，重复检查临时目录隔离且父环境不变', async () => {
  const { fileURLToPath } = await import('node:url'), { createHash } = await import('node:crypto')
  const root = await mkdtemp(join(tmpdir(), 'task-check-')), taskTmp = join(root, 'tmp')
  const launcher = fileURLToPath(new URL('../packages/dingtalk-dsh-assistant/execution-task-command.js', import.meta.url))
  const digest = createHash('sha256').update((await readFile(launcher, 'utf8')).replace(/\r\n/g, '\n')).digest('hex'), prior = process.env.TEMP
  const check = createVerificationJobCheck({ id: 'task', version: '1', root: join(root, 'work'), executable: process.execPath,
    args: [launcher, digest, taskTmp, process.execPath, '-e', `const fs=require('node:fs'),p=require('node:path'),os=require('node:os'); if(process.env.TEMP!==process.env.TMP||process.env.TMP!==process.env.TMPDIR)throw Error('env');fs.writeFileSync(p.join(os.tmpdir(),'actual.tmp'),'task');console.log(os.tmpdir())`] })
  const snapshot = { candidateDigest: 'a'.repeat(64), files: [], readFile: async () => Buffer.alloc(0) }
  const outputs = await Promise.all([check.run(snapshot), check.run(snapshot)])
  const directories = outputs.map(value => { assert.equal(value.passed, true, value.log); return JSON.parse(value.log).steps[0].stdout.trim() })
  assert.notEqual(directories[0], directories[1])
  for (const directory of directories) { assert.ok(directory.startsWith(taskTmp)); assert.equal(await readFile(join(directory, 'actual.tmp'), 'utf8'), 'task') }
  assert.equal(process.env.TEMP, prior)
})

test('任务检查拒绝tmp祖先junction，外部目录零新增', async () => {
 const { symlink, mkdir, readdir } = await import('node:fs/promises'), { fileURLToPath } = await import('node:url'), { createHash } = await import('node:crypto')
 const root = await mkdtemp(join(tmpdir(), 'task-check-link-')), outside = join(root, 'outside'), link = join(root, 'link')
 await mkdir(outside); await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
 const launcher = fileURLToPath(new URL('../packages/dingtalk-dsh-assistant/execution-task-command.js', import.meta.url))
 const digest = createHash('sha256').update((await readFile(launcher, 'utf8')).replace(/\r\n/g, '\n')).digest('hex')
 const check = createVerificationJobCheck({ id: 'link', version: '1', root: join(root, 'work'), executable: process.execPath, args: [launcher, digest, join(link, 'must-not-exist'), process.execPath, '-e', 'process.exit(0)'] })
 const result = await check.run({ files: [], candidateDigest: 'a'.repeat(64) })
 assert.equal(result.passed, false); assert.deepEqual(await readdir(outside), [])
})

test('业务验收完整核对超过100KiB实际值，诊断截断不误判且损坏结果不放行', async () => {
  const root=await mkdtemp(join(tmpdir(),'dsh-large-business-')),snapshot={candidateDigest:'a'.repeat(64),files:[]},expected='a'.repeat(120000)
  const config={id:'business',version:'1',root,criterion:'实际值完整一致',expected,executable:process.execPath}
  const passed=await createBusinessAcceptanceCheck({...config,args:['-e',"process.stdout.write(JSON.stringify({actual:'a'.repeat(120000)}))"]}).run(snapshot)
  assert.equal(passed.passed,true);const log=JSON.parse(passed.log)
  assert.equal(log.steps[0].outputTruncated,true);assert.equal(log.acceptance.actual,expected)
  assert.equal(log.acceptance.expected,expected)
  const invalid=await createBusinessAcceptanceCheck({...config,args:['-e',"process.stdout.write(JSON.stringify({actual:'a'.repeat(120000)}).slice(0,-1))"]}).run(snapshot)
  assert.equal(invalid.passed,false);assert.equal(JSON.parse(invalid.log).acceptance.actual,null)
  const cancelled=new AbortController()
  const pending=createBusinessAcceptanceCheck({...config,args:['-e',"process.stdout.write(JSON.stringify({actual:'a'.repeat(120000)}));setInterval(()=>{},1000)"]}).run(snapshot,{signal:cancelled.signal})
  setTimeout(()=>cancelled.abort(),500)
  const result=await pending
  assert.equal(result.passed,false);assert.equal(JSON.parse(result.log).reason,'cancelled')
})

test('PR完整读取超过100条历史和1MiB正文仍匹配后页目标，原生命令可明确取消', async () => {
  const directory=await mkdtemp(join(tmpdir(),'dsh-pr-paged-')),script=join(directory,'gh.cjs'),state=join(directory,'state.json'),pidPath=join(directory,'pid.json')
  await writeFile(script,`const fs=require('fs');const[file,...args]=process.argv.slice(2),s=JSON.parse(fs.readFileSync(file));
if(s.hang){fs.writeFileSync(s.pidPath,JSON.stringify(process.pid));setInterval(()=>{},1000)}
else if(args.includes('--paginate'))console.log(JSON.stringify(s.pages));
else if(args[1]==='view')console.log(JSON.stringify(s.pr));else process.exit(2);`)
  const adapter=createGithubPullRequests({repository:directory,repo:'test/repo',base:'main',head:'codex/test',ghCommand:{executable:process.execPath,args:[script,state]}})
  const prepared=adapter.prepare({runId:'paged',generation:1,requirementDigest:'b'.repeat(64),commitId:'a'.repeat(40),title:'完整分页',body:'业务结果'.repeat(300000)})
  const pr={number:151,url:'https://github.com/test/repo/pull/151',state:'OPEN',headRefOid:prepared.commitId,headRefName:'codex/test',baseRefName:'main',body:prepared.body+'\n<!-- dsh-operation:'+prepared.operationKey+' -->'}
  const rest=p=>({number:p.number,html_url:p.url,state:p.state.toLowerCase(),head:{sha:p.headRefOid,ref:p.headRefName},base:{ref:p.baseRefName},body:p.body})
  const history=Array.from({length:150},(_,index)=>rest({...pr,number:index+1,state:'CLOSED',body:'历史记录'}))
  await writeFile(state,JSON.stringify({pr,pages:[history.slice(0,100),[...history.slice(100),rest(pr)]]}))
  const actual=await adapter.reconcile(prepared);assert.equal(actual.status,'succeeded');assert.equal(actual.number,151)
  await writeFile(state,JSON.stringify({hang:true,pidPath}))
  const controller=new AbortController(),pending=adapter.reconcile(prepared,{signal:controller.signal})
  let pid
  for(let attempt=0;attempt<100;attempt++){try{pid=JSON.parse(await readFile(pidPath,'utf8'));break}catch{await new Promise(resolve=>setTimeout(resolve,20))}}
  assert.ok(pid);controller.abort()
  await assert.rejects(pending,{code:'PR_CANCELLED'})
  assert.throws(()=>process.kill(pid,0))
})
