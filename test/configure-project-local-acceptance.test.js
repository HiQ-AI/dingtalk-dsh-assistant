import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { createHash } from 'node:crypto'
import { configureProjectLocalAcceptance, planProjectLocalAcceptance } from '../scripts/configure-project-local-acceptance.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const command = { executable: process.execPath, args: ['-e', 'process.exit(0)'] }
const configuration = root => ({ version: 'test-v1', sharedDataProfilePath: join(root, 'shared.json'), prepareSteps: [command], service: { executable: process.execPath, args: ['server.js', '--host', '127.0.0.1', '--port', '{port}'], readyPath: '/ready' }, scenarios: [{ ...command, id: 'read-only', description: '读取任务数据' }], cleanup: command, verifyCleanup: command })
test('后端专项检查精确CAS：check零写、apply保留构建和其他仓库、重复零写及漂移拒绝',async t=>{
 const f=await fixture(t)
 const checks=[{id:'dataset-package',version:'1',steps:[{executable:process.execPath,args:['-DskipTests','package']}]}]
 const source=f.source.replace('            - id: dataset\n','            - id: dataset\n'+yaml.dump({checks},{lineWidth:-1}).trimEnd().split('\n').map(line=>'              '+line).join('\n')+'\n')
 await writeFile(f.profile,source)
 const step={executable:process.execPath,args:[join(f.root,'verify-dataset-unit-tests.mjs'),'--java',join(f.root,'java.exe'),'--maven-home',join(f.root,'maven')]}
 const proposal={repository:'dataset',sourceChecksSha256:hash(JSON.stringify(checks)),checks:[{...checks[0],version:'2',steps:[step,...checks[0].steps]}]}
 const checksProposal=join(f.root,'checks.json');await writeFile(checksProposal,JSON.stringify(proposal))
 const options={...f,checksProposal,expectedSha256:hash(source)}
 assert.equal((await configureProjectLocalAcceptance({...options,mode:'check'})).writes,0)
 assert.equal(await readFile(f.profile,'utf8'),source)
 assert.equal((await configureProjectLocalAcceptance({...options,mode:'apply'})).writes,2)
 const after=await readFile(f.profile,'utf8')
 assert.equal((await configureProjectLocalAcceptance({...options,expectedSha256:hash(after),mode:'apply'})).writes,0)
 await assert.rejects(configureProjectLocalAcceptance({...options,mode:'apply'}),/PROFILE_CHANGED/)
 for(const change of [{sourceChecksSha256:'0'.repeat(64)},{repository:'dataset-web'},{checks:[{...proposal.checks[0],steps:[step,{...checks[0].steps[0],args:['other']}]}]}])
  assert.throws(()=>planProjectLocalAcceptance(source,f.supplied,yaml,{allowUpdate:true,checksProposal:{...proposal,...change}}),/CHECKS_CHANGED|CHECKS_PROPOSAL_INVALID/)
})
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'local-profile-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const profile = join(root, 'cordis.patch.yml'), bundle = join(root, 'bundle.json')
  const source = `# 保留注释\n- insert:\n    - config:\n        hook: !!js |\n          ({ code: '保持原文' })\n        workflow:\n          repositories:\n            - id: dataset-web\n              managedRoot: ${JSON.stringify(root)}\n              untouched: original\n            - id: dataset\n              managedRoot: ${JSON.stringify(root)}\n              untouched: original\n            - id: other\n              localAcceptance: {keep: true}\n`
  const supplied = { dataset: configuration(root), 'dataset-web': configuration(root) }
  await writeFile(profile, source)
  await writeFile(bundle, JSON.stringify(supplied))
  return { root, profile, bundle, source, supplied, expectedSha256: hash(source) }
}

