import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve, sep } from 'node:path'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const source = resolve('scripts/restart-web.ps1').replaceAll("'", "''")
function scenario(mode, check = false) {
 const setup = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$script:mode='${mode}';$script:starts=0;$script:signals=0;$script:disabled=0;$script:stopped=$false
function Test-Path {param($LiteralPath,$PathType) $true}
function Get-ScheduledTask { @{Actions=@(@{Arguments='D:\dsh_home\launchers\start-web.ps1'});Settings=@{Enabled=$true;RestartCount=0}} }
function Get-CimInstance {
 param($ClassName,$Filter)
 if($Filter -like '*ParentProcessId*'){return}
 if($script:starts -or ($script:mode -in @('running','signal-error','busy','lease') -and -not $script:stopped)){@{ProcessId=$(if($script:starts){222}else{111});CommandLine='node D:\dsh_home\profiles\web\node_modules\@deepseek-ai\dsh\lib\bin.js web --no-open';CreationDate='2026-10-19'}}
}
function Get-NetTCPConnection {
 param($State,$LocalPort,$ErrorAction)
 if($script:mode -eq 'foreign'){@{OwningProcess=333}}
 elseif($script:starts -or ($script:mode -in @('running','signal-error','busy','lease') -and -not $script:stopped)){@{OwningProcess=$(if($script:starts){222}else{111})}}
}
function Start-ScheduledTask {$script:starts++}
function Disable-ScheduledTask {$script:disabled++}
function Enable-ScheduledTask {}
function Get-Process {param($Id,$ErrorAction) return}
function Invoke-RestMethod { @{status=$(if($script:mode -eq 'degraded'){'degraded'}else{'ok'});recoveryIssueCount=$(if($script:mode -eq 'degraded'){1}else{0});inboundConfigured=$true;inboundProcessing=$true} }
function Invoke-WebRequest { @{StatusCode=401} }
$body=(Get-Content -LiteralPath '${source}' -Raw).Replace('$PSScriptRoot', '$root')
$ast=[Management.Automation.Language.Parser]::ParseInput($body,[ref]$null,[ref]$null)
$fn=$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Run'},$false)[0]
$mock={
function Run($Executable,$Arguments) {
 if($Arguments -contains '-ExpectedPid'){$script:signals++;if($Arguments -notcontains '-Check'){if($script:mode -eq 'signal-error'){throw 'SIGNAL_FAILED'};$script:stopped=$true};return @{signals=0}}
 if($script:mode -eq 'busy'){throw 'DEPLOY_NOT_DRAINED'}
 if($script:mode -eq 'owner') {return @{ownerProcessExited=$false}}
 return @{ownerProcessExited=$true;quiescent=$true;drained=($script:mode -ne 'lease')}
}
}.ToString()
$body=$body.Remove($fn.Extent.StartOffset,$fn.Extent.EndOffset-$fn.Extent.StartOffset).Insert($fn.Extent.StartOffset,$mock)
$root=Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
try {
 try {$null=& ([scriptblock]::Create($body)) -ProjectRoot $root ${check ? '-Check' : ''};$failure=$null}
 catch {$failure=$_.Exception.Message}
 @{starts=$script:starts;signals=$script:signals;disabled=$script:disabled;failure=$failure}|ConvertTo-Json -Compress
} finally {if([IO.Directory]::Exists($root)){[IO.Directory]::Delete($root,$true)}}
`
 const result = spawnSync('pwsh', ['-NoProfile', '-Command', setup], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
 assert.equal(result.status, 0, result.stderr || result.stdout)
 return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1))
}
for (const mode of ['busy', 'owner', 'foreign', 'lease']) {
 test(`启动预检拒绝 ${mode}，不发信号、不启停`, { skip: process.platform !== 'win32' }, () => {
  const value = scenario(mode)
  assert.match(value.failure, { busy: /DEPLOY_NOT_DRAINED/, owner: /存活 owner/, foreign: /端口被其他进程占用/, lease: /尚未启动的领取/ }[mode])
  assert.equal(value.starts, 0); assert.equal(value.disabled, 0); assert.equal(value.signals, 0)
 })
}
test('停止态 Check 零启停；普通启动一次并核验健康', { skip: process.platform !== 'win32' }, () => {
 assert.deepEqual(scenario('stopped', true), { starts: 0, signals: 0, disabled: 0, failure: null })
 assert.deepEqual(scenario('stopped'), { starts: 1, signals: 0, disabled: 0, failure: null })
})
test('运行态 Check 仅请求控制台预检，不执行停机', { skip: process.platform !== 'win32' }, () => {
 assert.deepEqual(scenario('running', true), { starts: 0, signals: 1, disabled: 0, failure: null })
})
test('运行态经原生信号退出再启动；信号失败保持停机保护', { skip: process.platform !== 'win32' }, () => {
 assert.deepEqual(scenario('running'), { starts: 1, signals: 2, disabled: 1, failure: null })
 const failed = scenario('signal-error')
 assert.equal(failed.failure, 'SIGNAL_FAILED'); assert.equal(failed.starts, 0); assert.equal(failed.disabled, 1)
})
test('业务健康降级明确返回启动结果，不重启或重发', { skip: process.platform !== 'win32' }, () => {
 assert.deepEqual(scenario('degraded'), { starts: 1, signals: 0, disabled: 0, failure: null })
})
test('同步启动加载保持ESM、CJS、动态导入及worker导出；不留诊断或改写源码', async t => {
  await mkdir(resolve('docs/tmp'), { recursive: true })
  const directory = await mkdtemp(resolve('docs/tmp/web-loader-'))
  assert.equal(directory.startsWith(resolve('docs/tmp') + sep), true)
  t.after(() => rm(directory, { recursive: true, force: true }))
  const esm = pathToFileURL(resolve(directory, 'esm.mjs')).href
  const cjs = pathToFileURL(resolve(directory, 'cjs.cjs')).href
  await writeFile(resolve(directory, 'esm.mjs'), 'export const value=7; export default value;')
  await writeFile(resolve(directory, 'cjs.cjs'), 'exports.value=11;')
  const program = resolve(directory, 'run.mjs')
  await writeFile(program, `
import { Worker } from 'node:worker_threads';
const esm=await import(${JSON.stringify(esm)}), cjs=await import(${JSON.stringify(cjs)});
const dynamic=await import(${JSON.stringify(esm)});
const worker=new Worker("const {parentPort,workerData}=require('node:worker_threads');import(workerData).then(m=>parentPort.postMessage(m.value))",{eval:true,workerData:${JSON.stringify(esm)}});
const value=await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)});
console.log(JSON.stringify({esm:esm.value,cjs:cjs.value,same:esm===dynamic,worker:value}));
`)
  const normal = spawnSync(process.execPath, [program], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
  const hooked = spawnSync(process.execPath, ['--require', resolve('scripts/web-module-loader.cjs'), program], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
  assert.equal(normal.status, 0, normal.stderr)
  assert.equal(hooked.status, 0, hooked.stderr)
  assert.deepEqual(JSON.parse(hooked.stdout), JSON.parse(normal.stdout))
  assert.deepEqual(JSON.parse(hooked.stdout), { esm: 7, cjs: 11, same: true, worker: 7 })
})

test('冷启动只读核验身份与旧owner；保留未结束回合交Host恢复', async t => {
 const { DatabaseSync } = await import('node:sqlite')
 const { inspectStartup } = await import('../docs/acceptance/task-session-runtime-repair/scripts/inspect-quiescent-ledger.mjs')
 const { readFile } = await import('node:fs/promises')
 await mkdir(resolve('docs/tmp'), { recursive: true })
 const directory = await mkdtemp(resolve('docs/tmp/startup-ledger-'))
 const path = resolve(directory, 'control.sqlite'), db = new DatabaseSync(path)
 t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })
 db.exec("CREATE TABLE dynamic_meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO dynamic_meta VALUES('instanceId','test'),('initToken','token')")
 for (const table of ['tasks','executions','groups','operations','notifications']) db.exec(`CREATE TABLE dynamic_${table}(body TEXT)`)
 db.prepare('INSERT INTO dynamic_tasks VALUES(?)').run(JSON.stringify({ drained: false }))
 db.prepare('INSERT INTO dynamic_operations VALUES(?)').run(JSON.stringify({ state: 'starting' }))
 const marker = { version: 1, phase: 'initialized', instanceId: 'test', initToken: 'token' }
 await writeFile(path + '.initialized', JSON.stringify(marker))
 const before = await readFile(path)
 assert.deepEqual(inspectStartup(path), { ownerProcessExited: true, recoveryHandledByHost: true, pendingSessions: 1, startingOperations: 1, unknownNotifications: 0 })
 assert.deepEqual(await readFile(path), before)
 db.prepare("INSERT INTO dynamic_meta VALUES('owner',?)").run(process.pid + ':test')
 assert.throws(() => inspectStartup(path), /START_OWNER_STILL_ALIVE/)
 db.exec("DELETE FROM dynamic_meta WHERE key='owner'")
 await writeFile(path + '.initialized', JSON.stringify({ ...marker, initToken: 'different' }))
 assert.throws(() => inspectStartup(path), /START_INITIALIZATION_IDENTITY/)
})
