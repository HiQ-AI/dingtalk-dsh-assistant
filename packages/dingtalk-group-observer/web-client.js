window.__ModuleLoader__.load({
  id: '@zzusp/dingtalk-dsh-observer',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
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
    const listeners = new Set()
    const setOpen = (value) => { open = value; for (const listener of listeners) listener(value) }
    const useOpen = () => {
      const [value, setValue] = useState(open)
      useEffect(() => { listeners.add(setValue); return () => listeners.delete(setValue) }, [])
      return [value, setOpen]
    }
    const fmt = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'
    const short = (value) => value ? String(value).replace(/^session-/, '').slice(0, 14) : '—'
    const pill = (tone) => ({ display: 'inline-flex', alignItems: 'center', borderRadius: 999, padding: '3px 8px', fontSize: 12, color: tone, background: `color-mix(in srgb, ${tone} 12%, transparent)` })
    const card = { border: `1px solid ${colors.border}`, borderRadius: 12, background: colors.cardSurface, padding: 16, boxShadow: '0 4px 16px rgba(15,23,42,.07)' }
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
    function FooterAction({ wide }) {
      const [isOpen] = useOpen()
      const [hovered, setHovered] = useState(false)
      const icon = React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        React.createElement('rect', { x: 3, y: 3, width: 18, height: 18, rx: 3 }),
        React.createElement('path', { d: 'M7 15v2M12 11v6M17 7v10' }))
      return React.createElement('button', {
        type: 'button', title: '钉钉群聊运行看板', 'aria-label': '钉钉群聊运行看板', onClick: () => setOpen(!isOpen), onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false),
        style: wide
          ? { boxSizing: 'border-box', cursor: 'pointer', width: 'calc(100% + 4px)', height: 42, color: 'var(--dsw-alias-label-primary)', background: isOpen ? 'color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent)' : hovered ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent', border: 0, borderRadius: 12, flex: '0 0 auto', alignItems: 'center', gap: 8, margin: '4px -2px', padding: '0 10px 0 8px', fontFamily: 'inherit', fontSize: 14, lineHeight: '22px', display: 'flex', overflow: 'hidden' }
          : { boxSizing: 'border-box', cursor: 'pointer', width: 36, height: 36, color: 'var(--dsw-alias-label-primary)', background: isOpen ? 'color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent)' : hovered ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent', border: 0, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '8px 0 10px', padding: 0 }
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
      const [isOpen] = useOpen()
      const [activePage, setActivePage] = useState('groups')
      const [data, setData] = useState()
      const [error, setError] = useState()
      const [navigationError, setNavigationError] = useState()
      const [updatedAt, setUpdatedAt] = useState()
      const [selectedGroupId, setSelectedGroupId] = useState('')
      const [messagePage, setMessagePage] = useState(1)
      const [hoveredTaskId, setHoveredTaskId] = useState('')
      const [copiedId, setCopiedId] = useState('')
      const [navigatingSessionId, setNavigatingSessionId] = useState('')
      const [alertType, setAlertType] = useState('all')
      const [resolvedAlertPage, setResolvedAlertPage] = useState(1)
      const [authorizationComments, setAuthorizationComments] = useState({})
      const [decidingAuthorizationId, setDecidingAuthorizationId] = useState('')
      const [authorizationPage, setAuthorizationPage] = useState(1)
      const [selectedAuthorizationId, setSelectedAuthorizationId] = useState('')
      const refresh = useCallback(async () => {
        try { setData(await load()); setUpdatedAt(new Date()); setError(undefined) }
        catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
      }, [])
      useEffect(() => {
        if (!isOpen) return undefined
        refresh()
        const timer = window.setInterval(refresh, 5000)
        return () => window.clearInterval(timer)
      }, [isOpen, refresh])
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
      const copyButton = (value, label) => React.createElement('button', { type: 'button', disabled: !value, onClick: (event) => { event.stopPropagation(); copyId(value).catch((cause) => setNavigationError(cause instanceof Error ? cause.message : String(cause))) }, style: { border: `1px solid ${colors.border}`, borderRadius: 7, background: colors.surface2, color: copiedId === value ? 'var(--dsw-alias-state-success-primary, #248a3d)' : colors.muted, padding: '3px 7px', cursor: value ? 'pointer' : 'default', fontFamily: 'inherit', fontSize: 10.5 } }, copiedId === value ? '已复制' : `复制${label}`)
      const groupCards = (data?.groups || []).map((group) => React.createElement('div', { key: group.groupId, style: { ...card, display: 'grid', gap: 7, minWidth: 280, padding: '12px 16px', boxShadow: '0 4px 16px rgba(15,23,42,.07)' } },
        React.createElement('button', { type: 'button', onClick: () => navigate(group.residentSessionId), style: { border: 0, padding: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', textAlign: 'left', display: 'grid', gap: 5, fontFamily: 'inherit' } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 } }, React.createElement('strong', null, group.name || '未命名群'), React.createElement('span', { style: { flex: '0 0 auto', fontSize: 10.5, color: colors.muted } }, fmt(group.messages?.at?.(-1)?.occurredAt || group.updatedAt))),
          React.createElement('div', { style: { fontSize: 11, color: colors.muted, overflowWrap: 'anywhere' } }, group.groupId)),
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } }, React.createElement('code', { title: group.residentSessionId || '', style: { flex: 1, minWidth: 0, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis' } }, group.residentSessionId || '尚未建立'), copyButton(group.residentSessionId, '会话 ID'))))
      const selectedGroup = groupsById.get(selectedGroupId) || (data?.groups || [])[0]
      const selectedMessages = [...(selectedGroup?.messages || [])].sort((left, right) => Number(right.sequence || 0) - Number(left.sequence || 0))
      const pageSize = 10
      const pageCount = Math.max(1, Math.ceil(selectedMessages.length / pageSize))
      const currentMessagePage = Math.min(messagePage, pageCount)
      const visibleMessages = selectedMessages.slice((currentMessagePage - 1) * pageSize, currentMessagePage * pageSize)
      const delivery = {
        delivered: { label: '已投递', tone: 'var(--dsw-alias-state-success-primary, #248a3d)' },
        failed: { label: '投递失败', tone: colors.danger },
        pending: { label: '投递中', tone: colors.warning },
        skipped: { label: '历史补拉·未投递', tone: colors.muted },
        unknown: { label: '历史状态未知', tone: colors.muted },
      }
      const messageRows = visibleMessages.map((message) => {
        const status = delivery[message.agentDeliveryStatus] || delivery.unknown
        return React.createElement('tr', { key: message.messageId },
          React.createElement('td', { style: { padding: '11px 12px', borderTop: `1px solid ${colors.border}`, width: 150, verticalAlign: 'top' } }, React.createElement('strong', { style: { fontSize: 12 } }, message.senderName || message.senderOpenDingTalkId || '发送人未记录'), React.createElement('div', { style: { marginTop: 4, fontSize: 10.5, color: colors.muted } }, fmt(message.occurredAt))),
          React.createElement('td', { title: message.text, style: { padding: '11px 12px', borderTop: `1px solid ${colors.border}`, fontSize: 12, lineHeight: 1.55, overflowWrap: 'anywhere' } }, message.text || '（空消息）'),
          React.createElement('td', { style: { padding: '11px 12px', borderTop: `1px solid ${colors.border}`, width: 150, verticalAlign: 'top' } }, React.createElement('span', { title: message.agentDeliveryError || '', style: pill(status.tone) }, status.label)),
          React.createElement('td', { style: { padding: '11px 12px', borderTop: `1px solid ${colors.border}`, width: 150, verticalAlign: 'top' } }, React.createElement('code', { title: message.messageId, style: { fontSize: 10, color: colors.muted } }, `#${message.sequence ?? '—'} · ${short(message.messageId)}`)))
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
          React.createElement('strong', { title: task.objective, style: { fontSize: 13, lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' } }, task.objective),
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
          React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 12 } }, React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } }, React.createElement('strong', { style: { color: active ? colors.danger : 'var(--dsw-alias-state-success-primary, #248a3d)' } }, active ? '当前异常' : '已恢复'), React.createElement('span', { style: pill(colors.muted) }, category.label)), React.createElement('span', { style: { fontSize: 12, color: colors.muted } }, fmt(active ? alert.lastSeenAt : alert.resolvedAt || alert.lastSeenAt))),
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
        return React.createElement('div', { key: bucket.state, style: { boxSizing: 'border-box', borderRadius: 14, background: bucket.background, boxShadow: '0 4px 16px rgba(15,23,42,.07)', padding: 10, display: 'flex', flexDirection: 'column', height: 'max(1000px, calc(100dvh - 120px))', minHeight: 'max(1000px, calc(100dvh - 120px))', maxHeight: 'max(1000px, calc(100dvh - 120px))', overflow: 'hidden' } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px 10px' } }, React.createElement('strong', { style: { display: 'inline-flex', alignItems: 'center', borderRadius: 999, padding: '3px 9px', fontSize: 11.5, fontWeight: 650, lineHeight: 1.4, color: 'var(--dsw-alias-label-primary-inverted, #fff)', background: bucket.tone } }, bucket.label), React.createElement('span', { style: { borderRadius: 999, background: colors.cardSurface, padding: '2px 7px', fontSize: 10.5, color: colors.muted } }, tasks.length)),
          React.createElement('div', { style: { flex: 1, minHeight: 0, padding: '8px 12px 16px 8px', display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'scroll', scrollbarGutter: 'stable' } }, ...taskCards))
      })
      const menu = React.createElement('nav', { 'aria-label': '运行看板视图', style: { minWidth: 0, display: 'flex', justifyContent: 'center', gap: 4, overflowX: 'auto' } },
        ...pages.map((page) => React.createElement('button', { key: page.id, type: 'button', onClick: () => setActivePage(page.id), 'aria-current': activePage === page.id ? 'page' : undefined, style: { border: 0, borderRadius: 8, padding: '8px 14px', cursor: 'pointer', font: 'inherit', fontSize: 13, fontWeight: activePage === page.id ? 650 : 400, color: activePage === page.id ? colors.accent : 'inherit', background: activePage === page.id ? 'color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent)' : 'transparent' } }, page.label)))
      const header = React.createElement('header', { style: { position: 'sticky', top: 0, zIndex: 2, display: 'grid', gridTemplateColumns: 'minmax(220px, auto) minmax(300px, 1fr) auto', alignItems: 'center', gap: 18, padding: '10px 24px', borderBottom: `1px solid ${colors.border}`, background: colors.surface } },
        React.createElement('div', { style: { minWidth: 0 } }, React.createElement('strong', { style: { fontSize: 18, whiteSpace: 'nowrap' } }, '钉钉群聊运行看板'), React.createElement('span', { style: { marginLeft: 12, fontSize: 12, color: colors.muted, whiteSpace: 'nowrap' } }, `运行态 · ${updatedAt ? fmt(updatedAt) : '正在连接'}`)),
        menu,
        React.createElement('div', { style: { display: 'flex', gap: 8 } }, React.createElement('button', { type: 'button', onClick: refresh, style: { border: `1px solid ${colors.border}`, borderRadius: 8, background: 'transparent', color: 'inherit', padding: '7px 12px', cursor: 'pointer' } }, '刷新'), React.createElement('button', { type: 'button', onClick: () => setOpen(false), style: { border: 0, borderRadius: 8, background: colors.surface2, color: 'inherit', padding: '7px 12px', cursor: 'pointer' } }, '关闭')))
      const groupsPage = React.createElement(React.Fragment, null,
        React.createElement('section', null, React.createElement('h2', { style: { margin: '0 0 12px', fontSize: 16 } }, '群聊常驻会话'), React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 } }, ...(groupCards.length ? groupCards : [React.createElement('div', { key: 'empty', style: card }, '暂无常驻群')]))),
        React.createElement('section', null,
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 } },
            React.createElement('h2', { style: { margin: 0, fontSize: 16 } }, '群聊消息'),
            React.createElement('select', { 'aria-label': '选择群聊会话', value: selectedGroup?.groupId || '', onChange: (event) => { setSelectedGroupId(event.target.value); setMessagePage(1) }, style: { minWidth: 240, border: `1px solid ${colors.border}`, borderRadius: 8, background: colors.cardSurface, color: 'inherit', padding: '7px 10px', fontFamily: 'inherit', fontSize: 12 } }, ...(data?.groups || []).map((group) => React.createElement('option', { key: group.groupId, value: group.groupId }, group.name || group.groupId))),
            React.createElement('span', { style: { fontSize: 11, color: colors.muted } }, `${selectedMessages.length} 条 · 每页 ${pageSize} 条`)),
          React.createElement('div', { style: { ...card, padding: 0, overflow: 'hidden', boxShadow: '0 4px 16px rgba(15,23,42,.07)' } },
            React.createElement('div', { style: { overflowX: 'auto' } }, React.createElement('table', { style: { width: '100%', minWidth: 820, borderCollapse: 'collapse', tableLayout: 'fixed' } },
              React.createElement('thead', null, React.createElement('tr', { style: { background: colors.surface2, textAlign: 'left', fontSize: 11, color: colors.muted } }, React.createElement('th', { style: { padding: '14px 12px', width: 150 } }, '发送人 / 时间'), React.createElement('th', { style: { padding: '14px 12px' } }, '消息内容'), React.createElement('th', { style: { padding: '14px 12px', width: 150 } }, 'Agent 投递'), React.createElement('th', { style: { padding: '14px 12px', width: 150 } }, '消息'))),
              React.createElement('tbody', null, ...(messageRows.length ? messageRows : [React.createElement('tr', { key: 'empty' }, React.createElement('td', { colSpan: 4, style: { padding: 36, textAlign: 'center', color: colors.muted, fontSize: 12 } }, '暂无群聊消息'))])))),
            React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, padding: '10px 12px' } },
              React.createElement('button', { type: 'button', disabled: currentMessagePage <= 1, onClick: () => setMessagePage((page) => Math.max(1, page - 1)), style: { border: `1px solid ${colors.border}`, borderRadius: 8, background: colors.cardSurface, color: 'inherit', padding: '5px 10px', cursor: currentMessagePage <= 1 ? 'default' : 'pointer', opacity: currentMessagePage <= 1 ? 0.45 : 1 } }, '上一页'),
              React.createElement('span', { style: { fontSize: 11, color: colors.muted } }, `${currentMessagePage} / ${pageCount}`),
              React.createElement('button', { type: 'button', disabled: currentMessagePage >= pageCount, onClick: () => setMessagePage((page) => Math.min(pageCount, page + 1)), style: { border: `1px solid ${colors.border}`, borderRadius: 8, background: colors.cardSurface, color: 'inherit', padding: '5px 10px', cursor: currentMessagePage >= pageCount ? 'default' : 'pointer', opacity: currentMessagePage >= pageCount ? 0.45 : 1 } }, '下一页')))))
      const tasksPage = React.createElement('section', null, React.createElement('h2', { style: { margin: '0 0 12px', fontSize: 16 } }, '任务'), React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(320px, 1fr))', gap: 16, overflowX: 'auto', alignItems: 'start', paddingBottom: 8 } }, ...bucketColumns))
      const authorizationStatus = {
        'pending-send': { label: '待审批', tone: colors.warning },
        'waiting-reply': { label: '待审批', tone: colors.warning },
        answered: { label: '已处理', tone: colors.muted },
      }
      const authorizationDecision = { approved: { label: '已批准', tone: 'var(--dsw-alias-state-success-primary, #248a3d)' }, rejected: { label: '已拒绝', tone: colors.danger } }
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
      const authorizationPageSize = 10
      const authorizationPageCount = Math.max(1, Math.ceil(authorizationItems.length / authorizationPageSize))
      const currentAuthorizationPage = Math.min(authorizationPage, authorizationPageCount)
      const visibleAuthorizationItems = authorizationItems.slice((currentAuthorizationPage - 1) * authorizationPageSize, currentAuthorizationPage * authorizationPageSize)
      const selectedAuthorization = authorizationItems.find((item) => item.requestId === selectedAuthorizationId)
      const authorizationDetailField = (label, value) => React.createElement('div', { style: { display: 'grid', gap: 5 } },
        React.createElement('strong', { style: { fontSize: 11, color: colors.muted } }, label),
        React.createElement('div', { style: { fontSize: 13, lineHeight: 1.65, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, value || '—'))
      const authorizationRows = visibleAuthorizationItems.map((item) => {
        const pending = item.status !== 'answered'
        const status = pending ? authorizationStatus[item.status] : authorizationDecision[item.decision] || authorizationStatus.answered
        const group = groupsById.get(item.groupId)
        return React.createElement('div', { key: item.requestId, style: { width: '100%', minWidth: 0, boxSizing: 'border-box', display: 'grid', gridTemplateColumns: '88px minmax(260px, 1.1fr) minmax(300px, 1.5fr) 130px 44px', alignItems: 'center', gap: 18, borderTop: `1px solid ${colors.border}`, background: 'transparent', color: 'inherit', padding: '15px 18px' } },
          React.createElement('span', { style: { ...pill(status.tone), justifySelf: 'start', width: 'max-content', whiteSpace: 'nowrap', fontSize: 11, lineHeight: 1.4 } }, status.label),
          React.createElement('span', { style: { minWidth: 0 } }, React.createElement('strong', { title: item.objective, style: { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', fontSize: 12.5, lineHeight: 1.5 } }, item.objective), React.createElement('span', { style: { display: 'block', marginTop: 5, color: colors.muted, fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, group?.name || item.groupId)),
          React.createElement('span', { style: { minWidth: 0 } }, React.createElement('span', { title: item.requestedAction, style: { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', fontSize: 11.5, lineHeight: 1.55, color: colors.muted } }, item.requestedAction), item.risk && item.risk !== '未单独说明' ? React.createElement('span', { style: { display: 'block', marginTop: 6, color: colors.danger, fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `风险 · ${item.risk}`) : null),
          React.createElement('span', { style: { color: colors.muted, fontSize: 10.5, lineHeight: 1.5 } }, fmt(item.createdAt)),
          React.createElement('button', { type: 'button', onClick: () => setSelectedAuthorizationId(item.requestId), style: { border: 0, background: 'transparent', color: colors.accent, padding: '5px 0', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600 } }, '查看'))
      })
      const authorizationDetail = selectedAuthorization ? React.createElement('div', { role: 'presentation', onMouseDown: (event) => { if (event.target === event.currentTarget) setSelectedAuthorizationId('') }, style: { position: 'fixed', inset: 0, zIndex: 1100, display: 'flex', justifyContent: 'flex-end', background: 'rgba(0,0,0,.28)', backdropFilter: 'blur(2px)' } },
        React.createElement('section', { role: 'dialog', 'aria-modal': true, 'aria-label': '授权申请单详情', style: { width: 'min(640px, 100%)', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', borderLeft: `1px solid ${colors.border}`, background: colors.surface, boxShadow: '-20px 0 60px rgba(0,0,0,.2)' } },
          React.createElement('header', { style: { flex: '0 0 auto', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 20, padding: '20px 24px 18px', borderBottom: `1px solid ${colors.border}`, background: colors.surface } },
            React.createElement('div', { style: { minWidth: 0 } }, React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 9, marginBottom: 9 } }, React.createElement('span', { style: pill(selectedAuthorization.status === 'answered' ? (authorizationDecision[selectedAuthorization.decision]?.tone || colors.muted) : colors.warning) }, selectedAuthorization.status === 'answered' ? (authorizationDecision[selectedAuthorization.decision]?.label || '已处理') : '待审批'), React.createElement('span', { style: { color: colors.muted, fontSize: 11.5 } }, fmt(selectedAuthorization.createdAt))), React.createElement('h3', { style: { margin: 0, fontSize: 19, lineHeight: 1.45 } }, selectedAuthorization.objective || '授权申请'), React.createElement('code', { style: { display: 'block', marginTop: 8, color: colors.muted, fontSize: 10.5 } }, selectedAuthorization.requestId)),
            React.createElement('button', { type: 'button', 'aria-label': '关闭申请单', onClick: () => setSelectedAuthorizationId(''), style: { width: 32, height: 32, border: `1px solid ${colors.border}`, borderRadius: 8, background: colors.surface2, color: 'inherit', cursor: 'pointer', fontSize: 18 } }, '×')),
          React.createElement('div', { style: { flex: '1 1 auto', overflowY: 'auto', padding: '0 24px' } },
            React.createElement('section', { style: { padding: '20px 0', borderBottom: `1px solid ${colors.border}` } }, authorizationDetailField('申请范围', selectedAuthorization.requestedAction)),
            React.createElement('section', { style: { padding: '20px 0', borderBottom: `1px solid ${colors.border}` } }, authorizationDetailField('风险', selectedAuthorization.risk || '未单独说明')),
            React.createElement('section', { style: { padding: '20px 0', borderBottom: `1px solid ${colors.border}` } }, authorizationDetailField('阻塞原因', selectedAuthorization.waitingReason)),
            React.createElement('details', { open: true, style: { padding: '18px 0', borderBottom: `1px solid ${colors.border}` } }, React.createElement('summary', { style: { cursor: 'pointer', fontSize: 12, fontWeight: 600 } }, `现场证据 · ${(selectedAuthorization.evidence || []).length}`), React.createElement('div', { style: { marginTop: 14 } }, authorizationDetailField('', (selectedAuthorization.evidence || []).map((value, index) => `${index + 1}. ${value}`).join('\n')))),
            React.createElement('details', { style: { padding: '18px 0', borderBottom: `1px solid ${colors.border}` } }, React.createElement('summary', { style: { cursor: 'pointer', fontSize: 12, fontWeight: 600 } }, `已尝试 · ${(selectedAuthorization.attemptedActions || []).length}`), React.createElement('div', { style: { marginTop: 14 } }, authorizationDetailField('', (selectedAuthorization.attemptedActions || []).map((value, index) => `${index + 1}. ${value}`).join('\n')))),
            React.createElement('section', { style: { padding: '20px 0', borderBottom: `1px solid ${colors.border}` } }, authorizationDetailField('关联信息', `Task ID：${selectedAuthorization.taskId || '—'}\n群聊：${groupsById.get(selectedAuthorization.groupId)?.name || selectedAuthorization.groupId || '—'}`)),
            selectedAuthorization.status === 'answered' ? React.createElement('section', { style: { padding: '20px 0' } }, authorizationDetailField('批复结果', `${selectedAuthorization.decision === 'approved' ? '批准' : selectedAuthorization.decision === 'rejected' ? '拒绝' : selectedAuthorization.decision || '已处理'}\n批复渠道：${selectedAuthorization.decisionSource === 'web' ? '运行看板' : selectedAuthorization.decisionSource === 'dingtalk' ? '钉钉私聊' : selectedAuthorization.decisionSource || '历史迁移'}\n批复时间：${fmt(selectedAuthorization.decidedAt)}\n批复内容：${selectedAuthorization.reply || '—'}`)) : null),
          selectedAuthorization.status !== 'answered' ? React.createElement('footer', { style: { flex: '0 0 auto', display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 10, alignItems: 'center', padding: '14px 24px', borderTop: `1px solid ${colors.border}`, background: colors.surface } },
            React.createElement('input', { 'aria-label': `审批意见 ${selectedAuthorization.requestId}`, value: authorizationComments[selectedAuthorization.requestId] || '', onChange: (event) => setAuthorizationComments((current) => ({ ...current, [selectedAuthorization.requestId]: event.target.value })), placeholder: '审批意见（可选）', style: { minWidth: 0, border: `1px solid ${colors.border}`, borderRadius: 9, background: colors.surface2, color: 'inherit', padding: '9px 11px', fontFamily: 'inherit', fontSize: 12 } }),
            React.createElement('button', { type: 'button', disabled: decidingAuthorizationId === selectedAuthorization.requestId, onClick: () => decideAuthorization(selectedAuthorization.requestId, 'rejected'), style: { minWidth: 76, border: `1px solid ${colors.danger}`, borderRadius: 9, background: 'transparent', color: colors.danger, padding: '9px 14px', cursor: 'pointer', fontWeight: 600 } }, '拒绝'),
            React.createElement('button', { type: 'button', disabled: decidingAuthorizationId === selectedAuthorization.requestId, onClick: () => decideAuthorization(selectedAuthorization.requestId, 'approved'), style: { minWidth: 76, border: 0, borderRadius: 9, background: colors.accent, color: '#fff', padding: '10px 14px', cursor: 'pointer', fontWeight: 600 } }, decidingAuthorizationId === selectedAuthorization.requestId ? '处理中…' : '批准')) : null)) : null
      const authorizationsPage = React.createElement(React.Fragment, null, React.createElement('section', null,
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 } }, React.createElement('h2', { style: { margin: 0, fontSize: 16 } }, '授权审批'), React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } }, React.createElement('span', { style: pill(colors.warning) }, `${authorizationItems.filter((item) => item.status !== 'answered').length} 个待审批`), React.createElement('span', { style: { fontSize: 11, color: colors.muted } }, `${authorizationItems.length} 条 · 每页 ${authorizationPageSize} 条`))),
        React.createElement('div', { style: { ...card, padding: 0, overflow: 'hidden' } },
          React.createElement('div', { style: { minHeight: 44, boxSizing: 'border-box', display: 'grid', gridTemplateColumns: '88px minmax(260px, 1.1fr) minmax(300px, 1.5fr) 130px 44px', alignItems: 'center', gap: 18, padding: '0 18px', background: colors.surface2, color: colors.muted, fontSize: 10.5 } }, React.createElement('span', null, '状态'), React.createElement('span', null, '任务'), React.createElement('span', null, '申请摘要'), React.createElement('span', null, '申请时间'), React.createElement('span', null, '操作')),
          React.createElement('div', null, ...(authorizationRows.length ? authorizationRows : [React.createElement('div', { key: 'empty', style: { padding: 36, textAlign: 'center', color: colors.muted, fontSize: 12 } }, '暂无授权申请')])),
          React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, padding: '10px 12px' } },
            React.createElement('button', { type: 'button', disabled: currentAuthorizationPage <= 1, onClick: () => setAuthorizationPage((page) => Math.max(1, page - 1)), style: { border: `1px solid ${colors.border}`, borderRadius: 8, background: colors.cardSurface, color: 'inherit', padding: '5px 10px', cursor: currentAuthorizationPage <= 1 ? 'default' : 'pointer', opacity: currentAuthorizationPage <= 1 ? 0.45 : 1 } }, '上一页'),
            React.createElement('span', { style: { fontSize: 11, color: colors.muted } }, `${currentAuthorizationPage} / ${authorizationPageCount}`),
            React.createElement('button', { type: 'button', disabled: currentAuthorizationPage >= authorizationPageCount, onClick: () => setAuthorizationPage((page) => Math.min(authorizationPageCount, page + 1)), style: { border: `1px solid ${colors.border}`, borderRadius: 8, background: colors.cardSurface, color: 'inherit', padding: '5px 10px', cursor: currentAuthorizationPage >= authorizationPageCount ? 'default' : 'pointer', opacity: currentAuthorizationPage >= authorizationPageCount ? 0.45 : 1 } }, '下一页')))
      ), authorizationDetail)
      const archivedTasks = (data?.tasks || []).filter((task) => task.state === 'completed' && task.archivedAt).sort((left, right) => String(right.archivedAt).localeCompare(String(left.archivedAt)))
      const archivePage = React.createElement('section', null,
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 } }, React.createElement('h2', { style: { margin: 0, fontSize: 16 } }, '归档任务'), React.createElement('span', { style: pill('var(--dsw-alias-state-success-primary, #248a3d)') }, archivedTasks.length)),
        React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 } }, ...(archivedTasks.length ? archivedTasks.map(renderTaskCard) : [React.createElement('div', { key: 'empty', style: { ...card, color: colors.muted } }, '暂无归档任务')]))
      )
      const alertsPage = React.createElement(React.Fragment, null,
        React.createElement('section', { style: { ...card, display: 'flex', alignItems: 'center', gap: 12 } }, React.createElement('strong', { style: { fontSize: 13 } }, '告警类型'), React.createElement('select', { 'aria-label': '筛选告警类型', value: alertType, onChange: (event) => { setAlertType(event.target.value); setResolvedAlertPage(1) }, style: { minWidth: 160, border: `1px solid ${colors.border}`, borderRadius: 8, background: colors.cardSurface, color: 'inherit', padding: '7px 10px', fontFamily: 'inherit', fontSize: 12 } }, ...alertCategories.map((category) => React.createElement('option', { key: category.id, value: category.id }, category.label)))),
        React.createElement('section', { style: card }, React.createElement('h2', { style: { margin: '0 0 14px', fontSize: 16 } }, `当前异常 · ${filteredActiveAlerts.length}`), ...(filteredActiveAlerts.length ? filteredActiveAlerts.map(renderAlert) : [React.createElement('div', { key: 'empty', style: { color: colors.muted } }, '当前没有此类型异常')])),
        React.createElement('section', { style: card },
          React.createElement('h2', { style: { margin: '0 0 14px', fontSize: 16 } }, `已恢复历史 · ${filteredResolvedAlerts.length}`),
          ...(visibleResolvedAlerts.length ? visibleResolvedAlerts.map(renderAlert) : [React.createElement('div', { key: 'empty', style: { color: colors.muted } }, '暂无此类型恢复记录')]),
          React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, paddingTop: 12 } },
            React.createElement('button', { type: 'button', disabled: currentResolvedAlertPage <= 1, onClick: () => setResolvedAlertPage((page) => Math.max(1, page - 1)), style: { border: `1px solid ${colors.border}`, borderRadius: 8, background: colors.cardSurface, color: 'inherit', padding: '5px 10px', cursor: currentResolvedAlertPage <= 1 ? 'default' : 'pointer', opacity: currentResolvedAlertPage <= 1 ? 0.45 : 1 } }, '上一页'),
            React.createElement('span', { style: { fontSize: 11, color: colors.muted } }, `${currentResolvedAlertPage} / ${resolvedAlertPageCount} · 每页 ${resolvedAlertPageSize} 条`),
            React.createElement('button', { type: 'button', disabled: currentResolvedAlertPage >= resolvedAlertPageCount, onClick: () => setResolvedAlertPage((page) => Math.min(resolvedAlertPageCount, page + 1)), style: { border: `1px solid ${colors.border}`, borderRadius: 8, background: colors.cardSurface, color: 'inherit', padding: '5px 10px', cursor: currentResolvedAlertPage >= resolvedAlertPageCount ? 'default' : 'pointer', opacity: currentResolvedAlertPage >= resolvedAlertPageCount ? 0.45 : 1 } }, '下一页')))
      )
      const pageContent = activePage === 'tasks' ? tasksPage : activePage === 'authorizations' ? authorizationsPage : activePage === 'archive' ? archivePage : activePage === 'alerts' ? alertsPage : groupsPage
      const main = React.createElement('main', { style: { maxWidth: activePage === 'tasks' ? 1480 : 1240, margin: '0 auto', padding: 24, display: 'grid', gap: 20 } },
        error ? React.createElement('div', { style: { ...card, borderColor: colors.danger, color: colors.danger } }, `无法连接 resident 插件：${error}`) : null,
        navigationError ? React.createElement('div', { style: { ...card, borderColor: colors.danger, color: colors.danger } }, `无法打开 DSH Session：${navigationError}`) : null,
        pageContent
      )
      return React.createElement('div', { style: { pointerEvents: 'auto', position: 'fixed', inset: 0, zIndex: 1000, background: colors.surface, color: 'inherit', overflow: 'auto' } }, header, main)
    }
    function apply(ctx) {
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'dingtalk-group-observer-entry', order: 5, inject: () => ({}) }, FooterAction))
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dingtalk-group-observer-panel', order: 20, inject: () => ({ openSession: async (sessionId, parentSessionId) => {
        if (parentSessionId) {
          let address = ctx.sessions.subagentAddress(sessionId)
          if (!address) { await ctx.sessions.refreshSubagents(parentSessionId); address = ctx.sessions.subagentAddress(sessionId) }
          if (address) { ctx.sessions.openSubagent(address); return }
        }
        await ctx.sessions.refresh()
        ctx.sessions.open(sessionId)
      } }) }, ObserverOverlay))
    }
    module.exports = { name: 'dingtalk-group-observer-client', inject: ['slots', 'sessions'], apply }
    return module.exports
  }
})
