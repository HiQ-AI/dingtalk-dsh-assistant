import test from 'node:test'
import { assert, mkdtemp, mkdir, writeFile, readFile, rm, lstat, tmpdir, join, dirname, basename, resolve, execFile, promisify, createHash, freezeCandidate, createLocalAcceptanceRunner, acceptanceProcessTree, acceptanceProcessesAlive, exec, windows, fixtureScript, setup } from './fixtures/execution-local-acceptance-mixed.js'

test('进程归属拒绝历史父PID关联，当前子孙仍属于原启动身份', () => {
  const rows = [{pid:2,parent:1,born:10},{pid:3,parent:2,born:11},{pid:4,parent:1,born:110},{pid:5,parent:4,born:130}]
  assert.deepEqual(acceptanceProcessTree(rows,1,100,120),[{pid:4,born:110},{pid:5,born:130}])
  assert.equal(acceptanceProcessesAlive([{pid:4,born:110}],rows),true)
  assert.equal(acceptanceProcessesAlive([{pid:4,born:110}],[{pid:4,born:150}]),false)
})

test('关闭后复用的根PID及新子进程不具有终止授权，原后代存活仍阻断', () => {
  const rows=[{pid:1,parent:9,born:130},{pid:2,parent:1,born:140},{pid:3,parent:1,born:110}]
  const owned=acceptanceProcessTree(rows,1,100,120)
  assert.deepEqual(owned,[{pid:3,born:110}])
  assert.equal(owned.some(identity=>identity.pid===1),false)
  assert.equal(acceptanceProcessesAlive(owned,rows),true)
  assert.equal(acceptanceProcessesAlive(owned,[{pid:3,born:150}]),false)
  assert.throws(()=>acceptanceProcessTree([{pid:1,parent:0,born:null}],1,100),/PROCESS_INSPECTION_FAILED/)
  assert.throws(()=>acceptanceProcessTree([{pid:3,parent:1,born:null}],1,100),/PROCESS_INSPECTION_FAILED/)
  assert.throws(()=>acceptanceProcessesAlive([{pid:3,born:110}],[{pid:3,born:null}]),/PROCESS_INSPECTION_FAILED/)
})

test('大型进程快照保留归属判定且不混入无关进程', () => {
  const rows=Array.from({length:5000},(_,index)=>({pid:index+100,parent:90,born:110}))
  rows.push({pid:2,parent:1,born:111})
  assert.ok(Buffer.byteLength(JSON.stringify(rows))>16384)
  assert.ok(Buffer.byteLength(JSON.stringify(rows))<1024*1024)
  assert.deepEqual(acceptanceProcessTree(rows,1,100,120),[{pid:2,born:111}])
})

test('Host生成目录拒绝根目录、穿越、绝对路径和重复值',()=>{
 for(const generatedOutputDirectories of [[''],['.'],['..'],['src/../target'],['/target'],['C:/target'],['target/'],['target','TARGET']])
  assert.throws(()=>createLocalAcceptanceRunner({root:resolve('.'),config:{generatedOutputDirectories}}),/CONFIG_INVALID/)
})

test('本地验收真实进程全链通过，恢复只读收据且不重复业务写入', windows, async t => {
  const fixture = await setup(t, { largeOutput: true })
  const result = await fixture.runner.execute(fixture.prepared)
  assert.equal(result.passed, true, JSON.stringify(result))
  assert.deepEqual(result.cleanup, { dataCleaned: true, processStopped: true })
  assert.equal(result.checks[0].actual, 'actual-value')
  assert.deepEqual(result.phases.map(phase => phase.id), ['prepare', 'start', 'cases', 'cleanup', 'stop', 'verify-cleanup'])
  assert.ok(result.phases.every(phase => phase.status === 'succeeded' && phase.elapsedMs >= 0))
  const events = await fixture.events()
  assert.deepEqual(events.map(event => event.role), ['prepare', 'service', 'scenario', 'cleanup', 'verify'])
  const pid = events.find(event => event.role === 'service').pid
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  const recovered = createLocalAcceptanceRunner(fixture.options)
  assert.deepEqual(await recovered.readReceipt(fixture.prepared), result)
  assert.deepEqual(await recovered.execute(fixture.prepared), result)
  assert.deepEqual(await fixture.events(), events)
  assert.equal(await recovered.assertPassed(fixture.prepared, { ...result, status: 'succeeded' }), true)
  await assert.rejects(recovered.assertPassed(fixture.prepared, { ...result, candidateDigest: 'b'.repeat(64) }), { code: 'LOCAL_ACCEPTANCE_RECEIPT_INVALID' })
  assert.ok(!JSON.stringify(result).includes('fixture-private-secret'))
})

