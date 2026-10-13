// 固定同一旧 record，仅替换隔离副本的合同换行字节，验证摘要变化的原因。
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
const root=fileURLToPath(new URL('../../../../',import.meta.url)),output=join(root,'docs/tmp/workflow-dashboard')
const fixturePath=join(output,'v25-frozen-baseline.json'),original=await readFile(fixturePath)
const fixture=JSON.parse(original)
assert.equal(fixture.baseCommit,'44646d2056375b32ebf2ed2f7812d946473f9722')
const contract=await readFile(join(root,'packages/dingtalk-dsh-assistant/engineering-output-contract.js'),'utf8')
const names=['workflow-engineering.js','task-workflow.js','execution-controller.js','engineering-output-contract.js']
const results=[]
for(const mode of ['old-checkout-crlf','upstream-release-bytes']){
  const directory=await mkdtemp(join(output,`v25-contract-${mode}-`))
  const bytes=mode==='old-checkout-crlf'?contract.replace(/\r\n?|\n/g,'\r\n'):contract
  for(const name of names){
    let source=name==='engineering-output-contract.js'?bytes:await readFile(join(root,'packages/dingtalk-dsh-assistant',name),'utf8')
    if(name==='execution-controller.js'){
      assert.ok(source.includes('export function defineExecutionWorkflow('))
      source=source.replace('export function defineExecutionWorkflow(','function originalDefineExecutionWorkflow(')
        +'\nexport const capturedDefinitions=[];\nexport function defineExecutionWorkflow(...args){const result=originalDefineExecutionWorkflow(...args);capturedDefinitions.push(result);return result}\n'
    }
    const rewritten=source.replace(/from (['"])(\.\/[^'"]+)\1/g,(_,quote,target)=>`from ${quote}${pathToFileURL(names.includes(target.slice(2))?join(directory,target.slice(2)):join(root,'packages/dingtalk-dsh-assistant',target.slice(2))).href}${quote}`)
    await writeFile(join(directory,name),rewritten)
  }
  await writeFile(join(directory,'package.json'),JSON.stringify({type:'module'}))
  const {createEngineeringRegistry}=await import(pathToFileURL(join(directory,'workflow-engineering.js')).href)
  const {capturedDefinitions}=await import(pathToFileURL(join(directory,'execution-controller.js')).href)
  let writes=0
  const record=structuredClone(fixture.record)
  const store={command(){writes++;throw Error('RESTORE_MUST_NOT_WRITE')},query(input){if(input.kind==='workflow.list')return [record];if(input.kind==='run')return {run:null,nodes:[]};if(input.kind==='effect.list')return [];throw Error('UNEXPECTED_QUERY:'+input.kind)}}
  let strictResult='PASS'
  try{await createEngineeringRegistry({...fixture.options,modelConfig:()=>({provider:'test',model:'test'})}).restore(store)}catch(error){strictResult=error.code??error.message}
  // 只读记录原 defineExecutionWorkflow 的返回值；不改变 record 或摘要比较。
  const actualDigest=capturedDefinitions.at(-1)?.digest
  assert.equal(typeof actualDigest,'string')
  assert.equal(writes,0)
  if(mode==='old-checkout-crlf'){assert.equal(strictResult,'PASS');assert.equal(actualDigest,fixture.digest)}
  else{assert.equal(strictResult,'ENGINEERING_DEFINITION_DRIFT');assert.notEqual(actualDigest,fixture.digest)}
  results.push({mode,strictResult,expectedDigest:fixture.digest,actualDigest,contractSha256:createHash('sha256').update(bytes).digest('hex'),crlf:bytes.match(/\r\n/g)?.length??0,bareLf:bytes.match(/(?<!\r)\n/g)?.length??0,persistentWrites:writes})
}
assert.deepEqual(await readFile(fixturePath),original)
const result={verifiedAt:new Date().toISOString(),status:'PASS',fixtureUnchanged:true,results,boundary:'同一冻结record、同一当前工厂；仅隔离模块副本的合同换行字节不同。未修改生产代码或expected。'}
await writeFile(join(output,'v25-contract-byte-attribution.json'),JSON.stringify(result,null,2))
console.log(JSON.stringify(result,null,2))
