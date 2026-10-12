import {readFile} from 'node:fs/promises'
import assert from 'node:assert/strict'
import {readRealHttpEvidence} from './sg20-real-http-evidence.mjs'
try{
 const[flag,path]=process.argv.slice(2);assert.equal(flag,'--config');const config=JSON.parse(await readFile(path,'utf8'))
 let raw='';for await(const x of process.stdin){raw+=x;assert.ok(raw.length<64000)}const input=JSON.parse(raw)
 assert.equal(input.uatEnvironment,'uat3');assert.equal(input.case.scenarioId,'real-http-uat-contract');assert.deepEqual(input.case.parameters,{})
 assert.match(input.namespace,/^acceptance-[a-f0-9]{32}$/)
 console.log(JSON.stringify({namespace:input.namespace,actual:JSON.stringify(await readRealHttpEvidence(config))}))
}catch(e){console.error(JSON.stringify({code:'SG20_REAL_HTTP_EVIDENCE_REJECTED',message:e.message}));process.exitCode=1}
