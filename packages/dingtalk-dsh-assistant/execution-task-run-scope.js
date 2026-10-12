import { executionError } from './execution-artifacts.js'

const fail = code => { throw executionError(code) }
const effects = ['workspace','edit','external','commit','push','pr','progress']
const inbound = new Set(['message.coordinator.claim','message.agent.begin','message.node.claim','message.command.claim','message.notification.operation.claim','approval.notice.send'])
const planChanges = new Set(['task.plan.initialize','task.plan.extend','task.plan.insertDependency','task.plan.create','task.plan.revise','task.stage.input.bind','task.accept','run.create','task.web-rerun.accept'])
export function createTaskRunScope(db, args, incarnation) {
  const { taskId, runId, expectedRequirementRevision, expectedControlRevision, groupId, allowedEffects } = args
  if (![taskId,runId,groupId].every(v=>typeof v==='string'&&v.length>0) || !Number.isSafeInteger(expectedRequirementRevision) || !Number.isSafeInteger(expectedControlRevision)
    || !Array.isArray(allowedEffects) || new Set(allowedEffects).size!==allowedEffects.length || allowedEffects.some(v=>!effects.includes(v))) fail('TASK_RUN_SCOPE_INVALID')
  const task=db.prepare('SELECT b.*,c.state,c.control_revision FROM business_tasks b JOIN task_controls c ON c.task_id=b.task_id WHERE b.task_id=?').get(taskId)
  const run=db.prepare('SELECT * FROM execution_runs WHERE run_id=?').get(runId)
  const stage=db.prepare('SELECT * FROM task_plan_stages WHERE task_id=? AND plan_revision=? AND run_id=?').get(taskId,task?.plan_revision??-1,runId)
  const completionOnly=stage?.status==='succeeded'&&run?.status==='succeeded'&&allowedEffects.length===1&&allowedEffects[0]==='progress'
  if (!incarnation || !task || !(completionOnly?task.state==='active':task.state==='paused') || task.requirement_revision!==expectedRequirementRevision || task.control_revision!==expectedControlRevision || !run || run.task_id!==taskId
    || !stage || !(completionOnly||stage.status==='running'&&['queued','waiting','running'].includes(run.status)) || stage.requirement_ref!==run.requirement_ref) fail('TASK_RUN_SCOPE_STALE')
  const row=db.prepare('SELECT body FROM message_workflows WHERE digest=?').get(run.workflow_digest), record=row&&JSON.parse(row.body)
  const saved=record?.config
  if (saved?.kind!=='engineering' || saved.taskId!==taskId || saved.runId!==runId || !saved.repositoryIdentity?.remote || !saved.head || !saved.uatBranch) fail('TASK_RUN_SCOPE_ENGINEERING_REQUIRED')
  // Original conversation is proved from the stored source run, never from the request alone.
  const source=db.prepare(`SELECT m.body FROM message_runs m JOIN message_items i ON i.run_id=m.run_id WHERE i.kind='command' AND (json_extract(i.body,'$.result.taskId')=? OR json_extract(i.body,'$.args.taskId')=?) LIMIT 1`).get(taskId,taskId)
  const sourceBody=source&&JSON.parse(source.body)
  if (!sourceBody || (sourceBody.groupId??sourceBody.conversationId)!==groupId) fail('TASK_RUN_SCOPE_GROUP_UNPROVEN')
  return {...(completionOnly?{completionOnly:true}:{}),taskId,runId,requirementRevision:expectedRequirementRevision,controlRevision:expectedControlRevision,stageId:stage.stage_id,planRevision:task.plan_revision,
    groupId,allowedEffects:[...allowedEffects],processIncarnation:incarnation,remote:saved.repositoryIdentity.remote,repo:saved.repositoryIdentity.githubRepository,head:saved.head,base:saved.uatBranch,nodeIds:completionOnly?[]:db.prepare('SELECT node_id FROM execution_nodes WHERE run_id=? AND current=1').all(runId).map(n=>n.node_id)}
}
export function assertTaskRunScope(db, command, scope, incarnation) {
  if (!scope) return
  const {kind,args:a={}}=command
  const dispatch=kind==='node.claim'||kind==='run.recovery.admit'||kind==='run.workflow.checkpoint'||kind.startsWith('task.owner.')&&['claim','accept','applied','retry'].includes(kind.split('.').at(-1))||['effect.prepare','effect.begin','effect.rearmUnsent','message.notification.claim','task.control.resume','task.control.reopen'].includes(kind)||inbound.has(kind)||planChanges.has(kind)
  if(scope.completionOnly && dispatch && !['task.owner.claim','task.owner.accept','task.owner.applied','task.owner.retry'].includes(kind)) fail('TASK_RUN_SCOPE_DISPATCH_DENIED')
  if(!dispatch) return // reads, settlement and entering maintenance remain available after restart.
  // A restart cannot silently re-arm a previously running permit.
  if (scope.processIncarnation!==incarnation) fail('TASK_RUN_SCOPE_REARM_REQUIRED')
  if (inbound.has(kind) || planChanges.has(kind)) fail('TASK_RUN_SCOPE_DISPATCH_DENIED')
  let taskId=a.taskId,runId=a.runId
  if (kind==='effect.prepare') runId=a.runId
  if (kind==='effect.begin' || kind==='effect.rearmUnsent') {
    const row=db.prepare('SELECT run_id,definition_json,node_id FROM execution_effects WHERE effect_id=?').get(a.effectId)
    if(!row) fail('TASK_RUN_SCOPE_EFFECT_DENIED')
    runId=row.run_id;assertEffect(JSON.parse(row.definition_json),row.node_id)
  }
  if(runId) taskId=db.prepare('SELECT task_id FROM execution_runs WHERE run_id=?').get(runId)?.task_id
  if(kind.startsWith('task.owner.') && !taskId && a.turnId) taskId=db.prepare('SELECT task_id FROM task_owner_turns WHERE turn_id=?').get(a.turnId)?.task_id
  if(kind==='message.notification.claim') {
    const row=db.prepare("SELECT body FROM message_items WHERE kind='notification' AND item_id=?").get(a.notificationId), n=row&&JSON.parse(row.body)
    const reportId=n?.payload?.phase?.startsWith('owner:')?n.payload.phase.slice(6):null
    const report=reportId&&db.prepare('SELECT r.task_id,t.requirement_revision,t.application_status FROM task_reports r JOIN task_owner_turns t ON t.turn_id=r.turn_id WHERE r.report_id=?').get(reportId)
    if(!scope.allowedEffects.includes('progress')||!report || report.application_status!=='applied'||report.requirement_revision!==scope.requirementRevision || report.task_id!==scope.taskId || n.payload.conversationId!==scope.groupId || n.payload.fact?.taskId!==scope.taskId) fail('TASK_RUN_SCOPE_NOTIFICATION_DENIED')
    taskId=report.task_id
  }
  const guarded=kind==='node.claim'||kind==='run.recovery.admit'||kind.startsWith('task.owner.')&&['claim','accept','applied','retry'].includes(kind.split('.').at(-1))
    ||kind==='task.control.resume'||kind==='task.control.reopen'||kind==='effect.prepare'||kind==='effect.begin'||kind==='effect.rearmUnsent'||kind==='message.notification.claim'||kind==='run.workflow.checkpoint'
  if(guarded && (taskId!==scope.taskId || runId && runId!==scope.runId)) fail('TASK_RUN_SCOPE_DISPATCH_DENIED')
  if(guarded){
    const t=db.prepare('SELECT requirement_revision,plan_revision FROM business_tasks WHERE task_id=?').get(scope.taskId)
    const c=db.prepare('SELECT state,control_revision FROM task_controls WHERE task_id=?').get(scope.taskId)
    if(!t||t.requirement_revision!==scope.requirementRevision||t.plan_revision!==scope.planRevision||!c||!['paused','active'].includes(c.state)
      ||![scope.controlRevision,scope.controlRevision+1].includes(c.control_revision)) fail('TASK_RUN_SCOPE_STALE')
  }
  if(kind==='node.claim' && !scope.nodeIds.includes(a.nodeId)) fail('TASK_RUN_SCOPE_DISPATCH_DENIED')
  if(kind==='node.claim' && !scope.nodeIds.includes(a.nodeId)) fail('TASK_RUN_SCOPE_DISPATCH_DENIED')
  if(kind==='effect.prepare') assertEffect(a.definition,a.nodeId)
  function assertEffect(definition,nodeId){
    const p=definition?.payload,action=definition?.action
    if(!scope.allowedEffects.includes(action)||!p||!['prepare-workspace','apply-changes','run-local-acceptance','commit','push','create-pr'].includes(nodeId)) fail('TASK_RUN_SCOPE_EFFECT_DENIED')
    const roles={workspace:'prepare-workspace',edit:'apply-changes',external:'run-local-acceptance',commit:'commit',push:'push',pr:'create-pr'}
    if(roles[action]!==nodeId) fail('TASK_RUN_SCOPE_EFFECT_DENIED')
    if(action==='external'&&(p.workflowKind!=='local-acceptance'||p.taskId!==scope.taskId||p.runId!==scope.runId)) fail('TASK_RUN_SCOPE_EFFECT_DENIED')
    if(['commit','push'].includes(action)&&(p.remote!==scope.remote||p.ref!==`refs/heads/${scope.head}`)) fail('TASK_RUN_SCOPE_EFFECT_DENIED')
    if(action==='pr'&&(p.repo!==scope.repo||p.head!==scope.head||p.base!==scope.base)) fail('TASK_RUN_SCOPE_EFFECT_DENIED')
  }
}
