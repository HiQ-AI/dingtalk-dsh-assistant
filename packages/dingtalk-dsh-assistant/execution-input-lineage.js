import { executionDigest } from './execution-artifacts.js'

export const executionNodeContractDigest = node => executionDigest(Object.fromEntries(Object.entries(node).filter(([,value])=>value!==undefined).map(([key,value])=>[key,typeof value==='function'?value.toString().replace(/\r\n?/g,'\n'):value])))

/** Interpret only committed Host revisions, with their original immutable evidence. */
export async function inspectExecutionInputLineage({ store, artifacts, run, node, input, definition, resolveDefinition }) {
  const gates = []
  const gate = (name, expected, actual) => { const passed = executionDigest(expected) === executionDigest(actual); gates.push({ name, expected, actual, passed }); return passed }
  if (!gate('artifactDigest', node.inputDigest, executionDigest(input))
    || !gate('nodeIdentity', [node.nodeId, node.nodeVersion], [input.nodeId, input.nodeVersion])
    || !gate('nodeContract', [node.nodeId, node.nodeVersion], [definition.nodes[node.position]?.id, definition.nodes[node.position]?.version])) return { trusted: false, gates }
  if (input.workflowDigest === run.workflowDigest) return { trusted: true, gates }
  const history = await store.query({ kind: 'run.workflow-lineage', runId: run.runId })
  let digest = input.workflowDigest
  const chain = []
  for (const entry of history) {
    const event = entry.event, receipt = entry.receipt?.result
    if (event.fromDigest !== digest) continue
    if (!gate('committedReceipt', [run.runId, event.fromDigest, event.toDigest,event.evidenceRef], [receipt?.runId, receipt?.fromDigest, receipt?.toDigest,receipt?.evidenceRef])) return { trusted: false, gates }
    const before = entry.before, after = entry.after
    if (!gate('registeredScope', [run.taskId, run.runId, run.taskId, run.runId], [before?.config?.taskId, before?.config?.runId, after?.config?.taskId, after?.config?.runId])) return { trusted: false, gates }
    const changedKeys = entry.kind === 'run.workflow.revise' ? ['taskRevision'] : event.kind === 'checks' ? ['checkpoint','checkpointChecks'] : ['checkpoint','localAcceptanceConfig','localAcceptanceScope']
    const stable = config => Object.fromEntries(Object.entries(config).filter(([key]) => !changedKeys.includes(key)))
    if (!gate('businessConfiguration', executionDigest(stable(before.config)), executionDigest(stable(after.config)))) return { trusted: false, gates }
    const proof = await artifacts.read(event.evidenceRef)
    let retained = false
    if (entry.kind === 'run.workflow.revise') {
      const saved = proof.previousNodes?.find(item => item.nodeRunId === node.nodeRunId)
      retained = proof.kind === 'task-workflow-revision' && proof.runId === run.runId && proof.taskId === run.taskId
        && proof.fromDigest === event.fromDigest && proof.toDigest === event.toDigest
        && proof.retainedNodeIds?.includes(node.nodeId)
        && saved?.inputDigest === node.inputDigest && saved.inputRef === node.inputRef && saved.outputRef === node.outputRef
        && after.config.taskRevision?.fromDigest === event.fromDigest && after.config.taskRevision.startNodeId === event.startNodeId
        && definition.nodes.findIndex(item => item.id === event.startNodeId) > node.position
    } else {
      const start = definition.nodes.findIndex(item => item.id === event.startNodeId)
      const saved = event.retained?.find(item => item.nodeRunId === node.nodeRunId)
      retained = proof.kind === 'engineering-checkpoint' && proof.mode === event.kind && proof.runId === run.runId && proof.fromDigest === event.fromDigest && proof.toDigest === event.toDigest
        && after.config.checkpoint?.fromDigest === event.fromDigest
        && (start > node.position || saved?.inputDigest === node.inputDigest && saved.outputRef === node.outputRef && saved.leaseEpoch === node.leaseEpoch)
    }
    if (!gate('retainedContractAndInput', true, Boolean(retained))) return { trusted: false, gates }
    const currentContract=executionNodeContractDigest(definition.nodes[node.position])
    const attestation=proof.retainedContracts?.find(item=>item.nodeRunId===node.nodeRunId)
    let semantic=false
    if(proof.semanticProofVersion===1 && proof.producer==='execution-controller' && attestation){
      semantic=attestation.nodeId===node.nodeId && attestation.nodeVersion===node.nodeVersion
        && attestation.inputRef===node.inputRef && attestation.inputDigest===node.inputDigest
        && attestation.requirementRef===input.requirementRef && input.requirementRef===run.requirementRef
        && attestation.businessInputDigest===executionDigest(input.data)
        && attestation.fromContractDigest===currentContract && attestation.toContractDigest===currentContract
    }else if(resolveDefinition){
      const oldDefinition=resolveDefinition(before),newDefinition=resolveDefinition(after)
      const oldNode=oldDefinition?.nodes.find(item=>item.id===node.nodeId),newNode=newDefinition?.nodes.find(item=>item.id===node.nodeId)
      const saved=proof.previousNodes?.find(item=>item.nodeRunId===node.nodeRunId)
      // Legacy checkpoints did not save a complete retained-input/contract proof.
      // They are insufficient even when the position happens to precede the checkpoint.
      semantic=entry.kind==='run.workflow.revise' && !!oldNode && !!newNode
        && executionNodeContractDigest(oldNode)===currentContract && executionNodeContractDigest(newNode)===currentContract
        && saved?.inputRef===node.inputRef && saved.inputDigest===node.inputDigest
        && input.requirementRef===run.requirementRef
    }
    if (!gate('retainedBusinessSemantics', true, Boolean(semantic))) return { trusted: false, gates }
    chain.push(entry.seq); digest = event.toDigest
    if (digest === run.workflowDigest) break
  }
  gate('workflowLineage', run.workflowDigest, digest)
  return { trusted: gates.every(item => item.passed), gates, chain }
}

/** A readonly planner correction depends on its business input, not enclosing workflow metadata. */
export function inspectLocalAcceptanceCorrection({run,node,input,expectedData}) {
  const gates=[]
  const gate=(name,expected,actual)=>{const passed=executionDigest(expected)===executionDigest(actual);gates.push({name,expected,actual,passed});return passed}
  const taskPrefix=`tasks/${run.taskId}/`
  gate('originalTaskInput',true,node.inputRef?.startsWith(taskPrefix)&&input.requirementRef?.startsWith(taskPrefix))
  gate('artifactDigest',node.inputDigest,executionDigest(input))
  gate('plannerNode','plan-local-acceptance',input.nodeId)
  gate('currentRequirement',run.requirementRef,input.requirementRef)
  for(const key of ['request','criteria','scenarios','uatEnvironment']) gate(`business.${key}`,expectedData?.[key]??null,input.data?.[key]??null)
  gate('executableScenarios',true,Array.isArray(input.data?.scenarios)&&input.data.scenarios.length>0&&input.data.scenarios.every(s=>typeof s.id==='string'&&s.id.trim()))
  return {trusted:gates.every(g=>g.passed),gates,warnings:input.workflowDigest!==run.workflowDigest?['historical-workflow-metadata']:[]}
}
