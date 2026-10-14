window.__ModuleLoader__.load({
  id: '@zzusp/dingtalk-dsh-observer',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const { Button, IconChecklistOutlineRegular, IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, Menu, Pill, StateDot } = require('@deepseek-ai/dsh-client-ui-primitives')
    const { useCallback, useEffect, useState, useRef } = React
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
    const short = (value) => value ? String(value).replace(/^session-/, '').slice(0, 14) : '—'
    const outboxDelivery = (message) => {
      if (message.recallStatus === 'recalled') return { id: 'recalled', label: '已撤回', state: 'neutral' }
      if (message.recallStatus === 'failed') return { id: 'recall-failed', label: '撤回待处理', state: 'warning', detail: message.recallError === 'replacement_delivery_unknown' ? '已停止旧意图发送；历史是否送达仍未知，等待核验' : `旧消息撤回失败${message.recallRetryAt ? '，将有限重试' : '，需核验后处理'}：${message.recallError || '原因未记录'}` }
      if (message.supersededByOutboundId || message.status === 'superseded') return { id: 'superseded', label: '已替代', state: 'neutral', detail: message.deliveredMessageId ? '已记录送达，等待替换通知送达后撤回' : '已停止旧意图发送；未声称历史消息未送达' }
      if (message.status === 'sent') return { id: 'confirmed', label: message.deliveredMessageId ? '已回读' : '已发送', state: 'done' }
      const reason = message.deliveryPendingReason
      const notificationState = message.notificationState || ({
        'task-notification-prepared': 'prepared',
        'task-notification-starting': 'starting',
        'task-notification-unknown': 'unknown',
        'task-notification-failed': 'failed',
        'task-notification-pre-send-rejected': 'failed',
        'task-notification-task-terminal': 'failed',
        'task-notification-superseded': 'failed',
        'task-notification-confirmation-reassessment-required': 'failed',
      })[reason]
      if (notificationState === 'unknown') return { id: 'waiting', label: message.notificationFailurePhase === 'readback' ? '待回读' : '发送结果待核对', state: 'warning', detail: message.notificationFailurePhase === 'readback' ? '发送后回读尚未确认送达' : '发送结果未知，等待核验' }
      if (notificationState === 'starting') return { id: 'sending', label: '发送中', state: 'ongoing' }
      if (notificationState === 'prepared') return { id: 'queued', label: '待发送', state: 'ongoing' }
      if (notificationState === 'failed') {
        if (reason === 'task-notification-task-terminal') return { id: 'stopped', label: '已停止发送', state: 'neutral', detail: '关联任务已结束，停止旧通知发送；本次未发送', retryDisabled: true }
        if (reason === 'task-notification-superseded') return { id: 'stopped', label: '已停止发送', state: 'neutral', detail: '通知意图已被替代，停止旧通知发送；本次未发送', retryDisabled: true }
        if (reason === 'task-notification-confirmation-reassessment-required') return { id: 'reassessment', label: '已停止，需核验', state: 'warning', detail: '已停止发送，旧确认意图关联不足，需人工核验；不会自动恢复或发送', retryDisabled: true }
        return reason === 'task-notification-pre-send-rejected'
          ? { id: 'failed', label: '发送前受阻', state: 'error', detail: '发送前检查已拒绝，本次未发送' }
          : { id: 'failed', label: '投递异常', state: 'error', detail: message.notificationKnownNotSent === true ? '已确认本次未发送' : '尚未确认送达，需核验失败原因' }
      }
      if (notificationState === 'delivered') return { id: 'confirmed', label: '已回读', state: 'done' }
      if (message.deliveryBlockedAt) return { id: 'failed', label: '发送待处理', state: 'error', detail: '服务端已拒绝发送，停止自动重试；需核验失败原因' }
      const details = {
        preflight_history_partial: '发送前检查：历史消息不完整，本次未发送',
        preflight_failed: '发送前检查失败，本次未发送',
        send_failed: '发送调用失败，尚未确认送达',
        delivery_unknown: '发送结果未知，等待确认',
        postflight_history_partial: '发送后回读：历史消息不完整',
        postflight_failed: '发送后回读失败',
        message_not_observed: '已调用发送，回读尚未找到对应消息',
      }
      const detail = details[reason] || reason || (message.deliveryError ? '投递异常' : '')
      if (['delivery_unknown', 'postflight_history_partial', 'postflight_failed', 'message_not_observed'].includes(reason)) return { id: 'waiting', label: '待回读', state: 'warning', detail }
      if (reason === 'preflight_failed' || reason === 'preflight_history_partial') return { id: 'failed', label: '发送受阻', state: 'error', detail }
      if (message.deliveryError || reason === 'send_failed') return { id: 'failed', label: '投递异常', state: 'error', detail }
      return { id: 'queued', label: '待发送', state: 'ongoing', detail }
    }
    const ui = { textSm: 12, textMd: 14, textLg: 16, textXl: 20, space1: 4, space2: 8, space3: 12, space4: 16, space6: 24, radiusSm: 8, radiusMd: 12 }
    const observerCss = `
      [data-dingtalk-observer] :is(button, input, select, textarea, summary, [tabindex]):focus-visible {
        outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe) !important;
        outline-offset: 2px !important;
      }
      [data-dingtalk-observer] { scrollbar-color: ${colors.muted} ${colors.surface2}; scrollbar-width: thin; }
      [data-dingtalk-observer] ::-webkit-scrollbar { width: 10px; height: 10px; }
      [data-dingtalk-observer] ::-webkit-scrollbar-track { background: ${colors.surface2}; }
      [data-dingtalk-observer] ::-webkit-scrollbar-thumb { background: ${colors.muted}; border: 2px solid ${colors.surface2}; border-radius: 8px; }
      [data-dingtalk-observer] ::-webkit-scrollbar-thumb:hover { background: ${colors.accent}; }
      [data-dingtalk-observer] ::-webkit-scrollbar-thumb:active { background: ${colors.accent}; }
      [data-dingtalk-observer] .observer-task-layout { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 32px; align-items: start; }
      [data-dingtalk-observer] .observer-task-navigation { min-width: 0; }
      [data-dingtalk-observer] .observer-task-step { margin-bottom: 4px; }
      [data-dingtalk-observer] .observer-task-step-button { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 12px; width: 100%; padding: 12px; border: 1px solid transparent; border-radius: ${ui.radiusSm}px; background: transparent; color: inherit; text-align: left; font: inherit; cursor: pointer; }
      [data-dingtalk-observer] .observer-task-step-button:hover { background: ${colors.surface2}; }
      [data-dingtalk-observer] .observer-task-step-button:active { background: color-mix(in srgb, ${colors.accent} 14%, transparent); }
      [data-dingtalk-observer] .observer-task-step-button[aria-pressed="true"] { background: color-mix(in srgb, ${colors.accent} 8%, ${colors.surface}); border-color: color-mix(in srgb, ${colors.accent} 38%, transparent); box-shadow: inset 3px 0 ${colors.accent}; }
      [data-dingtalk-observer] .observer-task-reading { min-width: 0; position: sticky; top: 16px; border: 1px solid ${colors.border}; border-radius: ${ui.radiusMd}px; background: ${colors.surface}; }
      [data-dingtalk-observer] .observer-task-panel { padding: 24px; min-height: 280px; }
      [data-dingtalk-observer] .observer-task-panel[hidden] { display: none; }
      [data-dingtalk-observer] .observer-task-readout { padding-top: 24px; margin-top: 20px; border-top: 1px solid ${colors.border}; }
      [data-dingtalk-observer] .observer-task-result { padding: 20px 24px; margin: 0 0 28px; background: ${colors.surface2}; border-radius: ${ui.radiusMd}px; }
      [data-dingtalk-observer] .observer-task-result-text { max-height: 220px; overflow: auto; scrollbar-gutter: stable; }
      [data-dingtalk-observer] .observer-task-summary { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 24px; align-items: end; }
      [data-dingtalk-observer] .observer-task-statistics { display: grid; gap: 12px; font-size: 12px; font-variant-numeric: tabular-nums; }
      [data-dingtalk-observer] .observer-task-step-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 8px 16px; flex-wrap: wrap; min-height: 28px; }
      [data-dingtalk-observer] .observer-task-output-row { display: grid; grid-template-columns: 112px minmax(0, 1fr); gap: 12px; }
      [data-dingtalk-observer] .observer-task-overview { padding: 28px 0 24px; }
      [data-dingtalk-observer] .observer-task-detail :is(summary, a):hover { color: ${colors.accent}; }
      @media (prefers-reduced-motion: reduce) { [data-dingtalk-observer] article { transition: none !important; } }
      @media (forced-colors: active) {
        [data-dingtalk-observer] { scrollbar-color: auto; }
        [data-dingtalk-observer] .observer-task-step-button[aria-pressed="true"] { outline: 2px solid Highlight; outline-offset: -2px; }
      }
      [data-dingtalk-observer] .observer-config-field { display: grid; gap: 8px; min-width: 0; font-size: 14px; }
      [data-dingtalk-observer] .observer-config-input { width: 100%; min-width: 0; box-sizing: border-box; padding: 10px 12px; border: 1px solid ${colors.border}; border-radius: 8px; background: ${colors.surface}; color: inherit; font: inherit; line-height: 1.6; }
      [data-dingtalk-observer] textarea.observer-config-input { resize: none; }
      [data-dingtalk-observer] .observer-config-input:disabled { opacity: .65; cursor: not-allowed; }
      @media (max-width: 960px) {
        [data-dingtalk-observer] .observer-task-layout { grid-template-columns: 264px minmax(0, 1fr); gap: 20px; }
        [data-dingtalk-observer] .observer-task-summary { grid-template-columns: minmax(0, 1fr); gap: 16px; }
        [data-dingtalk-observer] .observer-task-output-row { grid-template-columns: minmax(0, 1fr); gap: 2px; }
        [data-dingtalk-observer] .observer-task-overview { padding: 20px 0; }
        [data-dingtalk-observer] .observer-task-result { padding: 18px; }
        [data-dingtalk-observer] .observer-main { padding: 16px !important; }
        [data-dingtalk-observer] .observer-topics-layout { display: grid !important; grid-template-columns: minmax(280px, 2fr) minmax(0, 3fr); }
        [data-dingtalk-observer] .observer-topic-list { max-width: none !important; }
        [data-dingtalk-observer] .observer-task-board { grid-template-columns: repeat(2, minmax(280px, 1fr)) !important; }
      }
      @media (max-width: 720px) {
        [data-dingtalk-observer] .observer-task-layout { grid-template-columns: minmax(0, 1fr); }
        [data-dingtalk-observer] .observer-task-navigation { max-height: 360px; overflow: auto; scrollbar-gutter: stable; padding: 2px; }
        [data-dingtalk-observer] .observer-task-reading { position: static; }
        [data-dingtalk-observer] .observer-task-panel { padding: 18px; }
        [data-dingtalk-observer] .observer-main { padding: 12px !important; }
        [data-dingtalk-observer] .observer-topics-layout,
        [data-dingtalk-observer] .observer-task-board { grid-template-columns: minmax(0, 1fr) !important; }
        [data-dingtalk-observer] .observer-topic-detail { min-height: 320px !important; }
        [data-dingtalk-observer] .observer-toolbar { align-items: stretch !important; }
      }
    `
    const pill = (tone) => ({ display: 'inline-flex', alignItems: 'center', borderRadius: 999, padding: `${ui.space1}px ${ui.space2}px`, fontSize: ui.textSm, color: tone, background: `color-mix(in srgb, ${tone} 12%, transparent)` })
    const card = { border: `1px solid ${colors.border}`, borderRadius: ui.radiusMd, background: colors.cardSurface, padding: ui.space4 }
    const tableFrame = { border: `1px solid ${colors.border}`, borderRadius: 12, background: colors.cardSurface, overflow: 'hidden' }
    const tableHeadCell = { height: 42, boxSizing: 'border-box', padding: `0 ${ui.space4}px`, color: colors.muted, fontSize: ui.textSm, fontWeight: 600, verticalAlign: 'middle' }
    const tableBodyCell = { padding: `${ui.space3}px ${ui.space4}px`, borderTop: `1px solid ${colors.border}`, fontSize: ui.textMd, lineHeight: 1.55, verticalAlign: 'middle' }
    const tableBodyContent = { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' }
    const clampTableContent = (...children) => React.createElement('div', { style: tableBodyContent }, ...children)
    const singleLineTableContent = (...children) => React.createElement('div', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, ...children)
    const tableFooter = { minHeight: 48, boxSizing: 'border-box', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, padding: '8px 12px', borderTop: `1px solid ${colors.border}`, background: colors.surface2 }
    const toolbar = { minHeight: 48, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 12px', borderBottom: `1px solid ${colors.border}`, background: colors.cardSurface }
    const navigationTabStyle = (selected, { paddingBottom = 12 } = {}) => ({ position: 'relative', boxSizing: 'border-box', border: 0, borderBottom: selected ? `2px solid ${colors.accent}` : '2px solid transparent', borderRadius: 0, padding: `0 0 ${paddingBottom}px`, cursor: 'pointer', font: 'inherit', fontSize: ui.textMd, fontWeight: 500, lineHeight: '20px', color: selected ? colors.accent : colors.muted, background: 'transparent', whiteSpace: 'nowrap' })
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
    const emptyState = (title, { detail, actionLabel, onAction } = {}) => React.createElement('div', { style: { minHeight: 112, display: 'grid', placeItems: 'center', padding: ui.space4, textAlign: 'center', color: colors.muted, fontSize: ui.textSm, border: `1px dashed ${colors.border}`, borderRadius: ui.radiusSm, background: colors.surface2 } },
      React.createElement('div', { style: { display: 'grid', justifyItems: 'center', gap: ui.space2 } },
        React.createElement('strong', { style: { color: 'inherit', fontSize: ui.textMd, fontWeight: 600 } }, title),
        detail ? React.createElement('span', null, detail) : null,
        actionLabel && onAction ? React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', onClick: onAction }, actionLabel) : null))
    async function get(path, { signal } = {}) {
      const response = await fetch(`${ENDPOINT}${path}`, { method: 'GET', headers: { accept: 'application/json' }, signal })
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
      const [health, groups, tasks, alerts, authorizations, topicPage] = await Promise.all([
        get('/health'), get('/state/groups'), get('/state/tasks'), get('/state/supervisor/alerts'), get('/state/authorizations'), get('/state/topics?offset=0&limit=100')
      ])
      return { health, groups, tasks, alerts, authorizations, topics: topicPage.topics }
    }
    function SidebarAction({ wide, onOpen }) {
      const isOpen = useOpen()
      const icon = React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        React.createElement('rect', { x: 3, y: 3, width: 18, height: 18, rx: 3 }),
        React.createElement('path', { d: 'M7 15v2M12 11v6M17 7v10' }))
      return React.createElement('button', {
        type: 'button', title: '钉钉群聊运行看板', 'aria-label': '钉钉群聊运行看板', onClick: onOpen,
        style: wide
          ? { boxSizing: 'border-box', cursor: 'pointer', width: 'calc(100% + 4px)', height: 42, color: 'var(--dsw-alias-label-primary)', background: isOpen ? 'var(--dingtalk-dsh-observer-selected-bg, var(--dsw-alias-interactive-bg-selected, var(--dsw-alias-interactive-bg-hover)))' : 'transparent', border: 0, outline: 'none', boxShadow: 'none', borderRadius: 12, flex: '0 0 auto', alignItems: 'center', gap: 8, margin: '4px -2px', padding: '0 10px 0 8px', fontFamily: 'inherit', fontSize: 14, lineHeight: '22px', display: 'flex', overflow: 'hidden' }
          : { boxSizing: 'border-box', cursor: 'pointer', width: 36, height: 36, color: 'var(--dsw-alias-label-primary)', background: isOpen ? 'var(--dingtalk-dsh-observer-selected-bg, var(--dsw-alias-interactive-bg-selected, var(--dsw-alias-interactive-bg-hover)))' : 'transparent', border: 0, outline: 'none', boxShadow: 'none', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '8px 0 10px', padding: 0 }
      }, icon, wide ? React.createElement('span', { style: { whiteSpace: 'nowrap', overflow: 'hidden' } }, '运行看板') : null)
    }
    const taskBuckets = [
      { state: 'queued', label: '待执行', tone: 'var(--dsw-alias-label-secondary, #64748b)', background: 'color-mix(in srgb, var(--dsw-alias-label-secondary, #64748b) 8%, var(--dsw-alias-bg-layer-1, #fff))' },
      { state: 'running', label: '执行中', tone: colors.accent, background: 'color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 8%, var(--dsw-alias-bg-layer-1, #fff))' },
      { state: 'waiting', label: '等待中', tone: colors.warning, background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary, #a56500) 8%, var(--dsw-alias-bg-layer-1, #fff))' },
      { state: 'completed', label: '已结束', tone: 'var(--dsw-alias-state-success-primary, #248a3d)', background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary, #248a3d) 8%, var(--dsw-alias-bg-layer-1, #fff))' }
    ]
    const pages = [{ id: 'groups', label: '群消息' }, { id: 'topics', label: '话题' }, { id: 'tasks', label: '任务看板' }, { id: 'authorizations', label: '历史人工介入' }, { id: 'archive', label: '历史任务' }, { id: 'alerts', label: '告警' }]
    const traceStatus = (status) => ({ succeeded: '已完成', applied: '已接纳', settled: '处理已结束', processed: '处理已结束', running: '处理中', claimed: '处理中', pending: '等待处理', queued: '等待处理', waiting: '等待继续', waiting_user: '待补充', interrupted: '待恢复', cancelling: '正在停止', ready: '等待执行', needs_attention: '需要处理', failed: '失败', blocked: '已阻塞', superseded: '已被新消息替代', cancelled: '已取消', rejected: '未接纳', accepted: '已接纳' }[status] || '状态未记录')
    const taskDisplayTitle = task => {
      const text = String(task.title || task.objective || '未命名任务').replace(/\s+/gu, ' ').trim() || '未命名任务'
      const first = text.split(/[。！？\n]/u)[0]
      if (Array.from(first).length >= 8 && Array.from(first).length <= 32) return first
      const characters = Array.from(text)
      return characters.length <= 32 ? text : `${characters.slice(0, 31).join('')}…`
    }
    const traceElapsed = (item, now) => {
      const start = Date.parse(item.startedAt), end = Date.parse(item.completedAt)
      const running = ['running', 'claimed'].includes(item.status)
      const duration = (running ? now : end) - start
      if (!Number.isFinite(duration) || duration < 0) return '耗时未记录'
      const seconds = duration / 1000
      const value = seconds < 1 ? `${Math.round(duration)} 毫秒` : seconds < 60 ? `${seconds.toFixed(1)} 秒`
        : seconds < 3600 ? `${Math.floor(seconds / 60)} 分 ${Math.floor(seconds % 60)} 秒`
          : `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分 ${Math.floor(seconds % 60)} 秒`
      return `${running ? '已用时' : '耗时'} ${value}${item.attempt > 1 ? `（第 ${item.attempt} 次处理）` : ''}`
    }
    const traceReason = (reason) => {
      if (!reason) return null
      const text = typeof reason === 'string' ? reason : JSON.stringify(reason)
      if (/MESSAGE_MODEL_CONTEXT_WINDOW_EXCEEDED/.test(text)) return '模型报告容量不足，已暂停处理；系统维护人员排查后继续，无需重复提交材料。'
      if (/MESSAGE_(?:CONTEXT|MATERIAL|REFERENCED_CANDIDATES)_CAPACITY|context_capacity_blocked/.test(text)) return '上下文容量受阻：必要材料未能完整提供，后续判断已停止。'
      return ({ LOCAL_ACCEPTANCE_CONFIG_REQUIRED: '尚未配置本地验收环境与固定验收命令，请补齐后继续', LOCAL_ACCEPTANCE_CRITERIA_REQUIRED: '缺少明确的业务验收条件，请补充预期结果', LOCAL_ACCEPTANCE_PLAN_INVALID: '验收方案未覆盖任务要求或包含无效用例，请修订方案', LOCAL_ACCEPTANCE_PENDING_RECONCILIATION: '上次本地验收结果待核对，暂停重试以避免重复写入共享 UAT 数据', LOCAL_ACCEPTANCE_FAILED: '本地业务验收未通过，请查看实际结果并修复', LOCAL_ACCEPTANCE_CLEANUP_UNCONFIRMED: '测试数据清理或本地服务停止尚未确认，后续提交已停止', LOCAL_ACCEPTANCE_RECEIPT_INVALID: '验收回执与当前代码或方案不一致，后续提交已停止', ENGINEERING_UAT_ENVIRONMENT_REQUIRED: '请明确指定 uat1～uat9 中的一个环境，不能默认选择', ENGINEERING_UAT_BRANCH_REQUIRED: '开发 PR 只能提交到明确指定的 UAT 分支，main 合并需独立上线任务', ENGINEERING_UAT_BRANCH_NOT_FOUND: '指定 UAT 环境对应的分支不存在，请核对', ENGINEERING_ACCEPTANCE_REQUIRED: '缺少业务验收用例与预期结果，后续提交已停止', ENGINEERING_ACCEPTANCE_FAILED: '业务验收未通过或未取得实际结果，后续提交已停止', ENGINEERING_VERIFICATION_FAILED: '构建检查未通过，后续步骤已停止' })[text] ?? text
    }
    const readableValue = (value) => value === undefined || value === null ? '历史未记录' : typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    const readout = (label, value) => React.createElement('details', { style: { borderTop: `1px solid ${colors.border}`, padding: '8px 0', overflowWrap: 'anywhere' } }, React.createElement('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, label), React.createElement('pre', { style: { margin: '8px 0 0', padding: 10, maxHeight: 300, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: colors.surface2, borderRadius: ui.radiusSm, font: 'inherit', fontSize: 12 } }, readableValue(value)))
    function TraceReadout({ runId, resourceRef, label }) {
      const [expanded, setExpanded] = useState(false)
      const [page, setPage] = useState()
      const [cursor, setCursor] = useState(0)
      const [hash, setHash] = useState('')
      const [text, setText] = useState('')
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState('')
      const [retry, setRetry] = useState(0)
      useEffect(() => {
        if (!expanded) return
        let active = true
        setLoading(true); setError('')
        get(`/state/workflows/${encodeURIComponent(runId)}/evidence/${encodeURIComponent(resourceRef)}?cursor=${cursor}${cursor && hash ? `&hash=${encodeURIComponent(hash)}` : ''}`).then(value => {
          if (active) { setPage(value); setHash(value.hash); setText(previous => cursor ? previous + value.text : value.text) }
        }, () => { if (active) setError('产出暂时无法读取，请重试。') }).finally(() => { if (active) setLoading(false) })
        return () => { active = false }
      }, [runId, resourceRef, expanded, cursor, retry])
      return React.createElement('section', { style: { minWidth: 0 } },
        React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', 'aria-expanded': expanded, onClick: () => { setExpanded(value => !value); setCursor(0); setHash(''); setText(''); setPage(undefined) } }, expanded ? '收起产出' : label),
        expanded ? React.createElement('div', { style: { marginTop: 10, padding: 12, background: colors.surface2, borderRadius: ui.radiusSm, lineHeight: 1.7 } },
          text ? React.createElement('div', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, text) : null,
          loading ? React.createElement('p', { role: 'status', style: { minHeight: 24 } }, '正在读取产出…') : null,
          error ? React.createElement('div', { role: 'alert' }, error, React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', onClick: () => setRetry(value => value + 1) }, '重试')) : null,
          !loading && !error && page && !text ? React.createElement('p', null, '未记录正文。') : null,
          page?.nextCursor !== null && page?.nextCursor !== undefined ? React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: loading, onClick: () => setCursor(page.nextCursor) }, '继续阅读产出') : null,
          page?.evidenceRefs?.length ? React.createElement('div', { style: { display: 'grid', gap: 8, marginTop: 12 } }, ...page.evidenceRefs.map((ref, index) => React.createElement(TraceReadout, { key: ref, runId, resourceRef: ref, label: `查看依据 ${index + 1}` }))) : null) : null)
    }
    function TraceDetail({ runId: initialRunId, onBack, onOpenSession, backLabel = '返回收信箱' }) {
      const [runId, setRunId] = useState(initialRunId)
      const [page, setPage] = useState()
      const [cursor, setCursor] = useState('')
      const [cursorHistory, setCursorHistory] = useState([])
      const [retry, setRetry] = useState(0)
      const [error, setError] = useState('')
      const [loading, setLoading] = useState(true)
      const [clock, setClock] = useState(Date.now)
      const hasRunningStep = page?.items?.some(item => ['running', 'claimed'].includes(item.status))
      useEffect(() => {
        if (!hasRunningStep) return
        const timer = setInterval(() => setClock(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [hasRunningStep])
      useEffect(() => {
        let active = true
        setLoading(true); setError('')
        get(`/state/workflows/${encodeURIComponent(runId)}/trace${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`).then((value) => { if (active) setPage(value) }, (cause) => { if (active) setError(cause.message) }).finally(() => { if (active) setLoading(false) })
        return () => { active = false }
      }, [runId, cursor, retry])
      const labels = { coordinator: '群消息协调', split: '拆分事项', route: '关联话题', intent: '判断下一步', command: '接纳动作', agent: '查询与答复' }
      const ready = !loading && !error && page
      return React.createElement('section', { 'aria-label': '消息处理过程', style: { ...card, display: 'grid', gap: 12 } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } }, React.createElement('strong', { style: { fontSize: 16 } }, '消息处理过程'), React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', onClick: onBack }, backLabel)),
        ready ? React.createElement('div', { style: { background: colors.surface2, padding: 16, borderRadius: ui.radiusSm, display: 'grid', gap: 10 } },
          React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' } }, React.createElement('strong', { style: { fontSize: 16 } }, traceStatus(page.status)), React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', onClick: () => setRetry(value => value + 1) }, '刷新处理记录')),
          React.createElement('blockquote', { style: { margin: 0, paddingLeft: 12, borderLeft: `3px solid ${colors.accent}`, fontSize: 14, lineHeight: 1.7, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, page.message?.text ?? '原消息未记录'),
          page.reason ? React.createElement('p', { role: 'status', style: { color: colors.warning, margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, traceReason(page.reason)) : null,
          React.createElement('span', { style: { color: colors.muted, fontSize: 12 } }, '这里展示消息判断、查询与答复；需要持续交付的任务见任务看板，回复送达情况见发信箱。')) : null,
        ready && page.items?.length ? React.createElement('div', { 'aria-label': '本页处理步骤', style: { display: 'flex', flexWrap: 'wrap', gap: 8 } }, ...Object.entries(labels).map(([kind, label]) => { const count = page.items.filter(item => item.kind === kind).length; return count ? React.createElement('span', { key: kind, style: pill(colors.accent) }, `${label} · ${count} 条记录`) : null })) : null,
        loading ? React.createElement('div', { role: 'status', style: { minHeight: 160 } }, '正在读取处理记录…') : error ? React.createElement('div', { role: 'alert' }, `处理记录读取失败：${error}`, React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', onClick: () => setRetry((value) => value + 1) }, '重试')) : !page?.items?.length ? emptyState('此页没有处理记录', { detail: '历史消息可能尚未记录完整处理轨迹。' }) : React.createElement('ol', { 'aria-label': '逐步判断记录', start: Number(cursor || 0) + 1, style: { margin: 0, paddingLeft: 28, display: 'grid', gap: 16 } }, ...page.items.map((item, index) => {
          const view = item.summary ?? { title: '处理记录', conclusion: '尚未记录判断结论', rows: [] }
          const tone = ['failed', 'blocked', 'needs_attention'].includes(item.status) ? colors.warning : colors.accent
          return React.createElement('li', { key: item.id || index, style: { borderLeft: `2px solid ${colors.border}`, padding: '0 0 12px 16px', minWidth: 0, fontSize: 14, overflowWrap: 'anywhere' } },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, React.createElement('strong', null, view.title), React.createElement('span', { style: pill(tone) }, traceStatus(item.status)), React.createElement('span', { style: { marginLeft: 'auto', color: colors.muted, fontSize: 12, textAlign: 'right', fontVariantNumeric: 'tabular-nums' } }, traceElapsed(item, clock))),
            ['intent', 'coordinator'].includes(item.kind) && item.sourceMessages?.length ? React.createElement('section', { 'aria-label': '本次判断的来源消息', style: { background: colors.surface2, padding: 12, borderRadius: ui.radiusSm, margin: '10px 0' } },
              React.createElement('strong', { style: { fontSize: 13 } }, `${item.topicTitle || '当前话题'} · 本次判断覆盖 ${item.sourceMessages.length} 条消息`),
              React.createElement('ol', { style: { margin: '12px 0 0', paddingLeft: 22, display: 'grid', gap: 12 } }, ...item.sourceMessages.map(message => React.createElement('li', { key: message.runId, style: { borderLeft: message.current ? `3px solid ${colors.accent}` : `3px solid ${colors.border}`, paddingLeft: 10 } },
                React.createElement('div', { style: { fontSize: 12, color: colors.muted } }, `${message.senderName || '发送人未记录'} · ${fmt(message.occurredAt)} · ${message.current ? '当前查看的消息' : '共同参与判断'}`),
                React.createElement('p', { style: { margin: '6px 0', whiteSpace: 'pre-wrap', lineHeight: 1.65 } }, message.text),
                !message.current ? React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', onClick: () => { setPage(undefined); setCursor(''); setCursorHistory([]); setRunId(message.runId) } }, '查看这条消息的过程') : null))),
              React.createElement('p', { style: { margin: '10px 0 0', color: colors.muted, fontSize: 12 } }, '以上消息共享下面这次判断，判断耗时只记录一次。后续重判保留为另一条判断记录。')) : null,
            React.createElement('p', { style: { margin: '10px 0', fontWeight: 600, lineHeight: 1.6 } }, view.conclusion),
            view.rows.length ? React.createElement('dl', { style: { margin: '0 0 12px', display: 'grid', gap: 10 } }, ...view.rows.map((row, i) => React.createElement('div', { key: i }, React.createElement('dt', { style: { color: colors.muted, fontSize: 12, marginBottom: 4 } }, row.label), React.createElement('dd', { style: { margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.65 } }, row.value)))) : null,
            item.clarification ? readout('历史补充请求（只读）', item.clarification.question) : null,
            item.kind === 'agent' ? React.createElement('div', { style: { display: 'grid', gap: 8, margin: '8px 0' } },
              item.outputRef ? React.createElement(TraceReadout, { key: item.outputRef, runId, resourceRef: item.outputRef, label: `查看答复与依据${item.evidenceCount ? `（${item.evidenceCount} 条）` : ''}` }) : null,
              item.sessionId && onOpenSession ? React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', style: { justifySelf: 'start' }, onClick: () => onOpenSession(item.sessionId) }, '查看会话记录') : null) : null,
            item.reason ? React.createElement('p', { style: { color: colors.warning, whiteSpace: 'pre-wrap' } }, traceReason(item.reason)) : null,
            item.sourceRunIds?.length > 1 ? React.createElement('p', { style: { color: colors.muted, fontSize: 12 } }, `同一话题的 ${new Set(item.sourceRunIds).size} 条消息共同判断，各事项的决定分别列出。`) : null,
            item.gaps?.length ? React.createElement('p', { style: { color: colors.warning } }, `依据缺口：${item.gaps.join('；')}`) : null)
        })),
        ready ? React.createElement('span', { style: { color: colors.muted, fontSize: 12 } }, `本页 ${page.items?.length ?? 0} 条${Number.isFinite(page.total) ? `，共 ${page.total} 条处理记录` : ''}；按记录时间排列，多事项可能分别判断。`) : null,
        ready ? React.createElement('p', { style: { color: colors.muted, fontSize: 12, margin: 0 } }, '耗时按本次开始到完成计算，包含工具等待；重试显示最近一次处理，不代表纯模型耗时。进行中记录可刷新查看最新状态。') : null,
        React.createElement('div', { style: { display: 'flex', gap: 8 } }, cursorHistory.length ? React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: loading, onClick: () => { setCursor(cursorHistory.at(-1)); setCursorHistory((items) => items.slice(0, -1)) } }, '上一页') : null, page?.nextCursor ? React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: loading, onClick: () => { setCursorHistory((items) => [...items, cursor]); setCursor(page.nextCursor) } }, '下一页') : null))
    }
    function TopicBrowser({ groups, tasks, target, updatedAt, onOpenTask, onOpenSession }) {
      const [groupId, setGroupId] = useState(target?.groupId || '')
      const [offset, setOffset] = useState(0)
      const [selection, setSelection] = useState(target)
      const [messageOffset, setMessageOffset] = useState(0)
      const [listing, setListing] = useState()
      const [context, setContext] = useState()
      const [topicContext, setTopicContext] = useState()
      const [contextCursor, setContextCursor] = useState('')
      const [contextCursorHistory, setContextCursorHistory] = useState([])
      const [contextRevision, setContextRevision] = useState()
      const [intentCursor, setIntentCursor] = useState('')
      const [intentCursorHistory, setIntentCursorHistory] = useState([])
      const [selectedIntentRun, setSelectedIntentRun] = useState('')
      const [contextError, setContextError] = useState('')
      const [contextLoading, setContextLoading] = useState(false)
      const [listError, setListError] = useState('')
      const [detailError, setDetailError] = useState('')
      const [loading, setLoading] = useState(true)
      const [detailLoading, setDetailLoading] = useState(false)
      const [retry, setRetry] = useState(0)
      const topicPageSize = 10
      const messagePageSize = 25
      useEffect(() => {
        if (!target?.topicId) return
        setGroupId(target.groupId || '')
        setSelection(target)
        setMessageOffset(0)
        setContextCursor('')
        setContextCursorHistory([])
        setIntentCursor(''); setIntentCursorHistory([]); setSelectedIntentRun(''); setContextRevision(undefined)
      }, [target?.groupId, target?.topicId, target?.revision])
      useEffect(() => {
        let active = true
        setLoading(true); setListError('')
        const params = new URLSearchParams({ offset: String(offset), limit: String(topicPageSize) })
        if (groupId) params.set('groupId', groupId)
        get(`/state/topics?${params}`).then((value) => { if (active) { setListing(value); if (value.total > 0 && offset >= value.total) setOffset(Math.floor((value.total - 1) / topicPageSize) * topicPageSize) } }, (error) => { if (active) setListError(error.message) }).finally(() => { if (active) setLoading(false) })
        return () => { active = false }
      }, [groupId, offset, retry, updatedAt])
      useEffect(() => {
        const current = listing?.topics.find(item => item.topicId === selection?.topicId && item.groupId === selection?.groupId)
        if (!current || current.revision === selection.revision && current.summaryRevision === selection.summaryRevision && current.updatedAt === selection.updatedAt) return
        setSelection({ groupId: current.groupId, topicId: current.topicId, revision: current.revision, summaryRevision: current.summaryRevision, updatedAt: current.updatedAt })
        setMessageOffset(0); setContextCursor(''); setContextCursorHistory([])
        setIntentCursor(''); setIntentCursorHistory([]); setSelectedIntentRun(''); setContextRevision(undefined)
        setContext(undefined); setTopicContext(undefined)
      }, [listing, selection])
      useEffect(() => {
        if (!selection) { setContext(undefined); return }
        let active = true
        setDetailLoading(true); setDetailError(''); setContext(undefined)
        const params = new URLSearchParams({ groupId: selection.groupId, revision: String(selection.revision), offset: String(messageOffset), limit: String(messagePageSize) })
        get(`/state/topics/${encodeURIComponent(selection.topicId)}?${params}`).then((value) => { if (active) setContext(value) }, (error) => { if (active) setDetailError(error.message) }).finally(() => { if (active) setDetailLoading(false) })
        return () => { active = false }
      }, [selection, messageOffset, retry])
      useEffect(() => {
        if (!selection) { setTopicContext(undefined); return }
        let active = true
        setContextLoading(true); setContextError('')
        const params = new URLSearchParams({ groupId: selection.groupId })
        if (contextCursor) params.set('cursor', contextCursor)
        if (intentCursor) params.set('intentCursor', intentCursor)
        if (contextRevision !== undefined) params.set('revision', String(contextRevision))
        get(`/state/topics/${encodeURIComponent(selection.topicId)}/context?${params}`).then((value) => { if (active) { setTopicContext(value); setContextRevision(value.revision) } }, (cause) => { if (active) setContextError(cause.message) }).finally(() => { if (active) setContextLoading(false) })
        return () => { active = false }
      }, [selection, contextCursor, intentCursor, retry])
      const selectTopic = (topic) => { setSelection({ groupId: topic.groupId, topicId: topic.topicId, revision: topic.revision }); setMessageOffset(0); setContextCursor(''); setContextCursorHistory([]); setIntentCursor(''); setIntentCursorHistory([]); setSelectedIntentRun(''); setContextRevision(undefined); setTopicContext(undefined) }
      if (selectedIntentRun) return React.createElement(TraceDetail, { key: selectedIntentRun, runId: selectedIntentRun, onOpenSession, onBack: () => setSelectedIntentRun(''), backLabel: '返回话题判断列表' })
      const topic = context?.topic
      const group = groups.find((item) => item.groupId === groupId)
      const relatedTasks = tasks.filter((task) => task.topicRefs?.some((ref) => (ref.groupId || task.sourceGroupId || task.groupId) === selection?.groupId && ref.topicId === selection?.topicId))
      const failure = (message) => React.createElement('div', { role: 'alert', style: { padding: 16, color: colors.danger } }, message, ' ', React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', onClick: () => setRetry((value) => value + 1) }, '重试'))
      const pager = (pageOffset, total, pageSize, onChange, busy) => React.createElement('div', { style: { ...tableFooter, flexWrap: 'wrap' } }, React.createElement('span', { style: { marginRight: 'auto', color: colors.muted, fontSize: 12 } }, `${total} 条 · 第 ${Math.floor(pageOffset / pageSize) + 1} 页`), React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: busy || pageOffset === 0, onClick: () => onChange(Math.max(0, pageOffset - pageSize)) }, '上一页'), React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: busy || pageOffset + pageSize >= total, onClick: () => onChange(pageOffset + pageSize) }, '下一页'))
      return React.createElement('section', { 'aria-label': '话题与上下文', style: { display: 'grid', gap: ui.space4 } },
        React.createElement('div', { className: 'observer-toolbar', style: { ...toolbar, flexWrap: 'wrap' } }, React.createElement(SelectMenu, { label: '筛选话题群聊', value: groupId, options: [{ id: '', label: '全部群聊' }, ...groups.map((item) => ({ id: item.groupId, label: item.name || item.groupId }))], onChange: (value) => { setGroupId(value); setOffset(0); setListing(undefined); setSelection(undefined) } }), React.createElement('span', { style: { fontSize: ui.textSm, color: colors.muted } }, group?.topicProgress ? `待归类 ${group.topicProgress.unroutedMessages} 条 · 待处理 ${group.topicProgress.pending} 个话题` : '接收、话题处理与任务完成分别计量')),
        React.createElement('div', { className: 'observer-topics-layout', style: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: ui.space4 } },
          React.createElement('section', { className: 'observer-topic-list', 'aria-label': '话题列表', 'aria-busy': loading, style: { ...tableFrame, flex: '1 1 340px', width: '100%', minWidth: 0, maxWidth: 420, minHeight: 200 } },
            React.createElement('div', { role: 'status', style: { ...toolbar, minHeight: 52 } }, React.createElement('strong', { style: { fontSize: 14 } }, loading ? '正在刷新话题…' : '话题'), listing ? React.createElement('span', { style: { color: colors.muted, fontSize: 12, fontVariantNumeric: 'tabular-nums' } }, `${listing.total} 个`) : null),
            listError ? failure(`话题加载失败：${listError}`) : !listing ? emptyState('正在读取话题…') : listing.topics.length === 0 ? emptyState('暂无话题', { detail: '新消息完成归类后会显示在这里。', actionLabel: '重新读取', onAction: () => setRetry((value) => value + 1) }) : React.createElement('ul', { style: { listStyle: 'none', margin: 0, padding: 0 } }, ...listing.topics.map((item) => { const selected = selection?.topicId === item.topicId && selection?.groupId === item.groupId; return React.createElement('li', { key: `${item.groupId}:${item.topicId}`, style: { borderBottom: `1px solid ${colors.border}` } }, React.createElement('button', { type: 'button', 'aria-pressed': selected, 'aria-label': item.title || item.topicId, onClick: () => selectTopic(item), style: { position: 'relative', width: '100%', minWidth: 0, border: 0, borderLeft: `3px solid ${selected ? colors.accent : 'transparent'}`, padding: `${ui.space4}px ${ui.space4}px ${ui.space4}px ${ui.space3}px`, background: selected ? `color-mix(in srgb, ${colors.accent} 8%, ${colors.cardSurface})` : colors.cardSurface, color: 'inherit', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', outlineOffset: -2 } },
              React.createElement('strong', { title: item.title || item.topicId, style: { display: 'block', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', overflowWrap: 'anywhere', fontSize: ui.textMd, fontWeight: 650, lineHeight: 1.5 } }, item.title || item.topicId),
              React.createElement('p', { title: item.summary || '暂无摘要', style: { margin: `${ui.space1}px 0 0`, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', color: colors.muted, fontSize: ui.textSm, lineHeight: 1.6 } }, item.summary || '暂无摘要')
            )) })),
            listing ? pager(offset, listing.total, topicPageSize, setOffset, loading) : null),
          React.createElement('section', { className: 'observer-topic-detail', 'aria-label': '话题详情', 'aria-busy': detailLoading, style: { ...tableFrame, flex: '2 1 560px', width: '100%', minWidth: 0, minHeight: 200 } },
            React.createElement('header', { style: { padding: '17px 18px 15px', borderBottom: `1px solid ${colors.border}`, background: colors.cardSurface } }, React.createElement('h2', { title: topic?.title, style: { minWidth: 0, margin: 0, overflowWrap: 'anywhere', fontSize: 18, fontWeight: 650, lineHeight: 1.5, letterSpacing: '-.01em' } }, topic?.title || '话题详情')),
            detailError ? failure(`上下文加载失败：${detailError}`) : detailLoading ? React.createElement('div', { role: 'status' }, emptyState('正在读取固定版本上下文…')) : !context ? emptyState('选择一个话题查看消息和关联任务') : React.createElement('div', { role: 'region', 'aria-label': '话题详情内容', style: { minWidth: 0, maxHeight: 'calc(100vh - 260px)', padding: '0 18px 18px', display: 'grid', gap: 0, overflowY: 'auto', overflowX: 'hidden', overflowWrap: 'anywhere' } },
              React.createElement('section', { 'aria-label': '话题摘要', style: { marginTop: 16, padding: '13px 14px', borderLeft: `3px solid ${colors.accent}`, borderRadius: '0 9px 9px 0', background: `color-mix(in srgb, ${colors.accent} 6%, ${colors.surface2})` } }, React.createElement('strong', { style: { display: 'block', fontSize: 12 } }, '话题摘要'), React.createElement('p', { style: { margin: '6px 0 0', whiteSpace: 'pre-wrap', color: topic?.summary ? 'inherit' : colors.muted, fontSize: 13, lineHeight: 1.65 } }, topic?.summary || '暂无摘要')),
              React.createElement('section', { 'aria-label': '当前上下文与判断记录', style: { padding: '16px 0', borderBottom: `1px solid ${colors.border}`, display: 'grid', gap: 10, fontSize: 12 } },
                React.createElement('strong', { style: { fontSize: 13 } }, '当前上下文与判断记录'),
                contextLoading ? React.createElement('span', { role: 'status' }, '正在读取话题上下文…') : contextError ? React.createElement('div', { role: 'alert', style: { color: colors.danger } }, `上下文读取失败：${contextError}`, React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', onClick: () => { setContextCursor(''); setContextCursorHistory([]); setIntentCursor(''); setIntentCursorHistory([]); setContextRevision(undefined); setRetry((value) => value + 1) } }, '重新读取当前上下文')) : topicContext ? React.createElement(React.Fragment, null,
                  readout('当前有效状态', topicContext.current),
                  React.createElement('strong', null, `事实 · ${(topicContext.facts || []).length} 条`),
                  ...(topicContext.facts || []).map((fact, index) => React.createElement('details', { key: fact.factId || index }, React.createElement('summary', { style: { cursor: 'pointer' } }, `${fact.kind || '事实'} · ${fact.text || '内容未记录'} · ${fact.status || '状态未记录'}`), readout('原文来源', fact.sourceRefs))),
                  React.createElement('strong', null, `意图判断批次 · ${(topicContext.intentRuns || []).length} 条`),
                  ...(topicContext.intentRuns || []).map((item, index) => React.createElement('details', { key: item.nodeRunId || item.intentRunId || index }, React.createElement('summary', { style: { cursor: 'pointer' } }, `${fmt(item.createdAt)} · ${item.status || '状态未记录'} · ${short(item.intentRunId)}`), readout('本批来源', item.sourceRunIds), readout('判断依据', item.reason), item.carrierRunId ? React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', onClick: () => setSelectedIntentRun(item.carrierRunId) }, '查看本次判断') : React.createElement('span', { style: { color: colors.muted } }, '历史未记录判断来源'))),
                  React.createElement('nav', { 'aria-label': '判断批次分页', style: { display: 'flex', gap: 8 } }, React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: !intentCursorHistory.length, onClick: () => { setIntentCursor(intentCursorHistory.at(-1)); setIntentCursorHistory((items) => items.slice(0, -1)) } }, '上一页判断'), React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: !topicContext.intentNextCursor, onClick: () => { setIntentCursorHistory((items) => [...items, intentCursor]); setIntentCursor(topicContext.intentNextCursor) } }, '下一页判断')),
                  React.createElement('div', { style: { display: 'flex', gap: 8 } }, contextCursorHistory.length ? React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', onClick: () => { setContextCursor(contextCursorHistory.at(-1)); setContextCursorHistory((items) => items.slice(0, -1)) } }, '上一页') : null, topicContext.nextCursor ? React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', onClick: () => { setContextCursorHistory((items) => [...items, contextCursor]); setContextCursor(topicContext.nextCursor) } }, '下一页') : null)) : React.createElement('span', { style: { color: colors.muted } }, '历史未记录')),
              React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: 12, padding: '16px 0', borderBottom: `1px solid ${colors.border}` } },
                React.createElement('section', { 'aria-label': '当前待解决问题', style: { minWidth: 0 } }, React.createElement('strong', { style: { display: 'block', marginBottom: 8, fontSize: 12 } }, `待解决问题 · ${topic?.openQuestions?.length || 0}`), topic?.openQuestions?.length ? React.createElement('ul', { style: { margin: 0, paddingLeft: 18, display: 'grid', gap: 6, fontSize: 12, lineHeight: 1.6 } }, ...topic.openQuestions.map((question, index) => React.createElement('li', { key: index }, question))) : React.createElement('span', { style: { color: colors.muted, fontSize: 12 } }, '当前没有待解决问题')),
                React.createElement('section', { 'aria-label': '关联任务', style: { minWidth: 0 } }, React.createElement('strong', { style: { display: 'block', marginBottom: 8, fontSize: 12 } }, `关联任务 · ${relatedTasks.length}`), React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 7 } }, ...relatedTasks.map((task) => React.createElement(Button, { key: task.taskId, variant: 'outline', size: 'sm', type: 'button', onClick: () => onOpenTask(task), style: { maxWidth: '100%' } }, React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: task.title || task.objective }, taskDisplayTitle(task)))), relatedTasks.length === 0 ? React.createElement('span', { style: { color: colors.muted, fontSize: 12 } }, '暂无关联任务') : null))),
              React.createElement('section', { 'aria-label': '群聊消息', style: { marginTop: 4 } },
                React.createElement('strong', { style: { display: 'block', padding: '14px 0', fontSize: 13, fontWeight: 600 } }, `群聊消息 · ${context.total} 条`),
                React.createElement('div', { style: { display: 'grid' } }, ...(context.messages?.length ? context.messages.map((message, index) => React.createElement('article', { key: `${message.messageId}:${index}`, style: { position: 'relative', minWidth: 0, padding: '10px 0 15px 22px', borderLeft: `1px solid ${colors.border}` } }, React.createElement('span', { 'aria-hidden': true, style: { position: 'absolute', top: 15, left: -4, width: 7, height: 7, borderRadius: '50%', background: index === 0 ? colors.accent : colors.cardSurface, border: `1px solid ${index === 0 ? colors.accent : colors.border}` } }), React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '2px 8px', color: colors.muted, fontSize: 11 } }, React.createElement('strong', { style: { color: 'inherit', fontWeight: 600 } }, message.senderName || message.sourceKind || '未知发送人'), React.createElement('time', { dateTime: message.occurredAt || undefined, style: { fontVariantNumeric: 'tabular-nums' } }, fmt(message.occurredAt))), React.createElement('p', { style: { margin: '6px 0 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 13, lineHeight: 1.7 } }, message.text || '（空消息）'), message.quotedMessage?.content ? React.createElement('details', { style: { marginTop: 9, color: colors.muted, fontSize: 12 } }, React.createElement('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, '查看引用消息'), React.createElement('blockquote', { style: { margin: '7px 0 0', padding: '8px 10px', borderLeft: `2px solid ${colors.border}`, background: colors.surface2, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.6 } }, message.quotedMessage.content)) : null)) : [emptyState('此版本没有消息')])),
                pager(messageOffset, context.total, messagePageSize, setMessageOffset, detailLoading))
            ))))
    }
    function TaskStepOutput({ taskId, node, detailRevision }) {
      return React.createElement(TaskStepOutputContent, { key: `${taskId}:${node.runId}:${node.nodeRunId}:${node.outputRef}`, taskId, node, detailRevision })
    }
    function TaskStepOutputContent({ taskId, node, detailRevision }) {
      const [text, setText] = useState('')
      const [overview, setOverview] = useState('')
      const [documentName, setDocumentName] = useState('')
      const [expanded, setExpanded] = useState(false)
      const [cursor, setCursor] = useState(0)
      const [nextCursor, setNextCursor] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const [retry, setRetry] = useState(0)
      const loadedCursor = useRef(null)
      useEffect(() => {
        if (loadedCursor.current === cursor) { setLoading(false); return }
        let active = true
        setLoading(true); setError('')
        get(`/state/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(node.runId)}/nodes/${encodeURIComponent(node.nodeRunId)}/output?ref=${encodeURIComponent(node.outputRef)}&cursor=${cursor}&detailRevision=${encodeURIComponent(detailRevision)}`).then(value => {
          if (active) { loadedCursor.current = cursor; setText(previous => cursor ? previous + value.text : value.text); setNextCursor(value.nextCursor); setOverview(value.overview || ''); setDocumentName(value.documentName || '') }
        }, () => { if (active) setError('产出暂时无法读取，请重试。') }).finally(() => { if (active) setLoading(false) })
        return () => { active = false }
      }, [taskId, node.runId, node.nodeRunId, node.outputRef, detailRevision, cursor, retry])
      const content = React.createElement('div', { style: { minWidth: 0, fontSize: 13, lineHeight: 1.7 } },
        text ? React.createElement('div', { style: { display: 'grid', gap: 6, overflowWrap: 'anywhere' } }, ...text.split('\n\n').map((part, index) => {
          const [heading, ...lines] = part.split('\n')
          const titled = ['产出摘要', '正文', '任务要求', '发现', '限制与未确认事项', '执行范围', '相关文件', '已有文件', '新建文件', '材料正文', '已读取文件', '已修改文件', '涉及文件', '文件变更', '修改方案', '方案修订意见', '技术方案引用', '检查结果', '文件索引', '基线版本', '可修改文件', '变更文件', '提交说明', '分支', '远端', '提交版本', '执行结果', 'PR 标题', '目标仓库', '来源分支', '目标分支', 'PR 正文', 'PR 地址', 'PR 状态', '方案工件路径', '工作目录', '来源仓库', '隔离方式', '处理内容', '项目', '工作分支', '起点版本'].includes(heading)
          return React.createElement('div', { key: index, className: titled ? 'observer-task-output-row' : undefined }, titled ? React.createElement('strong', { style: { fontSize: 12, fontWeight: 500, color: colors.muted } }, heading) : null,
            React.createElement('div', { style: { whiteSpace: 'pre-wrap' } }, titled ? lines.join('\n') : part))
        })) : null,
        loading ? React.createElement('span', { role: 'status', style: { color: colors.muted } }, '正在读取产出…') : null,
        error ? React.createElement('div', { role: 'alert', style: { color: colors.danger } }, error, React.createElement(Button, { type: 'button', variant: 'ghost', size: 'sm', onClick: () => setRetry(value => value + 1) }, '重试读取产出')) : null,
        !loading && !error && !text ? React.createElement('span', { style: { color: colors.muted } }, '已保存节点产出，暂未提供可读展示') : null,
        !loading && !error && nextCursor !== null ? React.createElement(Button, { type: 'button', variant: 'ghost', size: 'sm', onClick: () => setCursor(nextCursor) }, '继续阅读产出') : null)
      const documentLink = documentName ? React.createElement('a', { href: `${ENDPOINT}/state/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(node.runId)}/nodes/${encodeURIComponent(node.nodeRunId)}/document?ref=${encodeURIComponent(node.outputRef)}&detailRevision=${encodeURIComponent(detailRevision)}`, style: { display: 'inline-block', marginTop: 6, color: colors.accent, fontSize: 12 } }, `下载 ${documentName}`) : null
      return React.createElement('div', null, overview ? React.createElement('details', { onToggle: event => setExpanded(event.currentTarget.open), style: { fontSize: 13, lineHeight: 1.7 } },
        React.createElement('summary', { style: { cursor: 'pointer', color: colors.muted } }, overview, React.createElement('span', { style: { marginLeft: 12, color: colors.accent, fontSize: 12 } }, expanded ? '收起产出' : '查看产出')),
        expanded ? React.createElement('div', { style: { marginTop: 8 } }, content) : null) : content, documentLink)
    }
    const linkedTaskText = text => {
        const content = String(text), parts = []
        let offset = 0
        for (const match of content.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"）。，；]+)/g)) {
          const href = (match[2] || match[3]).replace(/[.,;!?]+$/, '')
          parts.push(content.slice(offset, match.index), React.createElement('a', { key: match.index, href, target: '_blank', rel: 'noopener noreferrer', style: { color: colors.accent } }, match[1] || href))
          if (!match[2]) parts.push(match[3].slice(href.length))
          offset = match.index + match[0].length
        }
        parts.push(content.slice(offset))
        return parts
      }
    const activePageStorageKey = 'dingtalk-dsh-observer.active-page'
    const readActivePage = () => {
      try {
        const page = window.sessionStorage.getItem(activePageStorageKey)
        return pages.some(item => item.id === page) ? page : 'groups'
      } catch { return 'groups' }
    }
    const taskStateLabel = state => ({ running: '执行中', queued: '待处理', waiting: '等待处理', paused: '已暂停', completed: '已结束', succeeded: '已完成', failed: '失败', cancelled: '已取消', blocked: '受阻', pending: '待执行', interrupted: '已中断' })[state] || state || '状态未记录'
    const taskStateTone = state => ['completed', 'succeeded'].includes(state) ? 'done' : ['failed', 'blocked'].includes(state) ? 'error' : ['waiting', 'paused', 'interrupted'].includes(state) ? 'warning' : ['running', 'queued', 'pending'].includes(state) ? 'ongoing' : 'neutral'
    const taskSession = task => task.session || { sessionId: task.sessionId, workspaceDir: task.workspaceDir, logPath: task.logPath }
    function SessionLocation({ session, label, onOpenSession }) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const pending = useRef(false)
      const open = async () => {
        if (pending.current || !session?.sessionId || session.sessionBound === false) return
        pending.current = true; setBusy(true); setError('')
        try { await onOpenSession(session.sessionId, session.parentSessionId) }
        catch (cause) { setError(cause.message) }
        finally { pending.current = false; setBusy(false) }
      }
      return React.createElement('section', { 'aria-label': label, style: { ...card, display: 'grid', gap: 10, overflowWrap: 'anywhere' } },
        React.createElement('strong', null, label),
        React.createElement('div', null, '会话 ID：', session?.sessionId ? `${session.sessionId}${session.sessionBound === false ? '（尚未绑定）' : ''}` : '尚未建立'),
        React.createElement('div', null, '工作目录：', session?.workspaceDir || '尚未分配'),
        React.createElement('div', null, '日志路径：', session?.logPath || '尚未记录'),
        session?.sessionId && session.sessionBound !== false ? React.createElement(Button, { type: 'button', variant: 'outline', size: 'sm', disabled: busy, onClick: open, style: { justifySelf: 'start', minWidth: 110 } }, busy ? '正在打开…' : `打开${label}`) : null,
        error ? React.createElement('p', { role: 'alert', style: { color: colors.danger } }, error) : null)
    }
    function TaskResult({ result }) {
      const value = typeof result === 'string' ? { summary: result } : result
      const values = items => Array.isArray(items) ? items : items ? [items] : []
      return React.createElement('section', { className: 'observer-task-result', 'aria-label': '当前结果' },
        React.createElement('h2', { style: { margin: '0 0 12px', fontSize: 16 } }, '当前结果'),
        React.createElement('div', { className: 'observer-task-result-text', style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, ...linkedTaskText(value?.summary || '尚未形成结果。')),
        values(value?.evidence).length ? React.createElement('div', null, React.createElement('h3', { style: { fontSize: 14 } }, '证据'), React.createElement('ul', null, ...values(value.evidence).map((item, index) => React.createElement('li', { key: index, style: { overflowWrap: 'anywhere' } }, ...linkedTaskText(typeof item === 'string' ? item : item.description || item.path || item.ref || '证据已记录'))))) : null,
        values(value?.limitations).length ? React.createElement('div', null, React.createElement('h3', { style: { fontSize: 14 } }, '限制与未验证项'), React.createElement('ul', null, ...values(value.limitations).map((item, index) => React.createElement('li', { key: index }, typeof item === 'string' ? item : readableValue(item))))) : null)
    }
    function useUnsavedTaskChanges(dirty, onDirtyChange) {
      useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false) }, [dirty, onDirtyChange])
      useEffect(() => {
        if (!dirty) return
        const warn = event => { event.preventDefault(); event.returnValue = '' }
        window.addEventListener('beforeunload', warn)
        return () => window.removeEventListener('beforeunload', warn)
      }, [dirty])
    }
    function CreateTaskForm({ groups, onCreated, onCancel, onDirtyChange }) {
      const [draft, setDraft] = useState({ groupId: '', title: '', objective: '', context: '', acceptance: '' })
      const [busy, setBusy] = useState(false), [error, setError] = useState('')
      const attempt = useRef(null), pending = useRef(false), fields = useRef({})
      const [errors, setErrors] = useState({}), [leaving, setLeaving] = useState(false)
      const dirty = Object.values(draft).some(Boolean)
      useUnsavedTaskChanges(dirty, onDirtyChange)
      const change = (field, value) => { setDraft(current => ({ ...current, [field]: value })); setErrors(current => ({ ...current, [field]: false })); attempt.current = null }
      const submit = async event => {
        event.preventDefault()
        if (event.nativeEvent?.isComposing || pending.current) return
        const invalid = { groupId: !draft.groupId, title: !draft.title.trim(), objective: !draft.objective.trim() }
        setErrors(invalid)
        if (Object.values(invalid).some(Boolean)) { setError('请选择来源群，并填写任务名称和目标。'); fields.current[Object.keys(invalid).find(name => invalid[name])]?.focus(); return }
        const body = { groupId: draft.groupId, title: draft.title.trim(), objective: draft.objective.trim(), ...(draft.context.trim() ? { context: draft.context.trim() } : {}), acceptanceCriteria: draft.acceptance.split('\n').map(text => text.trim()).filter(Boolean) }
        attempt.current ||= { ...body, requestId: crypto.randomUUID() }
        pending.current = true; setBusy(true); setError('')
        try { const result = await post('/tasks', attempt.current); onDirtyChange?.(false); onCreated(result) }
        catch (cause) { setError(cause.message) }
        finally { pending.current = false; setBusy(false) }
      }
      const field = (label, name, multiline = false, required = false) => React.createElement('label', { className: 'observer-config-field' }, label,
        React.createElement(multiline ? 'textarea' : 'input', { className: 'observer-config-input', ref: element => { fields.current[name] = element }, 'aria-invalid': !!errors[name], 'aria-describedby': errors[name] ? 'task-create-error' : undefined, value: draft[name], required, maxLength: name === 'title' ? 120 : 16000, rows: multiline ? 5 : undefined, disabled: busy, onChange: event => change(name, event.target.value) }))
      return React.createElement('form', { noValidate: true, 'aria-label': '新建任务', onSubmit: submit, style: { ...card, display: 'grid', gap: 16, maxWidth: 800 } },
        React.createElement('h2', { style: { margin: 0, fontSize: 20 } }, '新建任务'),
        React.createElement('p', { style: { margin: 0, color: colors.muted } }, '描述目标与约束。任务会话会按实际需要创建独立执行。'),
        React.createElement('label', { className: 'observer-config-field' }, '来源群', React.createElement('select', { className: 'observer-config-input', ref: element => { fields.current.groupId = element }, 'aria-invalid': !!errors.groupId, 'aria-describedby': errors.groupId ? 'task-create-error' : undefined, required: true, value: draft.groupId, disabled: busy, onChange: event => change('groupId', event.target.value) }, React.createElement('option', { value: '' }, '请选择群聊'), ...groups.map(group => React.createElement('option', { key: group.groupId, value: group.groupId }, group.name || group.groupId)))),
        field('任务名称', 'title', false, true), field('任务目标', 'objective', true, true), field('参考资料（不代表执行授权）', 'context', true), field('验收要求（每行一项，可选）', 'acceptance', true),
        error ? React.createElement('p', { id: 'task-create-error', role: 'alert', style: { margin: 0, color: colors.danger } }, error) : null,
        React.createElement('div', { style: { display: 'flex', gap: 12 } }, React.createElement(Button, { type: 'submit', disabled: busy, style: { minWidth: 100 } }, busy ? '提交中…' : '创建任务'), React.createElement(Button, { type: 'button', variant: 'outline', disabled: busy, onClick: () => dirty ? setLeaving(true) : onCancel() }, '返回看板')),
        leaving ? React.createElement('section', { 'aria-label': '确认放弃草稿', style: { display: 'grid', gap: 8 } }, React.createElement('p', null, '返回看板会丢弃尚未提交的任务草稿。'), React.createElement(Button, { type: 'button', variant: 'outline', onClick: () => setLeaving(false) }, '继续填写'), React.createElement(Button, { type: 'button', onClick: () => { onDirtyChange?.(false); onCancel() } }, '放弃草稿并返回')) : null)
    }
    function TaskControls({ task, onChanged, onDirtyChange }) {
      const [context, setContext] = useState(''), [reason, setReason] = useState(''), [confirmation, setConfirmation] = useState(null)
      const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false)
      const attempt = useRef(null), pending = useRef(false)
      const mutate = async (action, body) => {
        if (pending.current) return
        const fingerprint = JSON.stringify({ action, body })
        if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, body: { ...body, requestId: crypto.randomUUID() } }
        pending.current = true; setBusy(true); setError(''); setNotice('')
        try { await post(`/tasks/${encodeURIComponent(task.taskId)}/${action}`, attempt.current.body); attempt.current = null; setContext(''); setReason(''); setConfirmation(null); setNotice(action === 'cancel' ? '取消请求已记录。' : '需求补充已记录。'); onChanged() }
        catch (cause) { setError(cause.message) }
        finally { pending.current = false; setBusy(false) }
      }
      useUnsavedTaskChanges(!!context.trim() || !!reason.trim(), onDirtyChange)
      if (task.legacyReadonly) return React.createElement('p', { role: 'status', style: { color: colors.muted } }, '历史任务只读，不再接受旧执行操作。')
      const terminal = ['completed', 'succeeded', 'cancelled', 'failed'].includes(task.state) || ['cancelled', 'completed'].includes(task.controlState)
      return React.createElement('section', { 'aria-label': '任务控制', style: { ...card, display: 'grid', gap: 12 } },
        React.createElement('h2', { style: { margin: 0, fontSize: 16 } }, '需求与控制'),
        terminal ? React.createElement('p', null, '任务已结束。') : React.createElement(React.Fragment, null,
          React.createElement('label', { className: 'observer-config-field' }, '补充需求', React.createElement('textarea', { className: 'observer-config-input', rows: 5, value: context, disabled: busy, onChange: event => setContext(event.target.value), maxLength: 32000 })),
          React.createElement('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap' } }, React.createElement(Button, { type: 'button', disabled: busy || !context.trim(), onClick: () => mutate('context', { context: context.trim(), expectedRequirementRevision: task.requirementRevision, expectedControlRevision: task.controlRevision }) }, '提交需求补充'), React.createElement(Button, { type: 'button', variant: 'outline', disabled: busy || !!confirmation, onClick: () => setConfirmation({ revision: task.controlRevision }), style: { color: colors.danger } }, '取消任务')),
          confirmation ? React.createElement('section', { 'aria-label': '确认取消任务', style: { display: 'grid', gap: 12, padding: 12, border: `1px solid ${colors.danger}`, borderRadius: 8 } },
            React.createElement('p', { style: { margin: 0 } }, `取消“${taskDisplayTitle(task)}”？将停止后续执行；已经发生的外部操作不会自动撤销。`),
            React.createElement('label', { className: 'observer-config-field' }, '取消原因', React.createElement('input', { className: 'observer-config-input', value: reason, disabled: busy, onChange: event => setReason(event.target.value), maxLength: 2000 })),
            React.createElement('div', { style: { display: 'flex', gap: 12 } }, React.createElement(Button, { type: 'button', variant: 'outline', disabled: busy, onClick: () => { setConfirmation(null); setReason('') } }, '继续保留任务'), React.createElement(Button, { type: 'button', disabled: busy || !reason.trim(), onClick: () => mutate('cancel', { reason: reason.trim(), expectedControlRevision: confirmation.revision }), style: { color: colors.danger } }, '确认取消任务'))) : null),
        busy ? React.createElement('span', { role: 'status' }, '正在提交…') : null,
        error ? React.createElement('p', { role: 'alert', style: { color: colors.danger, margin: 0 } }, error, '。输入已保留，请刷新任务后核对再试。') : null,
        notice ? React.createElement('p', { role: 'status', style: { margin: 0 } }, notice) : null)
    }
    function TaskExecutions({ taskId, updatedAt, onOpenSession }) {
      const [offset, setOffset] = useState(0), [page, setPage] = useState(), [error, setError] = useState(''), [retry, setRetry] = useState(0)
      const [loading, setLoading] = useState(true)
      useEffect(() => {
        const controller = new AbortController(); let active = true
        setLoading(true); setError('')
        get(`/state/tasks/${encodeURIComponent(taskId)}/executions?offset=${offset}&limit=20`, { signal: controller.signal }).then(value => { if (active) { const items = value.executions || value.items || (Array.isArray(value) ? value : []); const total = value.total ?? items.length; if (offset > 0 && offset >= total) { setOffset(Math.max(0, Math.floor((total - 1) / 20) * 20)); return } setPage({ items, total, offset }); } }, cause => { if (active) setError(cause.message) }).finally(() => { if (active) setLoading(false) })
        return () => { active = false; controller.abort() }
      }, [taskId, offset, updatedAt, retry])
      const ready = page?.offset === offset
      return React.createElement('section', { 'aria-label': '动态执行列表', style: { display: 'grid', gap: 16, minHeight: 160 } },
        React.createElement('h2', { style: { margin: 0, fontSize: 18 } }, '动态执行'),
        React.createElement('p', { style: { margin: 0, color: colors.muted } }, '执行由任务会话按需安排，每次执行保留独立会话、目录、结果与日志。'),
        loading ? React.createElement('span', { role: 'status' }, '正在读取执行记录…') : null,
        error ? React.createElement('div', { role: 'alert', style: { color: colors.danger } }, `执行记录读取失败：${error}`, React.createElement(Button, { type: 'button', variant: 'outline', onClick: () => setRetry(value => value + 1) }, '重试读取执行')) : null,
        ready ? React.createElement('ol', { style: { margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 12 } }, ...page.items.map(execution => React.createElement('li', { key: execution.executionId, style: { ...card, overflowWrap: 'anywhere' } },
          React.createElement('details', null, React.createElement('summary', { style: { cursor: 'pointer', lineHeight: 1.7 } }, `${execution.objective || execution.executionId} · ${taskStateLabel(execution.status)}`),
            React.createElement('p', { style: { color: colors.muted } }, `执行 ${execution.executionId} · 需求修订 ${execution.requirementRevision ?? '未记录'} · ${fmt(execution.createdAt)}`),
            React.createElement(SessionLocation, { session: execution, label: '执行会话', onOpenSession }),
            execution.error ? React.createElement('p', { role: 'status', style: { color: colors.danger } }, traceReason(execution.error)) : null,
            React.createElement(TaskResult, { result: execution.result }))))) : null,
        ready && !page.items.length && !loading ? emptyState('尚无动态执行', { detail: '任务会话尚未分派执行；任务可直接形成结果。' }) : null,
        ready ? React.createElement('div', { style: { display: 'flex', gap: 12, alignItems: 'center' } }, React.createElement('span', { style: { marginRight: 'auto', color: colors.muted } }, `${page.total} 条执行记录`), React.createElement(Button, { type: 'button', variant: 'outline', disabled: loading || offset === 0, onClick: () => setOffset(value => Math.max(0, value - 20)) }, '上一页'), React.createElement(Button, { type: 'button', variant: 'outline', disabled: loading || offset + page.items.length >= page.total, onClick: () => setOffset(value => value + 20) }, '下一页')) : null)
    }
    function LegacyTaskOutput({ taskId, node, detailRevision }) {
      const [opened, setOpened] = useState(false)
      return React.createElement('details', { style: card, onToggle: event => { if (event.currentTarget.open) setOpened(true) } },
        React.createElement('summary', { style: { cursor: 'pointer' } }, `${node.title || node.nodeId || '历史执行'} · ${taskStateLabel(node.status)}`),
        opened ? node.outputRef ? React.createElement(TaskStepOutput, { taskId, node, detailRevision }) : React.createElement('p', null, '历史未记录产出') : null)
    }
    function LegacyTaskHistory({ task }) {
      const [page, setPage] = useState(1)
      const items = [...(task.executions || []).map(execution => ({ execution })), ...(task.executionNodes || []).map(node => ({ node }))]
      const pages = Math.max(1, Math.ceil(items.length / 20)), current = Math.min(page, pages)
      return React.createElement('section', { 'aria-label': '只读历史执行', style: { display: 'grid', gap: 12 } },
        React.createElement('p', { role: 'status' }, '历史任务只读，不再接受旧执行操作。'),
        task.session?.sessionId ? React.createElement('p', { style: { color: colors.muted } }, `历史任务会话：${task.session.sessionId}`) : null,
        ...items.slice((current - 1) * 20, current * 20).map(({ execution, node }, index) => node ? React.createElement(LegacyTaskOutput, { key: node.nodeRunId || index, taskId: task.taskId, node, detailRevision: task.detailRevision })
          : React.createElement('details', { key: execution.executionId, style: card }, React.createElement('summary', { style: { cursor: 'pointer' } }, `历史执行 ${execution.executionId} · ${taskStateLabel(execution.status)}`), React.createElement('p', null, `记录时间 ${fmt(execution.createdAt)}`), ...(execution.sessions || []).map(session => React.createElement('p', { key: session.sessionId }, `历史会话 ${session.sessionId} · ${taskStateLabel(session.status)}`)), execution.result ? React.createElement(TaskResult, { result: execution.result }) : null)),
        !items.length ? emptyState('暂无历史执行记录') : null,
        pages > 1 ? React.createElement('div', { style: { display: 'flex', gap: 12 } }, React.createElement(Button, { type: 'button', variant: 'outline', disabled: current <= 1, onClick: () => setPage(value => value - 1) }, '上一页'), React.createElement('span', null, `${current}/${pages}`), React.createElement(Button, { type: 'button', variant: 'outline', disabled: current >= pages, onClick: () => setPage(value => value + 1) }, '下一页')) : null)
    }
    function TaskSessionDetail({ task, onOpenSession, onChanged, onBack, updatedAt, onDirtyChange }) {
      return React.createElement('section', { 'aria-label': '任务会话详情', style: { maxWidth: 1100, margin: '0 auto', display: 'grid', gap: 20, overflowWrap: 'anywhere' } },
        React.createElement('div', { style: { display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between' } }, statusTag(task.legacyReadonly ? '历史只读' : taskStateLabel(task.state), taskStateTone(task.state)), React.createElement(Button, { type: 'button', variant: 'outline', onClick: onBack }, '返回看板')),
        React.createElement('h1', { style: { margin: 0, fontSize: 24 } }, taskDisplayTitle(task)),
        React.createElement('p', { style: { margin: 0, whiteSpace: 'pre-wrap' } }, task.objective),
        React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 16, color: colors.muted } }, `需求修订 ${task.requirementRevision ?? task.inputVersion ?? '未记录'}`, `控制修订 ${task.controlRevision ?? '未记录'}`, `控制状态 ${taskStateLabel(task.controlState || task.control?.state || task.state)}`),
        !task.legacyReadonly ? React.createElement(SessionLocation, { session: taskSession(task), label: '任务会话', onOpenSession }) : null,
        React.createElement(TaskResult, { result: task.result }),
        task.waitingReason ? React.createElement('p', { role: 'status', style: { color: colors.warning } }, traceReason(task.waitingReason)) : null,
        task.legacyReadonly ? React.createElement(LegacyTaskHistory, { key: task.taskId, task })
          : React.createElement(React.Fragment, null, React.createElement(TaskControls, { key: task.taskId, task, onChanged, onDirtyChange }), React.createElement(TaskExecutions, { key: task.taskId, taskId: task.taskId, updatedAt, onOpenSession })))
    }
    function ObserverContent({ openSession }) {
      const draftDirty = useRef(false)
      const [pendingNavigation, setPendingNavigation] = useState(null)
      const reportDirty = useCallback(value => { draftDirty.current = value }, [])
      const [activePage, updateActivePage] = useState(readActivePage)
      const setActivePage = useCallback(page => {
        if (draftDirty.current) { setPendingNavigation({ page }); return }
        updateActivePage(page)
        // 导航属于看板，不能随宿主 conversation 插槽重挂载而丢失。
        try { window.sessionStorage.setItem(activePageStorageKey, page) }
        catch { /* 浏览器禁用存储时仍允许正常切页。 */ }
      }, [])
      const [topicTarget, setTopicTarget] = useState()
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
      const [creatingTask, setCreatingTask] = useState(false)
      const [taskPages, setTaskPages] = useState({})
      const [selectedTaskId, setSelectedTaskId] = useState('')
      const [taskDetail, setTaskDetail] = useState()
      const [detailError, setDetailError] = useState('')
      const [detailRetry, setDetailRetry] = useState(0)
      const [selectedMessageRunId, setSelectedMessageRunId] = useState('')
      const [copiedId, setCopiedId] = useState('')
      const [navigatingSessionId, setNavigatingSessionId] = useState('')
      const [historyPage, setHistoryPage] = useState(1)
      const [alertType, setAlertType] = useState('all')
      const [alertView, setAlertView] = useState('active')
      const [resolvedAlertPage, setResolvedAlertPage] = useState(1)
      const [authorizationPage, setAuthorizationPage] = useState(1)
      const [authorizationFilter, setAuthorizationFilter] = useState('all')
      const [selectedAuthorizationId, setSelectedAuthorizationId] = useState('')
      const pendingRefresh = useRef(null)
      const refresh = useCallback(() => {
        if (pendingRefresh.current) return pendingRefresh.current
        pendingRefresh.current = load().then(value => { setData(value); setUpdatedAt(new Date()); setError(undefined) },
          cause => { setError(cause instanceof Error ? cause.message : String(cause)) })
          .finally(() => { pendingRefresh.current = null })
        return pendingRefresh.current
      }, [])
      const manualRefresh = useCallback(async () => {
        if (refreshState === 'refreshing') return
        setRefreshState('refreshing')
        await refresh()
        setRefreshState('done')
        window.setTimeout(() => setRefreshState('idle'), 1200)
      }, [refresh, refreshState])
      const pendingDetail = useRef(null)
      useEffect(() => {
        if (!selectedTaskId) { setTaskDetail(undefined); setDetailError(''); return }
        let active = true
        setDetailError('')
        if (pendingDetail.current?.taskId !== selectedTaskId || pendingDetail.current?.retry !== detailRetry) {
          const request = { taskId: selectedTaskId, retry: detailRetry }
          request.promise = get(`/state/tasks/${encodeURIComponent(selectedTaskId)}/detail`).finally(() => { if (pendingDetail.current === request) pendingDetail.current = null })
          pendingDetail.current = request
        }
        pendingDetail.current.promise.then(value => { if (active) setTaskDetail(value) }, cause => { if (active) setDetailError(cause.message) })
        return () => { active = false }
      }, [selectedTaskId, updatedAt, detailRetry])
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
      const tasksById = new Map((data?.tasks || []).map(task => [task.taskId, task]))
      const topicsById = new Map((data?.topics || []).map((topic) => [`${topic.groupId}:${topic.topicId}`, topic]))
      const navigate = async (sessionId, parentSessionId) => {
        try { setNavigationError(undefined); setNavigatingSessionId(sessionId); await openSession(sessionId, parentSessionId); setOpen(false) }
        catch (cause) { setNavigationError(cause instanceof Error ? cause.message : String(cause)) }
        finally { setNavigatingSessionId('') }
      }
      const openTask = task => { setCreatingTask(false); setSelectedTaskId(task.taskId); setActivePage('tasks') }
      const returnFromTask = () => { if (draftDirty.current) { setPendingNavigation({ back: true }); return } setSelectedTaskId(''); setCreatingTask(false) }
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
      const selectedMessages = [...(selectedGroup?.messages || [])].filter((message) => message.sourceKind === 'dingtalk' || message.sourceKind === 'migration' || message.sourceKind === 'workflow-v2' || message.sourceKind === 'task-session' || !message.sourceKind).sort((left, right) => (new Date(right.occurredAt).getTime() || 0) - (new Date(left.occurredAt).getTime() || 0) || Number(right.sequence || 0) - Number(left.sequence || 0))
      const messageWorkflowState = (message) => {
        if (['routing', 'waiting_clarification', 'waiting_authorization', 'waiting_context', 'waiting_system', 'execution_blocked', 'routing_blocked', 'waiting_routing_barrier', 'intent_judging', 'intent_rejudging', 'processed'].includes(message.workflowStatus)) return message.workflowStatus
        if (message.routingStatus === 'failed') return 'failed'
        if (message.routingStatus !== 'routed') return 'routing'
        if (message.sourceKind === 'workflow-v2') return 'processed'
        const related = (selectedGroup?.topics || []).flatMap((topic) => {
          const entry = [...(topic.entries || [])].reverse().find((item) => item.messageId === message.messageId)
          return entry?.action === 'add' && entry.messageVersion === message.messageVersion ? [{ topic, entry }] : []
        })
        if (related.some(({ topic, entry }) => (topic.processedRevision || 0) < entry.revision)) return 'processing'
        return 'processed'
      }
      const filteredMessages = selectedMessages.filter((message) => messageDeliveryFilter === 'all' || messageWorkflowState(message) === messageDeliveryFilter)
      const pageSize = 10
      const pageCount = Math.max(1, Math.ceil(filteredMessages.length / pageSize))
      const currentMessagePage = Math.min(messagePage, pageCount)
      const visibleMessages = filteredMessages.slice((currentMessagePage - 1) * pageSize, currentMessagePage * pageSize)
      const delivery = {
        routing: { label: '待归类', state: 'ongoing' },
        waiting_authorization: { label: '等待授权', state: 'ongoing' },
        waiting_clarification: { label: '等待用户补充', state: 'ongoing' },
        waiting_context: { label: '正在读取材料', state: 'ongoing' },
        waiting_system: { label: '材料读取受阻', state: 'error' },
        execution_blocked: { label: '执行受阻', state: 'error' },
        routing_blocked: { label: '关联受阻', state: 'error' },
        waiting_routing_barrier: { label: '核对相关输入', state: 'ongoing' },
        intent_judging: { label: '话题意图判断中', state: 'ongoing' },
        intent_rejudging: { label: '新消息加入 · 重新判断', state: 'ongoing' },
        processing: { label: '话题处理中', state: 'ongoing' },
        processed: { label: '已处理', state: 'done' },
        failed: { label: '归类失败', state: 'error' },
      }
      const messageRows = visibleMessages.map((message, rowIndex) => {
        const status = delivery[messageWorkflowState(message)]
        const notificationLabels = { prepared: '待发送', sending: '发送中', acknowledged: '已确认发送，待回读', unknown: '发送结果待核对', delivered: '已回读送达', superseded: '已失效' }
        const responsibilityLabels = { host: '助手读取和核对', requester: '请求人补充', system: '系统维护人员排查', approver: '审批人确认', acceptor: '验收人确认' }
        const messageFacts = message.waiting?.length || message.blockingSources?.length || message.notifications?.length
          ? React.createElement('details', { style: { marginTop: 6, fontSize: 12, overflowWrap: 'anywhere' } },
            React.createElement('summary', { style: { cursor: 'pointer', color: colors.accent } }, '等待与通知'),
            ...(message.waiting || []).map((wait, index) => React.createElement('p', { key: `wait-${index}`, style: { margin: '6px 0' } },
              `${wait.goalText ? `事项：${wait.goalText}；` : ''}${responsibilityLabels[wait.responsibility] || '责任待确认'}：${traceReason(wait.reason) || '原因待核对'}。恢复条件：${wait.recoveryCondition}`)),
            ...(message.blockingSources || []).map((source) => React.createElement('p', { key: source.runId, style: { margin: '6px 0' } }, `相关来源：${source.text || source.messageId || '来源正文未记录'}`)),
            React.createElement('p', { style: { margin: '6px 0' } }, '沟通状态独立于事项处理状态。'),
            ...(message.notifications || []).map((notice) => React.createElement('p', { key: notice.notificationId, style: { margin: '6px 0' } },
              `通知：${notificationLabels[notice.status] || '状态未记录'}`)),
            !message.notifications?.length ? React.createElement('p', null, '尚无通知记录') : null) : null
        return React.createElement('tr', { key: message.messageId, style: { background: rowIndex % 2 ? `color-mix(in srgb, ${colors.surface2} 55%, transparent)` : colors.cardSurface } },
          React.createElement('td', { style: { ...tableBodyCell, width: 144 }, title: traceReason(message.workflowStatusDetail || message.agentDeliveryError) || '' }, clampTableContent(tableStatusTag(status.label, status.state, { fontWeight: 600 }))),
          React.createElement('td', { style: { ...tableBodyCell, width: 160 } }, clampTableContent(React.createElement('strong', { style: { fontSize: 14, fontWeight: 600 } }, message.senderName || message.senderOpenDingTalkId || '发送人未记录'), React.createElement('div', { style: { marginTop: 3, fontSize: 11, color: colors.muted } }, fmt(message.occurredAt)))),
          React.createElement('td', { style: { ...tableBodyCell, width: 160 } }, React.createElement('div', { style: { display: 'flex', gap: 4, minWidth: 0, overflow: 'hidden' } }, ...(message.taskSessionRefs || []).map(taskId => React.createElement(Button, { key: `task:${taskId}`, type: 'button', variant: 'outline', size: 'sm', onClick: () => openTask(tasksById.get(taskId) || { taskId }), style: { maxWidth: 140, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }, 'aria-label': `查看任务 ${tasksById.get(taskId)?.title || taskId}` }, taskDisplayTitle(tasksById.get(taskId) || { title: taskId }))), ...(message.topicRefs?.length ? message.topicRefs.map((ref) => React.createElement('button', { key: ref.topicId, type: 'button', title: ref.title, 'aria-label': `话题 ${ref.title}`, onClick: () => { setTopicTarget({ groupId: selectedGroup.groupId, topicId: ref.topicId, revision: ref.revision }); setActivePage('topics') }, style: { ...pill(colors.accent), display: 'inline-block', flex: '0 1 auto', minWidth: 0, maxWidth: 120, border: 0, padding: '2px 7px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer', fontFamily: 'inherit' } }, ref.title)) : message.taskSessionRefs?.length ? [] : [React.createElement('span', { key: 'unrouted', style: { color: colors.muted, fontSize: 12 } }, messageWorkflowState(message) === 'processed' ? '—' : '待归类')]))),
          React.createElement('td', { title: message.text, style: tableBodyCell }, clampTableContent(message.text || '（空消息）')),
          React.createElement('td', { style: { ...tableBodyCell, width: 240 } }, singleLineTableContent(React.createElement('code', { title: message.messageId, style: { fontSize: 14, color: colors.muted, whiteSpace: 'nowrap' } }, `#${message.sequence ?? '—'} · ${short(message.messageId)}`)), message.runId ? React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', onClick: () => setSelectedMessageRunId(message.runId), style: { marginTop: 5 } }, '处理过程') : React.createElement('span', { style: { color: colors.muted, fontSize: 11, display: 'block' } }, '历史未记录处理过程'), messageFacts))
      })
      const selectedOutbox = [...(selectedGroup?.outbox || [])].reverse()
      const outboxState = (message) => outboxDelivery(message).id
      const filteredOutbox = selectedOutbox.filter((message) => outboxStatusFilter === 'all' || outboxState(message) === outboxStatusFilter)
      const outboxPageSize = 10
      const outboxPageCount = Math.max(1, Math.ceil(filteredOutbox.length / outboxPageSize))
      const currentOutboxPage = Math.min(outboxPage, outboxPageCount)
      const visibleOutbox = filteredOutbox.slice((currentOutboxPage - 1) * outboxPageSize, currentOutboxPage * outboxPageSize)
      const outboxRows = visibleOutbox.map((message, rowIndex) => {
        const status = outboxDelivery(message)
        return React.createElement('tr', { key: message.outboundId, style: { background: rowIndex % 2 ? `color-mix(in srgb, ${colors.surface2} 55%, transparent)` : colors.cardSurface } },
          React.createElement('td', { style: { ...tableBodyCell, width: 124 } }, clampTableContent(tableStatusTag(status.label, status.state, { fontWeight: 600 }))),
          React.createElement('td', { title: message.text, style: tableBodyCell }, clampTableContent(message.text || '（空消息）'),
            status.detail || !['confirmed', 'superseded', 'recalled', 'recall-failed'].includes(status.id) && typeof message.deliveryError === 'string' && message.deliveryError ? React.createElement('div', { style: { marginTop: 6, fontSize: 12, color: status.state === 'error' ? colors.danger : colors.warning, overflowWrap: 'anywhere' } }, status.detail || '', !message.supersededByOutboundId && !message.recallStatus && typeof message.deliveryError === 'string' && message.deliveryError ? `${status.detail ? '：' : ''}${message.deliveryError}` : '') : null,
            !status.retryDisabled && !['confirmed', 'superseded', 'recalled', 'recall-failed'].includes(status.id) && message.notificationRetryAt ? React.createElement('div', { style: { marginTop: 3, fontSize: 11, color: colors.muted } }, `计划${status.id === 'waiting' ? '核验' : '重试'} ${fmt(message.notificationRetryAt)}`) : null,
            message.deliveryAttemptedAt ? React.createElement('div', { style: { marginTop: 3, fontSize: 11, color: colors.muted } }, `最近尝试 ${fmt(message.deliveryAttemptedAt)} · 共 ${message.deliveryAttemptCount || 1} 次`) : null),
          React.createElement('td', { style: { ...tableBodyCell, width: 220 } },
            React.createElement('div', { style: { minWidth: 0 } }, singleLineTableContent(React.createElement('code', { title: message.sourceMessageId, style: { fontSize: 14, color: colors.muted, whiteSpace: 'nowrap' } }, short(message.sourceMessageId))), message.replyToMessageId ? React.createElement('div', { style: { marginTop: 3, fontSize: 11, color: colors.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, '回复 ', React.createElement('code', { title: message.replyToMessageId }, short(message.replyToMessageId))) : null)),
          React.createElement('td', { style: { ...tableBodyCell, width: 220 } }, singleLineTableContent(React.createElement('code', { title: message.deliveredMessageId || '', style: { fontSize: 14, color: colors.muted, whiteSpace: 'nowrap' } }, message.deliveredMessageId ? short(message.deliveredMessageId) : message.status === 'sent' ? '历史未记录' : '尚未确认'))),
          React.createElement('td', { style: { ...tableBodyCell, width: 220 } }, singleLineTableContent(React.createElement('code', { title: message.outboundId, style: { fontSize: 14, color: colors.muted, whiteSpace: 'nowrap' } }, short(message.outboundId)))))
      })
      const renderTaskCard = task => {
        const sourceGroup = groupsById.get(task.sourceGroupId || task.groupId)
        const groupLabel = sourceGroup?.name || (task.groupId?.startsWith('web:') ? 'Web 任务' : task.groupId) || '未关联群聊'
        const session = taskSession(task)
        const hovered = hoveredTaskId === task.taskId
        const queued = task.state === 'queued'
        const displayObjective = String(task.objective || '').startsWith('[TASK_SOURCE_EVIDENCE]') ? (task.title || task.objective) : task.objective
        return React.createElement('article', { key: task.taskId, onClick: event => { if (!event.target.closest('button')) openTask(task) }, onMouseEnter: () => setHoveredTaskId(task.taskId), onMouseLeave: () => setHoveredTaskId(''), style: { width: '100%', minWidth: 0, boxSizing: 'border-box', border: `1px solid ${colors.border}`, borderRadius: 12, background: colors.cardSurface, boxShadow: hovered ? '0 8px 20px rgba(15,23,42,.08), 0 2px 6px rgba(15,23,42,.05)' : 'var(--dsw-shadow-card, 0 1px 2px rgba(0,0,0,.08))', padding: '11px 13px', color: 'inherit', display: 'grid', gap: 6, opacity: queued ? 0.72 : 1, transition: 'box-shadow 180ms ease' } },
          React.createElement('button', { type: 'button', onClick: () => openTask(task), style: { width: '100%', minWidth: 0, boxSizing: 'border-box', border: 0, padding: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', textAlign: 'left', display: 'grid', gap: 6, fontFamily: 'inherit' } },
            React.createElement('strong', { title: task.title || task.objective, style: { fontSize: 13, lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' } }, taskDisplayTitle(task))),
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, overflow: 'hidden' } },
            React.createElement('span', { title: groupLabel, style: { ...pill(colors.muted), flex: '0 1 auto', maxWidth: 150, padding: '2px 7px', fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, groupLabel),
            ...(task.topicRefs || []).map(ref => {
              const groupId = ref.groupId || task.sourceGroupId || task.groupId
              const label = topicsById.get(`${groupId}:${ref.topicId}`)?.title || ref.title || `话题 ${short(ref.topicId)}`
              return React.createElement('button', { key: ref.topicId, type: 'button', title: label, 'aria-label': `话题 ${label}`, onClick: event => { event.stopPropagation(); setTopicTarget({ groupId, topicId: ref.topicId, revision: ref.revision }); setActivePage('topics') }, style: { ...pill(colors.accent), display: 'inline-block', border: 0, fontFamily: 'inherit', flex: '0 1 auto', minWidth: 0, maxWidth: 96, padding: '2px 7px', fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' } }, label)
            })),
          React.createElement('button', { type: 'button', title: displayObjective, 'aria-label': '查看完整任务目标', onClick: () => openTask(task), style: { border: 0, padding: 0, background: 'transparent', color: 'inherit', textAlign: 'left', fontFamily: 'inherit', cursor: 'pointer', minWidth: 0, display: 'block', maxHeight: '4.5em', overflow: 'hidden', overflowWrap: 'anywhere', fontSize: 11, lineHeight: 1.5 } },
            React.createElement('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, style: { display: 'inline-block', verticalAlign: -2, marginRight: 5, color: colors.muted } }, React.createElement('circle', { cx: 8, cy: 8, r: 5.5 }), React.createElement('circle', { cx: 8, cy: 8, r: 2 }), React.createElement('path', { d: 'M8 1v2M15 8h-2' })), displayObjective),
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 5, fontSize: 10.5, lineHeight: 1.5, color: colors.muted } },
            React.createElement(StateDot, { state: taskStateTone(task.state), size: 7 }), taskStateLabel(task.state), ' · ', task.legacyReadonly ? '历史只读 · 可查阅历史产出' : `任务会话 ${session.sessionId ? short(session.sessionId) : '待建立'} · ${task.executionCount ?? (task.executions || []).length} 次动态执行`),
          task.waitingReason ? React.createElement('div', { style: { fontSize: 11, lineHeight: 1.5, color: colors.warning, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' } }, task.waitingReason) : null,
          React.createElement('div', { style: { minWidth: 0, paddingTop: 6, borderTop: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', gap: 4, fontSize: 10.5, color: colors.muted } },
            React.createElement('svg', { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-label': '最后活动时间' }, React.createElement('circle', { cx: 12, cy: 12, r: 9 }), React.createElement('path', { d: 'M12 7v5l3 2' })), fmt(task.updatedAt)))
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
      const bucketColumns = taskBuckets.map(bucket => {
        const tasks = (data?.tasks || []).filter(task => (bucket.state === 'completed' ? ['completed', 'cancelled', 'succeeded', 'failed'].includes(task.state) : bucket.state === 'waiting' ? ['waiting', 'paused', 'blocked', 'interrupted'].includes(task.state) : task.state === bucket.state) && !task.archivedAt && !task.legacyReadonly).sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
        const totalPages = Math.max(1, Math.ceil(tasks.length / 10)), page = Math.min(taskPages[bucket.state] || 1, totalPages)
        const visible = tasks.slice((page - 1) * 10, page * 10)
        return React.createElement('section', { key: bucket.state, style: { boxSizing: 'border-box', borderRadius: 14, background: bucket.background, padding: '8px 4px', minWidth: 0, display: 'flex', flexDirection: 'column', height: 'calc(100dvh - 164px)', minHeight: 420, maxHeight: 'calc(100dvh - 164px)', overflow: 'hidden' } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px 10px' } }, React.createElement('strong', { style: { display: 'inline-flex', alignItems: 'center', borderRadius: 999, padding: '3px 9px', fontSize: 11.5, fontWeight: 650, lineHeight: 1.4, color: 'var(--dsw-alias-label-primary-inverted, #fff)', background: bucket.tone } }, bucket.label), React.createElement('span', { style: { borderRadius: 999, background: colors.cardSurface, padding: '2px 7px', fontSize: 10.5, color: colors.muted } }, tasks.length)),
          React.createElement('div', { style: { flex: 1, minHeight: 0, padding: '8px 8px 12px 8px', display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto', scrollbarWidth: 'none' } }, ...(visible.length ? visible.map(renderTaskCard) : [React.createElement('div', { key: 'empty', style: { border: `1px dashed ${colors.border}`, borderRadius: 10, minHeight: 90, display: 'grid', placeItems: 'center', color: colors.muted, fontSize: 12 } }, '暂无任务')])),
          totalPages > 1 ? React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8 } }, React.createElement(Button, { type: 'button', variant: 'outline', size: 'sm', disabled: page <= 1, onClick: () => setTaskPages(value => ({ ...value, [bucket.state]: page - 1 })) }, '上一页'), React.createElement('span', null, `${page}/${totalPages}`), React.createElement(Button, { type: 'button', variant: 'outline', size: 'sm', disabled: page >= totalPages, onClick: () => setTaskPages(value => ({ ...value, [bucket.state]: page + 1 })) }, '下一页')) : null)
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
        menu,
        pendingNavigation ? React.createElement('section', { 'aria-label': '未提交的修改', style: { padding: 12, display: 'flex', gap: 12, flexWrap: 'wrap' } }, React.createElement('span', null, '离开会丢弃尚未提交的修改。'), React.createElement(Button, { type: 'button', variant: 'outline', onClick: () => setPendingNavigation(null) }, '继续编辑'), React.createElement(Button, { type: 'button', onClick: () => { const target = pendingNavigation; draftDirty.current = false; setPendingNavigation(null); if (target.back) returnFromTask(); else setActivePage(target.page) } }, '放弃修改并离开')) : null)
      const dataViewTabs = React.createElement('div', { role: 'tablist', 'aria-label': '群聊数据视图', style: { display: 'flex', alignSelf: 'stretch', gap: 20 } },
        ...[{ id: 'messages', label: `收信箱 · ${selectedMessages.length}` }, { id: 'outbox', label: `发信箱 · ${selectedOutbox.length}` }].map((item) => React.createElement('button', { key: item.id, role: 'tab', 'aria-selected': groupTableView === item.id, type: 'button', onClick: () => setGroupTableView(item.id), style: navigationTabStyle(groupTableView === item.id, { paddingBottom: 4 }) }, item.label)))
      const groupTableToolbar = React.createElement('div', { style: toolbar },
        dataViewTabs,
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' } },
          (data?.groups || []).length ? React.createElement(SelectMenu, { label: '选择群聊', value: selectedGroup?.groupId || '', options: (data?.groups || []).map((group) => ({ id: group.groupId, label: group.name || group.groupId })), onChange: (value) => { setSelectedGroupId(value); setMessagePage(1); setOutboxPage(1); setSelectedMessageRunId('') }, fitContent: true }) : null,
          selectedGroup?.coordinator?.sessionId ? React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: navigatingSessionId === selectedGroup.coordinator.sessionId,
            onClick: () => navigate(selectedGroup.coordinator.sessionId) }, navigatingSessionId === selectedGroup.coordinator.sessionId ? '正在打开…' : '打开群常驻会话') : null,
          groupTableView === 'messages'
            ? React.createElement(SelectMenu, { label: '筛选处理状态', value: messageDeliveryFilter, options: [{ id: 'all', label: '全部处理状态' }, { id: 'routing', label: '待归类' }, { id: 'waiting_routing_barrier', label: '核对相关输入' }, { id: 'intent_judging', label: '意图判断中' }, { id: 'intent_rejudging', label: '意图重新判断' }, { id: 'waiting_clarification', label: '等待用户补充' }, { id: 'waiting_authorization', label: '等待授权' }, { id: 'waiting_context', label: '正在读取材料' }, { id: 'waiting_system', label: '材料读取受阻' }, { id: 'execution_blocked', label: '执行受阻' }, { id: 'routing_blocked', label: '关联受阻' }, { id: 'processing', label: '话题处理中' }, { id: 'processed', label: '已处理' }, { id: 'failed', label: '归类失败' }], onChange: (value) => { setMessageDeliveryFilter(value); setMessagePage(1) } })
            : React.createElement(SelectMenu, { label: '筛选发件状态', value: outboxStatusFilter, options: [{ id: 'all', label: '全部发件状态' }, { id: 'queued', label: '待发送' }, { id: 'sending', label: '发送中' }, { id: 'failed', label: '投递异常' }, { id: 'waiting', label: '待回读 / 核对' }, { id: 'stopped', label: '已停止发送' }, { id: 'reassessment', label: '已停止，需核验' }, { id: 'confirmed', label: '已发送' }, { id: 'superseded', label: '已替代' }, { id: 'recall-failed', label: '撤回待处理' }, { id: 'recalled', label: '已撤回' }], onChange: (value) => { setOutboxStatusFilter(value); setOutboxPage(1) } })))
      const messagesTable = React.createElement(React.Fragment, null,
        React.createElement('div', { style: { overflowX: 'auto' } }, React.createElement('table', { style: { width: '100%', minWidth: 910, borderCollapse: 'collapse', tableLayout: 'fixed' } },
          React.createElement('thead', null, React.createElement('tr', { style: { background: colors.surface2, textAlign: 'left' } }, React.createElement('th', { style: { ...tableHeadCell, width: 144 } }, '处理状态'), React.createElement('th', { style: { ...tableHeadCell, width: 160 } }, '发送人 / 时间'), React.createElement('th', { style: { ...tableHeadCell, width: 160 } }, '关联任务 / 历史话题'), React.createElement('th', { style: tableHeadCell }, '消息内容'), React.createElement('th', { style: { ...tableHeadCell, width: 240 } }, '消息'))),
          React.createElement('tbody', null, ...(messageRows.length ? messageRows : [React.createElement('tr', { key: 'empty' }, React.createElement('td', { colSpan: 5, style: { ...tableBodyCell, padding: 36, textAlign: 'center', color: colors.muted } }, '暂无符合条件的群聊消息'))])))),
        React.createElement('div', { style: tableFooter }, React.createElement('span', { style: { marginRight: 'auto', fontSize: 11, color: colors.muted } }, `${filteredMessages.length} 条 · 每页 ${pageSize} 条`), React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: currentMessagePage <= 1, onClick: () => setMessagePage((page) => Math.max(1, page - 1)) }, '上一页'), React.createElement('span', { style: { fontSize: 11, color: colors.muted } }, `${currentMessagePage} / ${pageCount}`), React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: currentMessagePage >= pageCount, onClick: () => setMessagePage((page) => Math.min(pageCount, page + 1)) }, '下一页')))
      const outboxTable = React.createElement(React.Fragment, null,
        React.createElement('div', { style: { overflowX: 'auto' } }, React.createElement('table', { style: { width: '100%', minWidth: 1100, borderCollapse: 'collapse', tableLayout: 'fixed' } },
          React.createElement('thead', null, React.createElement('tr', { style: { background: colors.surface2, textAlign: 'left' } }, React.createElement('th', { style: { ...tableHeadCell, width: 124 } }, '发送状态'), React.createElement('th', { style: tableHeadCell }, '消息内容'), React.createElement('th', { style: { ...tableHeadCell, width: 220 } }, '来源 / 回复目标'), React.createElement('th', { style: { ...tableHeadCell, width: 220 } }, '投递消息 ID'), React.createElement('th', { style: { ...tableHeadCell, width: 220 } }, '发信箱 ID'))),
          React.createElement('tbody', null, ...(outboxRows.length ? outboxRows : [React.createElement('tr', { key: 'empty' }, React.createElement('td', { colSpan: 5, style: { ...tableBodyCell, padding: 36, textAlign: 'center', color: colors.muted } }, '暂无符合条件的 Agent 发件记录'))])))),
        React.createElement('div', { style: tableFooter }, React.createElement('span', { style: { marginRight: 'auto', fontSize: 11, color: colors.muted } }, `${filteredOutbox.length} 条 · 每页 ${outboxPageSize} 条`), React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: currentOutboxPage <= 1, onClick: () => setOutboxPage((page) => Math.max(1, page - 1)) }, '上一页'), React.createElement('span', { style: { fontSize: 11, color: colors.muted } }, `${currentOutboxPage} / ${outboxPageCount}`), React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: currentOutboxPage >= outboxPageCount, onClick: () => setOutboxPage((page) => Math.min(outboxPageCount, page + 1)) }, '下一页')))
      const groupsPage = selectedMessageRunId ? React.createElement(TraceDetail, { runId: selectedMessageRunId, onOpenSession: navigate, onBack: () => setSelectedMessageRunId('') }) : React.createElement('section', null, React.createElement('div', { style: tableFrame }, groupTableToolbar, groupTableView === 'messages' ? messagesTable : outboxTable))
      const selectedTask = taskDetail?.taskId === selectedTaskId ? taskDetail : undefined
      const tasksPage = creatingTask ? React.createElement(CreateTaskForm, { groups: data?.groups || [], onDirtyChange: reportDirty, onCancel: returnFromTask, onCreated: result => { setCreatingTask(false); const task = result.task || result; if (task.taskId) openTask(task); void refresh() } })
        : selectedTaskId ? React.createElement(React.Fragment, null,
          detailError ? React.createElement('div', { role: 'alert', style: { ...card, color: colors.danger } }, `任务详情读取失败，已读取内容可能过期：${detailError}`, React.createElement(Button, { type: 'button', variant: 'outline', onClick: () => setDetailRetry(value => value + 1) }, '重试读取详情')) : null,
          selectedTask ? React.createElement(TaskSessionDetail, { task: selectedTask, onOpenSession: navigate, onChanged: () => { setDetailRetry(value => value + 1); void refresh() }, onBack: returnFromTask, updatedAt, onDirtyChange: reportDirty })
            : React.createElement('section', { style: { minHeight: 200, display: 'grid', gap: 12 } }, React.createElement(Button, { type: 'button', variant: 'outline', onClick: returnFromTask }, '返回看板'), !detailError ? React.createElement('span', { role: 'status' }, '正在读取任务详情…') : null))
        : React.createElement('section', { style: { display: 'grid', gap: 16 } }, React.createElement(Button, { type: 'button', onClick: () => setCreatingTask(true), style: { justifySelf: 'start' } }, '新建任务'), React.createElement('div', { className: 'observer-task-board', style: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(300px, 1fr))', gap: ui.space3, overflowX: 'auto', alignItems: 'start', paddingBottom: ui.space2 } }, ...bucketColumns))
      const authorizationStatus = {
        'pending-send': { label: '待发送', state: 'warning' },
        'sending-unknown': { label: '投递待确认', state: 'warning' },
        'waiting-reply': { label: '等待处理', state: 'warning' },
        answered: { label: '已处理', state: 'done' },
        superseded: { label: '已失效', state: 'neutral' },
      }
      const authorizationDecision = { approved: { label: '已继续', state: 'done' }, rejected: { label: '不执行', state: 'error' } }
      const isPendingAuthorization = (item) => item.status === 'pending-send' || item.status === 'sending-unknown' || item.status === 'waiting-reply'
      const authorizationPresentation = (item) => item.status === 'answered'
        ? authorizationDecision[item.decision] || authorizationStatus.answered
        : authorizationStatus[item.status] || { label: '状态异常', state: 'error' }
      const authorizationItems = [...(data?.authorizations || [])].sort((left, right) => {
        const leftPending = isPendingAuthorization(left) ? 1 : 0; const rightPending = isPendingAuthorization(right) ? 1 : 0
        return rightPending - leftPending || String(right.createdAt || '').localeCompare(String(left.createdAt || ''))
      })
      const filteredAuthorizationItems = authorizationItems.filter((item) => authorizationFilter === 'all' || (authorizationFilter === 'pending' ? isPendingAuthorization(item) : authorizationFilter === 'superseded' ? item.status === 'superseded' : item.decision === authorizationFilter))
      const authorizationPageSize = 10
      const authorizationPageCount = Math.max(1, Math.ceil(filteredAuthorizationItems.length / authorizationPageSize))
      const currentAuthorizationPage = Math.min(authorizationPage, authorizationPageCount)
      const visibleAuthorizationItems = filteredAuthorizationItems.slice((currentAuthorizationPage - 1) * authorizationPageSize, currentAuthorizationPage * authorizationPageSize)
      const selectedAuthorization = authorizationItems.find((item) => item.requestId === selectedAuthorizationId)
      const authorizationDetailField = (label, value) => React.createElement('div', { style: { display: 'grid', gap: 5 } },
        React.createElement('strong', { style: { fontSize: 11, color: colors.muted } }, label),
        React.createElement('div', { style: { fontSize: 13, lineHeight: 1.65, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, value || '—'))
      const authorizationRows = visibleAuthorizationItems.map((item, rowIndex) => {
        const status = authorizationPresentation(item)
        const group = groupsById.get(item.groupId)
        return React.createElement('div', { key: item.requestId, style: { width: '100%', minWidth: 0, boxSizing: 'border-box', display: 'grid', gridTemplateColumns: '104px minmax(220px, 1.1fr) minmax(280px, 1.5fr) 126px 52px', alignItems: 'center', gap: 16, borderTop: `1px solid ${colors.border}`, background: rowIndex % 2 ? `color-mix(in srgb, ${colors.surface2} 55%, transparent)` : colors.cardSurface, color: 'inherit', padding: '12px 16px', fontSize: 14 } },
          React.createElement('div', { style: { justifySelf: 'start' } }, tableStatusTag(status.label, status.state, { fontWeight: 600 })),
          React.createElement('span', { style: { minWidth: 0 } }, React.createElement('strong', { title: item.objective, style: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14, fontWeight: 600, lineHeight: 1.5 } }, item.objective), React.createElement('span', { style: { display: 'block', marginTop: 3, color: colors.muted, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, group?.name || item.groupId)),
          React.createElement('span', { style: { minWidth: 0 } }, React.createElement('span', { title: item.requestedAction, style: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14, lineHeight: 1.55, color: colors.muted } }, item.requestedAction), item.risk && item.risk !== '未单独说明' ? React.createElement('span', { style: { display: 'block', marginTop: 3, color: colors.danger, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `风险 · ${item.risk}`) : null),
          React.createElement('span', { style: { color: colors.muted, fontSize: 11, lineHeight: 1.5 } }, fmt(item.createdAt)),
          React.createElement(Button, { variant: 'ghost', size: 'sm', type: 'button', onClick: () => setSelectedAuthorizationId(item.requestId) }, '查看'))
      })
      const authorizationDetail = selectedAuthorization ? React.createElement('div', { role: 'presentation', onMouseDown: (event) => { if (event.target === event.currentTarget) setSelectedAuthorizationId('') }, style: { position: 'fixed', inset: 0, zIndex: 1100, display: 'flex', justifyContent: 'flex-end', background: 'rgba(0,0,0,.28)', backdropFilter: 'blur(2px)' } },
        React.createElement('section', { role: 'dialog', 'aria-modal': true, 'aria-label': '人工介入事项详情', style: { width: 'min(640px, 100%)', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', borderLeft: `1px solid ${colors.border}`, background: colors.surface, boxShadow: '-20px 0 60px rgba(0,0,0,.2)' } },
          React.createElement('header', { style: { flex: '0 0 auto', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 24, padding: '24px 24px 20px', borderBottom: `1px solid ${colors.border}`, background: colors.surface } },
            React.createElement('div', { style: { minWidth: 0 } }, React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 } }, statusTag(authorizationPresentation(selectedAuthorization).label, authorizationPresentation(selectedAuthorization).state), React.createElement('span', { style: { color: colors.muted, fontSize: 11.5 } }, fmt(selectedAuthorization.createdAt))), React.createElement('h3', { style: { margin: 0, fontSize: 18, fontWeight: 600, lineHeight: 1.5 } }, selectedAuthorization.objective || '人工介入事项'), React.createElement('code', { style: { display: 'block', marginTop: 10, color: colors.muted, fontSize: 10.5 } }, selectedAuthorization.requestId)),
            React.createElement(Button, { variant: 'ghost', size: 'sm', type: 'button', 'aria-label': '关闭人工介入事项', onClick: () => setSelectedAuthorizationId(''), style: { flex: '0 0 auto', minWidth: 52, whiteSpace: 'nowrap' } }, '关闭')),
          React.createElement('div', { style: { flex: '1 1 auto', overflowY: 'auto', padding: '0 24px 24px' } },
            React.createElement('section', { style: { padding: '24px 0', borderBottom: `1px solid ${colors.border}` } }, authorizationDetailField('需要人工处理', selectedAuthorization.requestedAction)),
            React.createElement('section', { style: { padding: '24px 0', borderBottom: `1px solid ${colors.border}` } }, authorizationDetailField('风险', selectedAuthorization.risk || '未单独说明')),
            React.createElement('section', { style: { padding: '24px 0', borderBottom: `1px solid ${colors.border}` } }, authorizationDetailField('阻塞原因', selectedAuthorization.waitingReason)),
            React.createElement('details', { open: true, style: { padding: '18px 0', borderBottom: `1px solid ${colors.border}` } }, React.createElement('summary', { style: { cursor: 'pointer', fontSize: 12, fontWeight: 600 } }, `现场证据 · ${(selectedAuthorization.evidence || []).length}`), React.createElement('div', { style: { marginTop: 14 } }, authorizationDetailField('', (selectedAuthorization.evidence || []).map((value, index) => `${index + 1}. ${value}`).join('\n')))),
            React.createElement('details', { style: { padding: '18px 0', borderBottom: `1px solid ${colors.border}` } }, React.createElement('summary', { style: { cursor: 'pointer', fontSize: 12, fontWeight: 600 } }, `已尝试 · ${(selectedAuthorization.attemptedActions || []).length}`), React.createElement('div', { style: { marginTop: 14 } }, authorizationDetailField('', (selectedAuthorization.attemptedActions || []).map((value, index) => `${index + 1}. ${value}`).join('\n')))),
            React.createElement('section', { style: { padding: '20px 0', borderBottom: `1px solid ${colors.border}` } }, authorizationDetailField('关联信息', `Task ID：${selectedAuthorization.taskId || '—'}\n群聊：${groupsById.get(selectedAuthorization.groupId)?.name || selectedAuthorization.groupId || '—'}`)),
            selectedAuthorization.status === 'answered' ? React.createElement('section', { style: { padding: '20px 0' } }, authorizationDetailField('处理结果', `${selectedAuthorization.decision === 'approved' ? '继续任务' : selectedAuthorization.decision === 'rejected' ? '不执行' : selectedAuthorization.decision || '已处理'}\n处理渠道：${selectedAuthorization.decisionSource === 'web' ? '运行看板' : selectedAuthorization.decisionSource === 'dingtalk' ? '钉钉私聊' : selectedAuthorization.decisionSource || '历史迁移'}\n处理时间：${fmt(selectedAuthorization.decidedAt)}\n处理意见：${selectedAuthorization.reply || '—'}`)) : null),
          React.createElement('p', { role: 'status', style: { padding: 16, color: colors.muted } }, '历史介入记录只读。新执行的权限请求请在对应执行会话中处理。'))) : null
      const authorizationsPage = React.createElement(React.Fragment, null, React.createElement('section', null,
        React.createElement('div', { style: tableFrame },
          React.createElement('div', { style: { ...toolbar, justifyContent: 'flex-end' } }, React.createElement(SelectMenu, { label: '筛选处理状态', value: authorizationFilter, options: [{ id: 'all', label: '全部处理状态' }, { id: 'pending', label: '等待处理' }, { id: 'approved', label: '已继续' }, { id: 'rejected', label: '不执行' }, { id: 'superseded', label: '已失效' }], onChange: (value) => { setAuthorizationFilter(value); setAuthorizationPage(1) }, fitContent: true })),
          React.createElement('div', { style: { height: 42, boxSizing: 'border-box', display: 'grid', gridTemplateColumns: '104px minmax(220px, 1.1fr) minmax(280px, 1.5fr) 126px 52px', alignItems: 'center', gap: 16, padding: '0 16px', background: colors.surface2, color: colors.muted, fontSize: 13, fontWeight: 600 } }, React.createElement('span', null, '状态'), React.createElement('span', null, '任务'), React.createElement('span', null, '阻塞事项'), React.createElement('span', null, '提出时间'), React.createElement('span', null, '操作')),
          React.createElement('div', null, ...(authorizationRows.length ? authorizationRows : [React.createElement('div', { key: 'empty', style: { padding: 36, textAlign: 'center', color: colors.muted, fontSize: 12 } }, '暂无人工介入事项')])),
          React.createElement('div', { style: tableFooter },
            React.createElement('span', { style: { marginRight: 'auto', fontSize: 11, color: colors.muted } }, `当前显示 ${filteredAuthorizationItems.length} 条 · 每页 ${authorizationPageSize} 条`),
            React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: currentAuthorizationPage <= 1, onClick: () => setAuthorizationPage((page) => Math.max(1, page - 1)) }, '上一页'),
            React.createElement('span', { style: { fontSize: 11, color: colors.muted } }, `${currentAuthorizationPage} / ${authorizationPageCount}`),
            React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: currentAuthorizationPage >= authorizationPageCount, onClick: () => setAuthorizationPage((page) => Math.min(authorizationPageCount, page + 1)) }, '下一页')))
      ), authorizationDetail)
      const archivedTasks = (data?.tasks || []).filter(task => task.legacyReadonly || task.archivedAt).sort((left, right) => String(right.updatedAt || right.archivedAt).localeCompare(String(left.updatedAt || left.archivedAt)))
      const historyPageCount = Math.max(1, Math.ceil(archivedTasks.length / 20)), currentHistoryPage = Math.min(historyPage, historyPageCount)
      const archivePage = React.createElement('section', { style: { display: 'grid', gap: 16 } },
        React.createElement('p', { role: 'status', style: { margin: 0, color: colors.muted } }, '历史任务只读。旧流程、参数和执行操作已停止。'),
        React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', gap: 12 } }, ...archivedTasks.slice((currentHistoryPage - 1) * 20, currentHistoryPage * 20).map(renderTaskCard)),
        !archivedTasks.length ? emptyState('暂无历史任务') : null,
        React.createElement('div', { style: { display: 'flex', gap: 12, alignItems: 'center' } }, React.createElement('span', { style: { marginRight: 'auto' } }, `${archivedTasks.length} 条 · ${currentHistoryPage}/${historyPageCount}`), React.createElement(Button, { type: 'button', variant: 'outline', disabled: currentHistoryPage <= 1, onClick: () => setHistoryPage(value => value - 1) }, '上一页'), React.createElement(Button, { type: 'button', variant: 'outline', disabled: currentHistoryPage >= historyPageCount, onClick: () => setHistoryPage(value => value + 1) }, '下一页')))
      const alertsPage = React.createElement(React.Fragment, null,
        React.createElement('section', null, React.createElement('div', { style: tableFrame },
          React.createElement('div', { style: toolbar },
            React.createElement('div', { role: 'tablist', 'aria-label': '告警状态视图', style: { display: 'flex', alignSelf: 'stretch', gap: 20 } }, ...[{ id: 'active', label: `当前异常 · ${filteredActiveAlerts.length}` }, { id: 'resolved', label: `恢复历史 · ${filteredResolvedAlerts.length}` }].map((item) => React.createElement('button', { key: item.id, role: 'tab', 'aria-selected': alertView === item.id, type: 'button', onClick: () => setAlertView(item.id), style: navigationTabStyle(alertView === item.id, { paddingBottom: 4 }) }, item.label))),
            React.createElement(SelectMenu, { label: '筛选告警类型', value: alertType, options: alertCategories.map((category) => ({ id: category.id, label: category.label })), onChange: (value) => { setAlertType(value); setResolvedAlertPage(1) }, fitContent: true })),
          React.createElement('div', { style: { padding: '0 16px' } }, ...(alertView === 'active' ? (filteredActiveAlerts.length ? filteredActiveAlerts.map(renderAlert) : [React.createElement('div', { key: 'empty', style: { padding: '36px 0', textAlign: 'center', color: colors.muted, fontSize: 12 } }, '当前没有此类型异常')]) : (visibleResolvedAlerts.length ? visibleResolvedAlerts.map(renderAlert) : [React.createElement('div', { key: 'empty', style: { padding: '36px 0', textAlign: 'center', color: colors.muted, fontSize: 12 } }, '暂无此类型恢复记录')]))),
          alertView === 'resolved' ? React.createElement('div', { style: tableFooter }, React.createElement('span', { style: { marginRight: 'auto', fontSize: 11, color: colors.muted } }, `${filteredResolvedAlerts.length} 条 · 每页 ${resolvedAlertPageSize} 条`), React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: currentResolvedAlertPage <= 1, onClick: () => setResolvedAlertPage((page) => Math.max(1, page - 1)) }, '上一页'), React.createElement('span', { style: { fontSize: 11, color: colors.muted } }, `${currentResolvedAlertPage} / ${resolvedAlertPageCount}`), React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: currentResolvedAlertPage >= resolvedAlertPageCount, onClick: () => setResolvedAlertPage((page) => Math.min(resolvedAlertPageCount, page + 1)) }, '下一页')) : null))
      )
      const topicsPage = React.createElement(TopicBrowser, { groups: data?.groups || [], tasks: data?.tasks || [], target: topicTarget, updatedAt, onOpenTask: openTask, onOpenSession: navigate })
      const pageContent = activePage === 'topics' ? topicsPage : activePage === 'tasks' ? tasksPage : activePage === 'authorizations' ? authorizationsPage : activePage === 'archive' ? archivePage : activePage === 'alerts' ? alertsPage : groupsPage
      const pageViewport = React.createElement('div', { style: { width: '100%', maxWidth: 1320, minHeight: 400, boxSizing: 'border-box', margin: '0 auto' } }, pageContent)
      const main = React.createElement('main', { className: 'observer-main', style: { width: '100%', minHeight: 'calc(100dvh - 90px)', boxSizing: 'border-box', padding: activePage === 'tasks' ? `${ui.space6}px ${ui.space6}px 0` : `${ui.space6}px ${ui.space6}px ${ui.space6 + ui.space2}px`, display: 'grid', alignContent: 'start', gap: ui.space6, pointerEvents: 'auto' } },
        error ? React.createElement('div', { style: { ...card, borderColor: colors.danger, color: colors.danger } }, `无法连接 resident 插件：${error}`) : null,
        navigationError ? React.createElement('div', { role: 'alert', style: { ...card, borderColor: colors.danger, color: colors.danger } }, `操作失败：${navigationError}`) : null,
        pageViewport
      )
      return React.createElement('div', { 'data-dingtalk-observer': '', style: { width: '100%', height: '100%', minWidth: 0, minHeight: 0, background: colors.surface, color: 'inherit', overflow: 'auto' } }, React.createElement('style', null, observerCss), header, main)
    }
    function apply(ctx) {
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'dingtalk-dsh-observer-entry', order: 5, inject: () => ({ onOpen: () => { ctx.layout.selectPanel(null); setOpen(true) } }) }, SidebarAction))
      ctx.slots.inject('main.conversation', () => {
        let disposeContent
        const syncContent = (visible) => {
          if (visible && !disposeContent) {
            disposeContent = ctx.slots.register({ name: 'main.conversation', priority: -10, inject: () => ({ openSession: async (sessionId, parentSessionId) => {
              if (parentSessionId) {
                let address = ctx.sessions.subagentAddress(sessionId)
                if (!address) { await ctx.sessions.refreshProjections(parentSessionId); address = ctx.sessions.subagentAddress(sessionId) }
                if (address) { ctx.uiWorkspace.openSession(address); return }
              }
              await ctx.sessions.refresh()
              ctx.uiWorkspace.openSession(sessionId)
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
    module.exports = { name: 'dingtalk-dsh-observer-client', inject: ['slots', 'sessions', 'uiWorkspace', 'layout'], apply }
    return module.exports
  }
})