for (const parameter of ['mutatePrepare','mutateScenario','extraSource']) test(`原始候选文件在${parameter}阶段漂移不能签发通过票据`, windows, async t => {
  const fixture=await setup(t,{[parameter]:true})
  const result=await fixture.runner.execute(fixture.prepared)
  assert.equal(result.passed,false)
  assert.equal(result.failureCode,'LOCAL_ACCEPTANCE_CANDIDATE_MISMATCH',JSON.stringify(result))
  if(parameter!=='mutateScenario')assert.equal((await fixture.events()).some(event=>event.role==='service'),false)
})

test('新增生成物不混入原始manifest，签票后改原文件也拒绝交付', windows, async t => {
  const fixture=await setup(t,{generated:true})
  const result=await fixture.runner.execute(fixture.prepared)
  assert.equal(result.passed,true)
  await writeFile(join(fixture.prepared.directory,'fixture.mjs'),'changed')
  await assert.rejects(fixture.runner.assertPassed(fixture.prepared,result),/CANDIDATE_MISMATCH/)
})

test('实际结果不符阻断提交，仍完成清理和停止', windows, async t => {
  const fixture = await setup(t, { mismatch: true })
  const result = await fixture.runner.execute(fixture.prepared)
  assert.equal(result.passed, false)
  assert.equal(result.failureCode, 'LOCAL_ACCEPTANCE_EXPECTATION_MISMATCH')
  assert.deepEqual(result.cleanup, { dataCleaned: true, processStopped: true })
  assert.equal(result.checks[0].passed, false)
  await assert.rejects(fixture.runner.assertPassed(fixture.prepared, result), { code: 'LOCAL_ACCEPTANCE_FAILED' })
})

test('清理失败持久化失败收据，不因执行用例成功而放行或重跑', windows, async t => {
  const fixture = await setup(t, { cleanupFailure: true })
  const result = await fixture.runner.execute(fixture.prepared)
  assert.equal(result.passed, false)
  assert.equal(result.failureCode, 'LOCAL_ACCEPTANCE_CLEANUP_UNCONFIRMED')
  assert.deepEqual(result.cleanup, { dataCleaned: false, processStopped: true })
  assert.equal(result.checks[0].passed, true)
  assert.equal((await fixture.events()).some(event => event.role === 'verify'), false)
  const events = await fixture.events()
  assert.deepEqual(await fixture.runner.execute(fixture.prepared), result)
  assert.deepEqual(await fixture.events(), events)
  await assert.rejects(fixture.runner.assertPassed(fixture.prepared, result), { code: 'LOCAL_ACCEPTANCE_CLEANUP_UNCONFIRMED' })
})

test('已有执行预约但无收据时只读恢复，候选变化也不能掩盖未知执行', windows, async t => {
  const fixture = await setup(t)
  const absent = { ...fixture.prepared, identity: 'c'.repeat(64) }, absentDirectory = join(fixture.options.root, absent.identity)
  await assert.rejects(fixture.runner.readReceipt(absent), { code: 'ENOENT' })
  await assert.rejects(lstat(absentDirectory), { code: 'ENOENT' })
  await writeFile(join(fixture.options.root, fixture.prepared.identity, 'execution-reserved.json'), '{}')
  await writeFile(join(fixture.prepared.directory, 'generated.txt'), 'interrupted prepare output')
  assert.equal(await fixture.runner.readReceipt(fixture.prepared), null)
  await assert.rejects(fixture.runner.execute(fixture.prepared), { code: 'LOCAL_ACCEPTANCE_EXECUTION_UNKNOWN', executionDrained: false })
  assert.deepEqual(await fixture.events(), [])
})

test('清理命令成功但独立回读仍有数据时不能通过', windows, async t => {
  const fixture = await setup(t, { dirty: true })
  const result = await fixture.runner.execute(fixture.prepared)
  assert.equal(result.passed, false)
  assert.equal(result.failureCode, 'LOCAL_ACCEPTANCE_CLEANUP_UNCONFIRMED')
  assert.deepEqual(result.cleanup, { dataCleaned: false, processStopped: true })
  assert.equal(result.phases.find(phase => phase.id === 'cleanup').status, 'succeeded')
  assert.equal(result.phases.find(phase => phase.id === 'verify-cleanup').status, 'failed')
  await assert.rejects(fixture.runner.assertPassed(fixture.prepared, result), { code: 'LOCAL_ACCEPTANCE_CLEANUP_UNCONFIRMED' })
})

