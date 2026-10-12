import { executionError } from './execution-artifacts.js'
const nonempty=value=>typeof value==='string'&&value.trim()===value&&value.length>0
export const currentOwnerUatPolicy=policy=>policy?.acceptancePolicy==='original-owner-current-scope'
export function validUatAcceptancePolicy(policy){
 if(currentOwnerUatPolicy(policy))return !Object.hasOwn(policy,'requiredScenarioIds')
 return !Object.hasOwn(policy,'acceptancePolicy')&&Array.isArray(policy.requiredScenarioIds)&&policy.requiredScenarioIds.length>0
  &&policy.requiredScenarioIds.every(nonempty)&&new Set(policy.requiredScenarioIds).size===policy.requiredScenarioIds.length
}
export function assertUatLocalAcceptance(policy,proof){
 const ids=proof?.scenarioIds
 if(!Array.isArray(ids)||!ids.length||ids.some(id=>!nonempty(id))||new Set(ids).size!==ids.length)throw executionError('UAT_LOCAL_SCENARIO_REQUIRED')
 if(currentOwnerUatPolicy(policy)){
  if(proof.definitionVersion!=='original-owner-candidate-v1'||!nonempty(proof.taskId)||!nonempty(proof.manifestRef)
   ||!nonempty(proof.reviewRef)||! /^[a-f0-9]{64}$/.test(proof.evidenceDigest??''))throw executionError('UAT_OWNER_CURRENT_SCOPE_REQUIRED')
 }else if(policy.requiredScenarioIds.some(id=>!ids.includes(id)))throw executionError('UAT_LOCAL_SCENARIO_REQUIRED')
}
export function assertCurrentUatOwnerBinding(policy,binding,plan){
 if(currentOwnerUatPolicy(policy)&&(!binding?.ref||binding.requirementRevision!==plan?.task?.requirementRevision))
  throw executionError('UAT_OWNER_CURRENT_SCOPE_REQUIRED')
}
