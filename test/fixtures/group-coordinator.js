import assert from 'node:assert/strict'

// 多个 service suite 共用正式常驻会话接口；没有旧 stage 转换。
export function scriptedCoordinator(decide, beforeSubmit) {
 return { async close() {}, async run(args) {
  await args.onSessionBound()
  await beforeSubmit?.(args)
  const decisions=[]
  for(const source of args.input.sources) {
   assert.ok(decide,'此执行恢复fixture不得处理新用户来源')
   decisions.push(await decide(source,args.input))
  }
  await args.onCandidate({decisions})
  return {status:'submitted'}
 } }
}
export function actionDecision(source, actions, {candidate=null,replyPolicy='result'}={}) {
 return {runId:source.runId,reason:'测试中明确业务请求',units:[{spans:[{start:0,end:source.body.length}],goalText:source.body,
  binding:{disposition:candidate?'existing':'new',candidateId:candidate?.candidateId??null},
  intent:{kind:'intent',actions,constraints:[],requiredExecutionMaterials:[],replyPolicy}}]}
}
