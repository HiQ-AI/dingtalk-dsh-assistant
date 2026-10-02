import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { describeMessageTraceItem } from '../packages/dingtalk-dsh-assistant/workflow-service.js'
import { runInNewContext } from 'node:vm'

test('消息与话题详情只展示有绑定的会话并支持分页', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  assert.match(source, /message\.runId \? React\.createElement\(Button[\s\S]*'处理过程'/)
  assert.match(source, /\/state\/workflows\/\$\{encodeURIComponent\(runId\)\}\/trace/)
  assert.match(source, /\/state\/workflows\/topics\/\$\{encodeURIComponent\(selection\.topicId\)\}\/context/)
  assert.match(source, /sessionId \? React\.createElement\('button'/)
  assert.match(source, /setCursorHistory\(\(items\) => \[\.\.\.items, cursor\]\)/)
  assert.match(source, /intentNextCursor/)
  assert.match(source, /判断批次分页/)
  assert.match(source, /查看本次判断/)
  assert.match(source, /重新读取当前上下文/)
})

test('精简判断轨迹不包含技术详情，并展示容量受阻原因', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  const reasonCode = source.slice(source.indexOf('const traceReason = ') + 'const traceReason = '.length, source.indexOf('    const readableValue ='))
  const reason = runInNewContext(`(${reasonCode})`)
  assert.match(reason('MESSAGE_CONTEXT_CAPACITY:IB:$:33000/32000'), /上下文容量受阻.*后续判断已停止/)
  assert.match(reason('MESSAGE_MATERIAL_CAPACITY:R:u1'), /必要材料未能完整提供/)
  assert.equal(reason({ code: 'FAILED' }), '{"code":"FAILED"}')
  assert.match(reason('ENGINEERING_ACCEPTANCE_REQUIRED'), /缺少业务验收.*后续提交已停止/)
  assert.match(reason('ENGINEERING_ACCEPTANCE_FAILED'), /业务验收未通过.*后续提交已停止/)
})

