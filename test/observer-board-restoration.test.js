import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
const durationComponent = source.slice(source.indexOf('    function ExecutionSessionDuration('), source.indexOf('    function TaskResult('))
assert.match(durationComponent, /^    function ExecutionSessionDuration\(/)
const flatten = tree => typeof tree !== 'object' || !tree ? [] : [tree, ...tree.children.flatMap(flatten)]
function card(task) {
 const actions = []
 const render = runInNewContext(`(()=>{${durationComponent}\n${source.slice(source.indexOf('      const renderTaskCard ='), source.indexOf('      const alertCategories ='))};return renderTaskCard})()`, {
  expandedTaskId:'card-copy',setExpandedTaskId(){},Button:'button',archivingIds:[],archiveTask:task=>actions.push(['archive',task.taskId]),copyButton:(id,label)=>({type:'button',props:{onClick:()=>actions.push(['copy',id])},children:[`复制${label}`]}),React: {createElement:(type, props,...children)=>({type,props:props||{},children:children.flat()})}, groupsById:new Map([['g',{name:'运维群'}]]),topicsById:new Map([['g:topic',{title:'服务上线'}]]), taskSession:task=>task.session||{},hoveredTaskId:'',setHoveredTaskId(){},colors:{border:'gray',cardSurface:'white',muted:'gray',accent:'blue',warning:'orange'},pill:()=>({}),taskDisplayTitle:task=>task.title,short:value=>value.slice(0,14),taskStateTone:()=> 'ongoing',taskStateLabel:state=>state,StateDot:'dot',fmt:value=>value,
  navigatingSessionId:'',navigate:(id,parent)=>actions.push(['session',id,parent]), statusTag:(label)=>({type:'span',props:{},children:[label]}),openTask:task=>actions.push(['task',task.taskId]),setTopicTarget:value=>actions.push(['topic',value.topicId]),setActivePage:value=>actions.push(['page',value])
 }); return {tree:render(task),actions}
}

test('只有已结束桶的未归档当前任务显示归档按钮',()=>{
 for (const state of ['queued','running','waiting','paused','blocked','interrupted','completed','cancelled','succeeded','failed']) {
  const nodes=flatten(card({taskId:'t',title:'任务',state}).tree)
  assert.equal(nodes.some(x=>x.props['aria-label']==='归档任务：任务'), ['completed','cancelled','succeeded','failed'].includes(state), state)
  assert.equal(nodes.some(x=>x.children.includes('已归档')),false,state)
 }
 for (const extra of [{archivedAt:'now'},{legacyReadonly:true}]) {
  assert.equal(flatten(card({taskId:'t',title:'任务',state:'completed',...extra}).tree).some(x=>x.props['aria-label']==='归档任务：任务'),false)
 }
})
test('原看板紧凑卡片恢复，完整目标及话题仍能通过原有入口查看',()=>{
 const {tree,actions}=card({taskId:'t',title:'核对服务',objective:'长目标'.repeat(50),sourceGroupId:'g',state:'queued',updatedAt:'now',session:{sessionId:'session'},executionCount:7,topicRefs:[{topicId:'topic'}]})
 assert.equal(tree.props.style.padding,'11px 13px');assert.equal(tree.props.style.gap,6);assert.equal(tree.props.style.opacity,.72)
 const nodes=flatten(tree);assert.equal(nodes.find(x=>x.type==='strong').props.style.fontSize,13)
 nodes.find(x=>x.type==='button' && x.children.some(y=>y?.type==='strong')).props.onClick()
 nodes.find(x=>x.props['aria-label']==='查看完整任务目标').props.onClick()
 nodes.find(x=>x.props['aria-label']==='话题 服务上线').props.onClick({stopPropagation(){}})
 assert.deepEqual(actions,[['task','t'],['task','t'],['topic','topic'],['page','topics']])
 assert.doesNotMatch(JSON.stringify(tree),/次动态执行|任务会话 session/);assert.equal(nodes.some(x=>x.props['aria-label']?.startsWith('任务状态：')),false);assert.doesNotMatch(JSON.stringify(tree),/progressbar|workflowProgress/)
})
test('历史卡片保留只读状态，不恢复旧归档或工作流写入口',()=>{
 const {tree}=card({taskId:'old',title:'历史任务',objective:'历史目标',state:'completed',legacyReadonly:true})
 assert.match(JSON.stringify(tree),/历史只读/)
 assert.doesNotMatch(JSON.stringify(tree),/确认归档|检查点|重新执行/)
 assert.match(source,/repeat\(4, minmax\(300px, 1fr\)\)/)
 assert.match(source,/padding: '8px 4px'/)
 assert.match(source,/overflowY: 'auto', scrollbarWidth: 'none'/)
})
test('原四列局部滚动保留，空列和大量任务分页有界，窄屏仅改变列数',()=>{
 const render = data => runInNewContext(`(()=>{${source.slice(source.indexOf('      const bucketColumns ='),source.indexOf('      const menu ='))};return bucketColumns})()`,{
  React:{createElement:(type,props,...children)=>({type,props:props||{},children:children.flat()})},data,taskBuckets:[{state:'running',label:'执行中',tone:'blue',background:'white'}],taskPages:{running:99},renderTaskCard:task=>({type:'article',props:{taskId:task.taskId},children:[]}),colors:{border:'gray',muted:'gray',cardSurface:'white'},Button:'button',setTaskPages(){}
 })
 const empty=render({tasks:[]})[0];assert.equal(empty.props.style.borderRadius,14);assert.equal(empty.props.style.flexDirection,'column');assert.equal(empty.props.style.overflow,'hidden')
 assert.ok(flatten(empty).some(x=>x.children.includes('暂无任务')))
 const column=render({tasks:Array.from({length:27},(_,i)=>({taskId:`t${i}`,state:'running',updatedAt:String(i)}))})[0]
 assert.equal(flatten(column).filter(x=>x.type==='article').length,7)
 const scroll=flatten(column).find(x=>x.props.style?.overflowY==='auto');assert.equal(scroll.props.style.flex,1);assert.equal(scroll.props.style.minHeight,0)
 const buttons=flatten(column).filter(x=>x.type==='button');assert.equal(buttons.at(-1).props.disabled,true)
 assert.match(source,/@media \(max-width: 960px\)[\s\S]*?observer-task-board \{ grid-template-columns: repeat\(2, minmax\(280px, 1fr\)\)/)
 assert.match(source,/@media \(max-width: 720px\)[\s\S]*?observer-task-board \{ grid-template-columns: minmax\(0, 1fr\)/)
})

test('卡片空白与底栏可点，内部按钮不会重复导航，等待原因恢复两行截断',()=>{
 const {tree,actions}=card({taskId:'t',title:'等待输入',objective:'目标',state:'waiting',waitingReason:'等待原因'.repeat(50)})
 tree.props.onClick({target:{closest:()=>null}})
 tree.props.onClick({target:{closest:()=>({})}})
 assert.deepEqual(actions,[['task','t']])
 const reason=flatten(tree).find(x=>x.children.includes('等待原因'.repeat(50)))
 assert.equal(reason.props.style.WebkitLineClamp,2);assert.equal(reason.props.style.overflow,'hidden')
})

test('真实任务卡片展示全部会话名称及状态；点击原生入口不重复导航',()=>{
 const executionSessions=Array.from({length:43},(_,i)=>({executionId:`e${i}`,sessionId:`s${i}`,title:`核对服务${i}`,status:i%2?'running':'succeeded'}))
 const {tree,actions}=card({taskId:'t',title:'完整列表',state:'running',executionSessions})
 const list=flatten(tree).find(x=>x.props['aria-label']==='全部执行会话')
 const buttons=flatten(list).filter(x=>x.type==='button')
 assert.equal(buttons.length,43);assert.match(JSON.stringify(list),/核对服务42/);assert.match(JSON.stringify(list),/succeeded/)
 buttons[42].props.onClick();assert.deepEqual(actions,[['session','s42',undefined]])
})

test('内嵌执行列表只按真实成功会话计数，支持单展开和归档',()=>{
 const {tree,actions}=card({taskId:'card-copy',title:'检查',state:'completed',executionSessions:[{executionId:'a',sessionId:'sa',title:'会话甲',status:'succeeded'},{executionId:'b',sessionId:'sb',title:'会话乙',status:'running'},{executionId:'c',sessionId:'sc',title:'会话丙',status:'failed'}]})
 const nodes=flatten(tree),list=nodes.find(x=>x.props['aria-label']==='全部执行会话')
 assert.equal(list.type,'details');assert.equal(list.props.open,true)
 const meter=nodes.find(x=>x.type==='meter');assert.equal(meter.props.max,3);assert.equal(meter.props.value,1);assert.equal(meter.props['aria-label'],'已完成执行会话数量')
 assert.match(JSON.stringify(list),/1\/3/)
 assert.deepEqual(flatten(list).filter(x=>x.props.role==='img').map(x=>x.props['aria-label']),['succeeded','running','failed'])
 let stopped=false;nodes.find(x=>x.props['aria-label']==='归档任务：检查').props.onClick({stopPropagation(){stopped=true}});assert.equal(stopped,true);assert.deepEqual(actions,[['archive','card-copy']])
})

test('卡片不展示整体状态badge或内部元信息，保留执行行状态',()=>{
 const {tree}=card({taskId:'t',title:'核对',state:'waiting',session:{sessionId:'INTERNAL_SECRET_SESSION'},executionCount:123,executionSessions:[{sessionId:'e',title:'会话甲',status:'running'}]})
 const nodes=flatten(tree)
 assert.equal(nodes.some(x=>x.props['aria-label']?.startsWith('任务状态：')),false)
 assert.equal(tree.children[0].type,'button')
 assert.doesNotMatch(JSON.stringify(tree),/INTERNAL_SECRET_SESSION|次动态执行/)
 assert.ok(nodes.some(x=>x.props['aria-label']==='全部执行会话'))
 assert.match(JSON.stringify(tree),/running/)
})
