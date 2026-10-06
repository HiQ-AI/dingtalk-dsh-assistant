import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve, sep } from 'node:path'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const source = resolve('scripts/restart-web.ps1').replaceAll("'", "''")
function powershell(body) {
  const setup = String.raw`
$ErrorActionPreference='Stop'
$ast=[Management.Automation.Language.Parser]::ParseFile('${source}',[ref]$null,[ref]$null)
foreach($fn in $ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)) {
  Invoke-Expression $fn.Extent.Text
}
$readyState='已就绪；认证访问和业务验收未验证'
$script:clock=[datetime]'2026-10-06T00:00:00Z'
$script:iterations=0
$script:fullChecks=0
function Get-Date { $script:clock }
function Start-Sleep { param($Milliseconds,$Seconds) $script:iterations++; $script:clock=$script:clock.AddSeconds(1) }
function Invoke-RestMethod { @{status='ok';recoveryIssueCount=0} }
function Invoke-WebRequest { @{StatusCode=401} }
function Get-WebState {
  $script:fullChecks++
  [pscustomobject]@{State=$readyState;ProcessId=222;ProcessCount=1;WebPortOwners='222';RuntimePortOwners='222'}
}
`
  const result = spawnSync('pwsh', ['-NoProfile', '-Command', setup + body], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout.trim())
}

test('无监听时不运行完整检查；真正就绪才核对新PID与双端口', { skip: process.platform !== 'win32' }, () => {
  const value = powershell(String.raw`
function Get-WebListeners { if($script:iterations -ge 4){3080;18998} }
$state=Wait-WebReady 111
@{checks=$script:fullChecks;polls=$script:iterations;pid=$state.ProcessId}|ConvertTo-Json -Compress
`)
  assert.deepEqual(value, { checks: 1, polls: 4, pid: 222 })
})

test('HTTP未就绪保持便宜轮询，成功时再次独立核验Owner', { skip: process.platform !== 'win32' }, () => {
  const value = powershell(String.raw`
function Get-WebListeners {3080;18998}
function Get-WebState {
 $script:fullChecks++
 @{State=$(if($script:iterations -lt 3){'异常或未就绪'}else{$readyState});ProcessId=222;ProcessCount=1;WebPortOwners='222';RuntimePortOwners='222'}
}
function Invoke-RestMethod { @{status=$(if($script:iterations -lt 3){'recovering'}else{'ok'});recoveryIssueCount=0} }
$state=Wait-WebReady 111
@{checks=$script:fullChecks;polls=$script:iterations;pid=$state.ProcessId}|ConvertTo-Json -Compress
`)
  assert.deepEqual(value, { checks: 2, polls: 3, pid: 222 })
})

test('端口属于其他进程或重复实例时拒绝；不借健康接口放宽归属', { skip: process.platform !== 'win32' }, () => {
  const value = powershell(String.raw`
function Get-WebListeners {3080;18998}
function Get-WebState { @{State='异常或未就绪';ProcessId=222;ProcessCount=1;WebPortOwners='333';RuntimePortOwners='222'} }
try {Wait-WebReady 111;throw 'unexpected success'} catch {if($_.Exception.Message -notlike '*其他进程占用端口*'){throw}}
function Get-WebState { @{State='异常或未就绪';ProcessId=222;ProcessCount=2;WebPortOwners='222';RuntimePortOwners='222'} }
try {Wait-WebReady 111;throw 'unexpected success'} catch {if($_.Exception.Message -notlike '*重复实例*'){throw}}
@{rejected=2}|ConvertTo-Json -Compress
`)
  assert.deepEqual(value, { rejected: 2 })
})

test('240秒超时保留失败且不重复启动', { skip: process.platform !== 'win32' }, () => {
  const value = powershell(String.raw`
function Start-Sleep { $script:iterations++;$script:clock=$script:clock.AddSeconds(300) }
function Get-WebListeners { }
function Start-ScheduledTask {throw 'must not launch again'}
try {Wait-WebReady 111;throw 'unexpected success'} catch {if($_.Exception.Message -notlike '*240 秒内未就绪*'){throw}}
@{checks=$script:fullChecks;polls=$script:iterations}|ConvertTo-Json -Compress
`)
  assert.deepEqual(value, { checks: 0, polls: 1 })
})

test('旧PID即使HTTP正常也不能冒充新实例', { skip: process.platform !== 'win32' }, () => {
  const value = powershell(String.raw`
function Get-WebListeners {3080;18998}
try {Wait-WebReady 222;throw 'unexpected success'} catch {if($_.Exception.Message -notlike '*新进程身份不一致*'){throw}}
@{rejected=$true}|ConvertTo-Json -Compress
`)
  assert.deepEqual(value, { rejected: true })
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
