import fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {pathToFileURL} from 'node:url'

// 只读 API 与 v4 会话；白名单输出元数据。正文、原始标识、模型流和 reasoning 不落盘。
const [day='2026-10-22', home='D:/dsh_home', base='http://127.0.0.1:18998', outputDirectory] = process.argv.slice(2)
const start=Date.parse(`${day}T00:00:00+08:00`), end=Math.min(Date.now(),start+86400000)
const output=outputDirectory?pathToFileURL(path.resolve(outputDirectory)+path.sep):new URL('../round-1/',import.meta.url)
// 后续采样用第四位置参数指定新轮次，禁止覆盖已经归档的快照。
try {await fs.access(new URL('today-metadata.json',output));throw new Error('AUDIT_SNAPSHOT_EXISTS: select a new output directory with argument 4')}
catch(error){if(error.code!=='ENOENT')throw error}
const alias=id=>createHash('sha256').update(String(id)).digest('hex').slice(0,12)
const time=x=>typeof x==='number'?x:Date.parse(x)
const today=x=>time(x)>=start&&time(x)<end
const bytes=x=>Buffer.byteLength(typeof x==='string'?x:JSON.stringify(x??null))
const plain=x=>typeof x==='string'?x:Array.isArray(x)?x.filter(p=>p.type==='text').map(p=>p.text??'').join('\n'):''
const values=x=>Array.isArray(x)?x:Object.values(x??{})
const groups=await (await fetch(`${base}/state/groups`)).json()
const performance=await (await fetch(`${base}/state/performance?day=${day}`)).json()
const messages=groups.flatMap(g=>values(g.messages).filter(m=>today(m.occurredAt)).map(m=>({...m,group:g})))
const sessions=[], internals=[]
for(const bucket of await fs.readdir(path.join(home,'sessions'),{withFileTypes:true})) if(bucket.isDirectory()) {
  const root=path.join(home,'sessions',bucket.name)
  for(const folder of await fs.readdir(root,{withFileTypes:true})) if(folder.isDirectory()) {
    const file=path.join(root,folder.name,'session.v4.jsonl')
    let stat,raw;try {stat=await fs.stat(file);if(stat.mtimeMs<start)continue;raw=await fs.readFile(file,'utf8')}catch{continue}
    const records=raw.trimEnd().split('\n').map((line,index)=>({e:JSON.parse(line),line:index+1}))
    const seed=records.findLastIndex(({e})=>e.type==='session/end-seed')
    const rows=records.slice(seed+1).filter(({e})=>today(e.time))
    if(!rows.length)continue
    const decisionReplies=new Set()
    const s={session:alias(folder.name),kind:folder.name.startsWith('independent-')?'independent':bucket.name.includes('5F52')?'route':bucket.name.includes('51B3')?'decision':'other',bytes:stat.size,dispatches:[],turns:[],steps:[],tools:[],inputs:[],headers:[],errors:[]}
    const steps=new Map(), calls=new Map(), turns=new Map(), joined=new Set()
    for(const {e,line} of rows) {
      const d=e.data??{}, at=e.time, key=`${d.turn}:${d.step}`
      if(e.type.endsWith('/coordination-dispatched'))s.dispatches.push({line,at,queuedAt:d.queuedAt,dispatchedAt:d.dispatchedAt,
        queueMs:d.dispatchedAt-d.queuedAt,role:d.role,fairnessTurn:d.fairnessTurn,queueDepth:d.queueDepth})
      if(e.type==='turn/start'){const x={at,line};turns.set(d.turn,x);s.turns.push(x)}
      if(e.type==='turn/end')Object.assign(turns.get(d.turn)??{},{end:at,ms:at-(turns.get(d.turn)?.at??at),reason:d.reason?.kind})
      if(e.type==='step/start'){const x={step:d.step,at,line};steps.set(key,x);s.steps.push(x)}
      if(e.type==='assistant/message') {
        const x=steps.get(key);if(x)Object.assign(x,{responseAt:at,modelMs:at-x.at,usage:d.usage,model:d.message?.source?.model})
      }
      if(e.type==='step/end'){const x=steps.get(key);if(x)Object.assign(x,{end:at,ms:at-x.at})}
      if(e.type==='request/header')s.headers.push({at,line,bytes:bytes(d.header)})
      if(e.type==='user/message') {
        const text=plain(d.content)
        let input;try {input=JSON.parse(text)}catch{try{input=JSON.parse(text.slice(text.indexOf('{')).split('\n')[0])}catch{}}
        const ids=input?.source?.messageId?[input.source.messageId]:input?.ownedDeltaMessageIds??input?.messages?.map(m=>m.messageId)??[]
        for(const m of messages)if(ids.includes(m.messageId))joined.add(m.messageId)
        s.inputs.push({at,line,bytes:bytes(d.content)})
      }
      if(e.type==='tool/call') {
        let args=d.arguments;try{if(typeof args==='string')args=JSON.parse(args)}catch{}
        const x={at,line,step:d.step,name:d.name,argBytes:bytes(d.arguments),argumentKeys:Object.keys(args??{}),
          taskIdCount:args?.taskIds?.length,limit:args?.limit,offset:args?.offset,proposalKind:args?.kind,
          topic:args?.topicId?alias(args.topicId):undefined,query:typeof args?.query==='string'?{chars:args.query.length,alias:alias(args.query)}:undefined}
        if(d.name==='group_decision_submit'&&args?.decision?.reply)decisionReplies.add(args.decision.reply)
        if(d.name==='group_decision_submit')x.decision={keys:Object.keys(args?.decision??{}),replyChars:args?.decision?.reply?.length,
          actionKinds:args?.decision?.actions?.map(a=>a.kind),review:args?.decision?.replyReview?{
            keys:Object.keys(args.decision.replyReview),kind:args.decision.replyReview.kind,
            reviewed:args.decision.replyReview.reviewedOutboundIds?.length,sameMatter:args.decision.replyReview.sameMatterOutboundIds?.length,
            replace:args.decision.replyReview.replaceOutboundIds?.length}:null}
        calls.set(d.callId,x);s.tools.push(x)
      }
      if(e.type==='tool/result'&&e.surfaceOp?.op!=='replace') {
        const msg=d.message, x=calls.get(msg?.toolCallId??msg?.source?.callId??d.callId)
        const text=plain(msg?.content)
        let result;try{result=JSON.parse(text)}catch{}
        const errorText=msg?.isError?text:JSON.stringify(result?.error??null)
        const codes=[...new Set(errorText.match(/\b(?:(?:COORDINATION|DYNAMIC|TOPIC|TASK|SOURCE)_[A-Z_]+|(?:group|topic|task|coordination)_[a-z_]+)\b/g)??[])]
        if(typeof result?.error==='string'&&/^[A-Za-z_]+$/.test(result.error))codes.push(result.error)
        const resultStatus=typeof result?.status==='string'&&/^[a-z_-]+$/.test(result.status)?result.status:undefined
        if(x)Object.assign(x,{end:at,ms:at-x.at,resultBytes:bytes(msg?.content),isError:msg?.isError===true,codes,resultStatus,resultLine:line,
          resultKeys:result?Object.keys(result):undefined,hasMore:result?.hasMore,hasMoreTopics:result?.hasMoreTopics,
          hasMoreMessages:result?.hasMoreMessages,
          nextOffset:result?.nextOffset,reused:result?.reused,topicCount:result?.topics?.length,messageCount:result?.messages?.length})
        if(msg?.isError||codes.length)s.errors.push({line,at,name:x?.name,codes})
      }
    }
    s.messageRefs=[...joined].map(alias)
    // 独立规划的 request 与消息身份关联来自只读 ownership 快照，不输出原始身份。
    for(const m of messages)for(const o of values(m.group.sourceDispatchOwnership)) {
      if(o.sourceSnapshot?.messageId===m.messageId&&folder.name.includes(o.reservationId))joined.add(m.messageId)
    }
    s.messageRefs=[...joined].map(alias)
    sessions.push(s);internals.push({s,joined,decisionReplies})
  }
}
const resultMessages=messages.map(m=>{
  const sourceOccurredAt=time(m.occurredAt), outbox=values(m.group.outbox).filter(o=>o.replyToMessageId===m.messageId||o.sourceMessageId===m.messageId)
    .filter(o=>time(o.deliveredAt)>=sourceOccurredAt).sort((a,b)=>time(a.deliveredAt)-time(b.deliveredAt))
  const stages=internals.filter(x=>x.joined.has(m.messageId)).map(({s})=>({session:s.session,kind:s.kind,start:s.turns[0]?.at,end:s.turns.at(-1)?.end,
    turns:s.turns.length,steps:s.steps.length,modelMs:s.steps.reduce((n,x)=>n+(x.modelMs??0),0),toolErrors:s.errors.length})).sort((a,b)=>a.start-b.start)
  const reply=outbox[0]
  const independentClarification=internals.some(({s,joined})=>joined.has(m.messageId)&&s.kind==='independent'
    &&s.tools.some(x=>x.name==='coordination_submit'&&x.proposalKind==='clarify'&&!x.isError))
  const replyClassification=!reply?'no-retained-related-reply':reply.replyKind==='confirmation'?'confirmation'
    :internals.some(x=>x.joined.has(m.messageId)&&x.decisionReplies.has(reply.text))?'exact-decision-reply'
      :independentClarification?'coordination-clarification':'related-substantive-unverified'
  return {message:alias(m.messageId),sourceOccurredAt,processingCompletedAt:m.processingCompletedAt,agentDeliveryAt:m.agentDeliveryAt,
    sourceKind:m.sourceKind,processingSentAt:m.processingSentAt,routingStatus:m.routingStatus,textChars:m.text?.length,
    earliestRelatedReplyMs:reply?time(reply.deliveredAt)-sourceOccurredAt:null,replyClassification,
    eligibleForAdmissionLatency:['confirmation','exact-decision-reply','coordination-clarification'].includes(replyClassification),
    replies:outbox.map(o=>({status:o.status,replyKind:o.replyKind,sendStartedAt:o.sendStartedAt,deliveredAt:o.deliveredAt,
      sendMs:time(o.deliveredAt)-time(o.sendStartedAt)})),stages}
}).sort((a,b)=>a.sourceOccurredAt-b.sourceOccurredAt)
const result={day,start,end,coverage:{api:performance.coverage,completeness:performance.completeness,performanceRows:performance.rows.length,
  sessions:sessions.length,messages:messages.length,limitations:['只统计当日仍保留的消息与已投影outbox；sourceOccurredAt为消息发生时间，不是独立本机入站时钟。','会话关联以输入含消息ID或来源ownership为准，跨消息共享会话不等于独占耗时。','modelMs是step开始至assistant/message，包含本地准备与网络；不声称纯provider推理耗时。']},messages:resultMessages,sessions}
await fs.mkdir(output,{recursive:true})
await fs.writeFile(new URL('today-metadata.json',output),JSON.stringify(result,null,2)+'\n')
console.log(JSON.stringify({coverage:result.coverage,messages:resultMessages.map(m=>({message:m.message,sourceOccurredAt:m.sourceOccurredAt,
  earliestRelatedReplyMs:m.earliestRelatedReplyMs,replyClassification:m.replyClassification,eligibleForAdmissionLatency:m.eligibleForAdmissionLatency,stages:m.stages,replies:m.replies}))},null,2))