test('收信箱区分话题关联等待与意图重判，任务详情展示业务计划阶段', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  assert.match(source, /message\.workflowStatus/)
  assert.match(source, /waiting_routing_barrier: \{ label: '核对相关输入'/)
  assert.match(source, /intent_judging: \{ label: '话题意图判断中'/)
  assert.match(source, /intent_rejudging: \{ label: '新消息加入 · 重新判断'/)
  assert.match(source, /routing_blocked: \{ label: '关联受阻'/)
  assert.match(source, /selectedWorkflowTask\.plan\.stages\.map/)
  assert.match(source, /waiting_confirmation: '等待人工确认'/)
  assert.match(source, /'aria-label': '任务阶段'/)
})

test('收信箱分开表达材料读取责任及通知回读，详情可用键盘展开', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  assert.match(source, /waiting_context: \{ label: '正在读取材料'/)
  assert.match(source, /waiting_clarification: \{ label: '等待用户补充'/)
  assert.match(source, /waiting_system: \{ label: '材料读取受阻'/)
  assert.match(source, /React\.createElement\('details'[\s\S]*React\.createElement\('summary'[\s\S]*'等待与通知'/)
  assert.match(source, /message\.blockingSources/)
  assert.match(source, /恢复条件/)
  assert.match(source, /acknowledged: '已确认发送，待回读'/)
  assert.match(source, /unknown: '发送结果待核对'/)
  assert.match(source, /delivered: '已回读送达'/)
})

test('运行看板保留左侧菜单并替换右侧整体内容', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  assert.match(source, /ctx\.slots\.inject\('conversation'/)
  assert.match(source, /name: 'conversation'/)
  assert.match(source, /id: 'dingtalk-dsh-observer'/)
  assert.match(source, /name: 'sidebar\.footer\.action'/)
  assert.match(source, /id: 'dingtalk-dsh-observer-entry'/)
  assert.match(source, /钉钉群聊运行看板/)
  assert.match(source, /onClick: \(\) => setOpen\(true\)/)
  assert.match(source, /closest\('\[role="treeitem"\]'\)/)
  assert.match(source, /await openSession\(sessionId, parentSessionId\); setOpen\(false\)/)
  assert.match(source, /getComputedStyle\(element\)\.backgroundColor/)
  assert.match(source, /element\.setAttribute\('aria-selected', 'false'\)/)
  assert.match(source, /name\.endsWith\('_selected'\)/)
  assert.match(source, /restoreSessionSelection\(\)/)
  assert.match(source, /outline: 'none', boxShadow: 'none'/)
  assert.match(source, /display: 'grid', gap: 4, padding: '12px 28px 0 20px'/)
  assert.match(source, /height: 32, boxSizing: 'border-box'/)
  assert.match(source, /padding: '4px 8px', fontSize: 14, fontWeight: 500, lineHeight: '20px'[\s\S]*'运行看板'/)
  assert.match(source, /height: 27[\s\S]*gap: 36[\s\S]*padding: '0 0 0 8px'/)
  assert.match(source, /padding: `0 0 \$\{paddingBottom\}px`[\s\S]*fontSize: ui\.textMd, fontWeight: 500, lineHeight: '20px'/)
  assert.match(source, /React\.createElement\(StateDot, \{ state: updatedAt \? 'done' : 'ongoing', size: 7 \}\)/)
  assert.match(source, /const refreshIcon = React\.createElement\('svg'/)
  assert.match(source, /const manualRefresh = useCallback/)
  assert.match(source, /disabled: refreshState === 'refreshing', onClick: manualRefresh/)
  assert.match(source, /refreshState === 'refreshing' \? '刷新中' : refreshState === 'done' \? '已刷新' : '刷新'/)
  assert.match(source, /'aria-label': updatedAt[\s\S]*gap: 12[\s\S]*React\.createElement\('span', \{ style: \{ display: 'inline-flex', alignItems: 'center', gap: 7 \} \}/u)
  assert.match(source, /updatedAt \? '运行正常' : '正在连接'/)
  assert.match(source, /`更新于 \$\{fmtTime\(updatedAt\)\}`/)
  assert.doesNotMatch(source, /`运行态 · \$\{updatedAt/)
  assert.match(source, /height: 27, display: 'flex'/)
  assert.doesNotMatch(source, /const pageHeader = \(title, description\)/)
  assert.doesNotMatch(source, /Pill, null, String\(count\)/)
  assert.match(source, /const main = React\.createElement\('main', \{ className: 'observer-main', style: \{ width: '100%'/)
  assert.doesNotMatch(source, /maxWidth: activePage === 'tasks'/)
  assert.match(source, /style: navigationTabStyle\(activePage === page\.id\)/)
  assert.match(source, /borderRadius: 999/)
  assert.doesNotMatch(source, /conversation\.view/)
  assert.match(source, /disposeContent = ctx\.slots\.register/)
  assert.match(source, /priority: -10/)
  assert.match(source, /disposeContent\(\)/)
  assert.doesNotMatch(source, /shell\.overlay/)
  assert.doesNotMatch(source, /position: 'fixed', inset: 0, paddingLeft/)
  assert.doesNotMatch(source, /ResizeObserver/)
  assert.doesNotMatch(source, /MutationObserver/)
  assert.doesNotMatch(source, /data-dingtalk-board-backdrop/)
  assert.match(source, /运行看板/)
  assert.match(source, /require\('@deepseek-ai\/dsh-client-ui-primitives'\)/)
  assert.match(source, /React\.createElement\(Button, \{ variant: 'outline', size: 'sm'/)
  assert.match(source, /React\.createElement\(StateDot/)
  assert.match(source, /React\.createElement\(Pill/)
  assert.match(source, /\/state\/groups/)
  assert.match(source, /\/state\/tasks/)
  assert.doesNotMatch(source, /\/state\/activities/)
  assert.match(source, /\/state\/supervisor\/alerts/)
  assert.match(source, /state: 'queued'/)
  assert.match(source, /state: 'running'/)
  assert.match(source, /state: 'waiting'/)
  assert.doesNotMatch(source, /正在调用工具|当前工具/)
  assert.match(source, /'aria-label': '任务目标'/)
  assert.doesNotMatch(source, /IconGoalOutline16/)
  assert.doesNotMatch(source, /\), '任务目标'\)/)
  assert.match(source, /display: 'block', maxHeight: '4\.5em', overflow: 'hidden'/)
  assert.match(source, /role: 'img', 'aria-label': '任务目标', style: \{ display: 'inline-block', verticalAlign: -2, marginRight: 5, color: colors\.muted \}/)
  assert.match(source, /React\.createElement\('circle', \{ cx: 8, cy: 8, r: 5\.5 \}\)/)
  assert.match(source, /IconChecklistOutline14/)
  assert.match(source, /'aria-label': '任务' \}\), '任务'/)
  assert.match(source, /role: 'progressbar', 'aria-label': '检查点进度'/)
  assert.match(source, /style: \{ minHeight: 24, boxSizing: 'border-box', display: 'flex'/)
  assert.match(source, /flex: '1 1 auto', minWidth: 24, height: 4/)
  assert.match(source, /IconChevronDownOutline14/)
  assert.match(source, /IconChevronUpOutline14/)
  assert.match(source, /data-task-card-action.*toggle-checkpoints/)
  assert.match(source, /'aria-expanded': checkpointsExpanded/)
  assert.match(source, /showCheckpoints \? React\.createElement\('section', null/)
  assert.doesNotMatch(source, /paddingTop: showCheckpoints \? 3 : 0/)
  assert.doesNotMatch(source, /gap: 8, padding: '7px 9px', fontSize: 10\.5/)
  assert.match(source, /checkpointsExpanded \? React\.createElement\('div', \{ style: \{ display: 'grid', gap: 4, padding: '2px 9px 9px'/)
  assert.doesNotMatch(source, /checkpoints\.slice\(0, 4\)/)
  assert.match(source, /maxWidth: 1320.*margin: '0 auto'/)
  assert.match(source, /repeat\(4, minmax\(300px, 1fr\)\)/)
  assert.match(source, /background: bucket\.background, padding: '8px 4px'/)
  assert.match(source, /repeat\(4, minmax\(300px, 1fr\)\)', gap: ui\.space3/)
  assert.doesNotMatch(source, /background: bucket\.background, boxShadow:/)
  assert.match(source, /color-mix\(in srgb, \$\{colors\.muted\} 22%, transparent\)/)
  assert.match(source, /startsWith\('\[TASK_SOURCE_EVIDENCE\]'\) \? \(task\.title \|\| task\.objective\) : task\.objective/)
  assert.match(source, /completedCheckpointCount.*checkpoints\.length/su)
  assert.match(source, /const completedCheckpointNames = new Set\(boardStages\.filter\(stage => stage\.completed\)/)
  assert.doesNotMatch(source, /new Set\(task\.state === 'completed' \? checkpoints/)
  assert.match(source, /群通知待确认送达/)
  assert.match(source, /currentCheckpoint = task\.state === 'running' \? checkpoints\.find/)
  assert.doesNotMatch(source, /latestCheckpoint\?\.nextStep === checkpoint/)
  assert.match(source, /style: \{ color: 'inherit', display: '-webkit-box'/)
  assert.match(source, /StateDot, \{ state: 'ongoing', size: 10 \}/)
  assert.match(source, /checkpointDuration\(checkpointLabel\(checkpoint\), currentCheckpointEvents, Date\.now\(\)\)/)
  assert.match(source, /title: node \? '本次执行耗时' : `执行时长 \$\{duration\}`/)
  assert.match(source, /gridTemplateColumns: '12px minmax\(0,1fr\) max-content'/)
  assert.match(source, /const CheckpointDoneIcon = \(\{ size = 12 \}\)/)
  assert.match(source, /completed \? React\.createElement\(CheckpointDoneIcon, \{ size: 12 \}\)/)
  assert.match(source, /color: colors\.muted, textAlign: 'right', whiteSpace: 'nowrap'/)
  assert.match(source, /'aria-label': '最后活动时间'/)
  assert.match(source, /marginTop: 0, paddingTop: 6, borderTop:/)
  assert.match(source, /'aria-label': '任务目标'/)
  assert.doesNotMatch(source, /`最后活动 \$\{fmt\(task\.updatedAt\)\}`\),/)
  assert.match(source, /checkpointEvents\.findLastIndex\(\(checkpoint\) => checkpoint\.kind === 'plan-confirmed'\)/)
  assert.match(source, /const checkpoints = boardStages\.map\(stage => stage\.stageId\)/)
  assert.doesNotMatch(source, /checkpointEvents\.flatMap\(\(checkpoint\) => \[\.\.\.\(checkpoint\.completedItems/)
  assert.doesNotMatch(source, /\$\{selectedGroup\.messages\?\.length \|\| 0\} 条消息/)
  assert.doesNotMatch(source, /selectedGroup\.messages\?\.at\?\.\(-1\)/)
  assert.match(source, /state: 'completed', label: '已结束'/)
  assert.match(source, /task\.state === 'completed'/)
  assert.match(source, /id: 'groups', label: '群消息'/)
  assert.match(source, /任务看板/)
  assert.match(source, /height: 'calc\(100dvh - 116px\)', minHeight: 420, maxHeight: 'calc\(100dvh - 116px\)'/)
  assert.doesNotMatch(source, /const pageHeader/)
  assert.doesNotMatch(source, /const sectionHeader/)
  assert.match(source, /const tableBodyContent = \{ display: '-webkit-box', WebkitLineClamp: 2/)
  assert.match(source, /const clampTableContent = \(\.\.\.children\)/)
  assert.match(source, /'话题处理'\), React\.createElement\('th',[\s\S]*'发送人 \/ 时间'\), React\.createElement\('th',[\s\S]*'消息内容'/)
  assert.match(source, /gridTemplateColumns: '104px minmax\(220px, 1\.1fr\) minmax\(280px, 1\.5fr\) 126px 52px'/)
  assert.match(source, /minHeight: 'calc\(100dvh - 138px\)'/)
  assert.match(source, /minHeight: 'calc\(100dvh - 90px\)'/)
  assert.match(source, /padding: activePage === 'tasks' \? `\$\{ui\.space6\}px \$\{ui\.space6\}px 0` : `\$\{ui\.space6\}px \$\{ui\.space6\}px \$\{ui\.space6 \+ ui\.space2\}px`/)
  assert.doesNotMatch(source, /max\(1000px/)
  assert.match(source, /boxSizing: 'border-box'/)
  assert.match(source, /overflowY: 'auto', scrollbarWidth: 'none'/)
  assert.doesNotMatch(source, /activePage === 'tasks' \? 1480 : 1240/)
  assert.match(source, /归档任务/)
  assert.match(source, /id: 'alerts', label: '告警'/)
  assert.match(source, /id: 'tasks', label: '任务看板' \}, \{ id: 'authorizations', label: '人工介入'/)
  assert.match(source, /\/state\/authorizations/)
  assert.match(source, /\/authorizations\/\$\{encodeURIComponent\(requestId\)\}\/decision/)
  assert.match(source, /const authorizationPageSize = 10/)
  assert.match(source, /style: \{ \.\.\.toolbar, justifyContent: 'flex-end' \}/)
  assert.match(source, /label: '筛选处理状态'[\s\S]*?fitContent: true \}\)\),/)
  assert.match(source, /setSelectedAuthorizationId\(item\.requestId\)/)
  assert.match(source, /aria-label': '人工介入事项详情'/)
  assert.match(source, /approved: \{ label: '已继续'/)
  assert.match(source, /rejected: \{ label: '不执行'/)
  assert.match(source, /superseded: \{ label: '已失效', state: 'neutral' \}/)
  assert.match(source, /const isPendingAuthorization = \(item\) => item\.status === 'pending-send' \|\| item\.status === 'waiting-reply'/)
  assert.match(source, /authorizationStatus\[item\.status\] \|\| \{ label: '状态异常', state: 'error' \}/)
  assert.match(source, /authorizationFilter === 'superseded' \? item\.status === 'superseded'/)
  assert.match(source, /selectedAuthorizationPending \? React\.createElement\('footer'/)
  assert.match(source, /'处理结果'/)
  assert.match(source, /'批准该事项并继续'/)
  assert.match(source, /执行限制或拒绝原因（可选）/)
  assert.match(source, /'暂无人工介入事项'/)
  assert.doesNotMatch(source, /授权审批|授权申请单详情|筛选审批状态|审批意见/)
  assert.match(source, /现场证据 ·/)
  assert.match(source, /selectedAuthorization\.evidence/)
  assert.match(source, /已尝试 ·/)
  assert.match(source, /selectedAuthorization\.attemptedActions/)
  assert.match(source, /finally \{ setNavigatingSessionId\(''\) \}/)
  assert.match(source, /currentAuthorizationPage/)
  assert.match(source, /style: \{ marginRight: 'auto', fontSize: 11, color: colors\.muted \} \}, `当前显示 \$\{filteredAuthorizationItems\.length\} 条 · 每页 \$\{authorizationPageSize\} 条`/)
  assert.match(source, /React\.createElement\('span', null, '阻塞事项'\)/)
  assert.match(source, /当前异常/)
  assert.match(source, /label: `当前异常 · \$\{filteredActiveAlerts\.length\}`/)
  assert.match(source, /label: `恢复历史 · \$\{filteredResolvedAlerts\.length\}`/)
  assert.match(source, /aria-label': '告警状态视图'/)
  assert.match(source, /navigationTabStyle\(alertView === item\.id, \{ paddingBottom: 4 \}\)/)
  assert.match(source, /tableStatusTag\(active \? '当前异常' : '已恢复', active \? 'error' : 'done', \{ fontWeight: 600 \}\)/)
  assert.match(source, /Pill, \{ style: \{ border: 0, fontSize: 12, fontWeight: 600 \} \}, category\.label/)
  assert.match(source, /fontSize: 11, color: colors\.muted \} \}, fmt\(active \? alert\.lastSeenAt/)
  assert.match(source, /marginTop: 5, fontSize: 14/)
  assert.match(source, /marginTop: 6, fontSize: 11, color: colors\.muted/)
  assert.match(source, /const resolvedAlertPageSize = 10/)
  assert.match(source, /筛选告警类型/)
  assert.match(source, /label: '筛选告警类型'[\s\S]*?fitContent: true \}\)\),/)
  assert.match(source, /id: 'message-channel', label: '消息通道'/)
  assert.match(source, /id: 'leaf-session', label: '叶子会话'/)
  assert.match(source, /id: 'goal', label: '任务目标'/)
  assert.match(source, /setResolvedAlertPage\(1\)/)
  assert.match(source, /群聊消息/)
  assert.match(source, /message\.senderName/)
  assert.match(source, /message\.occurredAt/)
  assert.match(source, /const pageSize = 10/)
  assert.match(source, /选择群聊/)
  assert.match(source, /role: 'tablist', 'aria-label': '群聊数据视图'/)
  assert.match(source, /筛选处理状态/)
  assert.match(source, /筛选发件状态/)
  assert.match(source, /话题处理/)
  assert.match(source, /messageWorkflowState/)
  assert.match(source, /label: `收信箱 · \$\{selectedMessages\.length\}`/)
  assert.match(source, /label: `发信箱 · \$\{selectedOutbox\.length\}`/)
  assert.match(source, /navigationTabStyle\(groupTableView === item\.id, \{ paddingBottom: 4 \}\)/)
  assert.match(source, /const selectedOutbox/)
  assert.match(source, /const outboxPageSize = 10/)
  assert.match(source, /已回读/)
  assert.match(source, /待回读/)
  assert.match(source, /已撤回/)
  assert.match(source, /message\.recallStatus === 'recalled'/)
  assert.match(source, /message\.deliveryPendingReason/)
  assert.match(source, /message\.sourceMessageId/)
  assert.match(source, /message\.replyToMessageId/)
  assert.match(source, /message\.deliveredMessageId/)
  assert.match(source, /message\.outboundId/)
  assert.match(source, /setOutboxPage\(1\)/)
  assert.doesNotMatch(source, /label: 'Resident'/)
  assert.match(source, /ctx\.sessions\.openSubagent/)
  assert.match(source, /ctx\.sessions\.open\(sessionId\)/)
  assert.match(source, /refreshSubagents\(parentSessionId\)/)
  assert.match(source, /正在打开会话…/)
  assert.match(source, /border: `1px solid \$\{colors\.border\}`/)
  assert.match(source, /background: colors\.cardSurface/)
  assert.doesNotMatch(source, /transform: hovered/)
  assert.doesNotMatch(source, /scale\(/)
  assert.match(source, /const statusTag =/)
  assert.match(source, /const tableStatusTag = \(label, state, \{ fontWeight = 500 \} = \{\}\) => statusTag\(label, state, \{ borderless: true, fontSize: 12, fontWeight \}\)/)
  assert.equal((source.match(/tableStatusTag\(status\.label, status\.state, \{ fontWeight: 600 \}\)/g) || []).length, 3)
  assert.match(source, /border: borderless \? 0 : `1px solid color-mix/)
  assert.equal((source.match(/tableStatusTag\(status\.label, status\.state/g) || []).length, 3)
  assert.doesNotMatch(source, /const authorizationTag =/)
  assert.match(source, /justifySelf: 'start'[\s\S]*tableStatusTag\(status\.label, status\.state, \{ fontWeight: 600 \}\)/)
  assert.match(source, /gridTemplateColumns: '104px minmax\(220px, 1\.1fr\) minmax\(280px, 1\.5fr\) 126px 52px'/)
  assert.doesNotMatch(source, /copyButton\(task\.taskId, ' Id'\)/)
  assert.match(source, /检查点进度/)
  assert.match(source, /fontSize: 13, fontWeight: 600 \} \}, React\.createElement\('span', null, '状态'\)/)
  assert.doesNotMatch(source, /\$\{group\.messages\?\.length \?\? 0\} 条消息/)
  assert.match(source, /const tableFrame =/)
  assert.match(source, /const tableHeadCell =/)
  assert.match(source, /const tableBodyCell =/)
  assert.match(source, /const tableFooter =/)
  assert.match(source, /const toolbar =/)
  assert.match(source, /const navigationTabStyle =/)
  assert.match(source, /borderBottom: selected \? `2px solid \$\{colors\.accent\}`[\s\S]*color: selected \? colors\.accent/)
  assert.equal((source.match(/style: navigationTabStyle\(/g) || []).length, 3)
  assert.match(source, /const tableHeadCell = \{[^\n]*fontSize: ui\.textSm, fontWeight: 600/)
  assert.match(source, /const tableBodyCell = \{[^\n]*fontSize: ui\.textMd/)
  assert.match(source, /React\.createElement\('strong', \{ style: \{ fontSize: 14, fontWeight: 600 \} \}/)
  assert.match(source, /marginTop: 3, fontSize: 11, color: colors\.muted/)
  assert.match(source, /title: message\.messageId, style: \{ fontSize: 14, color: colors\.muted, whiteSpace: 'nowrap' \}/)
  assert.match(source, /const singleLineTableContent =/)
  assert.match(source, /width: 240 \} \}, singleLineTableContent/)
  assert.match(source, /minWidth: 910/)
  assert.match(source, /minWidth: 1100/)
  assert.equal((source.match(/title: message\.(?:sourceMessageId|deliveredMessageId \|\| ''|outboundId), style: \{ fontSize: 14, color: colors\.muted, whiteSpace: 'nowrap' \}/g) || []).length, 3)
  assert.match(source, /fontSize: 14, fontWeight: 600, lineHeight: 1\.5/)
  assert.match(source, /title: item\.requestedAction[\s\S]*fontSize: 14, lineHeight: 1\.55/)
  assert.match(source, /筛选处理状态/)
  assert.match(source, /style: tableFrame/)
  assert.match(source, /style: tableFooter/)
  assert.match(source, /React\.createElement\(Button, \{ variant: 'outline', size: 'sm'/)
  assert.match(source, /0 8px 20px rgba\(15,23,42,\.08\), 0 2px 6px rgba\(15,23,42,\.05\)/)
  assert.match(source, /padding: '8px 8px 12px 8px'/)
  assert.match(source, /navigator\.clipboard\.writeText/)
  assert.match(source, /document\.execCommand\('copy'\)/)
  assert.doesNotMatch(source, /copyButton\(task\.taskId, ' Id'\)/)
  assert.match(source, /task\.title \|\| task\.objective/)
  assert.doesNotMatch(source, /copyButton\(task\.childSessionId/)
  assert.match(source, /overflowWrap: 'anywhere'/)
  assert.match(source, /maxHeight: '4\.5em'/)
  assert.doesNotMatch(source, /task\.childSessionId \|\| '—'/)
  assert.doesNotMatch(source, /常驻 Session|copyButton\(selectedGroup\.residentSessionId, '会话 ID'\)|const selectedGroupSummary/)
  assert.match(source, /\(data\?\.groups \|\| \[\]\)\.length \? React\.createElement\(SelectMenu, \{ label: '选择群聊'/)
  assert.match(source, /label: '选择群聊'[\s\S]*fitContent: true/)
  assert.match(source, /width: fitContent \? 'fit-content' : undefined/)
  assert.match(source, /gap: fitContent \? 8 : 16/)
  assert.doesNotMatch(source, /\(data\?\.groups \|\| \[\]\)\.length > 1/)
  assert.match(source, /\/tasks\/\$\{encodeURIComponent\(task\.taskId\)\}\/archive/)
  assert.match(source, /task\.state === 'completed' && task\.archivedAt/)
  assert.doesNotMatch(source, /打开常驻对话 \/ 轨迹/)
  assert.doesNotMatch(source, /打开对话 \/ 轨迹/)
  assert.match(source, /inject: \['slots', 'sessions'\]/)
  // 补充表单使用 ref 保留重试幂等标识及输入焦点；仍不依赖布局测量。
  assert.doesNotMatch(source, /useLayoutEffect/)
  assert.doesNotMatch(source, /\/config\//)
  assert.match(source, /method: 'POST'/)
})

test('任务卡不请求或展示执行轮次耗时统计', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /get\('\/state\/task-timings'\)/)
  assert.doesNotMatch(source, /taskTimings|timingsByTaskId|timingBreakdown|timingPart/)
  assert.doesNotMatch(source, /本轮用时|当前执行轮次统计不完整|未细分为运行状态中/)
})

test('运行看板提供统一视觉尺度、响应式布局和可见键盘焦点', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  assert.match(source, /const ui = \{ textSm: 12, textMd: 14, textLg: 16, textXl: 20/u)
  assert.match(source, /@media \(max-width: 960px\)/u)
  assert.match(source, /@media \(max-width: 720px\)/u)
  assert.match(source, /:focus-visible/u)
  assert.match(source, /observer-task-board/u)
  assert.match(source, /observer-topics-layout/u)
  assert.match(source, /actionLabel: '重新读取'/u)
})

test('Agent配置页面提供叶子任务并行上限且默认值为5', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-assistant/web-client.js', import.meta.url), 'utf8')
  assert.match(source, /叶子任务并行上限/)
  assert.match(source, /useState\(5\)/)
  assert.match(source, /maxConcurrentTasks/)
  assert.match(source, /min: 1, max: 50/)
})

test('发件状态按实际投递环节展示，pending不会伪装为已回读', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  const expression = source.slice(source.indexOf('const outboxDelivery = ') + 'const outboxDelivery = '.length, source.indexOf('    const ui ='))
  const classify = runInNewContext(`(${expression})`)
  const scenarios = [
    [{ status: 'pending', readbackRequired: true }, 'queued', '待发送'],
    [{ status: 'pending', readbackRequired: false }, 'queued', '待发送'],
    [{ status: 'pending', deliveryPendingReason: 'preflight_failed', deliveryError: 'CLI_ORG_NOT_AUTHORIZED' }, 'failed', '发送受阻'],
    [{ status: 'pending', deliveryPendingReason: 'preflight_history_partial' }, 'failed', '发送受阻'],
    [{ status: 'pending', deliveryPendingReason: 'send_failed', deliveryError: 'timeout' }, 'failed', '投递异常'],
    [{ status: 'pending', deliveryError: 'legacy_error' }, 'failed', '投递异常'],
    [{ status: 'pending', deliveryBlockedAt: '2026-09-11T00:00:00Z', deliveryError: 'server_rejected' }, 'failed', '发送待处理'],
    [{ status: 'pending', deliveryPendingReason: 'postflight_failed', deliveryError: 'CLI_ORG_NOT_AUTHORIZED' }, 'waiting', '待回读'],
    [{ status: 'pending', deliveryPendingReason: 'delivery_unknown' }, 'waiting', '待回读'],
    [{ status: 'pending', deliveryPendingReason: 'message_not_observed' }, 'waiting', '待回读'],
    [{ status: 'sent', deliveredMessageId: 'actual-message-id' }, 'confirmed', '已回读'],
    [{ status: 'sent' }, 'confirmed', '已发送'],
    [{ status: 'sent', recallStatus: 'recalled' }, 'recalled', '已撤回'],
    [{ status: 'superseded', supersededByOutboundId: 'new' }, 'superseded', '已替代'],
    [{ status: 'sent', supersededByOutboundId: 'new' }, 'superseded', '已替代'],
    [{ status: 'superseded', recallStatus: 'failed', recallError: 'replacement_delivery_unknown' }, 'recall-failed', '撤回待处理'],
    [{ status: 'sent', recallStatus: 'failed', recallError: 'dws_recall_failed:1:1001' }, 'recall-failed', '撤回待处理'],
  ]
  for (const [message, id, label] of scenarios) {
    const result = classify(message)
    assert.equal(result.id, id)
    assert.equal(result.label, label)
  }
  assert.match(source, /message\.deliveryError/)
  assert.match(source, /最近尝试.*fmt\(message\.deliveryAttemptedAt\)/)
  assert.match(source, /message\.deliveryAttemptCount/)
})

test('处理步骤直接展示事项、关联对象和动作结论，未知结构不编造结果', async () => {
  const source=await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js',import.meta.url),'utf8')
  const code=source.slice(source.indexOf('    const traceStatus ='),source.indexOf('    const traceElapsed ='))
  const describe=describeMessageTraceItem; const status=runInNewContext(`${code};traceStatus`)
  const split=describe({kind:'split',output:{units:[{goalText:'核对租户甲'},{goalText:'等待确认'}]}})
  assert.equal(split.conclusion,'拆分为 2 个事项');assert.equal(split.rows[1].value,'等待确认')
  const route=describe({kind:'route',input:{goalText:'核对租户甲',candidates:[{candidateId:'t1',title:'租户权限排查'}]},output:{kind:'binding',disposition:'existing',candidateId:'t1',evidence:['引用原话']}})
  assert.ok(route.rows.some(row=>row.value==='租户权限排查'))
  const intent=describe({kind:'intent',output:{decisions:[{intent:{actions:[{intent:'research',arguments:{objective:'核对权限'}}],constraints:['仅排查，不修改']}}]}})
  assert.equal(intent.rows[0].label,'开展排查');assert.equal(intent.rows[1].value,'仅排查，不修改')
  assert.equal(describe({kind:'route',output:{kind:'needs_clarification',question:'哪个租户？'}}).conclusion,'需要进一步确认')
  assert.equal(describe({kind:'intent',status:'failed'}).conclusion,'本步未完成，请查看阻塞原因')
  assert.equal(describe({kind:'unknown'}).conclusion,'尚未记录判断结论')
  assert.equal(status('settled'),'处理已结束');assert.equal(status('alien'),'状态未记录')
  assert.doesNotMatch(source,/技术详情|消息技术记录|const traceUsage/);assert.match(source,/回复送达情况见发信箱/)
})

test('步骤耗时使用本次 startedAt，缺失或倒置时间不冒充零耗时',async()=>{
 const source=await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js',import.meta.url),'utf8')
 const code=source.slice(source.indexOf('const traceElapsed = ')+ 'const traceElapsed = '.length,source.indexOf('    const traceReason ='))
 const elapsed=runInNewContext(`(${code})`)
 const step={startedAt:'2026-09-26T00:00:00Z',completedAt:'2026-09-26T00:00:02.500Z',status:'succeeded'}
 assert.equal(elapsed(step,0),'耗时 2.5 秒')
 assert.equal(elapsed({...step,attempt:2},0),'耗时 2.5 秒（第 2 次处理）')
 assert.equal(elapsed({...step,startedAt:undefined},0),'耗时未记录')
 assert.equal(elapsed({...step,completedAt:'2026-09-25T00:00:00Z'},0),'耗时未记录')
 assert.equal(elapsed({...step,status:'running'},Date.parse('2026-09-26T00:01:05Z')),'已用时 1 分 5 秒')
})

function stepOutputHarness(source, props) {
  const fragment = source.slice(source.indexOf('    function TaskStepOutputContent('), source.indexOf('    const linkedTaskText ='))
  const states = [], effects = [], scheduled = [], requests = []
  let cursor = 0
  const component = runInNewContext(`${fragment}; TaskStepOutputContent`, {
    useState(initial) {
      const index = cursor++
      if (!(index in states)) states[index] = initial
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }]
    },
    useRef(initial) { const index = cursor++; if (!(index in states)) states[index] = { current: initial }; return states[index] },
    useEffect(fn, deps) {
      const index = cursor++, previous = effects[index]
      if (!previous || deps.some((value, position) => value !== previous.deps[position])) {
        previous?.cleanup?.(); effects[index] = { deps }
        scheduled.push(() => { effects[index].cleanup = fn() })
      }
    },
    React: { createElement: (type, properties, ...children) => ({ type, props: properties || {}, children: children.flat() }) },
    Button: 'button', colors: {}, ENDPOINT: 'http://localhost',
    get(url) { return new Promise((resolve, reject) => requests.push({ url, resolve, reject })) },
  })
  return {
    requests,
    render(next = props) { props = next; cursor = 0; const tree = component(props); scheduled.splice(0).forEach(effect => effect()); return tree },
    unmount() { effects.forEach(effect => effect?.cleanup?.()) },
  }
}
function flattenElements(tree) {
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...(tree.children || []).flatMap(flattenElements)]
}
const settle = () => new Promise(resolve => setImmediate(resolve))

test('任务详情只展示当前步骤，支持旧详情别名并保持稳定步骤身份', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /TaskExecutionHistory|TaskHistoryDisclosure|TaskRunHistory|历史记录|返回最新执行|executionNumber/)
  assert.match(source, /workflowTaskDetail\?\.requestedTaskId === selectedWorkflowTaskId/)
  assert.match(source, /key: node\.stepKey/)
  assert.match(source, /'当前结果'/)
  assert.match(source, /当前详情刷新失败，以下内容尚未刷新/)
  assert.match(source, /setWorkflowTaskDetail\(value\)/)
  assert.match(source, /\[selectedWorkflowTaskId, updatedAt, workflowDetailRetry\]/)
  const code = source.slice(source.indexOf('      const taskNodes ='), source.indexOf('      const taskTone ='))
  const progress = task => runInNewContext(`${code}; ({ completedSteps, stepsResolved, stepProgress })`, { selectedWorkflowTask: task })
  assert.equal(progress({ plan: { stepsResolved: false }, executionNodes: [{ status: 'succeeded' }] }).stepProgress, 99)
  const pending = progress({ plan: { stepsResolved: false }, executionNodes: [{ status: 'succeeded' }, { definitionPending: true, status: 'succeeded' }] })
  assert.equal(pending.completedSteps, 1)
  assert.equal(pending.stepProgress, 50)
  assert.equal(progress({ plan: { stepsResolved: true }, executionNodes: [{ status: 'succeeded' }] }).stepProgress, 100)
  assert.equal(progress({ plan: { stepsResolved: false }, executionNodes: [] }).stepProgress, 0)
  assert.match(source, /taskNodes.length \|\| !stepsResolved/)
  const future = progress({ plan: { stepsResolved: true }, executionNodes: [{ stepKey: 'stage-a:analyze', stageId: 'stage-a', nodeId: 'analyze', status: 'succeeded' }, { stepKey: 'stage-b:analyze', stageId: 'stage-b', nodeId: 'analyze', status: 'pending' }] })
  assert.equal(future.completedSteps, 1)
  assert.equal(future.stepProgress, 50)
  assert.match(source, /groupTaskSteps\(taskNodes\)/)
  assert.match(source, /累计执行时长/)
  assert.match(source, /累计总耗时/)

})

test('任务正文分页绑定当前详情版本，失败保留正文且旧版本慢响应被隔离', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  const node = { runId: 'run', nodeRunId: 'node', outputRef: 'ref' }
  const first = stepOutputHarness(source, { taskId: 'task', node, detailRevision: 'v1' })
  first.render()
  assert.match(first.requests[0].url, /cursor=0&detailRevision=v1$/)
  first.requests[0].resolve({ text: '首段', nextCursor: 10, documentName: '结果.md' }); await settle()
  let tree = first.render()
  assert.match(flattenElements(tree).find(item => item.type === 'a').props.href, /detailRevision=v1$/)
  flattenElements(tree).find(item => item.children.includes('继续阅读产出')).props.onClick()
  first.render()
  assert.match(first.requests[1].url, /cursor=10&detailRevision=v1$/)
  first.requests[1].reject(new Error('network')); await settle()
  tree = first.render()
  assert.ok(flattenElements(tree).some(item => item.children.includes('首段')))
  assert.ok(flattenElements(tree).some(item => item.props.role === 'alert'))
  flattenElements(tree).find(item => item.children.includes('重试读取产出')).props.onClick(); first.render()
  first.unmount()
  const second = stepOutputHarness(source, { taskId: 'task', node: { ...node, outputRef: 'ref-v2' }, detailRevision: 'v2' })
  tree = second.render()
  assert.ok(!flattenElements(tree).some(item => item.children.includes('首段')))
  assert.match(second.requests[0].url, /cursor=0&detailRevision=v2$/)
  second.requests[0].resolve({ text: '当前正文', nextCursor: null }); await settle()
  first.requests[2].resolve({ text: '过期追加', nextCursor: null }); await settle()
  tree = second.render()
  assert.ok(flattenElements(tree).some(item => item.children.includes('当前正文')))
  assert.ok(!flattenElements(tree).some(item => item.children.includes('过期追加')))
  assert.match(source, /key: `\$\{taskId\}:\$\{node\.runId\}:\$\{node\.nodeRunId\}:\$\{node\.outputRef\}`/)
})

test('未变产物的详情版本推进保留已读正文与分页，新页使用新版本', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  const props = { taskId: 'task', node: { runId: 'run', nodeRunId: 'node', outputRef: 'ref' }, detailRevision: 'v1' }
  const view = stepOutputHarness(source, props); view.render()
  view.requests[0].resolve({ text: '保留正文', nextCursor: 6 }); await settle()
  let tree = view.render({ ...props, detailRevision: 'v2' })
  assert.equal(view.requests.length, 1)
  assert.ok(flattenElements(tree).some(item => item.children.includes('保留正文')))
  flattenElements(tree).find(item => item.children.includes('继续阅读产出')).props.onClick(); view.render({ ...props, detailRevision: 'v2' })
  assert.match(view.requests[1].url, /cursor=6&detailRevision=v2$/)
  view.render({ ...props, detailRevision: 'v3' })
  assert.match(view.requests[2].url, /cursor=6&detailRevision=v3$/)
  view.requests[1].resolve({ text: '过期页', nextCursor: null }); view.requests[2].resolve({ text: '当前页', nextCursor: null }); await settle()
  tree = view.render()
  assert.ok(flattenElements(tree).some(item => item.children.includes('保留正文当前页')))
  assert.ok(!flattenElements(tree).some(item => item.children.includes('保留正文过期页')))
})

test('阅读步骤移除后定位相邻步骤，未移除步骤不改变阅读位置', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  const fragment = source.slice(source.indexOf('    const adjacentCurrentStep ='), source.indexOf('    function ObserverContent('))
  const adjacent = runInNewContext(`${fragment}; adjacentCurrentStep`)
  assert.equal(adjacent(['a', 'b', 'c'], ['a', 'c', 'd'], 'b'), 'c')
  assert.equal(adjacent(['a', 'b', 'c'], ['a', 'b'], 'c'), 'b')
  assert.equal(adjacent(['a'], [], 'a'), '')
  assert.equal(adjacent(['a', 'b'], ['a', 'b', 'c'], 'a'), null)
  assert.match(source, /正在阅读的步骤已从当前计划移除/)
  assert.match(source, /'aria-live': 'polite'/)
  assert.match(source, /getBoundingClientRect/)
})

test('简短任务标题保留可读首句，完整目标仍可展开且不写回原任务', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  const fragment = source.slice(source.indexOf('    const taskDisplayTitle ='), source.indexOf('    const taskStepStart ='))
  const title = runInNewContext(`${fragment}; taskDisplayTitle`)
  assert.equal(title({ title: '核对部署结果' }), '核对部署结果')
  const task = { title: '核对当前服务部署结果。' + '补充验收条件'.repeat(30), objective: '完整目标' }
  assert.equal(title(task), '核对当前服务部署结果')
  assert.ok(Array.from(title({ title: '发布并部署'.repeat(30) })).length <= 32)
  assert.equal(title({ title: '   ' }), '未命名任务')
  assert.equal(task.objective, '完整目标')
  assert.match(source, /'summary'.*'任务目标'/)
  assert.match(source, /selectedWorkflowTask.objective\)\) : null/)
})

test('工作流分组保留全局顺序和跨工作流同名步骤，开始时间不借用任务创建时间', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  const fragment = source.slice(source.indexOf('    const taskStepStart ='), source.indexOf('    function TaskStepElapsed('))
  const { group, start } = runInNewContext(`${fragment}; ({ group: groupTaskSteps, start: taskStepStart })`, { fmt: value => `格式化(${value})` })
  const groups = group([{ stageId: 'a', stageTitle: '开发与验证', nodeId: 'prepare', startedAt: '2026-09-29T00:00:00Z', status: 'succeeded' },
    { stageId: 'a', stageTitle: '开发与验证', nodeId: 'verify', status: 'succeeded' },
    { stageId: 'b', stageTitle: '部署UAT', nodeId: 'prepare', status: 'pending' }])
  assert.deepEqual(Array.from(groups, item => item.title), ['开发与验证', '部署UAT'])
  assert.deepEqual(Array.from(groups, item => Array.from(item.steps, step => step.index)), [[0, 1], [2]])
  assert.equal(groups[0].steps[0].node.nodeId, groups[1].steps[0].node.nodeId)
  assert.equal(start(groups[0].steps[0].node), '开始 格式化(2026-09-29T00:00:00Z)')
  assert.equal(start({ status: 'pending', createdAt: '2026-09-29T00:00:00Z' }), '未开始')
  assert.equal(start({ status: 'succeeded' }), '开始时间未记录')
  assert.equal(start({ status: 'failed', startedAt: 'invalid' }), '开始时间未记录')
  assert.match(source, /'time', \{ dateTime: node.startedAt \}/)
})

