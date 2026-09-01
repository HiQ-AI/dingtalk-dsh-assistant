window.__ModuleLoader__.load({
  id: '@zzusp/dingtalk-dsh-observer',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const { Button, IconChecklistOutline14, IconChevronDownOutline14, IconChevronUpOutline14, Menu, Pill, StateDot } = require('@deepseek-ai/dsh-client-ui-primitives')
    const { useCallback, useEffect, useState } = React
    const ENDPOINT = 'http://127.0.0.1:18998'
    const colors = {
      surface: 'var(--dsw-alias-bg-base, #fff)',
      surface2: 'var(--dsw-alias-bg-layer-1, #f7f7f8)',
      cardSurface: 'var(--dsw-alias-bg-layer-1, #fff)',
      border: 'var(--dsw-alias-border-l2, rgba(127,127,127,.25))',
      muted: 'var(--dsw-alias-label-secondary, #737373)',
      accent: 'var(--dsw-alias-brand-primary, #4d6bfe)',
      danger: 'var(--dsw-alias-state-error-primary, #c33)',
      warning: 'var(--dsw-alias-state-warn-primary, #a56500)'
    }
    let open = false
    let selectedSessionSnapshot
    const openListeners = new Set()
    const clearSessionSelection = () => {
      const element = document.querySelector('[role="treeitem"][aria-selected="true"]')
      if (!element) return
      const selectedClasses = [...element.classList].filter((name) => name.endsWith('_selected'))
      selectedSessionSnapshot = { element, selectedClasses }
      document.documentElement.style.setProperty('--dingtalk-dsh-observer-selected-bg', getComputedStyle(element).backgroundColor)
      element.setAttribute('aria-selected', 'false')
      for (const name of selectedClasses) element.classList.remove(name)
    }
    const restoreSessionSelection = () => {
      const snapshot = selectedSessionSnapshot
      selectedSessionSnapshot = undefined
      if (!snapshot?.element?.isConnected) return
      snapshot.element.setAttribute('aria-selected', 'true')
      for (const name of snapshot.selectedClasses) snapshot.element.classList.add(name)
    }
    const setOpen = (value) => {
      if (value === open) return
      if (value) clearSessionSelection()
      else restoreSessionSelection()
      open = value
      for (const listener of openListeners) listener(value)
    }
    const useOpen = () => {
      const [value, setValue] = useState(open)
      useEffect(() => { openListeners.add(setValue); return () => openListeners.delete(setValue) }, [])
      return value
    }
    const fmt = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'
    const fmtTime = (value) => value ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) : '—'
    const fmtDuration = (value) => { const seconds = Math.max(0, Math.floor(value / 1000)); if (seconds < 60) return `${seconds}秒`; const minutes = Math.floor(seconds / 60); if (minutes < 60) return `${minutes}分${seconds % 60}秒`; const hours = Math.floor(minutes / 60); return `${hours}小时${minutes % 60}分` }
    const timingBreakdown = (timing) => [
      timing.queuedMs > 0 ? `排队 ${fmtDuration(timing.queuedMs)}` : '',
      timing.waitingMs > 0 ? `等待 ${fmtDuration(timing.waitingMs)}` : '',
      timing.toolMs > 0 ? `工具 ${fmtDuration(timing.toolMs)}` : '',
      timing.unclassifiedRunningMs > 0 ? `未细分 ${fmtDuration(timing.unclassifiedRunningMs)}` : '',
    ].filter(Boolean).join(' · ')
    const checkpointDuration = (checkpoint, events, now) => { let startedAt; for (const event of events) { const submittedAt = Date.parse(event.submittedAt); const remainingItems = event.remainingItems || []; if (startedAt === undefined && remainingItems[0] === checkpoint && Number.isFinite(submittedAt)) startedAt = submittedAt; if (startedAt !== undefined && !remainingItems.includes(checkpoint) && Number.isFinite(submittedAt)) return fmtDuration(submittedAt - startedAt) } return startedAt === undefined ? '—' : fmtDuration(now - startedAt) }
    const short = (value) => value ? String(value).replace(/^session-/, '').slice(0, 14) : '—'
    const pill = (tone) => ({ display: 'inline-flex', alignItems: 'center', borderRadius: 999, padding: '3px 8px', fontSize: 12, color: tone, background: `color-mix(in srgb, ${tone} 12%, transparent)` })
    const card = { border: `1px solid ${colors.border}`, borderRadius: 12, background: colors.cardSurface, padding: 16, boxShadow: '0 4px 16px rgba(15,23,42,.07)' }
    const tableFrame = { border: `1px solid ${colors.border}`, borderRadius: 12, background: colors.cardSurface, overflow: 'hidden' }
    const tableHeadCell = { height: 42, boxSizing: 'border-box', padding: '0 16px', color: colors.muted, fontSize: 13, fontWeight: 600, verticalAlign: 'middle' }
    const tableBodyCell = { padding: '12px 16px', borderTop: `1px solid ${colors.border}`, fontSize: 14, lineHeight: 1.55, verticalAlign: 'middle' }
    const tableBodyContent = { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' }
    const clampTableContent = (...children) => React.createElement('div', { style: tableBodyContent }, ...children)
    const singleLineTableContent = (...children) => React.createElement('div', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, ...children)
    const tableFooter = { minHeight: 48, boxSizing: 'border-box', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, padding: '8px 12px', borderTop: `1px solid ${colors.border}`, background: colors.surface2 }
    const toolbar = { minHeight: 48, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 12px', borderBottom: `1px solid ${colors.border}`, background: colors.cardSurface }
    const navigationTabStyle = (selected, { paddingBottom = 11 } = {}) => ({ position: 'relative', boxSizing: 'border-box', border: 0, borderBottom: selected ? '2px solid #4d6bfe' : '2px solid transparent', borderRadius: 0, padding: `0 0 ${paddingBottom}px`, cursor: 'pointer', font: 'inherit', fontSize: 13, fontWeight: 500, lineHeight: '16px', color: selected ? '#4d6bfe' : colors.muted, background: 'transparent', outline: 'none', whiteSpace: 'nowrap' })
    const statusTone = {
      done: 'var(--dsw-alias-state-success-primary, #248a3d)',
      warning: 'var(--dsw-alias-state-warn-primary, #a56500)',
      ongoing: 'var(--dsw-alias-brand-primary, #4d6bfe)',
      error: 'var(--dsw-alias-state-error-primary, #c33)'
    }
    const CheckpointDoneIcon = ({ size = 12 }) => React.createElement('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, React.createElement('circle', { cx: 8, cy: 8, r: 6.25 }), React.createElement('path', { d: 'M5 8.1 7.05 10 11.2 5.9' }))
    const statusTag = (label, state, { borderless = false, fontSize = 11, fontWeight = 500 } = {}) => {
      const tone = statusTone[state] || colors.muted
      return React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 24, boxSizing: 'border-box', border: borderless ? 0 : `1px solid color-mix(in srgb, ${tone} 28%, transparent)`, borderRadius: 999, background: `color-mix(in srgb, ${tone} 10%, transparent)`, color: tone, padding: '2px 8px', fontSize, fontWeight, lineHeight: 1.4, whiteSpace: 'nowrap' } }, React.createElement(StateDot, { state, size: 7 }), label)
    }
    const tableStatusTag = (label, state, { fontWeight = 500 } = {}) => statusTag(label, state, { borderless: true, fontSize: 12, fontWeight })
    function SelectMenu({ label, value, options, onChange, minWidth = 150, fitContent = false }) {
      const [open, setOpen] = useState(false)
      const selected = options.find((item) => item.id === value)
      const anchor = React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', 'aria-label': label, 'aria-expanded': open, onClick: () => setOpen((current) => !current), style: { minWidth: fitContent ? 0 : minWidth, width: fitContent ? 'fit-content' : undefined, maxWidth: fitContent ? 220 : undefined, justifyContent: fitContent ? 'flex-start' : 'space-between', gap: fitContent ? 8 : 16, fontWeight: 400 } }, React.createElement('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, selected?.label || value), React.createElement('span', { 'aria-hidden': true, style: { flex: '0 0 auto', color: colors.muted, fontSize: 9, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s ease' } }, '▼'))
      return React.createElement(Menu, { open, anchor, items: options, selectedId: value, onSelect: (id) => { onChange(id); setOpen(false) }, onClose: () => setOpen(false), align: 'end', portal: true, dense: true, compact: true })
    }
    const emptyState = (text) => React.createElement('div', { style: { minHeight: 112, display: 'grid', placeItems: 'center', color: colors.muted, fontSize: 12, border: `1px dashed ${colors.border}`, borderRadius: 10, background: colors.surface2 } }, text)
    async function get(path) {
      const response = await fetch(`${ENDPOINT}${path}`, { method: 'GET', headers: { accept: 'application/json' } })
      const value = await response.json()
      if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`)
      return value
    }
    async function post(path, body = {}) {
      const response = await fetch(`${ENDPOINT}${path}`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const value = await response.json()
      if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`)
      return value
    }
    async function load() {
      const [health, groups, tasks, taskTimings, alerts, authorizations] = await Promise.all([
        get('/health'), get('/state/groups'), get('/state/tasks'), get('/state/task-timings'), get('/state/supervisor/alerts'), get('/state/authorizations')
      ])
      return { health, groups, tasks, taskTimings, alerts, authorizations }
    }
    function SidebarAction({ wide }) {
      const isOpen = useOpen()
      const icon = React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        React.createElement('rect', { x: 3, y: 3, width: 18, height: 18, rx: 3 }),
        React.createElement('path', { d: 'M7 15v2M12 11v6M17 7v10' }))
      return React.createElement('button', {
        type: 'button', title: '钉钉群聊运行看板', 'aria-label': '钉钉群聊运行看板', onClick: () => setOpen(true),
        style: wide
          ? { boxSizing: 'border-box', cursor: 'pointer', width: 'calc(100% + 4px)', height: 42, color: 'var(--dsw-alias-label-primary)', background: isOpen ? 'var(--dingtalk-dsh-observer-selected-bg, var(--dsw-alias-interactive-bg-selected, var(--dsw-alias-interactive-bg-hover)))' : 'transparent', border: 0, outline: 'none', boxShadow: 'none', borderRadius: 12, flex: '0 0 auto', alignItems: 'center', gap: 8, margin: '4px -2px', padding: '0 10px 0 8px', fontFamily: 'inherit', fontSize: 14, lineHeight: '22px', display: 'flex', overflow: 'hidden' }
          : { boxSizing: 'border-box', cursor: 'pointer', width: 36, height: 36, color: 'var(--dsw-alias-label-primary)', background: isOpen ? 'var(--dingtalk-dsh-observer-selected-bg, var(--dsw-alias-interactive-bg-selected, var(--dsw-alias-interactive-bg-hover)))' : 'transparent', border: 0, outline: 'none', boxShadow: 'none', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '8px 0 10px', padding: 0 }
      }, icon, wide ? React.createElement('span', { style: { whiteSpace: 'nowrap', overflow: 'hidden' } }, '运行看板') : null)
    }
    const taskBuckets = [
      { state: 'queued', label: '待执行', tone: 'var(--dsw-alias-label-secondary, #64748b)', background: 'color-mix(in srgb, var(--dsw-alias-label-secondary, #64748b) 8%, var(--dsw-alias-bg-layer-1, #fff))' },
      { state: 'running', label: '执行中', tone: colors.accent, background: 'color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 8%, var(--dsw-alias-bg-layer-1, #fff))' },
      { state: 'waiting', label: '等待中', tone: colors.warning, background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary, #a56500) 8%, var(--dsw-alias-bg-layer-1, #fff))' },
      { state: 'completed', label: '已完成', tone: 'var(--dsw-alias-state-success-primary, #248a3d)', background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary, #248a3d) 8%, var(--dsw-alias-bg-layer-1, #fff))' }
    ]
    const pages = [{ id: 'groups', label: '群聊会话' }, { id: 'tasks', label: '任务看板' }, { id: 'authorizations', label: '授权审批' }, { id: 'archive', label: '归档任务' }, { id: 'alerts', label: '告警' }]
    function ObserverContent({ openSession }) {
      const [activePage, setActivePage] = useState('groups')
      const [data, setData] = useState()
      const [error, setError] = useState()
      const [navigationError, setNavigationError] = useState()
      const [updatedAt, setUpdatedAt] = useState()
      const [refreshState, setRefreshState] = useState('idle')
      const [selectedGroupId, setSelectedGroupId] = useState('')
      const [messagePage, setMessagePage] = useState(1)
      const [outboxPage, setOutboxPage] = useState(1)
      const [groupTableView, setGroupTableView] = useState('messages')
      const [messageDeliveryFilter, setMessageDeliveryFilter] = useState('all')
      const [outboxStatusFilter, setOutboxStatusFilter] = useState('all')
      const [hoveredTaskId, setHoveredTaskId] = useState('')
      const [expandedCheckpointTaskId, setExpandedCheckpointTaskId] = useState('')
      const [copiedId, setCopiedId] = useState('')
      const [navigatingSessionId, setNavigatingSessionId] = useState('')
      const [alertType, setAlertType] = useState('all')
      const [alertView, setAlertView] = useState('active')
      const [resolvedAlertPage, setResolvedAlertPage] = useState(1)
      const [authorizationComments, setAuthorizationComments] = useState({})
      const [decidingAuthorizationId, setDecidingAuthorizationId] = useState('')
      const [authorizationPage, setAuthorizationPage] = useState(1)
      const [authorizationFilter, setAuthorizationFilter] = useState('all')
      const [selectedAuthorizationId, setSelectedAuthorizationId] = useState('')
      const refresh = useCallback(async () => {
        try { setData(await load()); setUpdatedAt(new Date()); setError(undefined) }
        catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
      }, [])
      const manualRefresh = useCallback(async () => {
        if (refreshState === 'refreshing') return
        setRefreshState('refreshing')
        await refresh()
        setRefreshState('done')
        window.setTimeout(() => setRefreshState('idle'), 1200)
      }, [refresh, refreshState])
      useEffect(() => {
        refresh()
        const timer = window.setInterval(refresh, 5000)
        return () => window.clearInterval(timer)
      }, [refresh])
      useEffect(() => {
        const closeForSession = (event) => {
          if (event.target instanceof Element && event.target.closest('[role="treeitem"]')) setOpen(false)
        }
        document.addEventListener('click', closeForSession, true)
        return () => document.removeEventListener('click', closeForSession, true)
      }, [])
      const groupsById = new Map((data?.groups || []).map((group) => [group.groupId, group]))
      const timingsByTaskId = new Map((data?.taskTimings || []).map((timing) => [timing.taskId, timing]))
      const navigate = async (sessionId, parentSessionId) => {
        try { setNavigationError(undefined); setNavigatingSessionId(sessionId); await openSession(sessionId, parentSessionId); setOpen(false) }
        catch (cause) { setNavigationError(cause instanceof Error ? cause.message : String(cause)) }
        finally { setNavigatingSessionId('') }
      }
      const copyId = async (value) => {
        let copied = false
        try {
          if (globalThis.navigator?.clipboard?.writeText) { await globalThis.navigator.clipboard.writeText(value); copied = true }
        } catch {}
        if (!copied) {
          const input = document.createElement('textarea')
          input.value = value
          input.setAttribute('readonly', '')
          input.style.position = 'fixed'
          input.style.opacity = '0'
          document.body.appendChild(input)
          input.select()
          copied = document.execCommand('copy')
          input.remove()
        }
        if (!copied) throw new Error('当前浏览器未允许复制，请手动选择 ID')
        setCopiedId(value)
        window.setTimeout(() => setCopiedId((current) => current === value ? '' : current), 1500)
      }
      const copyButton = (value, label) => React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: !value, onClick: (event) => { event.stopPropagation(); copyId(value).catch((cause) => setNavigationError(cause instanceof Error ? cause.message : String(cause))) }, style: { color: copiedId === value ? 'var(--dsw-alias-state-success-primary, #248a3d)' : undefined, cursor: value ? 'pointer' : 'default', fontSize: 10.5 } }, copiedId === value ? '已复制' : `复制${label}`)
      const selectedGroup = groupsById.get(selectedGroupId) || (data?.groups || [])[0]
      const selectedMessages = [...(selectedGroup?.messages || [])].sort((left, right) => Number(right.sequence || 0) - Number(left.sequence || 0))
      const filteredMessages = selectedMessages.filter((message) => messageDeliveryFilter === 'all' || (message.agentDeliveryStatus || 'unknown') === messageDeliveryFilter)
      const pageSize = 10
      const pageCount = Math.max(1, Math.ceil(filteredMessages.length / pageSize))
      const currentMessagePage = Math.min(messagePage, pageCount)
      const visibleMessages = filteredMessages.slice((currentMessagePage - 1) * pageSize, currentMessagePage * pageSize)
      const delivery = {
        delivered: { label: '已投递', state: 'done' },
        failed: { label: '投递失败', state: 'error' },
        'decision-failed': { label: '判断失败', state: 'error' },
        steered: { label: '已插话·判断中', state: 'ongoing' },
        pending: { label: '投递中', state: 'ongoing' },
        skipped: { label: '历史补拉·未投递', state: 'warning' },
        unknown: { label: '历史状态未知', state: 'warning' },
      }
      const messageRows = visibleMessages.map((message, rowIndex) => {
        const status = delivery[message.agentDeliveryStatus] || delivery.unknown
        return React.createElement('tr', { key: message.messageId, style: { background: rowIndex % 2 ? `color-mix(in srgb, ${colors.surface2} 55%, transparent)` : colors.cardSurface } },
          React.createElement('td', { style: { ...tableBodyCell, width: 104 }, title: message.agentDeliveryError || '' }, clampTableContent(tableStatusTag(status.label, status.state, { fontWeight: 600 }))),
          React.createElement('td', { style: { ...tableBodyCell, width: 160 } }, clampTableContent(React.createElement('strong', { style: { fontSize: 14, fontWeight: 600 } }, message.senderName || message.senderOpenDingTalkId || '发送人未记录'), React.createElement('div', { style: { marginTop: 3, fontSize: 11, color: colors.muted } }, fmt(message.occurredAt)))),
          React.createElement('td', { title: message.text, style: tableBodyCell }, clampTableContent(message.text || '（空消息）')),
          React.createElement('td', { style: { ...tableBodyCell, width: 240 } }, singleLineTableContent(React.createElement('code', { title: message.messageId, style: { fontSize: 14, color: colors.muted, whiteSpace: 'nowrap' } }, `#${message.sequence ?? '—'} · ${short(message.messageId)}`))))
      })
      const selectedOutbox = [...(selectedGroup?.outbox || [])].reverse()
      const outboxState = (message) => message.recallStatus === 'recalled' ? 'recalled' : message.status === 'pending' && message.readbackRequired === true ? 'waiting' : 'confirmed'
      const filteredOutbox = selectedOutbox.filter((message) => outboxStatusFilter === 'all' || outboxState(message) === outboxStatusFilter)
      const outboxPageSize = 10
      const outboxPageCount = Math.max(1, Math.ceil(filteredOutbox.length / outboxPageSize))
      const currentOutboxPage = Math.min(outboxPage, outboxPageCount)
      const visibleOutbox = filteredOutbox.slice((currentOutboxPage - 1) * outboxPageSize, currentOutboxPage * outboxPageSize)
      const outboundStatus = {
        sent: { label: '已回读', state: 'done' },
        pending: { label: '已回读', state: 'done' },
        recalled: { label: '已撤回', state: 'neutral' },
      }
      const outboxRows = visibleOutbox.map((message, rowIndex) => {
        const status = message.recallStatus === 'recalled' ? outboundStatus.recalled : message.status === 'pending' && message.readbackRequired === true ? { label: '待回读', state: 'warning' } : outboundStatus[message.status] || outboundStatus.sent
        return React.createElement('tr', { key: message.outboundId, style: { background: rowIndex % 2 ? `color-mix(in srgb, ${colors.surface2} 55%, transparent)` : colors.cardSurface } },
          React.createElement('td', { style: { ...tableBodyCell, width: 104 } }, clampTableContent(tableStatusTag(status.label, status.state, { fontWeight: 600 }))),
          React.createElement('td', { title: message.text, style: tableBodyCell }, clampTableContent(message.text || '（空消息）')),
          React.createElement('td', { style: { ...tableBodyCell, width: 220 } },
            React.createElement('div', { style: { minWidth: 0 } }, singleLineTableContent(React.createElement('code', { title: message.sourceMessageId, style: { fontSize: 14, color: colors.muted, whiteSpace: 'nowrap' } }, short(message.sourceMessageId))), message.replyToMessageId ? React.createElement('div', { style: { marginTop: 3, fontSize: 11, color: colors.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, '回复 ', React.createElement('code', { title: message.replyToMessageId }, short(message.replyToMessageId))) : null)),
          React.createElement('td', { style: { ...tableBodyCell, width: 220 } }, singleLineTableContent(React.createElement('code', { title: message.deliveredMessageId || '', style: { fontSize: 14, color: colors.muted, whiteSpace: 'nowrap' } }, message.deliveredMessageId ? short(message.deliveredMessageId) : '历史未记录'))),
          React.createElement('td', { style: { ...tableBodyCell, width: 220 } }, singleLineTableContent(React.createElement('code', { title: message.outboundId, style: { fontSize: 14, color: colors.muted, whiteSpace: 'nowrap' } }, short(message.outboundId)))))
      })
      const renderTaskCard = (task) => {
        const group = groupsById.get(task.groupId)
        const timing = timingsByTaskId.get(task.taskId)
        const queued = task.state === 'queued'
        const checkpointEvents = task.checkpoints || []
        const planCheckpointIndex = checkpointEvents.findLastIndex((checkpoint) => checkpoint.kind === 'plan-confirmed')
        const planCheckpoint = checkpointEvents[planCheckpointIndex]
        const currentCheckpointEvents = checkpointEvents.slice(Math.max(0, planCheckpointIndex))
        const checkpoints = planCheckpoint?.remainingItems?.length ? planCheckpoint.remainingItems : (task.stageTasks?.length ? task.stageTasks : [task.objective])
        const displayObjective = String(task.objective || '').startsWith('[TASK_SOURCE_EVIDENCE]') ? (task.title || task.objective) : task.objective
        const latestCheckpoint = checkpointEvents.at(-1)
        const latestRemainingItems = latestCheckpoint?.remainingItems || checkpoints
        const remainingItemsMatchPlan = latestRemainingItems.every((checkpoint) => checkpoints.includes(checkpoint))
        const normalizedRemainingItems = remainingItemsMatchPlan ? latestRemainingItems : checkpoints.slice(-Math.min(checkpoints.length, latestRemainingItems.length))
        const remainingCheckpointNames = new Set(normalizedRemainingItems)
        const completedCheckpointNames = new Set(task.state === 'completed' ? checkpoints : checkpoints.filter((checkpoint) => !remainingCheckpointNames.has(checkpoint)))
        const currentCheckpoint = task.state === 'running' ? checkpoints.find((checkpoint) => remainingCheckpointNames.has(checkpoint)) : undefined
        const completedCheckpointCount = checkpoints.filter((checkpoint) => completedCheckpointNames.has(checkpoint)).length
        const progress = Math.round((completedCheckpointCount / checkpoints.length) * 100)
        const showCheckpoints = task.state !== 'completed' && !task.archivedAt
        const checkpointsExpanded = expandedCheckpointTaskId === task.taskId
        const hovered = hoveredTaskId === task.taskId
        const navigating = navigatingSessionId === task.childSessionId
        return React.createElement('div', { key: task.taskId, onMouseEnter: () => setHoveredTaskId(task.taskId), onMouseLeave: () => setHoveredTaskId(''), style: { width: '100%', minWidth: 0, boxSizing: 'border-box', border: `1px solid ${colors.border}`, borderRadius: 12, background: colors.cardSurface, boxShadow: hovered ? '0 8px 20px rgba(15,23,42,.08), 0 2px 6px rgba(15,23,42,.05)' : 'var(--dsw-shadow-card, 0 1px 2px rgba(0,0,0,.08))', padding: '11px 13px', color: 'inherit', display: 'grid', gap: 6, opacity: queued ? 0.72 : 1, transition: 'box-shadow 180ms ease' } },
          React.createElement('button', { type: 'button', disabled: queued || navigating, onClick: (event) => { if (event.target.closest('[data-task-card-action]')) return; navigate(task.childSessionId, group?.residentSessionId) }, style: { width: '100%', minWidth: 0, boxSizing: 'border-box', border: 0, padding: 0, background: 'transparent', color: 'inherit', cursor: queued || navigating ? 'default' : 'pointer', textAlign: 'left', display: 'grid', gap: 6, fontFamily: 'inherit' } },
          React.createElement('strong', { title: task.title || task.objective, style: { fontSize: 13, lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' } }, task.title || task.objective),
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', minWidth: 0 } }, React.createElement('span', { title: group?.name || task.groupId, style: { ...pill(colors.muted), maxWidth: '100%', padding: '2px 7px', fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, group?.name || task.groupId)),
          React.createElement('div', { title: displayObjective, style: { minWidth: 0, display: 'block', maxHeight: '4.5em', overflow: 'hidden', overflowWrap: 'anywhere', fontSize: 11, lineHeight: 1.5 } }, React.createElement('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', role: 'img', 'aria-label': '任务目标', style: { display: 'inline-block', verticalAlign: -2, marginRight: 5, color: colors.muted } }, React.createElement('circle', { cx: 8, cy: 8, r: 5.5 }), React.createElement('circle', { cx: 8, cy: 8, r: 2 }), React.createElement('path', { d: 'M8 1v2M15 8h-2' })), displayObjective),
          React.createElement('div', null,
            showCheckpoints ? React.createElement('section', null,
              React.createElement('div', { role: 'button', tabIndex: 0, 'aria-expanded': checkpointsExpanded, 'aria-label': checkpointsExpanded ? '收起检查点' : `展开全部 ${checkpoints.length} 个检查点`, 'data-task-card-action': 'toggle-checkpoints', onClick: (event) => { event.stopPropagation(); setExpandedCheckpointTaskId(checkpointsExpanded ? '' : task.taskId) }, onKeyDown: (event) => { if (event.key !== 'Enter' && event.key !== ' ') return; event.preventDefault(); event.stopPropagation(); setExpandedCheckpointTaskId(checkpointsExpanded ? '' : task.taskId) }, style: { minHeight: 24, boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 8, fontSize: 10.5, cursor: 'pointer' } }, React.createElement('span', { style: { flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', gap: 4, color: colors.muted } }, React.createElement(IconChecklistOutline14, { size: 12, 'aria-label': '任务' }), '任务'), React.createElement('div', { role: 'progressbar', 'aria-label': '检查点进度', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': progress, style: { flex: '1 1 auto', minWidth: 24, height: 4, borderRadius: 999, overflow: 'hidden', background: `color-mix(in srgb, ${colors.muted} 22%, transparent)` } }, React.createElement('div', { style: { width: `${progress}%`, height: '100%', borderRadius: 'inherit', background: completedCheckpointCount === checkpoints.length ? statusTone.done : colors.accent, transition: 'width 180ms ease' } })), React.createElement('span', { style: { flex: '0 0 auto', color: completedCheckpointCount === checkpoints.length ? statusTone.done : colors.muted } }, `${completedCheckpointCount} / ${checkpoints.length}`), React.createElement(checkpointsExpanded ? IconChevronUpOutline14 : IconChevronDownOutline14, { size: 14, 'aria-hidden': true, style: { flex: '0 0 auto', color: colors.muted } })),
              checkpointsExpanded ? React.createElement('div', { style: { display: 'grid', gap: 4, padding: '2px 9px 9px' } }, ...checkpoints.map((checkpoint, index) => { const completed = completedCheckpointNames.has(checkpoint); const current = !completed && currentCheckpoint === checkpoint; const tone = completed ? statusTone.done : current ? colors.accent : colors.muted; const duration = checkpointDuration(checkpoint, currentCheckpointEvents, Date.now()); return React.createElement('div', { key: `${index}:${checkpoint}`, title: checkpoint, style: { minWidth: 0, display: 'grid', gridTemplateColumns: '12px minmax(0,1fr) 64px', gap: 5, alignItems: 'start', fontSize: 10.5, lineHeight: 1.4 } }, React.createElement('span', { 'aria-hidden': true, style: { width: 12, height: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: tone } }, completed ? React.createElement(CheckpointDoneIcon, { size: 12 }) : current ? React.createElement(StateDot, { state: 'ongoing', size: 10 }) : '○'), React.createElement('span', { style: { color: 'inherit', display: '-webkit-box', WebkitLineClamp: 'unset', WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' } }, checkpoint), React.createElement('span', { title: `执行时长 ${duration}`, style: { width: 64, color: colors.muted, textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } }, duration)) })) : null) : null,
          task.waitingReason ? React.createElement('div', { title: task.waitingReason, style: { fontSize: 10.5, lineHeight: 1.45, color: colors.warning } }, `等待：${task.waitingReason}`) : null),
          timing ? React.createElement('div', { title: timing.complete ? '当前执行轮次精确统计；未细分为运行状态中尚未按工具调用单独计量的时间' : `当前执行轮次统计不完整：${(timing.missing || []).join('、') || '历史数据不足'}；未细分为运行状态中尚未按工具调用单独计量的时间`, style: { display: 'grid', gap: 2, padding: '5px 8px', borderRadius: 7, background: `color-mix(in srgb, ${colors.surface2} 70%, transparent)`, color: timing.complete ? colors.muted : colors.warning } },
            React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, fontSize: 10.5, lineHeight: 1.4 } }, React.createElement('span', null, '本轮用时'), React.createElement('strong', { style: { color: 'inherit', fontSize: 11.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } }, `${timing.complete ? '' : '约 '}${fmtDuration(timing.wallMs)}`)),
            timingBreakdown(timing) ? React.createElement('div', { style: { fontSize: 10, lineHeight: 1.4, overflowWrap: 'anywhere' } }, timingBreakdown(timing)) : null) : null,
          React.createElement('div', { style: { minWidth: 0, marginTop: 0, paddingTop: 6, borderTop: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
            React.createElement('span', { title: `最后活动 ${fmt(task.updatedAt)}`, style: { minWidth: 0, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, color: colors.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, React.createElement('svg', { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-label': '最后活动时间' }, React.createElement('circle', { cx: 12, cy: 12, r: 9 }), React.createElement('path', { d: 'M12 7v5l3 2' })), fmt(task.updatedAt)),
            task.state === 'completed' && !task.archivedAt ? React.createElement('button', { type: 'button', onClick: async (event) => { event.stopPropagation(); try { await post(`/tasks/${encodeURIComponent(task.taskId)}/archive`); await refresh() } catch (cause) { setNavigationError(cause instanceof Error ? cause.message : String(cause)) } }, style: { flex: '0 0 auto', border: `1px solid ${colors.border}`, borderRadius: 7, background: colors.surface2, color: colors.muted, padding: '3px 7px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 10.5 } }, '归档') : null),
          navigating ? React.createElement('div', { role: 'status', style: { fontSize: 11.5, color: colors.accent } }, '正在打开会话…') : queued ? React.createElement('div', { style: { fontSize: 11.5, color: colors.muted } }, '等待执行，尚无对话和轨迹') : null),
          null)
      }
      const alertCategories = [
        { id: 'all', label: '全部类型' },
        { id: 'message-channel', label: '消息通道' },
        { id: 'leaf-session', label: '叶子会话' },
        { id: 'goal', label: '任务目标' },
        { id: 'runtime', label: '运行时' }
      ]
      const classifyAlert = (alert) => {
        const fingerprint = String(alert.fingerprint || '')
        if (fingerprint.startsWith('dws-') || fingerprint.includes('consumer')) return alertCategories[1]
        if (fingerprint.startsWith('leaf-session') || fingerprint.startsWith('leaf-paused')) return alertCategories[2]
        if (fingerprint.startsWith('leaf-goal')) return alertCategories[3]
        return alertCategories[4]
      }
      const renderAlert = (alert, index) => {
        const active = alert.status !== 'resolved'
        const category = classifyAlert(alert)
        return React.createElement('div', { key: alert.alertId || alert.fingerprint || index, style: { padding: '12px 0', borderTop: `1px solid ${colors.border}` } },
          React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 12 } }, React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } }, tableStatusTag(active ? '当前异常' : '已恢复', active ? 'error' : 'done', { fontWeight: 600 }), React.createElement(Pill, { style: { border: 0, fontSize: 12, fontWeight: 600 } }, category.label)), React.createElement('span', { style: { fontSize: 11, color: colors.muted } }, fmt(active ? alert.lastSeenAt : alert.resolvedAt || alert.lastSeenAt))),
          React.createElement('div', { style: { marginTop: 5, fontSize: 14 } }, alert.message || alert.detail || alert.reason || JSON.stringify(alert)),
          React.createElement('code', { style: { display: 'block', marginTop: 6, fontSize: 11, color: colors.muted } }, `${alert.taskId} · ${alert.fingerprint} · ${alert.count || 1} 次`))
      }
      const activeAlerts = (data?.alerts || []).filter((alert) => alert.status !== 'resolved').sort((left, right) => String(right.lastSeenAt).localeCompare(String(left.lastSeenAt)))
      const resolvedAlerts = (data?.alerts || []).filter((alert) => alert.status === 'resolved').sort((left, right) => String(right.resolvedAt || right.lastSeenAt).localeCompare(String(left.resolvedAt || left.lastSeenAt)))
      const matchesAlertType = (alert) => alertType === 'all' || classifyAlert(alert).id === alertType
      const filteredActiveAlerts = activeAlerts.filter(matchesAlertType)
      const filteredResolvedAlerts = resolvedAlerts.filter(matchesAlertType)
      const resolvedAlertPageSize = 10
      const resolvedAlertPageCount = Math.max(1, Math.ceil(filteredResolvedAlerts.length / resolvedAlertPageSize))
      const currentResolvedAlertPage = Math.min(resolvedAlertPage, resolvedAlertPageCount)
      const visibleResolvedAlerts = filteredResolvedAlerts.slice((currentResolvedAlertPage - 1) * resolvedAlertPageSize, currentResolvedAlertPage * resolvedAlertPageSize)
      const bucketColumns = taskBuckets.map((bucket) => {
        const tasks = (data?.tasks || []).filter((task) => task.state === bucket.state && !task.archivedAt).sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
        const taskCards = tasks.length ? tasks.map(renderTaskCard) : [React.createElement('div', { key: 'empty', style: { border: `1px dashed ${colors.border}`, borderRadius: 10, minHeight: 90, display: 'grid', placeItems: 'center', color: colors.muted, fontSize: 12 } }, '暂无任务')]
        return React.createElement('div', { key: bucket.state, style: { boxSizing: 'border-box', borderRadius: 14, background: bucket.background, padding: '8px 4px', display: 'flex', flexDirection: 'column', height: 'calc(100dvh - 116px)', minHeight: 420, maxHeight: 'calc(100dvh - 116px)', overflow: 'hidden' } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px 10px' } }, React.createElement('strong', { style: { display: 'inline-flex', alignItems: 'center', borderRadius: 999, padding: '3px 9px', fontSize: 11.5, fontWeight: 650, lineHeight: 1.4, color: 'var(--dsw-alias-label-primary-inverted, #fff)', background: bucket.tone } }, bucket.label), React.createElement('span', { style: { borderRadius: 999, background: colors.cardSurface, padding: '2px 7px', fontSize: 10.5, color: colors.muted } }, tasks.length)),
          React.createElement('div', { style: { flex: 1, minHeight: 0, padding: '8px 8px 12px 8px', display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto', scrollbarWidth: 'none' } }, ...taskCards))
      })
      const menu = React.createElement('nav', { 'aria-label': '运行看板视图', style: { minWidth: 0, height: 27, display: 'flex', alignItems: 'stretch', gap: 36, overflowX: 'auto', padding: '0 0 0 8px' } },
        ...pages.map((page) => React.createElement('button', { key: page.id, type: 'button', onClick: () => setActivePage(page.id), 'aria-current': activePage === page.id ? 'page' : undefined, style: navigationTabStyle(activePage === page.id) }, page.label)))
      const refreshIcon = React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, style: refreshState === 'refreshing' ? { animation: 'spin 800ms linear infinite' } : undefined }, React.createElement('path', { d: 'M20 11a8 8 0 1 0-2.34 5.66' }), React.createElement('path', { d: 'M20 4v7h-7' }))
      const header = React.createElement('header', { style: { position: 'sticky', top: 0, zIndex: 2, boxSizing: 'border-box', display: 'grid', gap: 4, padding: '12px 28px 0 20px', borderBottom: `1px solid ${colors.border}`, background: colors.surface, pointerEvents: 'auto' } },
        React.createElement('div', { style: { height: 32, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24 } },
          React.createElement('div', { 'aria-label': updatedAt ? `运行正常，最近更新 ${fmt(updatedAt)}` : '正在连接运行时', style: { minWidth: 0, display: 'flex', alignItems: 'center', gap: 12, color: colors.muted, fontSize: 12, lineHeight: '18px', whiteSpace: 'nowrap' } },
            React.createElement('span', { style: { boxSizing: 'border-box', padding: '4px 8px', fontSize: 14, fontWeight: 500, lineHeight: '20px', whiteSpace: 'nowrap' } }, '运行看板'),
            React.createElement('span', { 'aria-hidden': true, style: { width: 1, height: 12, background: colors.border } }),
            React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 7 } },
              React.createElement(StateDot, { state: updatedAt ? 'done' : 'ongoing', size: 7 }),
              React.createElement('span', { style: { color: updatedAt ? statusTone.done : colors.muted } }, updatedAt ? '运行正常' : '正在连接')),
            updatedAt ? React.createElement('span', { 'aria-hidden': true, style: { width: 1, height: 12, background: colors.border } }) : null,
            updatedAt ? React.createElement('span', { title: fmt(updatedAt) }, `更新于 ${fmtTime(updatedAt)}`) : null),
          React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: refreshState === 'refreshing', onClick: manualRefresh, 'aria-live': 'polite', style: { gap: 6, minWidth: 78, fontSize: 13, lineHeight: '20px' } }, refreshState === 'refreshing' ? '刷新中' : refreshState === 'done' ? '已刷新' : '刷新', refreshIcon)),
        menu)
      const dataViewTabs = React.createElement('div', { role: 'tablist', 'aria-label': '群聊数据视图', style: { display: 'flex', alignSelf: 'stretch', gap: 20 } },
        ...[{ id: 'messages', label: `收信箱 · ${selectedMessages.length}` }, { id: 'outbox', label: `发信箱 · ${selectedOutbox.length}` }].map((item) => React.createElement('button', { key: item.id, role: 'tab', 'aria-selected': groupTableView === item.id, type: 'button', onClick: () => setGroupTableView(item.id), style: navigationTabStyle(groupTableView === item.id, { paddingBottom: 4 }) }, item.label)))
      const groupTableToolbar = React.createElement('div', { style: toolbar },
        dataViewTabs,
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' } },
          (data?.groups || []).length ? React.createElement(SelectMenu, { label: '选择群聊会话', value: selectedGroup?.groupId || '', options: (data?.groups || []).map((group) => ({ id: group.groupId, label: group.name || group.groupId })), onChange: (value) => { setSelectedGroupId(value); setMessagePage(1); setOutboxPage(1) }, fitContent: true }) : null,
          groupTableView === 'messages'
            ? React.createElement(SelectMenu, { label: '筛选投递状态', value: messageDeliveryFilter, options: [{ id: 'all', label: '全部投递状态' }, { id: 'delivered', label: '已投递' }, { id: 'failed', label: '投递失败' }, { id: 'pending', label: '投递中' }, { id: 'skipped', label: '历史未投递' }, { id: 'unknown', label: '状态未知' }], onChange: (value) => { setMessageDeliveryFilter(value); setMessagePage(1) } })
            : React.createElement(SelectMenu, { label: '筛选发件状态', value: outboxStatusFilter, options: [{ id: 'all', label: '全部发件状态' }, { id: 'confirmed', label: '已回读' }, { id: 'waiting', label: '待回读' }, { id: 'recalled', label: '已撤回' }], onChange: (value) => { setOutboxStatusFilter(value); setOutboxPage(1) } })))
      const messagesTable = React.createElement(React.Fragment, null,
        React.createElement('div', { style: { overflowX: 'auto' } }, React.createElement('table', { style: { width: '100%', minWidth: 910, borderCollapse: 'collapse', tableLayout: 'fixed' } },
          React.createElement('thead', null, React.createElement('tr', { style: { background: colors.surface2, textAlign: 'left' } }, React.createElement('th', { style: { ...tableHeadCell, width: 104 } }, 'Agent 投递'), React.createElement('th', { style: { ...tableHeadCell, width: 160 } }, '发送人 / 时间'), React.createElement('th', { style: tableHeadCell }, '消息内容'), React.createElement('th', { style: { ...tableHeadCell, width: 240 } }, '消息'))),
          React.createElement('tbody', null, ...(messageRows.length ? messageRows : [React.createElement('tr', { key: 'empty' }, React.createElement('td', { colSpan: 4, style: { ...tableBodyCell, padding: 36, textAlign: 'center', color: colors.muted } }, '暂无符合条件的群聊消息'))])))),
        React.createElement('div', { style: tableFooter }, React.createElement('span', { style: { marginRight: 'auto', fontSize: 11, color: colors.muted } }, `${filteredMessages.length} 条 · 每页 ${pageSize} 条`), React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: currentMessagePage <= 1, onClick: () => setMessagePage((page) => Math.max(1, page - 1)) }, '上一页'), React.createElement('span', { style: { fontSize: 11, color: colors.muted } }, `${currentMessagePage} / ${pageCount}`), React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: currentMessagePage >= pageCount, onClick: () => setMessagePage((page) => Math.min(pageCount, page + 1)) }, '下一页')))
      const outboxTable = React.createElement(React.Fragment, null,
        React.createElement('div', { style: { overflowX: 'auto' } }, React.createElement('table', { style: { width: '100%', minWidth: 1100, borderCollapse: 'collapse', tableLayout: 'fixed' } },
          React.createElement('thead', null, React.createElement('tr', { style: { background: colors.surface2, textAlign: 'left' } }, React.createElement('th', { style: { ...tableHeadCell, width: 104 } }, '发送状态'), React.createElement('th', { style: tableHeadCell }, '消息内容'), React.createElement('th', { style: { ...tableHeadCell, width: 220 } }, '来源 / 回复目标'), React.createElement('th', { style: { ...tableHeadCell, width: 220 } }, '投递消息 ID'), React.createElement('th', { style: { ...tableHeadCell, width: 220 } }, '发信箱 ID'))),
          React.createElement('tbody', null, ...(outboxRows.length ? outboxRows : [React.createElement('tr', { key: 'empty' }, React.createElement('td', { colSpan: 5, style: { ...tableBodyCell, padding: 36, textAlign: 'center', color: colors.muted } }, '暂无符合条件的 Agent 发件记录'))])))),
        React.createElement('div', { style: tableFooter }, React.createElement('span', { style: { marginRight: 'auto', fontSize: 11, color: colors.muted } }, `${filteredOutbox.length} 条 · 每页 ${outboxPageSize} 条`), React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: currentOutboxPage <= 1, onClick: () => setOutboxPage((page) => Math.max(1, page - 1)) }, '上一页'), React.createElement('span', { style: { fontSize: 11, color: colors.muted } }, `${currentOutboxPage} / ${outboxPageCount}`), React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: currentOutboxPage >= outboxPageCount, onClick: () => setOutboxPage((page) => Math.min(outboxPageCount, page + 1)) }, '下一页')))
      const groupsPage = React.createElement('section', null, React.createElement('div', { style: tableFrame }, groupTableToolbar, groupTableView === 'messages' ? messagesTable : outboxTable))
      const tasksPage = React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(300px, 1fr))', gap: 10, overflowX: 'auto', alignItems: 'start', paddingBottom: 8 } }, ...bucketColumns)
      const authorizationStatus = {
        'pending-send': { label: '待发送', state: 'warning' },
        'waiting-reply': { label: '待批复', state: 'warning' },
        answered: { label: '已处理', state: 'done' },
      }
      const authorizationDecision = { approved: { label: '已批准', state: 'done' }, rejected: { label: '已拒绝', state: 'error' } }
      const decideAuthorization = async (requestId, decision) => {
        try {
          setNavigationError(undefined); setDecidingAuthorizationId(requestId)
          await post(`/authorizations/${encodeURIComponent(requestId)}/decision`, { decision, comment: authorizationComments[requestId] || '' })
          await refresh()
        } catch (cause) { setNavigationError(cause instanceof Error ? cause.message : String(cause)) }
        finally { setDecidingAuthorizationId('') }
      }
      const authorizationItems = [...(data?.authorizations || [])].sort((left, right) => {
        const leftPending = left.status === 'answered' ? 0 : 1; const rightPending = right.status === 'answered' ? 0 : 1
        return rightPending - leftPending || String(right.createdAt || '').localeCompare(String(left.createdAt || ''))
      })
      const filteredAuthorizationItems = authorizationItems.filter((item) => authorizationFilter === 'all' || (authorizationFilter === 'pending' ? item.status !== 'answered' : item.decision === authorizationFilter))
      const authorizationPageSize = 10
      const authorizationPageCount = Math.max(1, Math.ceil(filteredAuthorizationItems.length / authorizationPageSize))
      const currentAuthorizationPage = Math.min(authorizationPage, authorizationPageCount)
      const visibleAuthorizationItems = filteredAuthorizationItems.slice((currentAuthorizationPage - 1) * authorizationPageSize, currentAuthorizationPage * authorizationPageSize)
      const selectedAuthorization = authorizationItems.find((item) => item.requestId === selectedAuthorizationId)
      const authorizationDetailField = (label, value) => React.createElement('div', { style: { display: 'grid', gap: 5 } },
        React.createElement('strong', { style: { fontSize: 11, color: colors.muted } }, label),
        React.createElement('div', { style: { fontSize: 13, lineHeight: 1.65, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, value || '—'))
      const authorizationRows = visibleAuthorizationItems.map((item, rowIndex) => {
        const pending = item.status !== 'answered'
        const status = pending ? authorizationStatus[item.status] : authorizationDecision[item.decision] || authorizationStatus.answered
        const group = groupsById.get(item.groupId)
        return React.createElement('div', { key: item.requestId, style: { width: '100%', minWidth: 0, boxSizing: 'border-box', display: 'grid', gridTemplateColumns: '104px minmax(220px, 1.1fr) minmax(280px, 1.5fr) 126px 52px', alignItems: 'center', gap: 16, borderTop: `1px solid ${colors.border}`, background: rowIndex % 2 ? `color-mix(in srgb, ${colors.surface2} 55%, transparent)` : colors.cardSurface, color: 'inherit', padding: '12px 16px', fontSize: 14 } },
          React.createElement('div', { style: { justifySelf: 'start' } }, tableStatusTag(status.label, status.state, { fontWeight: 600 })),
          React.createElement('span', { style: { minWidth: 0 } }, React.createElement('strong', { title: item.objective, style: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14, fontWeight: 600, lineHeight: 1.5 } }, item.objective), React.createElement('span', { style: { display: 'block', marginTop: 3, color: colors.muted, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, group?.name || item.groupId)),
          React.createElement('span', { style: { minWidth: 0 } }, React.createElement('span', { title: item.requestedAction, style: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14, lineHeight: 1.55, color: colors.muted } }, item.requestedAction), item.risk && item.risk !== '未单独说明' ? React.createElement('span', { style: { display: 'block', marginTop: 3, color: colors.danger, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `风险 · ${item.risk}`) : null),
          React.createElement('span', { style: { color: colors.muted, fontSize: 11, lineHeight: 1.5 } }, fmt(item.createdAt)),
          React.createElement(Button, { variant: 'ghost', size: 'sm', type: 'button', onClick: () => setSelectedAuthorizationId(item.requestId) }, '查看'))
      })
      const authorizationDetail = selectedAuthorization ? React.createElement('div', { role: 'presentation', onMouseDown: (event) => { if (event.target === event.currentTarget) setSelectedAuthorizationId('') }, style: { position: 'fixed', inset: 0, zIndex: 1100, display: 'flex', justifyContent: 'flex-end', background: 'rgba(0,0,0,.28)', backdropFilter: 'blur(2px)' } },
        React.createElement('section', { role: 'dialog', 'aria-modal': true, 'aria-label': '授权申请单详情', style: { width: 'min(640px, 100%)', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', borderLeft: `1px solid ${colors.border}`, background: colors.surface, boxShadow: '-20px 0 60px rgba(0,0,0,.2)' } },
          React.createElement('header', { style: { flex: '0 0 auto', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 24, padding: '24px 24px 20px', borderBottom: `1px solid ${colors.border}`, background: colors.surface } },
            React.createElement('div', { style: { minWidth: 0 } }, React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 } }, statusTag(selectedAuthorization.status === 'answered' ? (authorizationDecision[selectedAuthorization.decision]?.label || '已处理') : (authorizationStatus[selectedAuthorization.status]?.label || '待批复'), selectedAuthorization.status === 'answered' ? (authorizationDecision[selectedAuthorization.decision]?.state || 'done') : 'warning'), React.createElement('span', { style: { color: colors.muted, fontSize: 11.5 } }, fmt(selectedAuthorization.createdAt))), React.createElement('h3', { style: { margin: 0, fontSize: 18, fontWeight: 600, lineHeight: 1.5 } }, selectedAuthorization.objective || '授权申请'), React.createElement('code', { style: { display: 'block', marginTop: 10, color: colors.muted, fontSize: 10.5 } }, selectedAuthorization.requestId)),
            React.createElement(Button, { variant: 'ghost', size: 'sm', type: 'button', 'aria-label': '关闭申请单', onClick: () => setSelectedAuthorizationId(''), style: { flex: '0 0 auto', minWidth: 52, whiteSpace: 'nowrap' } }, '关闭')),
          React.createElement('div', { style: { flex: '1 1 auto', overflowY: 'auto', padding: '0 24px 24px' } },
            React.createElement('section', { style: { padding: '24px 0', borderBottom: `1px solid ${colors.border}` } }, authorizationDetailField('申请范围', selectedAuthorization.requestedAction)),
            React.createElement('section', { style: { padding: '24px 0', borderBottom: `1px solid ${colors.border}` } }, authorizationDetailField('风险', selectedAuthorization.risk || '未单独说明')),
            React.createElement('section', { style: { padding: '24px 0', borderBottom: `1px solid ${colors.border}` } }, authorizationDetailField('阻塞原因', selectedAuthorization.waitingReason)),
            React.createElement('details', { open: true, style: { padding: '18px 0', borderBottom: `1px solid ${colors.border}` } }, React.createElement('summary', { style: { cursor: 'pointer', fontSize: 12, fontWeight: 600 } }, `现场证据 · ${(selectedAuthorization.evidence || []).length}`), React.createElement('div', { style: { marginTop: 14 } }, authorizationDetailField('', (selectedAuthorization.evidence || []).map((value, index) => `${index + 1}. ${value}`).join('\n')))),
            React.createElement('details', { style: { padding: '18px 0', borderBottom: `1px solid ${colors.border}` } }, React.createElement('summary', { style: { cursor: 'pointer', fontSize: 12, fontWeight: 600 } }, `已尝试 · ${(selectedAuthorization.attemptedActions || []).length}`), React.createElement('div', { style: { marginTop: 14 } }, authorizationDetailField('', (selectedAuthorization.attemptedActions || []).map((value, index) => `${index + 1}. ${value}`).join('\n')))),
            React.createElement('section', { style: { padding: '20px 0', borderBottom: `1px solid ${colors.border}` } }, authorizationDetailField('关联信息', `Task ID：${selectedAuthorization.taskId || '—'}\n群聊：${groupsById.get(selectedAuthorization.groupId)?.name || selectedAuthorization.groupId || '—'}`)),
            selectedAuthorization.status === 'answered' ? React.createElement('section', { style: { padding: '20px 0' } }, authorizationDetailField('批复结果', `${selectedAuthorization.decision === 'approved' ? '批准' : selectedAuthorization.decision === 'rejected' ? '拒绝' : selectedAuthorization.decision || '已处理'}\n批复渠道：${selectedAuthorization.decisionSource === 'web' ? '运行看板' : selectedAuthorization.decisionSource === 'dingtalk' ? '钉钉私聊' : selectedAuthorization.decisionSource || '历史迁移'}\n批复时间：${fmt(selectedAuthorization.decidedAt)}\n批复内容：${selectedAuthorization.reply || '—'}`)) : null),
          selectedAuthorization.status !== 'answered' ? React.createElement('footer', { style: { flex: '0 0 auto', display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 10, alignItems: 'center', padding: '16px 24px', borderTop: `1px solid ${colors.border}`, background: colors.surface2 } },
            React.createElement('input', { 'aria-label': `审批意见 ${selectedAuthorization.requestId}`, value: authorizationComments[selectedAuthorization.requestId] || '', onChange: (event) => setAuthorizationComments((current) => ({ ...current, [selectedAuthorization.requestId]: event.target.value })), placeholder: '审批意见（可选）', style: { minWidth: 0, border: `1px solid ${colors.border}`, borderRadius: 9, background: colors.surface2, color: 'inherit', padding: '9px 11px', fontFamily: 'inherit', fontSize: 12 } }),
            React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: decidingAuthorizationId === selectedAuthorization.requestId, onClick: () => decideAuthorization(selectedAuthorization.requestId, 'rejected'), style: { color: colors.danger } }, '拒绝'),
            React.createElement(Button, { variant: 'primary', size: 'sm', type: 'button', disabled: decidingAuthorizationId === selectedAuthorization.requestId, onClick: () => decideAuthorization(selectedAuthorization.requestId, 'approved') }, decidingAuthorizationId === selectedAuthorization.requestId ? '处理中…' : '批准')) : null)) : null
      const authorizationsPage = React.createElement(React.Fragment, null, React.createElement('section', null,
        React.createElement('div', { style: tableFrame },
          React.createElement('div', { style: { ...toolbar, justifyContent: 'flex-end' } }, React.createElement(SelectMenu, { label: '筛选审批状态', value: authorizationFilter, options: [{ id: 'all', label: '全部审批状态' }, { id: 'pending', label: '待批复' }, { id: 'approved', label: '已批准' }, { id: 'rejected', label: '已拒绝' }], onChange: (value) => { setAuthorizationFilter(value); setAuthorizationPage(1) }, fitContent: true })),
          React.createElement('div', { style: { height: 42, boxSizing: 'border-box', display: 'grid', gridTemplateColumns: '104px minmax(220px, 1.1fr) minmax(280px, 1.5fr) 126px 52px', alignItems: 'center', gap: 16, padding: '0 16px', background: colors.surface2, color: colors.muted, fontSize: 13, fontWeight: 600 } }, React.createElement('span', null, '状态'), React.createElement('span', null, '任务'), React.createElement('span', null, '申请摘要'), React.createElement('span', null, '申请时间'), React.createElement('span', null, '操作')),
          React.createElement('div', null, ...(authorizationRows.length ? authorizationRows : [React.createElement('div', { key: 'empty', style: { padding: 36, textAlign: 'center', color: colors.muted, fontSize: 12 } }, '暂无授权申请')])),
          React.createElement('div', { style: tableFooter },
            React.createElement('span', { style: { marginRight: 'auto', fontSize: 11, color: colors.muted } }, `当前显示 ${filteredAuthorizationItems.length} 条 · 每页 ${authorizationPageSize} 条`),
            React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: currentAuthorizationPage <= 1, onClick: () => setAuthorizationPage((page) => Math.max(1, page - 1)) }, '上一页'),
            React.createElement('span', { style: { fontSize: 11, color: colors.muted } }, `${currentAuthorizationPage} / ${authorizationPageCount}`),
            React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: currentAuthorizationPage >= authorizationPageCount, onClick: () => setAuthorizationPage((page) => Math.min(authorizationPageCount, page + 1)) }, '下一页')))
      ), authorizationDetail)
      const archivedTasks = (data?.tasks || []).filter((task) => task.state === 'completed' && task.archivedAt).sort((left, right) => String(right.archivedAt).localeCompare(String(left.archivedAt)))
      const archivePage = React.createElement('section', null, React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 } }, ...(archivedTasks.length ? archivedTasks.map(renderTaskCard) : [React.createElement(React.Fragment, { key: 'empty' }, emptyState('暂无归档任务'))])))
      const alertsPage = React.createElement(React.Fragment, null,
        React.createElement('section', null, React.createElement('div', { style: tableFrame },
          React.createElement('div', { style: toolbar },
            React.createElement('div', { role: 'tablist', 'aria-label': '告警状态视图', style: { display: 'flex', alignSelf: 'stretch', gap: 20 } }, ...[{ id: 'active', label: `当前异常 · ${filteredActiveAlerts.length}` }, { id: 'resolved', label: `恢复历史 · ${filteredResolvedAlerts.length}` }].map((item) => React.createElement('button', { key: item.id, role: 'tab', 'aria-selected': alertView === item.id, type: 'button', onClick: () => setAlertView(item.id), style: navigationTabStyle(alertView === item.id, { paddingBottom: 4 }) }, item.label))),
            React.createElement(SelectMenu, { label: '筛选告警类型', value: alertType, options: alertCategories.map((category) => ({ id: category.id, label: category.label })), onChange: (value) => { setAlertType(value); setResolvedAlertPage(1) }, fitContent: true })),
          React.createElement('div', { style: { padding: '0 16px' } }, ...(alertView === 'active' ? (filteredActiveAlerts.length ? filteredActiveAlerts.map(renderAlert) : [React.createElement('div', { key: 'empty', style: { padding: '36px 0', textAlign: 'center', color: colors.muted, fontSize: 12 } }, '当前没有此类型异常')]) : (visibleResolvedAlerts.length ? visibleResolvedAlerts.map(renderAlert) : [React.createElement('div', { key: 'empty', style: { padding: '36px 0', textAlign: 'center', color: colors.muted, fontSize: 12 } }, '暂无此类型恢复记录')]))),
          alertView === 'resolved' ? React.createElement('div', { style: tableFooter }, React.createElement('span', { style: { marginRight: 'auto', fontSize: 11, color: colors.muted } }, `${filteredResolvedAlerts.length} 条 · 每页 ${resolvedAlertPageSize} 条`), React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: currentResolvedAlertPage <= 1, onClick: () => setResolvedAlertPage((page) => Math.max(1, page - 1)) }, '上一页'), React.createElement('span', { style: { fontSize: 11, color: colors.muted } }, `${currentResolvedAlertPage} / ${resolvedAlertPageCount}`), React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: currentResolvedAlertPage >= resolvedAlertPageCount, onClick: () => setResolvedAlertPage((page) => Math.min(resolvedAlertPageCount, page + 1)) }, '下一页')) : null))
      )
      const pageContent = activePage === 'tasks' ? tasksPage : activePage === 'authorizations' ? authorizationsPage : activePage === 'archive' ? archivePage : activePage === 'alerts' ? alertsPage : groupsPage
      const pageViewport = React.createElement('div', { style: { width: '100%', maxWidth: 1320, minHeight: 'calc(100dvh - 138px)', boxSizing: 'border-box', margin: '0 auto' } }, pageContent)
      const main = React.createElement('main', { style: { width: '100%', minHeight: 'calc(100dvh - 90px)', boxSizing: 'border-box', padding: activePage === 'tasks' ? '24px 24px 0' : '24px 24px 32px', display: 'grid', alignContent: 'start', gap: 20, pointerEvents: 'auto' } },
        error ? React.createElement('div', { style: { ...card, borderColor: colors.danger, color: colors.danger } }, `无法连接 resident 插件：${error}`) : null,
        navigationError ? React.createElement('div', { style: { ...card, borderColor: colors.danger, color: colors.danger } }, `无法打开 DSH Session：${navigationError}`) : null,
        pageViewport
      )
      return React.createElement('div', { style: { width: '100%', height: '100%', minWidth: 0, minHeight: 0, background: colors.surface, color: 'inherit', overflow: 'auto' } }, header, main)
    }
    function apply(ctx) {
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'dingtalk-dsh-observer-entry', order: 5, inject: () => ({}) }, SidebarAction))
      ctx.slots.inject('conversation', () => {
        let disposeContent
        const syncContent = (visible) => {
          if (visible && !disposeContent) {
            disposeContent = ctx.slots.register({ name: 'conversation', id: 'dingtalk-dsh-observer', priority: -10, inject: () => ({ openSession: async (sessionId, parentSessionId) => {
              if (parentSessionId) {
                let address = ctx.sessions.subagentAddress(sessionId)
                if (!address) { await ctx.sessions.refreshSubagents(parentSessionId); address = ctx.sessions.subagentAddress(sessionId) }
                if (address) { ctx.sessions.openSubagent(address); return }
              }
              await ctx.sessions.refresh()
              ctx.sessions.open(sessionId)
            } }) }, ObserverContent)
          } else if (!visible && disposeContent) {
            disposeContent()
            disposeContent = undefined
          }
        }
        openListeners.add(syncContent)
        syncContent(open)
        return () => {
          openListeners.delete(syncContent)
          disposeContent?.()
        }
      })
    }
    module.exports = { name: 'dingtalk-dsh-observer-client', inject: ['slots', 'sessions'], apply }
    return module.exports
  }
})
