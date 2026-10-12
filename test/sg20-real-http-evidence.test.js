import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {readRealHttpEvidence} from '../scripts/sg20-real-http-evidence.mjs'
const config=JSON.parse(await readFile('D:/project/dataset-web-sg20-pure-20261010/docs/sg20-pure/req6-runner-frontend.json','utf8'))
test('current req6 real HTTP proof stays partial and candidate-bound',async()=>{const r=await readRealHttpEvidence(config);assert.equal(r.tests,11);assert.equal(r.httpRequests,47);assert.equal(r.domVerified,false);assert.equal(r.fullAcceptanceComplete,false)})
test('different task or requirement cannot reuse SG20 real HTTP proof',async()=>{await assert.rejects(readRealHttpEvidence({...config,taskId:'other'}),/TASK_SCOPE/);await assert.rejects(readRealHttpEvidence({...config,requirementRevision:2}),/REQUIREMENT_SCOPE/)})
test('changed candidate source or historical raw log rejects proof',async()=>{await assert.rejects(readRealHttpEvidence(config,{git:()=> 'different-tree'}),/SOURCE_CHANGED/);await assert.rejects(readRealHttpEvidence(config,{read:async(p,...a)=>p.endsWith('real-http-round3.log')?Buffer.from('edited'):readFile(p,...a)}),/EVIDENCE_CHANGED:log/)})
