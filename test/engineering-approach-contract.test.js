import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile, unlink, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as contract from '../packages/dingtalk-dsh-assistant/engineering-output-contract.js'
import { validateEngineeringApproach } from '../packages/dingtalk-dsh-assistant/engineering-output-contract.js'
const scope={editablePaths:[],allowedPrefixes:['src/']}
test('technical approach tolerates filenames, extra metadata and optional repeated criteria',()=>{
 const plan={document:{name:'approach.md',markdown:'Use the existing merge handler.',revision:9},notes:{format:'new'}}
 assert.equal(validateEngineeringApproach(plan,scope),plan)
 assert.equal(validateEngineeringApproach({...plan,scopePaths:['src/merge.js'],criteria:[{criterion:'paraphrase'}]},scope).document.markdown,plan.document.markdown)
})
test('meaningful missing approach and repository escape remain errors',()=>{
 for(const plan of [{},{document:{markdown:' '}},{document:{markdown:12}}]) assert.throws(()=>validateEngineeringApproach(plan,scope),{code:'ENGINEERING_TECHNICAL_PLAN_INVALID'})
 for(const path of ['../escape','/absolute','D:/absolute','.git/config','src/../escape','outside.js']) assert.throws(()=>validateEngineeringApproach({document:{markdown:'Approach'},scopePaths:[path]},scope),{code:'ENGINEERING_TECHNICAL_PLAN_INVALID'})
})

// 冻结定义使用函数源码；期望来自已受信发行包 83399d6e1e9f，不能随换行重建更新。
const releaseHashes={
 file:'8e82c88c2eb226dc1ed880f1f399f60a29f8d51c1929405c879aecacee34561a',
 validateEngineeringPlanScope:'d451f5dd32330820c17e72f26d614ad7891d28cdfce0ad35793d3ee74521859e',
 validateLocalAcceptanceSubmission:'99adaa529d5895973b4ab1a9d70e34de7ffba3552872b18fcbff64372fe6ab15',
 validateEngineeringApproach:'c7b8434ce7b45d8b74652b9bcfa38fdecf232423c5a1039141163e87b08f397e',
}
const sourcePath='packages/dingtalk-dsh-assistant/engineering-output-contract.js'
const workspace=fileURLToPath(new URL('../',import.meta.url))
const sha=value=>createHash('sha256').update(value).digest('hex')
const hashes=(bytes,module)=>({file:sha(bytes),...Object.fromEntries(Object.keys(releaseHashes).filter(name=>name!=='file').map(name=>[name,sha(module[name].toString())]))})

test('工程校验器保留冻结发行文件和函数源码摘要',async()=>{
 assert.deepEqual(hashes(await readFile(join(workspace,sourcePath)),contract),releaseHashes)
})

test('真实 Git add/checkout 在两种 autocrlf 设置下保留发行字节',async t=>{
 const temporary=join(workspace,'docs/tmp/engineering-contract-checkout');await mkdir(temporary,{recursive:true})
 for(const autocrlf of ['false','true'])await t.test(`core.autocrlf=${autocrlf}`,async t=>{
  const directory=await mkdtemp(join(temporary,'repo-')),file=join(directory,sourcePath)
  t.after(async()=>{assert.equal(dirname(directory),temporary);await rm(directory,{recursive:true,force:true})})
  const git=(...args)=>execFileSync('git',['-C',directory,...args],{windowsHide:true,stdio:'pipe'})
  git('init');git('config','core.autocrlf',autocrlf)
  await mkdir(dirname(file),{recursive:true})
  await writeFile(join(directory,'.gitattributes'),await readFile(join(workspace,'.gitattributes')))
  await writeFile(file,await readFile(join(workspace,sourcePath)))
  git('add','--','.gitattributes',sourcePath);await unlink(file);git('checkout','--',sourcePath)
  // 只复制真实导入依赖；摘要仅约束本次冻结合同，不固定其它实现。
  for(const name of ['execution-artifacts.js','session-workspaces.js'])await writeFile(join(dirname(file),name),await readFile(join(workspace,'packages/dingtalk-dsh-assistant',name)))
  assert.deepEqual(hashes(await readFile(file),await import(pathToFileURL(file))),releaseHashes)
 })
})