test('配置接入check不写文件且保留js代码、注释及其他项目', async t => {
  const f = await fixture(t), files = await readdir(f.root)
  const result = await configureProjectLocalAcceptance({ ...f, mode: 'check' })
  assert.equal(result.writes, 0)
  assert.equal(result.changed, true)
  assert.equal(await readFile(f.profile, 'utf8'), f.source)
  assert.deepEqual(await readdir(f.root), files)
  const plan = planProjectLocalAcceptance(f.source, f.supplied, yaml)
  assert.match(plan.updated, /hook: !!js \|\n          \(\{ code: '保持原文' \}\)/)
  assert.match(plan.updated, /# 保留注释/)
  assert.match(plan.updated, /- id: other\n              localAcceptance: \{keep: true\}/)
  assert.equal((plan.updated.match(/localAcceptance:/g) ?? []).length, 3)
})

test('配置接入apply备份原文并读回，重复应用零写入', async t => {
  const f = await fixture(t)
  const result = await configureProjectLocalAcceptance({ ...f, mode: 'apply' })
  assert.equal(result.writes, 2)
  assert.equal(await readFile(result.backupPath, 'utf8'), f.source)
  assert.notEqual(await readFile(f.profile, 'utf8'), f.source)
  assert.equal(planProjectLocalAcceptance(await readFile(f.profile, 'utf8'), f.supplied, yaml).changed, false)
  const files = await readdir(f.root)
  const repeated = await configureProjectLocalAcceptance({ ...f, expectedSha256: hash(await readFile(f.profile, 'utf8')), mode: 'apply' })
  assert.equal(repeated.writes, 0)
  assert.deepEqual(await readdir(f.root), files)
})

test('配置更新拒绝过期哈希且不写备份', async t => {
  const f = await fixture(t)
  await configureProjectLocalAcceptance({ ...f, mode: 'apply' })
  f.supplied.dataset.version = 'different'
  await writeFile(f.bundle, JSON.stringify(f.supplied))
  const before = await readFile(f.profile, 'utf8'), files = await readdir(f.root)
  await assert.rejects(configureProjectLocalAcceptance({ ...f, mode: 'apply' }), /LOCAL_CONFIG_PROFILE_CHANGED/)
  assert.equal(await readFile(f.profile, 'utf8'), before)
  assert.deepEqual(await readdir(f.root), files)
})

test('既有配置CAS更新保留js和其他字段，锁冲突拒绝写入', async t => {
  const f=await fixture(t)
  await configureProjectLocalAcceptance({...f,mode:'apply'})
  const before=await readFile(f.profile,'utf8'),expectedSha256=hash(before)
  f.supplied.dataset.version='updated'
  await writeFile(f.bundle,JSON.stringify(f.supplied))
  await assert.rejects(configureProjectLocalAcceptance({...f,expectedSha256:undefined,mode:'apply'}),/EXPECTED_HASH_REQUIRED/)
  const check=await configureProjectLocalAcceptance({...f,expectedSha256,mode:'check'})
  assert.equal(check.changed,true);assert.equal(check.writes,0)
  await writeFile(`${f.profile}.local-acceptance.lock`,'other operation')
  await assert.rejects(configureProjectLocalAcceptance({...f,expectedSha256,mode:'apply'}),/PROFILE_LOCKED/)
  assert.equal(await readFile(f.profile,'utf8'),before)
  await rm(`${f.profile}.local-acceptance.lock`)
  const result=await configureProjectLocalAcceptance({...f,expectedSha256,mode:'apply'})
  const after=await readFile(f.profile,'utf8')
  assert.match(after,/version: updated/);assert.match(after,/hook: !!js/)
  assert.equal(await readFile(result.backupPath,'utf8'),before)
  assert.equal(hash(after),result.afterSha256)
})

test('双目标合并策略仅接受UAT3后端/UAT2前端并要求已配置业务场景',async t=>{
  const f=await fixture(t)
  const source=f.source+`- name: '@zzusp/dingtalk-dsh-assistant/platform-host'\n  config:\n    secretsDirectory: external\n    productionTagWritesEnabled: false\n`
  const targets=`          platforms:\n            release:\n              targets:\n                - id: dataset-uat3-deployment\n                  kind: uat-deployment\n                  repository: HiQ-AI/dataset\n                  branch: feature/uat3-base\n                - id: dataset-web-uat2-deployment\n                  kind: uat-deployment\n                  repository: HiQ-AI/dataset-web\n                  branch: feature/uat2-base\n`
  const profile=source.replace('          repositories:',targets+'          repositories:')
  const policy={targets:[{targetId:'dataset-uat3-deployment',requiredChecks:[],requiredScenarioIds:['read-only']},{targetId:'dataset-web-uat2-deployment',requiredChecks:[],requiredScenarioIds:['read-only']}]}
  const plan=planProjectLocalAcceptance(profile,f.supplied,yaml,{allowUpdate:true,mergePolicy:policy})
  assert.match(plan.updated,/uatMergeWritesEnabled: true/)
  assert.match(plan.updated,/requiredScenarioIds:/)
  assert.match(plan.updated,/productionTagWritesEnabled: false/)
  assert.equal(planProjectLocalAcceptance(plan.updated,f.supplied,yaml,{allowUpdate:true,mergePolicy:policy}).changed,false)
  policy.targets[0].requiredScenarioIds=['not-implemented']
  assert.throws(()=>planProjectLocalAcceptance(profile,f.supplied,yaml,{allowUpdate:true,mergePolicy:policy}),/MERGE_POLICY_INVALID/)
  policy.targets[0].requiredScenarioIds=['read-only'];policy.targets[0].targetId='dataset-uat2-deployment'
  assert.throws(()=>planProjectLocalAcceptance(profile,f.supplied,yaml,{allowUpdate:true,mergePolicy:policy}),/MERGE_POLICY_INVALID/)
})

test('配置接入拒绝未知项目、缺项目、无效runner配置及歧义repository', async t => {
  const f = await fixture(t)
  for (const supplied of [{ dataset: f.supplied.dataset }, { ...f.supplied, other: {} }]) assert.throws(() => planProjectLocalAcceptance(f.source, supplied, yaml), /LOCAL_CONFIG_BUNDLE_INVALID/)
  assert.throws(() => planProjectLocalAcceptance(f.source, { ...f.supplied, dataset: {} }, yaml), /LOCAL_CONFIG_INVALID_dataset/)
  assert.throws(() => planProjectLocalAcceptance(f.source.replace('- id: other', '- id: dataset'), f.supplied, yaml), /LOCAL_CONFIG_REPOSITORIES_AMBIGUOUS/)
  assert.throws(() => planProjectLocalAcceptance(f.source.replace('- id: dataset\n', '- id: missing\n'), f.supplied, yaml), /LOCAL_CONFIG_REPOSITORIES_AMBIGUOUS/)
})

test('配置接入保留CRLF并拒绝不支持的行内映射', async t => {
  const f = await fixture(t), crlf = f.source.replaceAll('\n', '\r\n')
  const plan = planProjectLocalAcceptance(crlf, f.supplied, yaml)
  assert.equal(plan.updated.replaceAll('\r\n', '').includes('\n'), false)
  assert.throws(() => planProjectLocalAcceptance(`repositories:\n  - {id: dataset, managedRoot: ${JSON.stringify(f.root)}}\n  - {id: dataset-web, managedRoot: ${JSON.stringify(f.root)}}\n`, f.supplied, yaml), /LOCAL_CONFIG_REPOSITORY_LAYOUT_UNSUPPORTED/)
})

test('配置接入CLI错误不回显敏感配置原文', async t => {
  const f = await fixture(t)
  await writeFile(f.bundle, '{"password":"DO_NOT_PRINT_SECRET"')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { fileURLToPath } = await import('node:url')
  await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/configure-project-local-acceptance.mjs', import.meta.url)), '--profile', f.profile, '--bundle', f.bundle, '--check']), error => {
    assert.match(error.stderr, /LOCAL_CONFIG_BUNDLE_JSON_INVALID/)
    assert.doesNotMatch(error.stdout + error.stderr, /DO_NOT_PRINT_SECRET/)
    return error.code === 1
  })
  assert.equal(await readFile(f.profile, 'utf8'), f.source)
})
