window.__ModuleLoader__.load({
  id: '@zzusp/dingtalk-dsh-observer',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const { Button, Menu, Pill, StateDot } = require('@deepseek-ai/dsh-client-ui-primitives')
    const { useCallback, useEffect, useLayoutEffect, useRef, useState } = React
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
    const short = (value) => value ? String(value).replace(/^session-/, '').slice(0, 14) : '—'
    const pill = (tone) => ({ display: 'inline-flex', alignItems: 'center', borderRadius: 999, padding: '3px 8px', fontSize: 12, color: tone, background: `color-mix(in srgb, ${tone} 12%, transparent)` })
    const card = { border: `1px solid ${colors.border}`, borderRadius: 12, background: colors.cardSurface, padding: 16, boxShadow: '0 4px 16px rgba(15,23,42,.07)' }
    const tableFrame = { border: `1px solid ${colors.border}`, borderRadius: 12, background: colors.cardSurface, overflow: 'hidden', boxShadow: 'var(--dsw-shadow-card, 0 1px 2px rgba(0,0,0,.06))' }
    const tableHeadCell = { height: 40, boxSizing: 'border-box', padding: '0 12px', color: colors.muted, fontSize: 11, fontWeight: 500, verticalAlign: 'middle' }
    const tableBodyCell = { padding: '12px', borderTop: `1px solid ${colors.border}`, fontSize: 12, lineHeight: 1.55, verticalAlign: 'top' }
    const tableFooter = { minHeight: 48, boxSizing: 'border-box', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, padding: '8px 12px', borderTop: `1px solid ${colors.border}`, background: colors.surface2 }
    const toolbar = { minHeight: 48, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 12px', borderBottom: `1px solid ${colors.border}`, background: colors.cardSurface }
    const statusTone = {
      done: 'var(--dsw-alias-state-success-primary, #248a3d)',
      warning: 'var(--dsw-alias-state-warn-primary, #a56500)',
      ongoing: 'var(--dsw-alias-brand-primary, #4d6bfe)',
      error: 'var(--dsw-alias-state-error-primary, #c33)'
    }
    const statusTag = (label, state) => {
      const tone = statusTone[state] || colors.muted
      return React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 24, boxSizing: 'border-box', border: `1px solid color-mix(in srgb, ${tone} 28%, transparent)`, borderRadius: 999, background: `color-mix(in srgb, ${tone} 10%, transparent)`, color: tone, padding: '2px 8px', fontSize: 11, fontWeight: 500, lineHeight: 1.4, whiteSpace: 'nowrap' } }, React.createElement(StateDot, { state, size: 7 }), label)
    }
    const authorizationTag = (label, state) => {
      const tone = statusTone[state] || colors.muted
      return React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5, minWidth: 58, minHeight: 22, boxSizing: 'border-box', border: `1px solid color-mix(in srgb, ${tone} 18%, transparent)`, borderRadius: 6, background: `color-mix(in srgb, ${tone} 7%, transparent)`, color: tone, padding: '2px 7px', fontSize: 11, fontWeight: 500, lineHeight: 1.35, whiteSpace: 'nowrap' } }, React.createElement(StateDot, { state, size: 6 }), label)
    }
    function SelectMenu({ label, value, options, onChange, minWidth = 150 }) {
      const [open, setOpen] = useState(false)
      const selected = options.find((item) => item.id === value)
      const anchor = React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', 'aria-label': label, 'aria-expanded': open, onClick: () => setOpen((current) => !current), style: { minWidth, justifyContent: 'space-between', gap: 16, fontWeight: 400 } }, React.createElement('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, selected?.label || value), React.createElement('span', { 'aria-hidden': true, style: { color: colors.muted, fontSize: 9, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s ease' } }, '▼'))
      return React.createElement(Menu, { open, anchor, items: options, selectedId: value, onSelect: (id) => { onChange(id); setOpen(false) }, onClose: () => setOpen(false), align: 'end', portal: true, dense: true, compact: true })
    }
    const pageHeader = (title, description, count) => React.createElement('div', { style: { minHeight: 44, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 20, marginBottom: 16 } },
      React.createElement('div', { style: { minWidth: 0 } }, React.createElement('h1', { style: { margin: 0, fontSize: 18, lineHeight: 1.45, fontWeight: 600 } }, title), React.createElement('p', { style: { margin: '4px 0 0', color: colors.muted, fontSize: 12, lineHeight: 1.5 } }, description)),
      count === undefined ? null : React.createElement(Pill, null, String(count)))
    const sectionHeader = (title, meta) => React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, marginBottom: 12 } }, React.createElement('h2', { style: { margin: 0, fontSize: 15, lineHeight: 1.45, fontWeight: 600 } }, title), meta ? React.createElement('span', { style: { color: colors.muted, fontSize: 11 } }, meta) : null)
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
      const [health, groups, tasks, activities, alerts, authorizations] = await Promise.all([
        get('/health'), get('/state/groups'), get('/state/tasks'), get('/state/activities'), get('/state/supervisor/alerts'), get('/state/authorizations')
      ])
      return { health, groups, tasks, activities, alerts, authorizations }
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
    function ObserverOverlay({ openSession }) {
      const isOpen = useOpen()
      const [activePage, setActivePage] = useState('groups')
      const [data, setData] = useState()
      const [error, setError] = useState()
      const [navigationError, setNavigationError] = useState()
      const [updatedAt, setUpdatedAt] = useState()
      const [selectedGroupId, setSelectedGroupId] = useState('')
      const [messagePage, setMessagePage] = useState(1)
      const [outboxPage, setOutboxPage] = useState(1)
      const [groupTableView, setGroupTableView] = useState('messages')
      const [messageDeliveryFilter, setMessageDeliveryFilter] = useState('all')
      const [outboxStatusFilter, setOutboxStatusFilter] = useState('all')
      const [hoveredTaskId, setHoveredTaskId] = useState('')
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
      const [sidebarWidth, setSidebarWidth] = useState(280)
      const overlayRef = useRef()
      const refresh = useCallback(async () => {
        try { setData(await load()); setUpdatedAt(new Date()); setError(undefined) }
        catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
      }, [])
      useLayoutEffect(() => {
        if (!isOpen) return undefined
        refresh()
        const timer = window.setInterval(refresh, 5000)
        return () => window.clearInterval(timer)
      }, [isOpen, refresh])
      useEffect(() => {
        if (!isOpen) return undefined
        const entry = document.querySelector('[aria-label="钉钉群聊运行看板"]')
        let sidebar = entry?.parentElement
        while (sidebar?.parentElement) {
          const rect = sidebar.getBoundingClientRect()
          if (rect.left === 0 && rect.width >= 40 && rect.width <= 400 && rect.height >= window.innerHeight * .8) break
          sidebar = sidebar.parentElement
        }
        const update = () => {
          const right = sidebar?.getBoundingClientRect().right
          if (Number.isFinite(right) && right >= 40 && right <= 400) {
            const roundedRight = Math.round(right)
            if (overlayRef.current) overlayRef.current.style.paddingLeft = `${roundedRight}px`
            setSidebarWidth((current) => current === roundedRight ? current : roundedRight)
          }
        }
        let animationFrame
        let trackingUntil = 0
        const trackTransition = () => {
          trackingUntil = performance.now() + 700
          if (animationFrame) return
          const track = () => {
            update()
            if (performance.now() < trackingUntil) animationFrame = window.requestAnimationFrame(track)
            else animationFrame = undefined
          }
          animationFrame = window.requestAnimationFrame(track)
        }
        update()
        const observer = sidebar && typeof ResizeObserver === 'function' ? new ResizeObserver(update) : undefined
        if (sidebar && observer) observer.observe(sidebar)
        sidebar?.addEventListener('transitionrun', trackTransition)
        document.addEventListener('click', trackTransition, true)
        window.addEventListener('resize', update)
        return () => {
          observer?.disconnect()
          sidebar?.removeEventListener('transitionrun', trackTransition)
          document.removeEventListener('click', trackTransition, true)
          window.removeEventListener('resize', update)
          if (animationFrame) window.cancelAnimationFrame(animationFrame)
        }
      }, [isOpen])
      useEffect(() => {
        const closeForSession = (event) => {
          if (event.target instanceof Element && event.target.closest('[role="treeitem"]')) setOpen(false)
        }
        document.addEventListener('click', closeForSession, true)
        return () => document.removeEventListener('click', closeForSession, true)
      }, [])
      if (!isOpen) return null
      const activities = new Map((data?.activities || []).map((item) => [item.taskId, item]))
      const groupsById = new Map((data?.groups || []).map((group) => [group.groupId, group]))
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
      const selectedGroupSummary = selectedGroup ? React.createElement('div', { style: { minHeight: 64, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20, padding: '10px 12px', borderBottom: `1px solid ${colors.border}`, background: colors.surface2 } },
        React.createElement('div', { style: { minWidth: 0, display: 'grid', gap: 5 } }, React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10 } }, React.createElement('button', { type: 'button', onClick: () => navigate(selectedGroup.residentSessionId), style: { minWidth: 0, border: 0, padding: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', fontSize: 13, fontWeight: 600 } }, selectedGroup.name || '未命名群'), React.createElement('span', { style: { color: colors.muted, fontSize: 10.5 } }, `${selectedGroup.messages?.length || 0} 条消息`), React.createElement('span', { style: { color: colors.muted, fontSize: 10.5 } }, `更新于 ${fmt(selectedGroup.messages?.at?.(-1)?.occurredAt || selectedGroup.updatedAt)}`)), React.createElement('div', { style: { minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, color: colors.muted, fontSize: 10.5 } }, React.createElement('span', null, '常驻 Session'), React.createElement('code', { title: selectedGroup.residentSessionId || '', style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', color: 'inherit', fontSize: 10.5 } }, selectedGroup.residentSessionId || '尚未建立'))),
        copyButton(selectedGroup.residentSessionId, '会话 ID')) : emptyState('暂无常驻群')
      const selectedMessages = [...(selectedGroup?.messages || [])].sort((left, right) => Number(right.sequence || 0) - Number(left.sequence || 0))
      const filteredMessages = selectedMessages.filter((message) => messageDeliveryFilter === 'all' || (message.agentDeliveryStatus || 'unknown') === messageDeliveryFilter)
      const pageSize = 10
      const pageCount = Math.max(1, Math.ceil(filteredMessages.length / pageSize))
      const currentMessagePage = Math.min(messagePage, pageCount)
      const visibleMessages = filteredMessages.slice((currentMessagePage - 1) * pageSize, currentMessagePage * pageSize)
      const delivery = {
        delivered: { label: '已投递', state: 'done' },
        failed: { label: '投递失败', state: 'error' },
        pending: { label: '投递中', state: 'ongoing' },
        skipped: { label: '历史补拉·未投递', state: 'warning' },
        unknown: { label: '历史状态未知', state: 'warning' },
      }
      const messageRows = visibleMessages.map((message) => {
        const status = delivery[message.agentDeliveryStatus] || delivery.unknown
        return React.createElement('tr', { key: message.messageId },
          React.createElement('td', { style: { ...tableBodyCell, width: 150 } }, React.createElement('strong', { style: { fontSize: 12 } }, message.senderName || message.senderOpenDingTalkId || '发送人未记录'), React.createElement('div', { style: { marginTop: 4, fontSize: 10.5, color: colors.muted } }, fmt(message.occurredAt))),
          React.createElement('td', { title: message.text, style: { ...tableBodyCell, overflowWrap: 'anywhere' } }, message.text || '（空消息）'),
          React.createElement('td', { style: { ...tableBodyCell, width: 150 }, title: message.agentDeliveryError || '' }, statusTag(status.label, status.state)),
          React.createElement('td', { style: { ...tableBodyCell, width: 150 } }, React.createElement('code', { title: message.messageId, style: { fontSize: 10, color: colors.muted } }, `#${message.sequence ?? '—'} · ${short(message.messageId)}`)))
      })
      const selectedOutbox = [...(selectedGroup?.outbox || [])].reverse()
      const filteredOutbox = selectedOutbox.filter((message) => outboxStatusFilter === 'all' || (outboxStatusFilter === 'waiting' ? message.status === 'pending' && message.readbackRequired === true : !(message.status === 'pending' && message.readbackRequired === true)))
      const outboxPageSize = 10
      const outboxPageCount = Math.max(1, Math.ceil(filteredOutbox.length / outboxPageSize))
      const currentOutboxPage = Math.min(outboxPage, outboxPageCount)
      const visibleOutbox = filteredOutbox.slice((currentOutboxPage - 1) * outboxPageSize, currentOutboxPage * outboxPageSize)
      const outboundStatus = {
        sent: { label: '已回读确认', state: 'done' },
        pending: { label: '已回读确认', state: 'done' },
      }
      const outboxRows = visibleOutbox.map((message) => {
        const status = message.status === 'pending' && message.readbackRequired === true ? { label: '待回读确认', state: 'warning' } : outboundStatus[message.status] || outboundStatus.sent
        return React.createElement('tr', { key: message.outboundId },
          React.createElement('td', { style: { ...tableBodyCell, width: 130 } }, statusTag(status.label, status.state)),
          React.createElement('td', { title: message.text, style: { ...tableBodyCell, overflowWrap: 'anywhere' } }, message.text || '（空消息）'),
          React.createElement('td', { style: { ...tableBodyCell, width: 180 } },
            React.createElement('div', null, React.createElement('code', { title: message.sourceMessageId, style: { fontSize: 10, color: colors.muted } }, short(message.sourceMessageId))),
            message.replyToMessageId ? React.createElement('div', { style: { marginTop: 5, fontSize: 10.5, color: colors.muted } }, '回复 ', React.createElement('code', { title: message.replyToMessageId }, short(message.replyToMessageId))) : null),
          React.createElement('td', { style: { ...tableBodyCell, width: 170 } }, React.createElement('code', { title: message.deliveredMessageId || '', style: { fontSize: 10, color: colors.muted } }, message.deliveredMessageId ? short(message.deliveredMessageId) : '历史未记录')),
          React.createElement('td', { style: { ...tableBodyCell, width: 150 } }, React.createElement('code', { title: message.outboundId, style: { fontSize: 10, color: colors.muted } }, short(message.outboundId))))
      })
      const renderTaskCard = (task) => {
        const group = groupsById.get(task.groupId)
        const activity = activities.get(task.taskId)
        const queued = task.state === 'queued'
        const summary = task.waitingReason || task.completion || activity?.type || activity?.eventType
        const hovered = hoveredTaskId === task.taskId
        const navigating = navigatingSessionId === task.childSessionId
        return React.createElement('div', { key: task.taskId, onMouseEnter: () => setHoveredTaskId(task.taskId), onMouseLeave: () => setHoveredTaskId(''), style: { width: '100%', minWidth: 0, boxSizing: 'border-box', border: `1px solid ${colors.border}`, borderRadius: 12, background: colors.cardSurface, boxShadow: hovered ? '0 8px 20px rgba(15,23,42,.08), 0 2px 6px rgba(15,23,42,.05)' : 'var(--dsw-shadow-card, 0 1px 2px rgba(0,0,0,.08))', padding: '11px 13px', color: 'inherit', display: 'grid', gap: 6, opacity: queued ? 0.72 : 1, transition: 'box-shadow 180ms ease' } },
          React.createElement('button', { type: 'button', disabled: queued || navigating, onClick: () => navigate(task.childSessionId, group?.residentSessionId), style: { width: '100%', minWidth: 0, boxSizing: 'border-box', border: 0, padding: 0, background: 'transparent', color: 'inherit', cursor: queued || navigating ? 'default' : 'pointer', textAlign: 'left', display: 'grid', gap: 6, fontFamily: 'inherit' } },
          React.createElement('strong', { title: task.title || task.objective, style: { fontSize: 13, lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' } }, task.title || task.objective),
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', minWidth: 0 } }, React.createElement('span', { title: group?.name || task.groupId, style: { ...pill(colors.muted), maxWidth: '100%', padding: '2px 7px', fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, group?.name || task.groupId)),
          summary ? React.createElement('div', { title: String(summary), style: { minWidth: 0, fontSize: 11, lineHeight: 1.55, color: task.waitingReason ? colors.warning : colors.muted, display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere', wordBreak: 'break-word' } }, summary) : null,
          React.createElement('div', { style: { minWidth: 0, marginTop: 3, paddingTop: 9, borderTop: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
            React.createElement('span', { title: task.updatedAt, style: { minWidth: 0, fontSize: 10.5, color: colors.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `最后活动 ${fmt(task.updatedAt)}`),
            React.createElement('div', { style: { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 5 } }, copyButton(task.taskId, ' Task'), task.state === 'completed' && !task.archivedAt ? React.createElement('button', { type: 'button', onClick: async (event) => { event.stopPropagation(); try { await post(`/tasks/${encodeURIComponent(task.taskId)}/archive`); await refresh() } catch (cause) { setNavigationError(cause instanceof Error ? cause.message : String(cause)) } }, style: { flex: '0 0 auto', border: `1px solid ${colors.border}`, borderRadius: 7, background: colors.surface2, color: colors.muted, padding: '3px 7px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 10.5 } }, '归档') : null)),
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
          React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 12 } }, React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } }, statusTag(active ? '当前异常' : '已恢复', active ? 'error' : 'done'), React.createElement(Pill, null, category.label)), React.createElement('span', { style: { fontSize: 12, color: colors.muted } }, fmt(active ? alert.lastSeenAt : alert.resolvedAt || alert.lastSeenAt))),
          React.createElement('div', { style: { marginTop: 5, fontSize: 12 } }, alert.message || alert.detail || alert.reason || JSON.stringify(alert)),
          React.createElement('code', { style: { display: 'block', marginTop: 6, fontSize: 10.5, color: colors.muted } }, `${alert.taskId} · ${alert.fingerprint} · ${alert.count || 1} 次`))
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
        return React.createElement('div', { key: bucket.state, style: { boxSizing: 'border-box', borderRadius: 14, background: bucket.background, boxShadow: '0 4px 16px rgba(15,23,42,.07)', padding: 10, display: 'flex', flexDirection: 'column', height: 'calc(100dvh - 238px)', minHeight: 420, maxHeight: 'calc(100dvh - 238px)', overflow: 'hidden' } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px 10px' } }, React.createElement('strong', { style: { display: 'inline-flex', alignItems: 'center', borderRadius: 999, padding: '3px 9px', fontSize: 11.5, fontWeight: 650, lineHeight: 1.4, color: 'var(--dsw-alias-label-primary-inverted, #fff)', background: bucket.tone } }, bucket.label), React.createElement('span', { style: { borderRadius: 999, background: colors.cardSurface, padding: '2px 7px', fontSize: 10.5, color: colors.muted } }, tasks.length)),
          React.createElement('div', { style: { flex: 1, minHeight: 0, padding: '8px 12px 16px 8px', display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'scroll', scrollbarGutter: 'stable' } }, ...taskCards))
      })
      const menu = React.createElement('nav', { 'aria-label': '运行看板视图', style: { minWidth: 0, height: 38, display: 'flex', alignItems: 'stretch', gap: 28, overflowX: 'auto', padding: '0 24px' } },
        ...pages.map((page) => React.createElement('button', { key: page.id, type: 'button', onClick: () => setActivePage(page.id), 'aria-current': activePage === page.id ? 'page' : undefined, style: { position: 'relative', border: 0, borderBottom: activePage === page.id ? '2px solid #4d6bfe' : '2px solid transparent', borderRadius: 0, padding: '0 0 8px', cursor: 'pointer', font: 'inherit', fontSize: 13, fontWeight: 400, color: activePage === page.id ? '#4d6bfe' : colors.muted, background: 'transparent', outline: 'none', whiteSpace: 'nowrap' } }, page.label)))
      const refreshIcon = React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, React.createElement('path', { d: 'M20 11a8 8 0 1 0-2.34 5.66' }), React.createElement('path', { d: 'M20 4v7h-7' }))
      const header = React.createElement('header', { style: { position: 'sticky', top: 0, zIndex: 2, borderBottom: `1px solid ${colors.border}`, background: colors.surface, pointerEvents: 'auto' } },
        React.createElement('div', { style: { height: 52, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24, padding: '0 24px' } },
          React.createElement('div', { style: { minWidth: 0, display: 'flex', alignItems: 'center', gap: 14 } },
            React.createElement('span', { style: { fontSize: 15, fontWeight: 400, whiteSpace: 'nowrap' } }, '运行看板'),
            React.createElement('div', { 'aria-label': updatedAt ? `运行正常，最近更新 ${fmt(updatedAt)}` : '正在连接运行时', style: { display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0, color: colors.muted, fontSize: 11.5, whiteSpace: 'nowrap' } },
              React.createElement(StateDot, { state: updatedAt ? 'done' : 'ongoing', size: 7 }),
              React.createElement('span', { style: { color: updatedAt ? statusTone.done : colors.muted } }, updatedAt ? '运行正常' : '正在连接'),
              updatedAt ? React.createElement('span', { 'aria-hidden': true, style: { width: 1, height: 12, background: colors.border } }) : null,
              updatedAt ? React.createElement('span', { title: fmt(updatedAt) }, `更新于 ${fmtTime(updatedAt)}`) : null)),
          React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', onClick: refresh, style: { gap: 6 } }, '刷新', refreshIcon)),
        menu)
      const dataViewTabs = React.createElement('div', { role: 'tablist', 'aria-label': '群聊数据视图', style: { display: 'flex', alignSelf: 'stretch', gap: 20 } },
        ...[{ id: 'messages', label: `群消息 ${selectedMessages.length}` }, { id: 'outbox', label: `Outbox ${selectedOutbox.length}` }].map((item) => React.createElement('button', { key: item.id, role: 'tab', 'aria-selected': groupTableView === item.id, type: 'button', onClick: () => setGroupTableView(item.id), style: { border: 0, borderBottom: groupTableView === item.id ? `2px solid ${colors.accent}` : '2px solid transparent', background: 'transparent', color: groupTableView === item.id ? colors.accent : colors.muted, padding: '0 2px', fontFamily: 'inherit', fontSize: 12, cursor: 'pointer' } }, item.label)))
      const groupTableToolbar = React.createElement('div', { style: toolbar },
        dataViewTabs,
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' } },
          (data?.groups || []).length > 1 ? React.createElement(SelectMenu, { label: '选择群聊会话', value: selectedGroup?.groupId || '', options: (data?.groups || []).map((group) => ({ id: group.groupId, label: group.name || group.groupId })), onChange: (value) => { setSelectedGroupId(value); setMessagePage(1); setOutboxPage(1) }, minWidth: 220 }) : null,
          groupTableView === 'messages'
            ? React.createElement(SelectMenu, { label: '筛选投递状态', value: messageDeliveryFilter, options: [{ id: 'all', label: '全部投递状态' }, { id: 'delivered', label: '已投递' }, { id: 'failed', label: '投递失败' }, { id: 'pending', label: '投递中' }, { id: 'skipped', label: '历史未投递' }, { id: 'unknown', label: '状态未知' }], onChange: (value) => { setMessageDeliveryFilter(value); setMessagePage(1) } })
            : React.createElement(SelectMenu, { label: '筛选发件状态', value: outboxStatusFilter, options: [{ id: 'all', label: '全部发件状态' }, { id: 'confirmed', label: '已回读确认' }, { id: 'waiting', label: '待回读确认' }], onChange: (value) => { setOutboxStatusFilter(value); setOutboxPage(1) } })))
      const messagesTable = React.createElement(React.Fragment, null,
        React.createElement('div', { style: { overflowX: 'auto' } }, React.createElement('table', { style: { width: '100%', minWidth: 820, borderCollapse: 'collapse', tableLayout: 'fixed' } },
          React.createElement('thead', null, React.createElement('tr', { style: { background: colors.surface2, textAlign: 'left' } }, React.createElement('th', { style: { ...tableHeadCell, width: 150 } }, '发送人 / 时间'), React.createElement('th', { style: tableHeadCell }, '消息内容'), React.createElement('th', { style: { ...tableHeadCell, width: 150 } }, 'Agent 投递'), React.createElement('th', { style: { ...tableHeadCell, width: 150 } }, '消息'))),
          React.createElement('tbody', null, ...(messageRows.length ? messageRows : [React.createElement('tr', { key: 'empty' }, React.createElement('td', { colSpan: 4, style: { ...tableBodyCell, padding: 36, textAlign: 'center', color: colors.muted } }, '暂无符合条件的群聊消息'))])))),
        React.createElement('div', { style: tableFooter }, React.createElement('span', { style: { marginRight: 'auto', fontSize: 11, color: colors.muted } }, `${filteredMessages.length} 条 · 每页 ${pageSize} 条`), React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: currentMessagePage <= 1, onClick: () => setMessagePage((page) => Math.max(1, page - 1)) }, '上一页'), React.createElement('span', { style: { fontSize: 11, color: colors.muted } }, `${currentMessagePage} / ${pageCount}`), React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: currentMessagePage >= pageCount, onClick: () => setMessagePage((page) => Math.min(pageCount, page + 1)) }, '下一页')))
      const outboxTable = React.createElement(React.Fragment, null,
        React.createElement('div', { style: { overflowX: 'auto' } }, React.createElement('table', { style: { width: '100%', minWidth: 900, borderCollapse: 'collapse', tableLayout: 'fixed' } },
          React.createElement('thead', null, React.createElement('tr', { style: { background: colors.surface2, textAlign: 'left' } }, React.createElement('th', { style: { ...tableHeadCell, width: 130 } }, '发送状态'), React.createElement('th', { style: tableHeadCell }, '消息内容'), React.createElement('th', { style: { ...tableHeadCell, width: 180 } }, '来源 / 回复目标'), React.createElement('th', { style: { ...tableHeadCell, width: 170 } }, '投递消息 ID'), React.createElement('th', { style: { ...tableHeadCell, width: 150 } }, 'Outbox ID'))),
          React.createElement('tbody', null, ...(outboxRows.length ? outboxRows : [React.createElement('tr', { key: 'empty' }, React.createElement('td', { colSpan: 5, style: { ...tableBodyCell, padding: 36, textAlign: 'center', color: colors.muted } }, '暂无符合条件的 Agent 发件记录'))])))),
        React.createElement('div', { style: tableFooter }, React.createElement('span', { style: { marginRight: 'auto', fontSize: 11, color: colors.muted } }, `${filteredOutbox.length} 条 · 每页 ${outboxPageSize} 条`), React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: currentOutboxPage <= 1, onClick: () => setOutboxPage((page) => Math.max(1, page - 1)) }, '上一页'), React.createElement('span', { style: { fontSize: 11, color: colors.muted } }, `${currentOutboxPage} / ${outboxPageCount}`), React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: currentOutboxPage >= outboxPageCount, onClick: () => setOutboxPage((page) => Math.min(outboxPageCount, page + 1)) }, '下一页')))
      const groupsPage = React.createElement(React.Fragment, null,
        pageHeader('群聊会话', '查看常驻会话、群消息接收状态与 Agent 发件记录。', (data?.groups || []).length),
        React.createElement('section', null, sectionHeader('消息记录', '群消息与 Agent 发件记录'), React.createElement('div', { style: tableFrame }, selectedGroupSummary, groupTableToolbar, groupTableView === 'messages' ? messagesTable : outboxTable)))
      const tasksPage = React.createElement(React.Fragment, null, pageHeader('任务看板', '按执行阶段查看任务、叶子会话和目标进展。', (data?.tasks || []).filter((task) => !task.archivedAt).length), React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(320px, 1fr))', gap: 16, overflowX: 'auto', alignItems: 'start', paddingBottom: 8 } }, ...bucketColumns))
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
      const authorizationRows = visibleAuthorizationItems.map((item) => {
        const pending = item.status !== 'answered'
        const status = pending ? authorizationStatus[item.status] : authorizationDecision[item.decision] || authorizationStatus.answered
        const group = groupsById.get(item.groupId)
        return React.createElement('div', { key: item.requestId, style: { width: '100%', minWidth: 0, boxSizing: 'border-box', display: 'grid', gridTemplateColumns: '88px minmax(260px, 1.1fr) minmax(300px, 1.5fr) 130px 44px', alignItems: 'center', gap: 18, borderTop: `1px solid ${colors.border}`, background: 'transparent', color: 'inherit', padding: '15px 18px' } },
          authorizationTag(status.label, status.state),
          React.createElement('span', { style: { minWidth: 0 } }, React.createElement('strong', { title: item.objective, style: { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', fontSize: 12.5, lineHeight: 1.5 } }, item.objective), React.createElement('span', { style: { display: 'block', marginTop: 5, color: colors.muted, fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, group?.name || item.groupId)),
          React.createElement('span', { style: { minWidth: 0 } }, React.createElement('span', { title: item.requestedAction, style: { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', fontSize: 11.5, lineHeight: 1.55, color: colors.muted } }, item.requestedAction), item.risk && item.risk !== '未单独说明' ? React.createElement('span', { style: { display: 'block', marginTop: 6, color: colors.danger, fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `风险 · ${item.risk}`) : null),
          React.createElement('span', { style: { color: colors.muted, fontSize: 10.5, lineHeight: 1.5 } }, fmt(item.createdAt)),
          React.createElement(Button, { variant: 'ghost', size: 'sm', type: 'button', onClick: () => setSelectedAuthorizationId(item.requestId) }, '查看'))
      })
      const authorizationDetail = selectedAuthorization ? React.createElement('div', { role: 'presentation', onMouseDown: (event) => { if (event.target === event.currentTarget) setSelectedAuthorizationId('') }, style: { position: 'fixed', inset: 0, zIndex: 1100, display: 'flex', justifyContent: 'flex-end', background: 'rgba(0,0,0,.28)', backdropFilter: 'blur(2px)' } },
        React.createElement('section', { role: 'dialog', 'aria-modal': true, 'aria-label': '授权申请单详情', style: { width: 'min(640px, 100%)', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', borderLeft: `1px solid ${colors.border}`, background: colors.surface, boxShadow: '-20px 0 60px rgba(0,0,0,.2)' } },
          React.createElement('header', { style: { flex: '0 0 auto', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 24, padding: '24px 24px 20px', borderBottom: `1px solid ${colors.border}`, background: colors.surface } },
            React.createElement('div', { style: { minWidth: 0 } }, React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 } }, authorizationTag(selectedAuthorization.status === 'answered' ? (authorizationDecision[selectedAuthorization.decision]?.label || '已处理') : (authorizationStatus[selectedAuthorization.status]?.label || '待批复'), selectedAuthorization.status === 'answered' ? (authorizationDecision[selectedAuthorization.decision]?.state || 'done') : 'warning'), React.createElement('span', { style: { color: colors.muted, fontSize: 11.5 } }, fmt(selectedAuthorization.createdAt))), React.createElement('h3', { style: { margin: 0, fontSize: 18, fontWeight: 600, lineHeight: 1.5 } }, selectedAuthorization.objective || '授权申请'), React.createElement('code', { style: { display: 'block', marginTop: 10, color: colors.muted, fontSize: 10.5 } }, selectedAuthorization.requestId)),
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
      const authorizationsPage = React.createElement(React.Fragment, null, pageHeader('授权审批', '处理需要人工确认的操作范围，并保留风险、证据和批复记录。', authorizationItems.filter((item) => item.status !== 'answered').length), React.createElement('section', null,
        sectionHeader('审批记录', `${authorizationItems.length} 条 · 每页 ${authorizationPageSize} 条`),
        React.createElement('div', { style: tableFrame },
          React.createElement('div', { style: toolbar }, React.createElement('span', { style: { fontSize: 12, color: colors.muted } }, `当前显示 ${filteredAuthorizationItems.length} 条`), React.createElement(SelectMenu, { label: '筛选审批状态', value: authorizationFilter, options: [{ id: 'all', label: '全部审批状态' }, { id: 'pending', label: '待批复' }, { id: 'approved', label: '已批准' }, { id: 'rejected', label: '已拒绝' }], onChange: (value) => { setAuthorizationFilter(value); setAuthorizationPage(1) } })),
          React.createElement('div', { style: { height: 40, boxSizing: 'border-box', display: 'grid', gridTemplateColumns: '88px minmax(260px, 1.1fr) minmax(300px, 1.5fr) 130px 44px', alignItems: 'center', gap: 18, padding: '0 18px', background: colors.surface2, color: colors.muted, fontSize: 11, fontWeight: 500 } }, React.createElement('span', null, '状态'), React.createElement('span', null, '任务'), React.createElement('span', null, '申请摘要'), React.createElement('span', null, '申请时间'), React.createElement('span', null, '操作')),
          React.createElement('div', null, ...(authorizationRows.length ? authorizationRows : [React.createElement('div', { key: 'empty', style: { padding: 36, textAlign: 'center', color: colors.muted, fontSize: 12 } }, '暂无授权申请')])),
          React.createElement('div', { style: tableFooter },
            React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: currentAuthorizationPage <= 1, onClick: () => setAuthorizationPage((page) => Math.max(1, page - 1)) }, '上一页'),
            React.createElement('span', { style: { fontSize: 11, color: colors.muted } }, `${currentAuthorizationPage} / ${authorizationPageCount}`),
            React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: currentAuthorizationPage >= authorizationPageCount, onClick: () => setAuthorizationPage((page) => Math.min(authorizationPageCount, page + 1)) }, '下一页')))
      ), authorizationDetail)
      const archivedTasks = (data?.tasks || []).filter((task) => task.state === 'completed' && task.archivedAt).sort((left, right) => String(right.archivedAt).localeCompare(String(left.archivedAt)))
      const archivePage = React.createElement('section', null,
        pageHeader('归档任务', '归档只影响看板展示，Task、Session、Goal 与历史证据仍完整保留。', archivedTasks.length),
        React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 } }, ...(archivedTasks.length ? archivedTasks.map(renderTaskCard) : [React.createElement(React.Fragment, { key: 'empty' }, emptyState('暂无归档任务'))]))
      )
      const alertsPage = React.createElement(React.Fragment, null,
        pageHeader('告警', '集中查看消息通道、叶子会话、任务目标和 Runtime 的当前异常与恢复历史。', filteredActiveAlerts.length),
        React.createElement('section', null, sectionHeader('告警记录', '按状态和类型筛选'), React.createElement('div', { style: tableFrame },
          React.createElement('div', { style: toolbar },
            React.createElement('div', { role: 'tablist', 'aria-label': '告警状态视图', style: { display: 'flex', alignSelf: 'stretch', gap: 20 } }, ...[{ id: 'active', label: `当前异常 ${filteredActiveAlerts.length}` }, { id: 'resolved', label: `恢复历史 ${filteredResolvedAlerts.length}` }].map((item) => React.createElement('button', { key: item.id, role: 'tab', 'aria-selected': alertView === item.id, type: 'button', onClick: () => setAlertView(item.id), style: { border: 0, borderBottom: alertView === item.id ? `2px solid ${colors.accent}` : '2px solid transparent', background: 'transparent', color: alertView === item.id ? colors.accent : colors.muted, padding: '0 2px', fontFamily: 'inherit', fontSize: 12, cursor: 'pointer' } }, item.label))),
            React.createElement(SelectMenu, { label: '筛选告警类型', value: alertType, options: alertCategories.map((category) => ({ id: category.id, label: category.label })), onChange: (value) => { setAlertType(value); setResolvedAlertPage(1) } })),
          React.createElement('div', { style: { padding: '0 16px' } }, ...(alertView === 'active' ? (filteredActiveAlerts.length ? filteredActiveAlerts.map(renderAlert) : [React.createElement('div', { key: 'empty', style: { padding: '36px 0', textAlign: 'center', color: colors.muted, fontSize: 12 } }, '当前没有此类型异常')]) : (visibleResolvedAlerts.length ? visibleResolvedAlerts.map(renderAlert) : [React.createElement('div', { key: 'empty', style: { padding: '36px 0', textAlign: 'center', color: colors.muted, fontSize: 12 } }, '暂无此类型恢复记录')]))),
          alertView === 'resolved' ? React.createElement('div', { style: tableFooter }, React.createElement('span', { style: { marginRight: 'auto', fontSize: 11, color: colors.muted } }, `${filteredResolvedAlerts.length} 条 · 每页 ${resolvedAlertPageSize} 条`), React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: currentResolvedAlertPage <= 1, onClick: () => setResolvedAlertPage((page) => Math.max(1, page - 1)) }, '上一页'), React.createElement('span', { style: { fontSize: 11, color: colors.muted } }, `${currentResolvedAlertPage} / ${resolvedAlertPageCount}`), React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: currentResolvedAlertPage >= resolvedAlertPageCount, onClick: () => setResolvedAlertPage((page) => Math.min(resolvedAlertPageCount, page + 1)) }, '下一页')) : null))
      )
      const pageContent = activePage === 'tasks' ? tasksPage : activePage === 'authorizations' ? authorizationsPage : activePage === 'archive' ? archivePage : activePage === 'alerts' ? alertsPage : groupsPage
      const pageViewport = React.createElement('div', { style: { minHeight: 'calc(100dvh - 138px)', boxSizing: 'border-box' } }, pageContent)
      const main = React.createElement('main', { style: { maxWidth: activePage === 'tasks' ? 1480 : 1240, minHeight: 'calc(100dvh - 90px)', boxSizing: 'border-box', margin: '0 auto', padding: '24px 24px 32px', display: 'grid', alignContent: 'start', gap: 20, pointerEvents: 'auto' } },
        error ? React.createElement('div', { style: { ...card, borderColor: colors.danger, color: colors.danger } }, `无法连接 resident 插件：${error}`) : null,
        navigationError ? React.createElement('div', { style: { ...card, borderColor: colors.danger, color: colors.danger } }, `无法打开 DSH Session：${navigationError}`) : null,
        pageViewport
      )
      return React.createElement('div', { ref: overlayRef, style: { position: 'fixed', inset: 0, paddingLeft: sidebarWidth, boxSizing: 'border-box', zIndex: 900, minWidth: 0, background: colors.surface, color: 'inherit', overflow: 'auto', pointerEvents: 'none' } }, header, main)
    }
    function apply(ctx) {
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'dingtalk-dsh-observer-entry', order: 5, inject: () => ({}) }, SidebarAction))
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dingtalk-dsh-observer', order: 20, inject: () => ({ openSession: async (sessionId, parentSessionId) => {
        if (parentSessionId) {
          let address = ctx.sessions.subagentAddress(sessionId)
          if (!address) { await ctx.sessions.refreshSubagents(parentSessionId); address = ctx.sessions.subagentAddress(sessionId) }
          if (address) { ctx.sessions.openSubagent(address); return }
        }
        await ctx.sessions.refresh()
        ctx.sessions.open(sessionId)
      } }) }, ObserverOverlay))
    }
    module.exports = { name: 'dingtalk-dsh-observer-client', inject: ['slots', 'sessions'], apply }
    return module.exports
  }
})
