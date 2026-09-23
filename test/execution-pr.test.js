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
  assert.equal(result.passed, true); assert.equal(log.exitCode, 0); assert.match(log.stdout, /real check passed/)
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