test('卡片原生步骤复用中文名称和本次节点耗时，不从历史检查点猜测', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  const fragment = source.match(/    const nodeTitle = (\{[^\n]+\})/)[1]
  const titles = runInNewContext(`(${fragment})`)
  assert.equal(titles['execute-build'], '执行构建')
  assert.equal(titles['inspect-runtime'], '核对运行版本')
  assert.equal(titles['accept-result'], '校验调查结果')
  assert.deepEqual(['prepare-delivery', 'send-files', 'verify-delivery'].map(id => titles[id]),
    ['核对待交付文件', '发送群文件', '回读并核验文件'])
  assert.match(source, /const node = \(task.executionNodes \|\| \[\]\).find/)
  assert.match(source, /node \? React.createElement\(TaskStepElapsed, \{ node, fontSize: 10.5 \}\)/)
  assert.match(source, /const checkpointLabel = id => nodeTitle\[id\]/)
})

test('Web重执行卡片显示原群名，缺少可读群来源时不暴露Web标识', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  const fragment = source.slice(source.indexOf('const sourceGroup ='), source.indexOf('const waitingNotice ='))
  const label = task => runInNewContext(`(() => { ${fragment}; return groupLabel })()`, { task, groupsById: new Map([['g', { name: '工程群' }]]) })
  assert.equal(label({ groupId: 'web:actor', sourceGroupId: 'g' }), '工程群')
  assert.equal(label({ groupId: 'web:actor', sourceGroupId: null }), 'Web 任务')
  assert.equal(label({ groupId: 'g' }), '工程群')
  assert.match(source, /title: task.sourceChannel === 'web' \? `\$\{groupLabel\} · Web 重新执行`/u)
})

