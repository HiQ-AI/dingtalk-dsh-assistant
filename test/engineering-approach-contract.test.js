import test from 'node:test'
import assert from 'node:assert/strict'
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
