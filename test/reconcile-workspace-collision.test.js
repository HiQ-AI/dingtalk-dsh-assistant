import test from 'node:test'
import assert from 'node:assert/strict'
import {validateCollisionBinding} from '../scripts/reconcile-workspace-collision.mjs'
test('reconciliation only admits the exact unknown managed-workspace effect or its proven terminal collision',()=>{
 const scope={effectId:'workspace-x',runId:'run-x'},effect={effectId:'workspace-x',runId:'run-x',kind:'operation',nodeId:'prepare-workspace',state:'unknown',definition:{action:'workspace',adapterId:'managed-workspace',adapterVersion:'1'}}
 assert.doesNotThrow(()=>validateCollisionBinding(effect,scope))
 for(const change of [{runId:'foreign'},{effectId:'foreign'},{nodeId:'apply-changes'},{state:'executing'},{definition:{...effect.definition,action:'external'}}])assert.throws(()=>validateCollisionBinding({...effect,...change},scope),/SCOPE_INVALID/)
 assert.throws(()=>validateCollisionBinding({...effect,state:'failed',result:{result:{reason:'OTHER_FAILURE',mutationAttempted:false}}},scope),/NOT_COLLISION/)
 assert.doesNotThrow(()=>validateCollisionBinding({...effect,state:'failed',result:{result:{reason:'WORKSPACE_PREPARATION_ADDRESS_COLLISION',mutationAttempted:false}}},scope))
})