test('Web任务话题按钮和键盘均使用原话题群聊，话题页能反查关联任务', async () => {
  const source = await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js', import.meta.url), 'utf8')
  const fragment = source.match(/\.\.\.(\(task\.topicRefs \|\| \[\]\)\.map\(\(ref\) => \{[\s\S]*?label\) \}\))/u)[1]
  const targets = [], pages = []
  const [button] = runInNewContext(`(() => { return ${fragment} })()`, {
    task: { groupId: 'web:actor', sourceGroupId: 'g', topicRefs: [{ groupId: 'g', topicId: 'topic', revision: 2, title: '真实话题' }] },
    topicsById: new Map(), React: { createElement: (type, props, ...children) => ({ type, props, children }) },
    colors: { accent: 'blue' }, pill: () => ({}), short: v => v,
    setTopicTarget: v => targets.push(v), setActivePage: v => pages.push(v),
  })
  assert.equal(button.children[0], '真实话题')
  button.props.onClick({ stopPropagation() {} })
  button.props.onKeyDown({ key: 'Enter', preventDefault() {}, stopPropagation() {} })
  assert.deepEqual(targets.map(t => t.groupId), ['g', 'g'])
  assert.deepEqual(pages, ['topics', 'topics'])
  assert.match(source, /ref\.groupId \|\| task\.sourceGroupId \|\| task\.groupId\) === selection\?\.groupId/u)
})

