import { DatabaseSync } from 'node:sqlite'
import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
const { values } = parseArgs({ options: { check: { type: 'boolean', default: true }, db: { type: 'string' }, instance: { type: 'string' }, output: { type: 'string' }, 'catalog-url': { type: 'string' } } })
if (!values.db || !values.instance || !values.check) throw Error('USAGE: --check --db PATH --instance ID [--output NEW_PATH] [--catalog-url URL]')
const dbPath = values.db
const selected=['task-analysis','task-general','task-intake','task-general-intake','task-general-capability','task-investigation','task-planning','task-pr-review','task-data-query','task-retrospective']
const db=new DatabaseSync(dbPath,{readOnly:true})
let result
try{
 db.exec('BEGIN')
 const meta=db.prepare('SELECT instance_id,schema_version FROM execution_meta WHERE singleton=1').get()
 if(meta.instance_id!==values.instance)throw Error('INVENTORY_INSTANCE_MISMATCH')
 const placeholders=selected.map(()=>'?').join(',')
 const runs=db.prepare(`SELECT run_id,task_id,workflow_id,workflow_digest,status,generation,created_at,updated_at FROM execution_runs WHERE workflow_id IN (${placeholders}) ORDER BY created_at`).all(...selected)
 const stages=db.prepare(`SELECT s.task_id,s.plan_revision,s.stage_id,s.position,s.workflow_id,s.workflow_digest,s.status,s.run_id,t.status task_status,c.state control_state,(s.plan_revision=t.plan_revision) current_plan FROM task_plan_stages s JOIN business_tasks t ON t.task_id=s.task_id LEFT JOIN task_controls c ON c.task_id=t.task_id WHERE s.workflow_id IN (${placeholders}) ORDER BY s.task_id,s.plan_revision,s.position`).all(...selected)
 const definitions=db.prepare('SELECT body FROM message_workflows').all().map(row=>JSON.parse(row.body)).filter(r=>selected.includes(r.workflowId)).map(r=>({workflowId:r.workflowId,definitionVersion:r.definitionVersion,digest:r.digest,kind:r.config?.kind??null}))
 const activeRuns=runs.filter(r=>!['succeeded','failed','cancelled'].includes(r.status))
 const activeStages=stages.filter(s=>s.current_plan&&s.control_state!=='cancelled'&&s.task_status!=='succeeded'&&!['succeeded','invalidated'].includes(s.status))
 const commandReferences=[]
 for(const row of db.prepare("SELECT item_id,run_id,body FROM message_items WHERE kind='command'").all()){
  const body=JSON.parse(row.body),ids=new Set()
  const find=value=>{if(typeof value==='string'&&selected.includes(value))ids.add(value);else if(value&&typeof value==='object')for(const child of Object.values(value))find(child)};find(body)
  if(ids.size)commandReferences.push({commandId:row.item_id,runId:row.run_id,status:body.status,workflowIds:[...ids]})
 }
 const counts=selected.map(workflowId=>({workflowId,runs:runs.filter(r=>r.workflow_id===workflowId).length,runStatuses:Object.fromEntries([...new Set(runs.filter(r=>r.workflow_id===workflowId).map(r=>r.status))].map(status=>[status,runs.filter(r=>r.workflow_id===workflowId&&r.status===status).length])),activeRuns:activeRuns.filter(r=>r.workflow_id===workflowId).length,historicalStageReferences:stages.filter(s=>s.workflow_id===workflowId).length,activeCurrentStages:activeStages.filter(s=>s.workflow_id===workflowId).length,registeredDefinitions:definitions.filter(d=>d.workflowId===workflowId).length}))
 const busyNodes=db.prepare(`SELECT n.node_run_id,n.node_id,n.status,n.drained,r.run_id,r.workflow_id FROM execution_nodes n JOIN execution_runs r ON r.run_id=n.run_id WHERE n.current=1 AND (n.status='running' OR n.drained=0) AND r.workflow_id IN (${placeholders})`).all(...selected)
 const effects=db.prepare(`SELECT e.* FROM execution_effects e JOIN execution_runs r ON r.run_id=e.run_id WHERE r.workflow_id IN (${placeholders})`).all(...selected).map(e=>({effectId:e.effect_id,runId:e.run_id,state:e.state,kind:e.kind}))
 result={commandReferences,observedAt:new Date().toISOString(),database:dbPath,meta,counts,activeRuns,activeStages,busyNodes,effects,runs,stages,definitions}
 db.exec('ROLLBACK')
}finally{db.close()}
const found=[]
if(values['catalog-url']) {
const response=await fetch(values['catalog-url'],{signal:AbortSignal.timeout(10000)})
if(!response.ok)throw Error('INVENTORY_CATALOG_UNAVAILABLE')
const catalog=await response.json()
// 目录只记录流程身份/版本/可发起性，不输出配置或业务正文。
const walk=value=>{if(!value||typeof value!=='object')return;const id=value.workflowId??value.id;if(selected.includes(id))found.push({id,version:value.version??value.definitionVersion??null,available:value.available??value.startable??null});for(const child of Object.values(value))walk(child)};walk(catalog)
}
result.liveCatalog=found
if(values.output) await writeFile(values.output,JSON.stringify(result,null,2),{flag:'wx'})
console.log(JSON.stringify({observedAt:result.observedAt,counts:result.counts,activeRuns:result.activeRuns,activeStages:result.activeStages,busyNodes:result.busyNodes,effects:result.effects,commandReferences:result.commandReferences,liveCatalog:found}))
