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
test('必要仓库依赖及Task场景精确更新保留无关字段，越界拒绝',async t=>{
 const f=await fixture(t),source=planProjectLocalAcceptance(f.source,f.supplied,yaml).updated
 const scope={taskId:'task-abc123',uatEnvironment:'uat3',requestDigest:'a'.repeat(64)}
 const patches=[{id:'sample-ui',dependencyRepositories:['sampleApi'],taskLocalAcceptance:[{scope,localAcceptance:f.supplied['sample-ui'],checks:[{id:'merge-check',version:'1',executable:process.execPath,args:['scripts/test-merge.js']}]}]},{id:'sampleApi',dependencyRepositories:['sample-ui']}]
 const plan=planProjectLocalAcceptance(source,f.supplied,yaml,{allowUpdate:true,repositoryPatches:patches})
 assert.match(plan.updated,/dependencyRepositories:/);assert.match(plan.updated,/task-abc123/);assert.match(plan.updated,/# 保留注释/)
 assert.equal(planProjectLocalAcceptance(plan.updated,f.supplied,yaml,{allowUpdate:true,repositoryPatches:patches}).changed,false)
 assert.match(plan.updated,/merge-check/);const invalidChecks=structuredClone(patches);invalidChecks[0].taskLocalAcceptance[0].checks=[];assert.throws(()=>planProjectLocalAcceptance(source,f.supplied,yaml,{allowUpdate:true,repositoryPatches:invalidChecks}),/LOCAL_CONFIG_REPOSITORY_PATCH_INVALID/)
 for(const invalid of [[{id:'sample-ui',dependencyRepositories:['other']}],[{id:'sample-ui',managedRoot:'D:/other'}],[{id:'other',dependencyRepositories:['sampleApi']}],[{id:'sampleApi',dependencyRepositories:['sampleApi']}],[{id:'sampleApi',taskLocalAcceptance:[{scope:{...scope,requestDigest:'wrong'},localAcceptance:f.supplied.sampleApi}]}]])
  assert.throws(()=>planProjectLocalAcceptance(source,f.supplied,yaml,{allowUpdate:true,repositoryPatches:invalid}),/LOCAL_CONFIG_REPOSITORY_PATCH_INVALID/)
})

test('退役专项检查修改入口关闭且check/apply均不写文件',async t=>{
 const f=await fixture(t)
 const checks=[{id:'sampleApi-package',version:'1',steps:[{executable:process.execPath,args:['-DskipTests','package']}]}]
 const source=f.source.replace('            - id: sampleApi\n','            - id: sampleApi\n'+yaml.dump({checks},{lineWidth:-1}).trimEnd().split('\n').map(line=>'              '+line).join('\n')+'\n')
 await writeFile(f.profile,source)
 const step={executable:process.execPath,args:[join(f.root,'verify-sampleApi-unit-tests.mjs'),'--java',join(f.root,'java.exe'),'--maven-home',join(f.root,'maven')]}
 const proposal={repository:'sampleApi',sourceChecksSha256:hash(JSON.stringify(checks)),checks:[{...checks[0],version:'2',steps:[step,...checks[0].steps]}]}
 const checksProposal=join(f.root,'checks.json');await writeFile(checksProposal,JSON.stringify(proposal))
 const options={...f,checksProposal,expectedSha256:hash(source)}
 const files=await readdir(f.root)
 for(const mode of ['check','apply'])await assert.rejects(configureProjectLocalAcceptance({...options,mode}),/LOCAL_CONFIG_LEGACY_CHECKS_PROPOSAL_UNSUPPORTED/)
 assert.equal(await readFile(f.profile,'utf8'),source)
 assert.deepEqual(await readdir(f.root),files)
 assert.throws(()=>planProjectLocalAcceptance(source,f.supplied,yaml,{allowUpdate:true,repositoryPatches:[{id:'sample-ui',checks:[]}]}),/LOCAL_CONFIG_REPOSITORY_PATCH_INVALID/)
})
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'local-profile-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const profile = join(root, 'cordis.patch.yml'), bundle = join(root, 'bundle.json')
  const source = `# 保留注释\n- insert:\n    - config:\n        hook: !!js |\n          ({ code: '保持原文' })\n        workflow:\n          repositories:\n            - id: sample-ui\n              managedRoot: ${JSON.stringify(root)}\n              untouched: original\n            - id: sampleApi\n              managedRoot: ${JSON.stringify(root)}\n              untouched: original\n            - id: other\n              localAcceptance: {keep: true}\n`
  const supplied = { sampleApi: configuration(root), 'sample-ui': configuration(root) }
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
  f.supplied.sampleApi.version = 'different'
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
  f.supplied.sampleApi.version='updated'
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

test('合并策略绑定明确配置的仓库与UAT目标并要求已配置业务场景',async t=>{
  const f=await fixture(t)
  const source=f.source+`- name: '@zzusp/dingtalk-dsh-assistant/platform-host'\n  config:\n    secretsDirectory: external\n    productionTagWritesEnabled: false\n`
  const targets=`          platforms:\n            release:\n              targets:\n                - id: sampleApi-uat3-deployment\n                  kind: uat-deployment\n                  repository: example/sampleApi\n                  branch: feature/uat3-base\n                - id: sample-ui-uat2-deployment\n                  kind: uat-deployment\n                  repository: example/sample-ui\n                  branch: feature/uat2-base\n`
  const profile=source.replace('          repositories:',targets+'          repositories:')
    .replace('- id: sampleApi\n','- id: sampleApi\n              githubRepository: example/sampleApi\n')
    .replace('- id: sample-ui\n','- id: sample-ui\n              githubRepository: example/sample-ui\n')
  const policy={targets:[{targetId:'sampleApi-uat3-deployment',requiredChecks:[],requiredScenarioIds:['read-only']},{targetId:'sample-ui-uat2-deployment',requiredChecks:[],requiredScenarioIds:['read-only']}]}
  const plan=planProjectLocalAcceptance(profile,f.supplied,yaml,{allowUpdate:true,mergePolicy:policy})
  assert.match(plan.updated,/uatMergeWritesEnabled: true/)
  assert.match(plan.updated,/requiredScenarioIds:/)
  assert.match(plan.updated,/productionTagWritesEnabled: false/)
  assert.equal(planProjectLocalAcceptance(plan.updated,f.supplied,yaml,{allowUpdate:true,mergePolicy:policy}).changed,false)
  policy.targets[0].requiredScenarioIds=['not-implemented']
  assert.throws(()=>planProjectLocalAcceptance(profile,f.supplied,yaml,{allowUpdate:true,mergePolicy:policy}),/MERGE_POLICY_INVALID/)
  policy.targets[0].requiredScenarioIds=['read-only'];policy.targets[0].targetId='sampleApi-uat2-deployment'
  assert.throws(()=>planProjectLocalAcceptance(profile,f.supplied,yaml,{allowUpdate:true,mergePolicy:policy}),/MERGE_POLICY_INVALID/)
})

test('配置接入要求显式项目且拒绝未知项目、无效runner配置及歧义repository', async t => {
  const f = await fixture(t)
  for (const supplied of [{}, null, []]) assert.throws(() => planProjectLocalAcceptance(f.source, supplied, yaml), /LOCAL_CONFIG_BUNDLE_INVALID/)
  assert.deepEqual(planProjectLocalAcceptance(f.source, {sampleApi:f.supplied.sampleApi}, yaml).repositoryIds,['sampleApi'])
  assert.throws(() => planProjectLocalAcceptance(f.source, {missing:f.supplied.sampleApi}, yaml), /LOCAL_CONFIG_REPOSITORIES_AMBIGUOUS/)
  assert.throws(() => planProjectLocalAcceptance(f.source, { ...f.supplied, sampleApi: {} }, yaml), /LOCAL_CONFIG_INVALID_sampleApi/)
  assert.throws(() => planProjectLocalAcceptance(f.source.replace('- id: other', '- id: sampleApi'), f.supplied, yaml), /LOCAL_CONFIG_REPOSITORIES_AMBIGUOUS/)
  assert.throws(() => planProjectLocalAcceptance(f.source.replace('- id: sampleApi\n', '- id: missing\n'), f.supplied, yaml), /LOCAL_CONFIG_REPOSITORIES_AMBIGUOUS/)
})

test('配置接入保留CRLF并拒绝不支持的行内映射', async t => {
  const f = await fixture(t), crlf = f.source.replaceAll('\n', '\r\n')
  const plan = planProjectLocalAcceptance(crlf, f.supplied, yaml)
  assert.equal(plan.updated.replaceAll('\r\n', '').includes('\n'), false)
  assert.throws(() => planProjectLocalAcceptance(`repositories:\n  - {id: sampleApi, managedRoot: ${JSON.stringify(f.root)}}\n  - {id: sample-ui, managedRoot: ${JSON.stringify(f.root)}}\n`, f.supplied, yaml), /LOCAL_CONFIG_REPOSITORY_LAYOUT_UNSUPPORTED/)
})

test('显式单项目与三项目bundle均可用且不改未选择项目', async t => {
  const f=await fixture(t)
  const supplied=Object.fromEntries(['catalog','portal','worker'].map(id=>[id,configuration(f.root)]))
  const profile=yaml.dump({workflow:{repositories:[...Object.keys(supplied).map(id=>({id,managedRoot:f.root})),{id:'untouched',localAcceptance:{original:true}}]}})
  const plan=planProjectLocalAcceptance(profile,supplied,yaml)
  assert.deepEqual(plan.repositoryIds,['catalog','portal','worker'])
  const repos=yaml.load(plan.updated).workflow.repositories
  assert.deepEqual(repos.at(-1),{id:'untouched',localAcceptance:{original:true}})
  for(const repo of repos.slice(0,-1))assert.deepEqual(repo.localAcceptance,supplied[repo.id])
  const subset=planProjectLocalAcceptance(profile,{catalog:supplied.catalog},yaml)
  assert.deepEqual(yaml.load(subset.updated).workflow.repositories[1],{id:'portal',managedRoot:f.root})
  const patches=[{id:'catalog',dependencyRepositories:['portal','worker']}]
  assert.match(planProjectLocalAcceptance(plan.updated,supplied,yaml,{allowUpdate:true,repositoryPatches:patches}).updated,/dependencyRepositories:/)
})

test('仓库名与UAT分支不推断；缺绑定、生产目标、重复或未知目标均拒绝',async t=>{
  const f=await fixture(t),config=configuration(f.root)
  const document={workflow:{repositories:[{id:'service',githubRepository:'example/catalog',managedRoot:f.root}],platforms:{release:{targets:[{id:'preview',kind:'uat-deployment',repository:'example/catalog',branch:'integration/review'}]},uatMerge:{targets:[{targetId:'unrelated',requiredChecks:['keep'],requiredScenarioIds:['keep']}]}}},host:{name:'@zzusp/dingtalk-dsh-assistant/platform-host',config:{uatMergeWritesEnabled:false,untouched:true}}}
  const policy={targets:[{targetId:'preview',requiredChecks:[],requiredScenarioIds:['read-only']}]}
  const plan=planProjectLocalAcceptance(yaml.dump(document),{service:config},yaml,{mergePolicy:policy})
  const after=yaml.load(plan.updated)
  assert.deepEqual(after.workflow.platforms.uatMerge.targets,[document.workflow.platforms.uatMerge.targets[0],policy.targets[0]])
  assert.equal(after.host.config.untouched,true)
  assert.equal(planProjectLocalAcceptance(plan.updated,{service:config},yaml,{mergePolicy:policy}).changed,false)
  for(const mutate of [d=>delete d.workflow.repositories[0].githubRepository,d=>d.workflow.platforms.release.targets[0].kind='production-deployment',d=>delete d.workflow.platforms.release.targets[0].branch,d=>d.workflow.platforms.release.targets.push({...d.workflow.platforms.release.targets[0]}),d=>d.workflow.repositories.push({id:'ambiguous',githubRepository:'example/catalog'})]){
    const changed=structuredClone(document);mutate(changed)
    assert.throws(()=>planProjectLocalAcceptance(yaml.dump(changed),{service:config},yaml,{mergePolicy:policy}),/LOCAL_CONFIG_MERGE_POLICY_INVALID/)
  }
  for(const targets of [[],[null],[policy.targets[0],policy.targets[0]],[{...policy.targets[0],targetId:'unknown'}]])assert.throws(()=>planProjectLocalAcceptance(yaml.dump(document),{service:config},yaml,{mergePolicy:{targets}}),/LOCAL_CONFIG_MERGE_POLICY_INVALID/)
})

test('项目选择拒绝特殊键且绝不从历史项目名补默认', async t=>{
  const f=await fixture(t)
  for(const id of ['../outside','constructor','prototype','__proto__'])assert.throws(()=>planProjectLocalAcceptance(f.source,{[id]:f.supplied.sampleApi},yaml),/LOCAL_CONFIG_BUNDLE_INVALID/)
  const result=await configureProjectLocalAcceptance({...f,mode:'check'})
  assert.deepEqual(result.repositories,['sampleApi','sample-ui'])
  const source=await readFile(new URL('../scripts/configure-project-local-acceptance.mjs',import.meta.url),'utf8')
  assert.doesNotMatch(source,/HiQ-AI|dataset|D:\/baibu-agent/)
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

test('受控恢复精确旧checks与移除taskmap，check零写/apply保留依赖查询，篡改与越界拒绝',async t=>{
 const {DatabaseSync}=await import('node:sqlite'),{executionDigest}=await import('../packages/dingtalk-dsh-assistant/execution-artifacts.js');
 const root=await mkdtemp(join(tmpdir(),'repository-restore-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const profile=join(root,'current.yml'),oldPath=join(root,'old.yml'),dbPath=join(root,'control.db'),proposalPath=join(root,'proposal.json');
 const repos=['backend','frontend','worker'].map(id=>({id,remote:'https://github.com/example/'+id,githubRepository:'example/'+id,baseRef:'main',baseBranch:'main',editablePaths:[],checks:[{id:'check',version:'1',steps:[command]}]}));
 const old={workflow:{dbPath,repositories:repos},queries:{preserve:'current-only'}},oldText=yaml.dump(old);await writeFile(oldPath,oldText);
 const current=structuredClone(old);for(const r of current.workflow.repositories){r.checks[0].version='2';r.taskLocalAcceptance=[{fixture:true}];r.dependencyRepositories=[repos.find(x=>x.id!==r.id).id]}
 const source=yaml.dump(current);await writeFile(profile,source);
 const db=new DatabaseSync(dbPath);db.exec('CREATE TABLE execution_runs(task_id TEXT,run_id TEXT,status TEXT,generation INTEGER,workflow_digest TEXT);CREATE TABLE message_workflows(digest TEXT,body TEXT)');
 const runs=[];for(const [i,r]of repos.entries()){const digest=executionDigest({config:r,ghCommand:null,author:null}),run={taskId:'t'+i,runId:'r'+i,status:'waiting',generation:1,savedRepositoryDigest:digest};runs.push(run);db.prepare('INSERT INTO execution_runs VALUES(?,?,?,?,?)').run(run.taskId,run.runId,run.status,1,'w'+i);db.prepare('INSERT INTO message_workflows VALUES(?,?)').run('w'+i,JSON.stringify({config:{kind:'engineering',repoId:r.id,repositoryDigest:digest}}))}db.close();
 const receiptPath=join(root,'receipt.json'),proofPath=join(root,'proof.json');await writeFile(receiptPath,JSON.stringify({mode:'apply',changed:true,beforeSha256:hash(oldText),afterSha256:hash(source),backupPath:oldPath}));await writeFile(proofPath,JSON.stringify({oldProfile:oldPath,runs}));
 const proposal={profile,expectedProfileSha256:hash(source),sourceProfile:oldPath,sourceProfileSha256:hash(oldText),deploymentReceipt:{path:receiptPath,sha256:hash(await readFile(receiptPath))},beforeConfigProof:{path:proofPath,sha256:hash(await readFile(proofPath))},repositories:repos.map(r=>({id:r.id,restoreChecks:r.checks,removeTaskLocalAcceptance:true,dependencyRepositories:current.workflow.repositories.find(x=>x.id===r.id).dependencyRepositories}))};
 const save=p=>writeFile(proposalPath,JSON.stringify(p));await save(proposal);const args={profile,restoreProposal:proposalPath,expectedSha256:hash(source)};
 const check=await configureProjectLocalAcceptance({...args,mode:'check'});assert.equal(check.writes,0);assert.equal(check.restore.knownActiveRuns.length,3);assert.equal(await readFile(profile,'utf8'),source);
 for(const mutate of [p=>p.sourceProfileSha256='0'.repeat(64),p=>p.repositories[0].id='foreign',p=>p.repositories[0].restoreChecks[0].version='0',p=>p.beforeConfigProof.sha256='0'.repeat(64)]){const changed=structuredClone(proposal);mutate(changed);await save(changed);await assert.rejects(configureProjectLocalAcceptance({...args,mode:'check'}),/LOCAL_CONFIG_RESTORE_/)}
 await save(proposal);await assert.rejects(configureProjectLocalAcceptance({...args,bundle:oldPath,mode:'check'}),/LOCAL_CONFIG_RESTORE_ARGUMENTS_INVALID/);
 const driftDb=new DatabaseSync(dbPath);driftDb.prepare("UPDATE execution_runs SET generation=2 WHERE run_id='r0'").run();await assert.rejects(configureProjectLocalAcceptance({...args,mode:'check'}),/LOCAL_CONFIG_RESTORE_ACTIVE_DIGEST_MISMATCH/);driftDb.prepare("UPDATE execution_runs SET generation=1 WHERE run_id='r0'").run();driftDb.close();
 const applied=await configureProjectLocalAcceptance({...args,mode:'apply'}),after=yaml.load(await readFile(profile,'utf8'));assert.equal(applied.afterSha256,check.afterSha256);assert.deepEqual(after.queries,current.queries);for(const repo of after.workflow.repositories){assert.equal(repo.checks[0].version,'1');assert.equal(Object.hasOwn(repo,'taskLocalAcceptance'),false);assert.deepEqual(repo.dependencyRepositories,current.workflow.repositories.find(x=>x.id===repo.id).dependencyRepositories)}
 // 改动其他仓库字段，即使调用方重绑current SHA和部署回执，也不允许借恢复改写。
 const altered=structuredClone(current);altered.workflow.repositories[0].baseBranch='other';const alteredText=yaml.dump(altered);await writeFile(profile,alteredText);const receipt={mode:'apply',changed:true,beforeSha256:hash(oldText),afterSha256:hash(alteredText),backupPath:oldPath};await writeFile(receiptPath,JSON.stringify(receipt));await save({...proposal,expectedProfileSha256:hash(alteredText),deploymentReceipt:{path:receiptPath,sha256:hash(await readFile(receiptPath))}});await assert.rejects(configureProjectLocalAcceptance({...args,expectedSha256:hash(alteredText),mode:'check'}),/LOCAL_CONFIG_RESTORE_UNRELATED_CHANGE/);
});