test('已读取材料但执行受阻走实际状态分支与显示标签，不回落已处理',async()=>{
 const source=await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js',import.meta.url),'utf8')
 const stateCode=source.slice(source.indexOf('const messageWorkflowState = ')+'const messageWorkflowState = '.length,source.indexOf('      const filteredMessages ='))
 const state=runInNewContext(`(${stateCode})`,{selectedGroup:{topics:[]}})
 const deliveryCode=source.slice(source.indexOf('const delivery = ')+'const delivery = '.length,source.indexOf('      const messageRows ='))
 const delivery=runInNewContext(`(${deliveryCode})`)
 const message={workflowStatus:'execution_blocked',routingStatus:'routed',sourceKind:'workflow-v2'}
 assert.equal(state(message),'execution_blocked')
 assert.equal(delivery[state(message)].label,'执行受阻')
 assert.equal(delivery[state({...message,workflowStatus:'waiting_system'})].label,'材料读取受阻')
 assert.equal([message].filter(item=>state(item)==='execution_blocked').length,1)
})

test('任务短名称合同拒绝超过30字，读模型回退截断不修改完整目标',async()=>{
 const {taskTitle,taskTitleSchema}=await import('../packages/dingtalk-dsh-assistant/task-input-contract.js');
 assert.equal(taskTitleSchema.safeParse('字'.repeat(30)).success,true);
 assert.equal(taskTitleSchema.safeParse('字'.repeat(31)).success,false);
 const objective='针对孙鹏要求在生产环境Editor数据库process_id_temp表新增name列，调查结构并准备DDL';
 assert.equal(Array.from(taskTitle(objective)).length,30);
 assert.equal(taskTitle('  核对Editor临时表结构  '),'核对Editor临时表结构');
 assert.ok(objective.includes('准备DDL'));
 const source=await readFile(new URL('../packages/dingtalk-dsh-assistant/workflow-service.js',import.meta.url),'utf8');
 assert.match(source,/title: taskTitle\(requirement\?\.title/);
});

test('自动与手动刷新共用一个请求，失败后可重新读取',async()=>{
 const source=await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js',import.meta.url),'utf8');
 const fragment=source.slice(source.indexOf('      const pendingRefresh = '),source.indexOf('      const manualRefresh = '));
 let calls=0,resolve,reject;const updates=[],errors=[];const operation=()=>{calls++;return new Promise((yes,no)=>{resolve=yes;reject=no})};
 const refresh=runInNewContext(`(()=>{${fragment};return refresh})()`,{useRef:value=>({current:value}),useCallback:fn=>fn,load:operation,setData:v=>updates.push(v),setUpdatedAt:()=>{},setError:e=>errors.push(e),Date,Error});
 const first=refresh();assert.equal(refresh(),first);assert.equal(calls,1);resolve({groups:[]});await first;assert.equal(updates.length,1);
 const failed=refresh();reject(new Error('读取失败'));await failed;assert.equal(errors.at(-1),'读取失败');
 const recovered=refresh();resolve({groups:[1]});await recovered;assert.equal(calls,3);assert.equal(updates.length,2);
});

test('详情慢查询跨刷新复用，切换任务不接受旧响应',async()=>{
 const source=await readFile(new URL('../packages/dingtalk-dsh-observer/web-client.js',import.meta.url),'utf8');
 const start=source.indexOf('      const pendingDetail = '),end=source.lastIndexOf('      useEffect(() => {',source.indexOf('        const target = detailFocusTarget.current',start));
 const effects=[],requests=[],details=[],pending={current:null};
 const environment={useRef:()=>pending,useEffect:fn=>effects.push(fn),selectedWorkflowTaskId:'one',workflowDetailRetry:0,updatedAt:0,get:path=>new Promise(resolve=>requests.push({path,resolve})),setWorkflowTaskDetail:v=>details.push(v),setWorkflowDetailError:()=>{},setStepReadingNotice:()=>{},detailFocusTarget:{current:null},adjacentCurrentStep:()=>null,document:{querySelectorAll:()=>[],activeElement:null},window:{innerHeight:900},encodeURIComponent};
 const effect=()=>{runInNewContext(`(()=>{${source.slice(start,end)}})()`,environment);return effects.pop()()};
 const first=effect();first();const refresh=effect();assert.equal(requests.length,1);refresh();
 environment.selectedWorkflowTaskId='two';effect();assert.equal(requests.length,2);
 requests[0].resolve({taskId:'one'});requests[1].resolve({taskId:'two'});await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(details.map(v=>v.taskId),['two']);
});