test('取消用例后服务保留至清理完成，进程和数据都能回收', windows, async t => {
  const fixture = await setup(t, { hang: true }), controller = new AbortController()
  let settled = false
  const execution = fixture.runner.execute(fixture.prepared, { signal: controller.signal }).finally(() => { settled = true })
  const timer = setTimeout(() => controller.abort(), 45000)
  try {
    while (!settled && !(await fixture.events()).some(event => event.role === 'scenario')) await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(settled, false, '服务或准备阶段提前结束，未进入可取消的业务用例')
    controller.abort()
    const result = await execution
    assert.equal(result.passed, false)
    assert.equal(result.failureCode, 'LOCAL_ACCEPTANCE_CANCELLED')
    assert.deepEqual(result.cleanup, { dataCleaned: true, processStopped: true })
    assert.deepEqual((await fixture.events()).map(event => event.role), ['prepare', 'service', 'scenario', 'cleanup', 'verify'])
  } finally { clearTimeout(timer) }
})

test('受信伴随服务按哈希绑定且和主服务共同停止后才核对清理', windows, async t => {
  const fixture = await setup(t, { readonly: true }, true), result = await fixture.runner.execute(fixture.prepared)
  assert.equal(result.passed, true, JSON.stringify(result))
  assert.equal(result.services.dataset.artifactSha256, fixture.options.config.companionServices[0].artifactSha256)
  assert.notEqual(result.services.dataset.baseUrl, result.baseUrl)
  assert.deepEqual(result.phases.map(phase => phase.id), ['prepare', 'start-dataset', 'start', 'cases', 'cleanup', 'stop', 'stop-dataset', 'verify-cleanup'])
  const services = (await fixture.events()).filter(event => event.role === 'service')
  assert.equal(services.length, 2)
  for (const service of services) assert.throws(() => process.kill(service.pid, 0), { code: 'ESRCH' })
  assert.deepEqual(result.cleanup, { dataCleaned: true, processStopped: true, mode: 'read-only', createdResources: 0 })
})

test('伴随服务产物在准备后被替换时拒绝启动，也不执行准备命令', windows, async t => {
  const fixture = await setup(t, {}, true)
  await writeFile(fixture.options.config.companionServices[0].artifactPath, 'tampered artifact')
  await assert.rejects(fixture.runner.execute(fixture.prepared), { code: 'LOCAL_ACCEPTANCE_COMPANION_ARTIFACT_MISMATCH' })
  assert.deepEqual(await fixture.events(), [])
})

test('真实延迟就绪先进行轻量HTTP轮询，就绪后才核对端口归属并执行业务', windows, async t => {
  const fixture = await setup(t, { readyDelayMs: 3000 }), result = await fixture.runner.execute(fixture.prepared)
  assert.equal(result.passed, true, JSON.stringify(result))
  const events = await fixture.events(), probes = events.filter(event => event.role === 'ready-probe')
  assert.ok(probes.filter(event => event.waiting).length >= 4, JSON.stringify(probes))
  assert.ok(events.findIndex(event => event.role === 'scenario') > events.findIndex(event => event.role === 'ready-probe' && !event.waiting))
})

test('HTTP健康但监听属于子进程时拒绝就绪，不执行业务且回收整个服务树', windows, async t => {
  const fixture = await setup(t, { wrongPid: true }), result = await fixture.runner.execute(fixture.prepared)
  assert.equal(result.passed, false)
  assert.equal(result.failureCode, 'LOCAL_ACCEPTANCE_SERVICE_IDENTITY_CHANGED')
  assert.equal(result.checks.length, 0)
  const events = await fixture.events()
  assert.ok(!events.some(event => event.role === 'scenario'))
  assert.deepEqual(result.cleanup, { dataCleaned: true, processStopped: true })
  for (const service of events.filter(event => event.role.startsWith('service'))) assert.throws(() => process.kill(service.pid, 0), { code: 'ESRCH' })
})

test('进程检查启动失败保留安全分类和阶段证据，不包含stderr或命令内容', windows, async t => {
  const fixture = await setup(t), previousPath = process.env.PATH
  try {
    process.env.PATH = ''
    const result = await fixture.runner.execute(fixture.prepared)
    assert.equal(result.passed, false)
    assert.equal(result.executionDrained, false)
    assert.equal(result.inspectionFailure.kind, 'spawn')
    assert.deepEqual(Object.keys(result.inspectionFailure).sort(), ['elapsedMs', 'exitCode', 'kind', 'signal'])
    assert.ok(result.phases.some(phase => phase.inspectionFailure?.kind === 'spawn'))
    assert.equal(result.inspectionFailure.exitCode, null)
    assert.ok(result.inspectionFailure.elapsedMs >= 0)
    assert.ok(!JSON.stringify(result).includes('fixture-private-secret'))
    assert.ok(!(await fixture.events()).some(event => event.role.startsWith('service')))
  } finally { process.env.PATH = previousPath }
})

