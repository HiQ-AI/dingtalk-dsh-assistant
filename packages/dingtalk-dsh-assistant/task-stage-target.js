import {executionError} from './execution-artifacts.js'
/** Same workflow can publish several repositories; bind each occurrence to its declared target. */
export function stageTargetId(requirement,plan,stageIndex,workflowId){
 const target=requirement.stageTargets?.[workflowId]??requirement.target?.targetId
 if(!Array.isArray(target))return target
 const ordinal=plan.stages.slice(0,stageIndex).filter(item=>item.workflowId===workflowId).length
 const selected=target[ordinal]
 if(typeof selected!=='string'||!selected)throw executionError('EXTERNAL_TARGET_NOT_ALLOWED')
 return selected
}
