import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdtemp,writeFile,readFile,readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { planFrontendChecks,configureFrontendChecks,testStep } from '../docs/acceptance/topic-context-completeness/scripts/configure-frontend-review-checks.mjs'
const yaml=createRequire(import.meta.url)('D:/dsh_home/profiles/web/node_modules/js-yaml')
const hash=s=>createHash('sha256').update(s).digest('hex')
const steps=[{executable:testStep.executable,args:['D:/soft/node-v16.20.2/node_global/node_modules/yarn/bin/yarn.js','install','--frozen-lockfile','--non-interactive','--silent'],timeoutMs:600000},{executable:testStep.executable,args:['D:/soft/node-v16.20.2/node_global/node_modules/yarn/bin/yarn.js','run','build'],timeoutMs:1800000}]
const source='# 原配置\ncode: !!js "ctx => ctx.value"\nrepositories:\n  - id: dataset-web\n    checks:\n      - steps:\n'+yaml.dump(steps,{lineWidth:-1}).split('\n').filter(Boolean).map(s=>'          '+s).join('\n')+'\n        id: dataset-build\n        version: "1"\n  - id: dataset\n    checks: [{id: java, steps: [{executable: java, args: [package]}]}]\n# 原尾注释\n'
test('仅steps插入原生测试，!!js及其余原文稳定，重复幂等',()=>{
 const result=planFrontendChecks(source,yaml)
 assert.equal(result.changed,true)
 assert.equal(result.updated.slice(0,source.indexOf('          - executable:')),source.slice(0,source.indexOf('          - executable:')))
 assert.equal(result.updated.slice(result.updated.indexOf('        id: dataset-build')),source.slice(source.indexOf('        id: dataset-build')))
 assert.equal(planFrontendChecks(result.updated,yaml).changed,false)
 assert.throws(()=>planFrontendChecks(source.replace('600000','1'),yaml),/EXISTING_STEPS_DIFFERENT/)
})
test('隔离配置check零写、apply备份回读、旧hash及并发锁拒绝',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'frontend-checks-')),profile=join(dir,'patch.yml'),dbPath=join(dir,'control.sqlite')
 await writeFile(profile,source)
 const db=new DatabaseSync(dbPath);db.exec('CREATE TABLE execution_nodes(current,status,drained); CREATE TABLE task_owners(status); CREATE TABLE execution_effects(state)');db.close()
 const args={profile,dbPath,yaml,expectedSha256:hash(source)}
 const before=await readdir(dir)
 assert.equal((await configureFrontendChecks({...args,mode:'check'})).writes,0);assert.deepEqual(await readdir(dir),before)
 const lock=new DatabaseSync(dbPath+'.owner.sqlite');lock.exec('BEGIN EXCLUSIVE')
 await assert.rejects(configureFrontendChecks({...args,mode:'apply'}));assert.equal(await readFile(profile,'utf8'),source);lock.exec('ROLLBACK');lock.close()
 await writeFile(profile,source+'# concurrent\n')
 await assert.rejects(configureFrontendChecks({...args,mode:'apply'}),/PROFILE_CHANGED/)
 await writeFile(profile,source)
 const applied=await configureFrontendChecks({...args,mode:'apply'})
 assert.equal(await readFile(applied.backupPath,'utf8'),source)
 const updated=await readFile(profile,'utf8');assert.equal(hash(updated),applied.afterSha256)
 assert.equal((await configureFrontendChecks({...args,mode:'apply',expectedSha256:hash(updated)})).changed,false)
})