test('任务目录验收直接服务PID通过，所有阶段使用任务临时目录和旁路证据根', windows, async t => {
 const fixture = await setup(t, { largeOutput: true }, true, true)
 const result = await fixture.runner.execute(fixture.prepared)
 assert.equal(result.passed, true, JSON.stringify(result))
 const events = await fixture.events()
 for (const event of events) {
  assert.equal(dirname(event.temp), fixture.options.tempRoot)
  assert.equal(event.tmp, event.temp); assert.equal(event.tmpdir, event.temp)
  assert.equal(event.evidenceRoot, join(dirname(fixture.prepared.directory), 'evidence'))
 }
 const { createTaskLocalAcceptanceRunner } = await import('../packages/dingtalk-dsh-assistant/execution-task-local-acceptance.js')
 assert.deepEqual(await createTaskLocalAcceptanceRunner(fixture.options).readReceipt(fixture.prepared), result)
})

for (const taskFiles of [false, true]) test('验收配置和方案不以数量或信封容量限制任务：'+(taskFiles?'任务目录':'候选目录'), windows, async t => {
  const fixture=await setup(t, {}, true, taskFiles)
  const config=structuredClone(fixture.options.config)
  config.prepareSteps=Array.from({length:9},()=>structuredClone(config.prepareSteps[0]))
  config.scenarios=Array.from({length:40},(_,index)=>({...config.scenarios[0],id:'scenario-'+index}))
  config.companionServices=Array.from({length:5},(_,index)=>({...config.companionServices[0],id:'service-'+index}))
  const options={...fixture.options,root:join(fixture.directory,'large-runs'),config}
  const runner=taskFiles?(await import('../packages/dingtalk-dsh-assistant/execution-task-local-acceptance.js')).createTaskLocalAcceptanceRunner(options):createLocalAcceptanceRunner(options)
  const plan={cases:config.scenarios.map((scenario,index)=>({criterionId:'criterion-'+index,scenarioId:scenario.id,expected:'actual-value',steps:Array.from({length:40},(_,step)=>'操作'+step),parameters:{description:'必要业务背景'.repeat(1000)}}))}
  assert.ok(Buffer.byteLength(JSON.stringify(plan))>65536)
  const prepared=await runner.prepare({...fixture.request,plan})
  assert.equal(prepared.plan.cases.length,40)
  assert.equal(prepared.plan.cases[0].steps.length,40)
})

for (const taskFiles of [false, true]) test('干净失败的新attempt绑定当前runner并保留原快照和回执：'+taskFiles, windows, async t => {
 const fixture=await setup(t,{readonly:true,mismatch:true},false,taskFiles)
 const failed=await fixture.runner.execute(fixture.prepared)
 assert.equal(failed.passed,false);assert.equal(failed.cleanup.createdResources,0)
 const oldReceipt=await readFile(join(dirname(fixture.prepared.directory),'receipt.json'),'utf8')
 const options={...fixture.options,config:{...fixture.options.config,version:'fixture-2'}}
 const runner=taskFiles?(await import('../packages/dingtalk-dsh-assistant/execution-task-local-acceptance.js')).createTaskLocalAcceptanceRunner(options):createLocalAcceptanceRunner(options)
 await assert.rejects(runner.execute(fixture.prepared),{code:'LOCAL_ACCEPTANCE_PREPARED_MISMATCH'})
 const retry=await runner.retryPrepared({...fixture.prepared,action:'external'},{attemptKey:'fixed-runner'})
 assert.equal(retry.runnerIdentity,runner.identity);assert.equal(retry.directory,fixture.prepared.directory)
 assert.notEqual(retry.identity,fixture.prepared.identity);assert.equal(retry.candidateDigest,fixture.prepared.candidateDigest)
 assert.deepEqual(await runner.retryPrepared(fixture.prepared,{attemptKey:'fixed-runner'}),retry)
 const result=await runner.execute(retry);assert.equal(result.identity,retry.identity);assert.equal(result.failureCode,'LOCAL_ACCEPTANCE_EXPECTATION_MISMATCH')
 assert.equal(await readFile(join(dirname(fixture.prepared.directory),'receipt.json'),'utf8'),oldReceipt)
 await assert.rejects(runner.retryPrepared({...fixture.prepared,candidateDigest:'b'.repeat(64)},{attemptKey:'bad'}),{code:'LOCAL_ACCEPTANCE_PREPARED_MISMATCH'})
})
