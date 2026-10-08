import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
const exec = promisify(execFile)
const repository = resolve(import.meta.dirname, '..')
const hash = text => createHash('sha256').update(text).digest('hex')
// 仅替换外部部署helper与固定正式profile路径，完整执行真实入口，不复制其编排逻辑。
async function fixture(mode = 'success') {
  const temp = join(repository, 'docs/tmp/deploy-local-tests')
  await mkdir(temp, { recursive: true })
  const root = await mkdtemp(join(temp, 'case-'))
  await mkdir(join(root, 'scripts'), { recursive: true })
  await mkdir(join(root, 'docs/acceptance/topic-context-completeness/scripts'), { recursive: true })
  await mkdir(join(root, 'docs/tmp'), { recursive: true })
  const profile = join(root, 'profile.yml'), packagePath = join(root, 'candidate.tgz'), evidence = join(root, 'docs/tmp/deployment')
  await writeFile(profile, 'private-token: fixture-secret\n')
  await writeFile(packagePath, 'candidate-package')
  const original = await readFile(join(repository, 'scripts/deploy-local.ps1'), 'utf8')
  assert.ok(original.includes("D:/dsh_home/profiles/web/cordis.patch.yml"))
  await writeFile(join(root, 'scripts/deploy-local.ps1'), original.replace('D:/dsh_home/profiles/web/cordis.patch.yml', profile.replaceAll('\\', '/')))
  const helper = `param([switch]$Check,[switch]$Readback,[switch]$Resume,[switch]$HoldMaintenance,[string]$Package,[string]$ExpectedProfileSha256,[string]$ExpectedPackageSha256,[string]$EvidenceDirectory,[string]$RestoreConfigurationProposal,[string]$RepairStoppedLaunch)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../..'))
$mode=Get-Content -LiteralPath (Join-Path $root 'mode') -Raw
if($ExpectedPackageSha256 -ne (Get-FileHash -LiteralPath $Package).Hash.ToLowerInvariant()){throw 'PACKAGE_HASH_WRONG'}
if($ExpectedProfileSha256 -ne (Get-FileHash -LiteralPath (Join-Path $root 'profile.yml')).Hash.ToLowerInvariant()){throw 'PROFILE_HASH_WRONG'}
$stage=if($Check){'check'}elseif($Readback){'readback'}elseif($Resume){'resume'}else{'deploy'}
if(-not $Check){$(if($stage -eq 'deploy' -and $RestoreConfigurationProposal){'restore'}else{$stage})|Add-Content (Join-Path $root 'calls.log')}
if($mode -eq ('fail-'+$stage)){[Console]::Error.WriteLine('fixture-secret');exit 23}
if($stage -eq 'deploy'){
 if(-not $HoldMaintenance){throw 'MUST_HOLD_MAINTENANCE'}
 if($RestoreConfigurationProposal -and (-not (Test-Path -LiteralPath $RestoreConfigurationProposal) -or -not (Test-Path -LiteralPath $RepairStoppedLaunch))){throw 'RESTORE_SOURCE_MISSING'}
 [void](New-Item -ItemType Directory -Path $EvidenceDirectory -Force)
 @{sourceProfileSha256=$ExpectedProfileSha256;packageSha256=$ExpectedPackageSha256}|ConvertTo-Json|Set-Content (Join-Path $EvidenceDirectory 'launch.json')
}
@{ready=($mode -ne 'pending' -and -not ($Resume -and $mode -eq 'resume-not-ready'));dispatchResumed=($Resume -and $mode -ne 'not-resumed');secret='fixture-secret';writes=$(if($mode -eq 'check-wrote'){1}else{0})}|ConvertTo-Json
`
  await writeFile(join(root, 'docs/acceptance/topic-context-completeness/scripts/deploy-owner-repair.ps1'), helper)
  await writeFile(join(root, 'mode'), mode)
  const argumentsFile = join(root, 'arguments.json')
  await writeFile(argumentsFile, JSON.stringify({ Package: packagePath, EvidenceDirectory: evidence }))
  async function run(option) {
    try { return { code: 0, ...await exec('pwsh', ['-NoProfile', '-NonInteractive', '-File', join(root, 'scripts/deploy-local.ps1'), '-ArgumentsFile', argumentsFile, ...(option ? [`-${option}`] : [])], { windowsHide: true }) } }
    catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr } }
  }
  return { root, evidence, packagePath, argumentsFile, run, calls: async () => (await readFile(join(root, 'calls.log'), 'utf8').catch(() => '')).trim().split(/\r?\n/).filter(Boolean) }
}
async function snapshot(root) {
  const files = await readdir(root, { recursive: true, withFileTypes: true })
  return Object.fromEntries(await Promise.all(files.filter(x => x.isFile()).map(async x => { const path = join(x.parentPath, x.name); return [path, hash(await readFile(path))] })))
}
function summary(result) {
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-secret/)
  return JSON.parse(result.stdout.slice(result.stdout.indexOf('{')))
}
test('统一入口Check实际核SHA且目录零写', async () => {
  const f = await fixture(), before = await snapshot(f.root), result = await f.run('Check')
  assert.equal(result.code, 0); assert.equal(summary(result).writes, 0)
  assert.deepEqual(await snapshot(f.root), before)
})
test('统一入口单调用顺序完成并仅输出汇总；重复Readback/Resume不安装', async () => {
  const f = await fixture(), result = await f.run()
  assert.equal(result.code, 0); assert.equal(summary(result).dispatchResumed, true)
  assert.deepEqual(await f.calls(), ['deploy', 'readback', 'resume'])
  for (const phase of ['Readback', 'Readback', 'Resume', 'Resume']) { const next = await f.run(phase); assert.equal(next.code, 0); summary(next) }
  assert.deepEqual(await f.calls(), ['deploy', 'readback', 'resume', 'readback', 'readback', 'resume', 'resume'])
  assert.match(await readFile(f.evidence + '-runner/deploy.stdout.log', 'utf8'), /fixture-secret/)
})
for (const [mode, calls] of [['check-wrote', []], ['fail-check', []], ['fail-deploy', ['deploy']], ['fail-readback', ['deploy', 'readback']], ['pending', ['deploy', 'readback']], ['not-resumed', ['deploy', 'readback', 'resume']], ['resume-not-ready', ['deploy', 'readback', 'resume']]]) {
  test(`统一入口失败不继续或伪报恢复：${mode}`, async () => {
    const f = await fixture(mode), result = await f.run(), report = summary(result)
    assert.equal(result.code, 1); assert.equal(report.ok, false); assert.equal(report.dispatchResumed, false)
    assert.deepEqual(await f.calls(), calls)
  })
}

test('已安装失败只转发受控恢复原收据，不进入重复安装模式', async () => {
  const f = await fixture(), proposal = join(f.root, 'restore.json'), oldLaunch = join(f.root, 'old-launch.json')
  await writeFile(proposal, JSON.stringify({ source: 'this-deployment' })); await writeFile(oldLaunch, '{}')
  await writeFile(f.argumentsFile, JSON.stringify({ Package: f.packagePath, EvidenceDirectory: f.evidence, RestoreConfigurationProposal: proposal, RepairStoppedLaunch: oldLaunch }))
  const result = await f.run()
  assert.equal(result.code, 0); assert.equal(summary(result).dispatchResumed, true)
  assert.deepEqual(await f.calls(), ['restore', 'readback', 'resume'])
})
for (const [phase, mode] of [['Readback', 'pending'], ['Resume', 'not-resumed']]) test(`独立${phase}不能将未就绪当成功`, async () => {
  const f = await fixture(); assert.equal((await f.run()).code, 0)
  await writeFile(join(f.root, 'mode'), mode)
  const result = await f.run(phase)
  assert.equal(result.code, 1); assert.equal(summary(result).ok, false)
  assert.equal((await f.calls()).filter(x => x === 'deploy').length, 1)
})
