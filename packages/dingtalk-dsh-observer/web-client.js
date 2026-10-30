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
    let sessionNavigationVersion = 0
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
      sessionNavigationVersion++
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
      const reason = message.deliveryPendingReason
      const notificationState = message.notificationState || message.notificationStatus
      const historical = !notificationState
      const cancellationReasons = {
        'task-notification-task-terminal': '关联任务已结束，已取消这条通知；本次未发送',
        'task-notification-superseded': '这条通知已被替代；本次未发送',
        'task-notification-coordination-source-resolved': '后续消息已补充或订正原安排，已取消旧回复；本次未发送',
        'task-notification-coordination-schedule-changed': '提醒时间或安排已调整，已取消旧确认；本次未发送',
        'task-notification-coordination-facts-changed': '安排已有更新，已取消过时通知；本次未发送',
        'task-notification-coordination-cancelled': '相关安排已取消或不再适用，已取消这条通知；本次未发送',
        'task-notification-stale-question': '原问题已失效，已取消这条通知；本次未发送',
      }
      const reassessment = reason === 'task-notification-confirmation-reassessment-required'
      const knownNotSent = message.notificationKnownNotSent === true
      // 取消必须有未发送证明；替代关系、旧错误和撤回记录不能覆盖当前发送事实。
      const cancelled = knownNotSent && (notificationState === 'superseded' || cancellationReasons[reason]) && !reassessment
      // 旧字段仅适配历史事实，不推断仍会派发、重试或撤回。
      const legacy = () => {
        if (message.deliveredMessageId) return 'confirmed'
        if (message.status === 'sent') return 'unverified'
        if (['postflight_history_partial', 'postflight_failed', 'message_not_observed'].includes(reason)) return 'waiting'
        if (['task-notification-unknown', 'delivery_unknown', 'send_unknown'].includes(reason)) return message.notificationFailurePhase === 'readback' ? 'waiting' : 'checking'
        if (knownNotSent && (message.status === 'superseded' || cancellationReasons[reason]) && !reassessment) return 'cancelled'
        if (reassessment) return 'failed'
        if (message.status === 'superseded') return 'checking'
        if (reason === 'task-notification-prepared') return 'queued'
        if (reason === 'task-notification-starting') return 'sending'
        if (cancellationReasons[reason] || message.deliveryBlockedAt || message.deliveryError || ['preflight_failed', 'preflight_history_partial', 'send_failed', 'task-notification-failed', 'task-notification-pre-send-rejected'].includes(reason)) return 'failed'
        return 'checking'
      }
      const current = { prepared: 'queued', starting: 'sending', sending: 'sending', acknowledged: 'waiting',
        unknown: message.notificationFailurePhase === 'readback' ? 'waiting' : 'checking', delivered: 'confirmed',
        superseded: reassessment ? 'failed' : cancelled ? 'cancelled' : 'checking', failed: cancelled ? 'cancelled' : 'failed' }
      const legacyDelivered = !message.notificationState && notificationState === 'superseded' && message.deliveredMessageId
      const phaseId = historical ? legacy() : legacyDelivered ? 'confirmed' : current[notificationState] || 'checking'
      const id = ['waiting', 'checking', 'unverified'].includes(phaseId) ? 'confirmation' : phaseId
      const states = {
        queued: ['待发送', 'ongoing', '通知已准备，等待发送'],
        sending: ['发送中', 'ongoing', '正在执行发送，尚未确认送达'],
        waiting: ['待回读', 'warning', '发送后回读尚未确认送达'],
        checking: ['待核对', 'warning', '发送结果未知，等待核验'],
        confirmed: ['已送达', 'done', '回读已确认送达'],
        failed: ['投递异常', 'error', '需核验投递原因'],
        cancelled: ['已取消', 'neutral', '已取消这条通知，本次未发送；不代表撤回已发消息'],
        unverified: ['已发送', 'warning', '历史发送记录，缺少回读消息 ID'],
      }
      const [phaseLabel, state, hint] = states[phaseId]
      const label = ({ confirmation: '待确认', failed: '异常' })[id] || phaseLabel
      const reasons = {
        'task-notification-confirmation-reassessment-required': ['verification', '旧确认意图关联不足，需人工核验；不会自动恢复或发送'],
        'task-notification-pre-send-rejected': ['pre-send', '发送前检查已拒绝，本次未发送'],
        preflight_history_partial: ['pre-send', '历史发送前检查：消息不完整，本次未发送'],
        preflight_failed: ['pre-send', '历史发送前检查失败，本次未发送'],
        postflight_history_partial: ['readback', '历史发送后回读：消息不完整'],
        postflight_failed: ['readback', '历史发送后回读失败'],
        message_not_observed: ['readback', '已调用发送，回读尚未找到对应消息'],
      }
      let [reasonId, detail] = ((historical || ['failed', 'superseded'].includes(notificationState)) && reasons[reason]) || (phaseId === 'waiting' ? ['readback', hint] : phaseId === 'checking' ? ['verification', hint]
        : phaseId === 'unverified' ? ['history', hint] : id === 'failed' ? ['failure', knownNotSent ? '已确认本次未发送' : '尚未确认送达，需核验失败原因'] : ['none', ''])
      if (phaseId === 'cancelled') { reasonId = 'cancelled'; detail = cancellationReasons[reason] || hint }
      else if (!historical && !Object.hasOwn(current, notificationState)) { reasonId = 'verification'; detail = '通知状态暂无法识别，需人工核验' }
      else if (!historical && ['checking', 'waiting'].includes(phaseId)) { reasonId = phaseId === 'waiting' ? 'readback' : 'verification'; detail = hint }
      if (phaseId === 'checking' && (notificationState === 'superseded' || historical && message.status === 'superseded')) detail = '这条通知的发送意图已停止，历史送达情况仍需核验'
      if (id === 'confirmed') { reasonId = 'none'; detail = '' }
      const recallId = ({ requested: 'requested', recalled: 'recalled', failed: 'failed' })[message.recallStatus] || 'none'
      const recall = { id: recallId, label: ({ requested: '已申请', recalled: '已撤回', failed: '撤回受阻', none: '无记录' })[recallId],
        detail: recallId === 'failed' ? message.recallError === 'replacement_delivery_unknown' ? '历史送达证据不足，撤回结果需核验' : '撤回未完成，需核验原因' : '' }
      return { id, label, state, hint, detail, reasonId, phaseId, historical, recall, replacementId: message.supersededByOutboundId,
        retryDisabled: historical || reassessment || notificationState === 'superseded' || phaseId === 'cancelled' || !Object.hasOwn(current, notificationState) }
    }
    const ui = { textSm: 12, textMd: 14, textLg: 16, textXl: 20, space1: 4, space2: 8, space3: 12, space4: 16, space6: 24, radiusSm: 8, radiusMd: 12 }
    const observerCss = `
      @media (forced-colors: active) {
      }
      @media (max-width: 720px) {
      }
      .observer-human-modal { box-sizing: border-box; width: min(1040px, calc(100vw - 48px)); height: min(900px, calc(100dvh - 48px)); max-width: none; max-height: none; margin: auto; padding: 0; border: 1px solid ${colors.border}; border-radius: 12px; background: ${colors.surface}; color: inherit; box-shadow: 0 24px 80px rgba(0,0,0,.22); overflow: hidden; }
      .observer-human-modal[open] { display: flex; flex-direction: column; }
      .observer-human-modal::backdrop { background: rgba(0,0,0,.28); backdrop-filter: blur(2px); }
      .observer-human-modal > header { max-height: 30%; overflow-y: auto; }
      .observer-human-modal > form, .observer-human-modal > p { flex: 0 0 auto; margin: 0; padding: 16px 24px; border-top: 1px solid ${colors.border}; background: ${colors.surface2}; }
      .observer-human-modal > form { gap: 8px !important; max-height: 45%; overflow-y: auto; }
      .observer-human-modal textarea { min-height: 64px; height: 80px; resize: none; }
      .observer-human-modal form > button { min-width: 120px; }
      .observer-human-modal form :is([role=alert], [role=status]) { grid-area: feedback; }
      .observer-human-modal form { grid-template-areas: 'hint' 'field' 'feedback' 'action'; grid-template-rows: auto auto minmax(42px, auto) auto; }
      .observer-human-modal form > p:first-child { grid-area: hint; }
      .observer-human-modal form > label { grid-area: field; }
      .observer-human-modal form > button { grid-area: action; }
      @media (max-width: 600px) { .observer-human-modal { width: calc(100vw - 16px); height: calc(100dvh - 16px); border-radius: 8px; } .observer-human-modal > header { padding: 16px !important; gap: 12px !important; } .observer-human-modal > div { padding: 0 16px 16px !important; } .observer-human-modal > form, .observer-human-modal > p { padding: 12px 16px; } }

      [data-dingtalk-observer] .observer-card-sessions summary::-webkit-details-marker { display: none; }
      [data-dingtalk-observer] .observer-card-sessions:not([open]) .observer-card-session-chevron { transform: rotate(-90deg); }
      [data-dingtalk-observer] .observer-card-sessions summary:focus-visible { outline: 2px solid ${colors.accent}; outline-offset: 2px; border-radius: 4px; }
      [data-dingtalk-observer] .observer-card-sessions meter { appearance: none; border: 0; border-radius: 3px; background: ${colors.border}; }
      [data-dingtalk-observer] .observer-card-sessions meter::-webkit-meter-bar { height: 5px; border: 0; border-radius: 3px; background: ${colors.border}; }
      [data-dingtalk-observer] .observer-card-sessions meter::-webkit-meter-optimum-value { background: ${colors.accent}; border-radius: 3px; }
      [data-dingtalk-observer] .observer-card-sessions meter::-moz-meter-bar { background: ${colors.accent}; border-radius: 3px; }
      [data-dingtalk-observer] .observer-execution-session:hover:enabled { background: ${colors.surface2} !important; }
      [data-dingtalk-observer] .observer-execution-session:focus-visible { outline: 2px solid ${colors.accent}; outline-offset: 2px; }
      [data-dingtalk-observer] .observer-execution-session:active:enabled { opacity: .8; }

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
        /* The topic picker owns this scroll; the selected overview stays in document flow. */
        [data-dingtalk-observer] .observer-topic-list { box-sizing: border-box; max-height: 360px; overflow-y: auto !important; scrollbar-gutter: stable; }
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
      const response = await fetch(`${ENDPOINT}${path}`, { method: 'GET', headers: { accept: 'application/json' }, signal:typeof AbortSignal!=='undefined'&&AbortSignal.timeout?(signal&&AbortSignal.any?AbortSignal.any([signal,AbortSignal.timeout(15000)]):signal||AbortSignal.timeout(15000)):signal })
      const value = await response.json()
      if (!response.ok) throw Object.assign(new Error(value.error || `HTTP ${response.status}`), { status: response.status })
      return value
    }
    async function post(path, body = {}) {
      const response = await fetch(`${ENDPOINT}${path}`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const value = await response.json()
      if (!response.ok) throw Object.assign(new Error(value.error || `HTTP ${response.status}`), { status: response.status })
      return value
    }
    async function load({ activePage='groups',signal,taskPages = {}, historyPage = 1, revisions = {}, selectedGroupId='', messagePage=1,outboxPage=1,messageDeliveryFilter='all',outboxStatusFilter='all',authorizationPage=1,authorizationFilter='all',alertType='all',resolvedAlertPage=1 } = {}) {
      const empty=()=>({items:[],total:0,offset:0,limit:10}), read=path=>get(path,{signal})
      const [health, groups, taskCollections, alertPages, authorizationCollection, topicPage] = await Promise.all([
        read('/health'), read('/state/groups?summary=true'),
        Promise.all([...taskBuckets.map(bucket => activePage==='tasks' ? read(`/state/tasks?state=${bucket.state}&offset=${((taskPages[bucket.state] || 1) - 1) * 10}&limit=10${revisions[bucket.state] ? `&revision=${encodeURIComponent(revisions[bucket.state])}` : ''}`) : empty()), activePage==='archive' ? read(`/state/tasks?archived=true&offset=${(historyPage - 1) * 20}&limit=20${revisions.archive ? `&revision=${encodeURIComponent(revisions.archive)}` : ''}`) : empty()]),
        Promise.all(['active','resolved'].map(view=>activePage==='alerts'?read(`/state/supervisor/alerts?view=${view}&type=${alertType}&offset=${(resolvedAlertPage-1)*10}&limit=10`):empty())),
        activePage==='authorizations'?read(`/state/authorizations?offset=${(authorizationPage-1)*10}&limit=10&filter=${authorizationFilter}${revisions.authorizations?`&pageRevision=${encodeURIComponent(revisions.authorizations)}`:''}`):empty(),
        {topics:[]}
      ])
      const groupId=groups.some(group=>group.groupId===selectedGroupId)?selectedGroupId:groups[0]?.groupId
      const groupCollections=activePage==='groups'&&groupId?await Promise.all(['messages','outbox'].map(collection=>{
        const page=collection==='messages'?messagePage:outboxPage,filter=collection==='messages'?messageDeliveryFilter:outboxStatusFilter
        return read(`/state/groups/${encodeURIComponent(groupId)}/${collection}?offset=${(page-1)*10}&limit=10&filter=${encodeURIComponent(filter)}${revisions[collection]?`&pageRevision=${encodeURIComponent(revisions[collection])}`:''}`).then(value=>({...value,groupId,filter}))
      })):[]
      return { health, groups, groupCollections:Object.fromEntries(groupCollections.map((value,i)=>[['messages','outbox'][i],value])), tasks: taskCollections.flatMap(page => page.items), taskCollections: Object.fromEntries(taskBuckets.map((bucket,index) => [bucket.state,taskCollections[index]])), archiveCollection: taskCollections.at(-1), alerts:alertPages.flatMap(page=>page.items),alertCollections:Object.fromEntries(alertPages.map((page,i)=>[['active','resolved'][i],page])),authorizations:authorizationCollection.items,authorizationCollection:{...authorizationCollection,filter:authorizationFilter},topics: topicPage.topics }
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
    const pages = [{ id: 'groups', label: '群消息' }, { id: 'topics', label: '话题' }, { id: 'tasks', label: '任务看板' }, { id: 'authorizations', label: '人工介入' }, { id: 'archive', label: '历史任务' }, { id: 'alerts', label: '告警' }]
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
    const messageProcessingElapsed = (message) => {
      const parse = value => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && value.trim() ? Date.parse(value) : NaN
      const duration = parse(message.processingCompletedAt) - parse(message.processingSentAt)
      if (!Number.isFinite(duration)) return '历时未记录'
      if (duration < 0) return '历时异常（时钟逆序）'
      const seconds = duration / 1000
      const value = seconds < 1 ? `${Math.round(duration)} 毫秒` : seconds < 60 ? `${seconds.toFixed(1)} 秒`
        : seconds < 3600 ? `${Math.floor(seconds / 60)} 分 ${Math.floor(seconds % 60)} 秒`
          : `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分 ${Math.floor(seconds % 60)} 秒`
      return `历时 ${value}`
    }
    function MessageRecovery({ path, body, token, readback = false, onChanged }) {
      const flight = useRef(false)
      const consumed = useRef(null)
      const [busy, setBusy] = useState(false)
      const [feedback, setFeedback] = useState(null)
      const retry = async () => {
        if (flight.current || consumed.current === token) return
        flight.current = true; setBusy(true); setFeedback(null)
        try {
          const result = await post(path, body)
          consumed.current = token
          setFeedback(result.sourcePending ? '原来源尚未收束，继续等待；本次未发送。' : readback ? '已尝试原生回读；未确认送达前不会重发。' : '已请求按原身份恢复；不代表处理完成或送达。')
        } catch (cause) {
          const code = cause instanceof Error ? cause.message : ''
          setFeedback(/STALE|IN_PROGRESS/.test(code) ? '状态已变化或正在恢复，请刷新后核对。'
            : '本次未能恢复；请先解决网络、鉴权或业务阻塞，再刷新后重试。未知效果不会重放。')
        } finally {
          await onChanged()
          flight.current = false; setBusy(false)
        }
      }
      return React.createElement('div', { style: { marginTop: 6, fontSize: 11, overflowWrap: 'anywhere' } },
        React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: busy || consumed.current === token,
          onClick: retry }, busy ? '恢复中…' : readback ? '核验发送结果' : '重试原消息'),
        React.createElement('div', { style: { marginTop: 3, color: colors.muted } }, readback ? '仅回读，不重新发送。'
          : '先解除网络、鉴权或其他阻塞；仅恢复原请求，不重做已完成效果。'),
        feedback ? React.createElement('div', { role: 'status', style: { marginTop: 3 } }, feedback) : null)
    }
    const messageFailureHint = (code) => code === 'DYNAMIC_TASK_NOT_ACTIVE'
      ? '关联任务已暂停或取消，补充尚未应用；恢复原任务后按当前版本重新判断。'
      : code === 'DYNAMIC_OPERATION_UNRESOLVED' ? '原操作效果未知，需先核实；不得重放该操作。'
        : '消息处理未完成，请核对原错误后恢复；已完成的动作不会重做。'
    const traceReason = (reason) => {
      if (!reason) return null
      const text = typeof reason === 'string' ? reason : JSON.stringify(reason)
      if (['DYNAMIC_TASK_NOT_ACTIVE', 'DYNAMIC_OPERATION_UNRESOLVED'].includes(text)) return messageFailureHint(text)
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
      const [unitCursor,setUnitCursor]=useState('')
      const [unitCursorHistory,setUnitCursorHistory]=useState([])
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
        const params=new URLSearchParams()
        if(cursor)params.set('cursor',cursor)
        if(unitCursor)params.set('unitCursor',unitCursor)
        if(page?.runId===runId&&page?.pageRevision&&(unitCursor||cursor&&page?.offset!==Number(cursor)))params.set('pageRevision',page.pageRevision)
        get(`/state/workflows/${encodeURIComponent(runId)}/trace?${params}`).then((value) => { if (active) setPage(value) }, (cause) => { if(active){setError(cause.message);if(cause.status===409){setCursor('');setCursorHistory([]);setUnitCursor('');setUnitCursorHistory([]);setPage(undefined)}} }).finally(() => { if (active) setLoading(false) })
        return () => { active = false }
      }, [runId, cursor, unitCursor, retry])
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
                !message.current ? React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', onClick: () => { setPage(undefined); setCursor(''); setCursorHistory([]); setUnitCursor('');setUnitCursorHistory([]);setRunId(message.runId) } }, '查看这条消息的过程') : null))),
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
        ready&&page.coordinatorUnits ? React.createElement('nav', { 'aria-label':'协调单元分页', style:{display:'flex',gap:8,flexWrap:'wrap'} },
          React.createElement('span', {role:'status'}, `有效协调单元共 ${page.coordinatorUnits.total} 个，本批 ${page.coordinatorUnits.returned} 个${page.coordinatorUnits.nextCursor!==null?'，还有后续记录':'，已到最后一批'}`),
          unitCursorHistory.length ? React.createElement(Button,{type:'button',variant:'outline',size:'sm',disabled:loading,onClick:()=>{setUnitCursor(unitCursorHistory.at(-1));setUnitCursorHistory(items=>items.slice(0,-1))}},'上一批协调单元'):null,
          page.coordinatorUnits.nextCursor!==null ? React.createElement(Button,{type:'button',variant:'outline',size:'sm',disabled:loading,onClick:()=>{setUnitCursorHistory(items=>[...items,unitCursor]);setUnitCursor(String(page.coordinatorUnits.nextCursor))}},'下一批协调单元'):null):null,
        ready ? React.createElement('span', { style: { color: colors.muted, fontSize: 12 } }, `本页 ${page.items?.length ?? 0} 条${Number.isFinite(page.total) ? `，共 ${page.total} 条处理记录` : ''}；按记录时间排列，多事项可能分别判断。`) : null,
        ready ? React.createElement('p', { style: { color: colors.muted, fontSize: 12, margin: 0 } }, '耗时按本次开始到完成计算，包含工具等待；重试显示最近一次处理，不代表纯模型耗时。进行中记录可刷新查看最新状态。') : null,
        React.createElement('div', { style: { display: 'flex', gap: 8 } }, cursorHistory.length ? React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: loading, onClick: () => { setUnitCursor('');setUnitCursorHistory([]);setCursor(cursorHistory.at(-1)); setCursorHistory((items) => items.slice(0, -1)) } }, '上一页') : null, page?.nextCursor ? React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: loading, onClick: () => { setUnitCursor('');setUnitCursorHistory([]);setCursorHistory((items) => [...items, cursor]); setCursor(page.nextCursor) } }, '下一页') : null))
    }
    function FixedTopicDetail({ topicId, title, groupId, updatedAt }) {
      const [offset, setOffset] = useState(0), [page, setPage] = useState(), [loading, setLoading] = useState(true)
      const [error, setError] = useState(''), [retry, setRetry] = useState(0), snapshot = useRef()
      const limit = 25
      const read = useTopicRequest(`${groupId}:${topicId}:${offset}`)
      useEffect(() => {
        let active = true
        const params = new URLSearchParams({ offset: String(offset), limit: String(limit) })
        if (groupId) params.set('groupId', groupId)
        if (offset && snapshot.current?.offset !== offset && snapshot.current?.revision) params.set('pageRevision', snapshot.current.revision)
        setLoading(true); setError('')
        read(`/state/fixed-topics/${encodeURIComponent(topicId)}?${params}`).then(value => {
          if (!active) return
          snapshot.current = value; setPage(value)
          if (offset && offset >= value.total) setOffset(Math.max(0, Math.floor((value.total - 1) / limit) * limit))
        }, cause => {
          if (!active) return
          if (cause.status === 409) { snapshot.current = undefined; setPage(undefined); setOffset(0); setRetry(value => value + 1) }
          else setError(cause.message)
        }).finally(() => { if (active) setLoading(false) })
        return () => { active = false }
      }, [topicId, groupId, offset, retry, updatedAt])
      const ready = page?.offset === offset
      return React.createElement('section', { className: 'observer-topic-detail', 'aria-label': '固定话题详情', 'aria-busy': loading, style: { ...tableFrame, flex: '2 1 560px', width: '100%', minWidth: 0 } },
        React.createElement('header', { style: { padding: '17px 18px 15px', borderBottom: `1px solid ${colors.border}` } },
          React.createElement('h2', { style: { margin: 0, fontSize: 18, overflowWrap: 'anywhere' } }, title),
          React.createElement('p', { style: { margin: '8px 0 0', color: colors.muted, fontSize: ui.textSm } }, `${groupId ? '当前群聊' : '全部群聊'}的分类消息与处理记录`)),
        error ? React.createElement('div', { role: 'alert', style: { padding: 16, color: colors.danger } }, `记录加载失败：${error} `, React.createElement(Button, { type: 'button', variant: 'outline', size: 'sm', onClick: () => setRetry(value => value + 1) }, '重试')) : null,
        React.createElement('div', { style: { padding: '0 18px' } }, React.createElement(TopicPageStatus, { loading, hasContent: ready })),
        ready ? React.createElement('div', { style: { padding: '0 18px', overflowWrap: 'anywhere' } }, page.items.length ? page.items.map(item => {
          const fixedDelivery = item.reply ? outboxDelivery(item.reply) : null
          const state = item.manualCorrection && item.state === 'silent' ? '人工归类纠正 · 保持沉默' : ({ pending: '待处理', failed: '消息处理异常', silent: '已处理 · 保持沉默', replied: '已处理 · 回复已准备', superseded: '已被后续归类替代' })[item.state] || '处理状态未记录'
          return React.createElement('article', { key: item.id, style: { padding: '16px 0', borderBottom: `1px solid ${colors.border}` } },
            React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, color: colors.muted, fontSize: ui.textSm } }, React.createElement('strong', null, item.senderName || '未知发送人'), !groupId ? React.createElement('span', null, item.groupName || item.groupId) : null, React.createElement('time', null, fmt(item.occurredAt))),
            React.createElement('p', { style: { whiteSpace: 'pre-wrap', lineHeight: 1.7 } }, item.sourceText || item.summary),
            React.createElement('details', null, React.createElement('summary', { style: { cursor: 'pointer', fontSize: ui.textSm } }, '查看来源消息'), React.createElement('p', { style: { whiteSpace: 'pre-wrap', lineHeight: 1.7 } }, item.text || '（空消息）')),
            React.createElement('p', { style: { fontSize: ui.textSm, color: item.state === 'failed' ? colors.danger : colors.muted } }, state, item.handledAt ? ` · ${fmt(item.handledAt)}` : ''),
            item.error ? React.createElement('p', { style: { color: colors.danger, whiteSpace: 'pre-wrap' } }, item.error) : null,
            item.manualCorrection ? React.createElement('p', { style: { color: colors.muted, whiteSpace: 'pre-wrap' } }, item.manualCorrection.reason) : null,
            item.reply ? React.createElement('section', { 'aria-label': '固定话题回复', style: { padding: 12, borderRadius: ui.radiusSm, background: colors.surface2 } },
              React.createElement('strong', { style: { fontSize: ui.textSm } }, `回复 · ${fixedDelivery.label}`),
              React.createElement('p', { style: { whiteSpace: 'pre-wrap', lineHeight: 1.7 } }, item.reply.text),
              fixedDelivery.detail ? React.createElement('p', { style: { color: colors.muted, fontSize: ui.textSm } }, fixedDelivery.detail) : null) : null)
        }) : emptyState('暂无分类消息', { detail: '收到属于此类别的消息后，会在这里显示处理记录。' })) : null,
        page ? React.createElement('nav', { 'aria-label': '固定话题记录分页', style: { ...tableFooter, flexWrap: 'wrap' } },
          React.createElement('span', { style: { marginRight: 'auto', color: colors.muted, fontSize: ui.textSm } }, `${page.total} 条事项 · 第 ${Math.floor(offset / limit) + 1} 页`),
          React.createElement(Button, { type: 'button', variant: 'outline', size: 'sm', disabled: loading || offset === 0, onClick: () => setOffset(value => Math.max(0, value - limit)) }, '上一页'),
          React.createElement(Button, { type: 'button', variant: 'outline', size: 'sm', disabled: loading || !ready || page.nextOffset === null, onClick: () => setOffset(page.nextOffset) }, '下一页')) : null)
    }
    // Reuse an unfinished read across polling ticks, just like CardExecutionPage.
    // Changing the query identity or unmounting still cancels it immediately.
    function useTopicRequest(key) {
      const pending = useRef()
      useEffect(() => () => { pending.current?.controller.abort(); pending.current = undefined }, [key])
      return path => {
        if (pending.current?.path !== path) {
          pending.current?.controller.abort()
          const controller = new AbortController(), request = { path, controller, promise: get(path, { signal: controller.signal }) }
          pending.current = request
          request.promise.finally(() => { if (pending.current === request) pending.current = undefined }).catch(() => {})
        }
        return pending.current.promise
      }
    }
    function TopicPageStatus({ loading, error, hasContent, onRetry }) {
      return React.createElement('div', { style: { minHeight: 32, display: 'flex', alignItems: 'center', gap: 8, fontSize: ui.textSm, color: error ? colors.danger : colors.muted } },
        error ? React.createElement(React.Fragment, null, React.createElement('span', { role: 'alert' }, `读取失败：${error}`),
          React.createElement(Button, { type: 'button', variant: 'ghost', size: 'sm', onClick: onRetry }, '重试'))
          : React.createElement('span', { role: 'status' }, loading ? hasContent ? '正在更新…' : '正在读取…' : ''))
    }
    function TopicPager({ page, loading, onChange, label }) {
      return page ? React.createElement('nav', { 'aria-label': label, style: { ...tableFooter, flexWrap: 'wrap', gap: 8 } },
        React.createElement('span', { style: { marginRight: 'auto', color: colors.muted, fontSize: ui.textSm } }, `${page.total} 条 · 第 ${Math.floor(page.offset / page.limit) + 1} 页`),
        React.createElement(Button, { type: 'button', variant: 'outline', size: 'sm', disabled: loading || page.offset === 0, onClick: () => onChange(Math.max(0, page.offset - page.limit)) }, '上一页'),
        React.createElement(Button, { type: 'button', variant: 'outline', size: 'sm', disabled: loading || page.nextOffset === null, onClick: () => onChange(page.nextOffset) }, '下一页')) : null
    }
    function TopicListItem({ title, summary, updatedAt, selected, onSelect }) {
      return React.createElement('li', { style: { borderBottom: `1px solid ${colors.border}` } }, React.createElement('button', { type: 'button', 'aria-pressed': selected, 'aria-label': title, onClick: onSelect, style: { position: 'relative', width: '100%', minWidth: 0, border: 0, borderLeft: `3px solid ${selected ? colors.accent : 'transparent'}`, padding: `${ui.space3}px ${ui.space4}px`, background: selected ? `color-mix(in srgb, ${colors.accent} 8%, ${colors.cardSurface})` : colors.cardSurface, color: 'inherit', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', outlineOffset: -2 } },
        React.createElement('strong', { title, style: { display: 'block', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: ui.textMd, fontWeight: 600, lineHeight: 1.5 } }, title),
        summary ? React.createElement('p', { style: { margin: `${ui.space1}px 0 0`, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', color: colors.muted, fontSize: ui.textSm, lineHeight: 1.6 } }, summary) : null,
        updatedAt ? React.createElement('time', { dateTime: updatedAt, style: { display: 'block', marginTop: 6, fontSize: ui.textSm, color: colors.muted, fontVariantNumeric: 'tabular-nums' } }, fmt(updatedAt)) : null))
    }
    function TopicRelatedTasks({ selection, updatedAt, onOpenTask }) {
      const [offset, setOffset] = useState(0), [page, setPage] = useState(), [loading, setLoading] = useState(true)
      const [error, setError] = useState(''), [retry, setRetry] = useState(0), snapshot = useRef()
      const read = useTopicRequest(`${selection.groupId}:${selection.topicId}:${offset}`)
      useEffect(() => {
        let active = true
        const params = new URLSearchParams({ groupId: selection.groupId, topicId: selection.topicId, archived: 'all', view: 'summary', offset: String(offset), limit: '10' })
        if (offset && snapshot.current?.offset !== offset && snapshot.current?.revision) params.set('revision', snapshot.current.revision)
        setLoading(true); setError('')
        read(`/state/tasks?${params}`).then(value => {
          if (!active) return
          snapshot.current = value; setPage(value)
          if (offset && offset >= value.total) setOffset(Math.max(0, Math.floor((value.total - 1) / 10) * 10))
        }, cause => {
          if (!active) return
          if (cause.status === 409) { snapshot.current = undefined; setOffset(0); setRetry(value => value + 1) }
          else setError(cause.message)
        }).finally(() => { if (active) setLoading(false) })
        return () => { active = false }
      }, [selection.groupId, selection.topicId, offset, retry, updatedAt])
      return React.createElement('section', { 'aria-label': '关联任务', 'aria-busy': loading, style: { borderTop: `1px solid ${colors.border}`, paddingTop: ui.space4 } },
        React.createElement('h3', { style: { margin: 0, fontSize: ui.textMd } }, '关联任务', page ? React.createElement('span', { style: { marginLeft: 8, color: colors.muted, fontWeight: 400 } }, page.total) : null),
        React.createElement(TopicPageStatus, { loading, error, hasContent: !!page, onRetry: () => setRetry(value => value + 1) }),
        page?.items.length ? React.createElement('ul', { style: { listStyle: 'none', padding: 0, margin: 0 } }, ...page.items.map(task => React.createElement('li', { key: task.taskId },
          React.createElement('button', { type: 'button', onClick: () => onOpenTask(task), style: { width: '100%', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, padding: '12px 0', border: 0, borderBottom: `1px solid ${colors.border}`, background: 'transparent', color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer' } },
            React.createElement('span', { style: { minWidth: 0, overflowWrap: 'anywhere', fontSize: ui.textMd } }, task.title || '未命名任务'),
            React.createElement('span', { style: { flexShrink: 0, fontSize: ui.textSm, color: colors.muted } }, `${task.archivedAt ? '已归档 · ' : ''}${taskStateLabel(task.state)}`))))) : page && !loading ? React.createElement('p', { style: { color: colors.muted, fontSize: ui.textSm } }, '暂无关联任务') : null,
        page?.total > 10 ? React.createElement(TopicPager, { page, loading, onChange: setOffset, label: '关联任务分页' }) : null)
    }
    // Mounted only after an explicit disclosure. History has its own snapshot and
    // refresh action, so routine overview polling cannot restart historical reads.
    function TopicRecords({ selection, kind }) {
      const [offset, setOffset] = useState(0), [page, setPage] = useState(), [loading, setLoading] = useState(true)
      const [error, setError] = useState(''), [retry, setRetry] = useState(0), snapshot = useRef()
      const selectedRevision = useRef(selection.revision)
      const messages = kind === 'messages', limit = messages ? 25 : 10
      useEffect(() => {
        let active = true
        const controller = new AbortController()
        const params = new URLSearchParams({ groupId: selection.groupId, offset: String(offset), limit: String(limit) })
        if (messages && !offset && selectedRevision.current > 0) params.set('revision', String(selectedRevision.current))
        if (offset && snapshot.current) {
          if (messages && snapshot.current.revision !== undefined) params.set('revision', String(snapshot.current.revision))
          const version = messages ? snapshot.current.pageRevision : snapshot.current.revision
          if (version) params.set('pageRevision', version)
        }
        setLoading(true); setError('')
        get(`/state/topics/${encodeURIComponent(selection.topicId)}${messages ? '' : '/decisions'}?${params}`, { signal: controller.signal }).then(value => {
          if (!active) return
          const result = messages ? { ...value, items: value.messages, nextOffset: value.offset + value.messages.length < value.total ? value.offset + value.messages.length : null } : value
          snapshot.current = result; setPage(result)
          if (offset && offset >= result.total) setOffset(Math.max(0, Math.floor((result.total - 1) / limit) * limit))
        }, cause => {
          if (!active) return
          if (cause.status === 409) { snapshot.current = undefined; selectedRevision.current = undefined; setOffset(0); setRetry(value => value + 1) }
          else setError(cause.message)
        }).finally(() => { if (active) setLoading(false) })
        return () => { active = false; controller.abort() }
      }, [selection.groupId, selection.topicId, kind, offset, retry])
      return React.createElement('div', { 'aria-busy': loading, style: { minHeight: 120, paddingTop: ui.space2 } },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 } },
          React.createElement(TopicPageStatus, { loading, error, hasContent: !!page, onRetry: () => setRetry(value => value + 1) }),
          React.createElement(Button, { type: 'button', variant: 'ghost', size: 'sm', disabled: loading, onClick: () => { snapshot.current = undefined; selectedRevision.current = undefined; setOffset(0); setRetry(value => value + 1) } }, '刷新记录')),
        messages && page?.revision !== undefined ? React.createElement('p', { style: { color: colors.muted, fontSize: ui.textSm } }, `消息版本 ${page.revision}`) : null,
        page?.topic?.openQuestions?.length ? readout('待解决问题', page.topic.openQuestions) : null,
        page?.items.map((item, index) => React.createElement('article', { key: messages ? `${item.messageId}:${index}` : item.decisionId, style: { padding: '14px 0', borderBottom: `1px solid ${colors.border}`, overflowWrap: 'anywhere' } },
          React.createElement('div', { style: { fontSize: ui.textSm, color: colors.muted } },
            messages ? item.senderName || item.sourceKind || '未知发送人' : ({ completed: '已完成判断', accepted: '已接收', applying: '处理中', failed: '判断失败', blocked: '判断受阻', rejected: '已拒绝' })[item.status] || '状态未记录',
            ' · ', fmt(messages ? item.occurredAt : item.createdAt)),
          React.createElement('p', { style: { margin: '8px 0', whiteSpace: 'pre-wrap', lineHeight: 1.7, fontSize: ui.textMd } }, messages ? item.text || '（空消息）' : item.decision?.reason || item.decision?.reply || item.error || '未记录判断结论'),
          messages ? item.quotedMessage?.content ? readout('引用消息', item.quotedMessage.content) : null
            : readout('判断依据与执行记录', { 来源消息: item.decision?.basisMessageIds, 判断原文: item.decision, 执行记录: item.operations }))),
        page && !page.items.length && !loading ? React.createElement('p', { style: { color: colors.muted } }, messages ? '此版本没有消息记录' : '暂无判断记录') : null,
        React.createElement(TopicPager, { page, loading, onChange: setOffset, label: messages ? '消息记录分页' : '判断记录分页' }))
    }
    function TopicOverview({ selection, updatedAt, onOpenTask }) {
      const [topic, setTopic] = useState(), [loading, setLoading] = useState(true), [error, setError] = useState(''), [retry, setRetry] = useState(0)
      const [messagesOpen, setMessagesOpen] = useState(false), [decisionsOpen, setDecisionsOpen] = useState(false)
      const read = useTopicRequest(`${selection.groupId}:${selection.topicId}`)
      useEffect(() => {
        let active = true
        const params = new URLSearchParams({ groupId: selection.groupId, view: 'overview' })
        setLoading(true); setError('')
        read(`/state/topics/${encodeURIComponent(selection.topicId)}?${params}`).then(value => { if (active) setTopic(value.topic) },
          cause => { if (active) setError(cause.message) }).finally(() => { if (active) setLoading(false) })
        return () => { active = false }
      }, [selection.groupId, selection.topicId, updatedAt, retry])
      const disclosure = (label, open, setExpanded, kind) => React.createElement('details', { onToggle: event => setExpanded(event.currentTarget.open), style: { borderTop: `1px solid ${colors.border}`, padding: '16px 0' } },
        React.createElement('summary', { style: { cursor: 'pointer', fontSize: ui.textMd, fontWeight: 500 } }, label),
        open ? React.createElement(TopicRecords, { selection, kind }) : null)
      return React.createElement('section', { className: 'observer-topic-detail', 'aria-label': '话题详情', style: { ...tableFrame, width: '100%', minWidth: 0, minHeight: 300 } },
        React.createElement('header', { style: { padding: '18px 18px 0' } },
          React.createElement('h2', { style: { margin: 0, fontSize: 18, fontWeight: 600, lineHeight: 1.5, overflowWrap: 'anywhere' } }, topic?.title || selection.title || '话题详情'),
          React.createElement('div', { style: { minHeight: 28, marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: ui.textSm, color: colors.muted } },
            topic ? React.createElement('span', null, ({ active: '进行中', waiting: '等待中', closed: '已关闭' })[topic.status] || '状态未记录') : null,
            topic ? React.createElement('time', { dateTime: topic.updatedAt || undefined }, `更新于 ${fmt(topic.updatedAt)}`) : null,
            React.createElement(TopicPageStatus, { loading, error, hasContent: !!topic, onRetry: () => setRetry(value => value + 1) }))),
        React.createElement('div', { style: { padding: '0 18px 4px', minWidth: 0 } },
          React.createElement('section', { 'aria-label': '话题摘要', 'aria-busy': loading, style: { minHeight: 100, paddingBottom: 20 } },
            React.createElement('h3', { style: { margin: 0, fontSize: ui.textSm, color: colors.muted, fontWeight: 500 } }, '当前摘要'),
            topic ? React.createElement('p', { style: { margin: '8px 0 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: ui.textMd, lineHeight: 1.8 } }, topic.summary || '暂无摘要') : null),
          React.createElement(TopicRelatedTasks, { selection, updatedAt, onOpenTask }),
          disclosure('消息记录', messagesOpen, setMessagesOpen, 'messages'),
          topic?.engine !== 'workflow-v2' ? disclosure('判断记录', decisionsOpen, setDecisionsOpen, 'decisions') : null))
    }
    function TopicBrowser({ groups, target, updatedAt, onOpenTask }) {
      const [groupId, setGroupId] = useState(target?.groupId || ''), [selection, setSelection] = useState(target)
      const [offset, setOffset] = useState(0), [listing, setListing] = useState(), [loading, setLoading] = useState(true)
      const [listError, setListError] = useState(''), [retry, setRetry] = useState(0), snapshot = useRef()
      const [fixedTopics, setFixedTopics] = useState(), [fixedError, setFixedError] = useState('')
      const read = useTopicRequest(`${groupId}:${offset}`)
      useEffect(() => {
        let active = true
        const controller = new AbortController(), params = new URLSearchParams()
        if (groupId) params.set('groupId', groupId)
        setFixedError('')
        get(`/state/fixed-topics?${params}`, { signal: controller.signal }).then(value => { if (active) setFixedTopics(value.fixedTopics) },
          cause => { if (active) setFixedError(cause.message) })
        return () => { active = false; controller.abort() }
      }, [groupId, retry])
      useEffect(() => {
        if (!target?.topicId) return
        setGroupId(target.groupId || ''); setSelection(target); setOffset(0); snapshot.current = undefined; setListing(undefined)
      }, [target?.groupId, target?.topicId, target?.revision])
      useEffect(() => {
        let active = true
        const params = new URLSearchParams({ offset: String(offset), limit: '10', view: 'overview' })
        if (groupId) params.set('groupId', groupId)
        if (offset && snapshot.current?.offset !== offset && snapshot.current?.revision) params.set('pageRevision', snapshot.current.revision)
        setLoading(true); setListError('')
        read(`/state/topics?${params}`).then(value => {
          if (!active) return
          snapshot.current = value; setListing(value)
          if (offset && offset >= value.total) setOffset(Math.max(0, Math.floor((value.total - 1) / 10) * 10))
        }, cause => {
          if (!active) return
          if (cause.status === 409) { snapshot.current = undefined; setOffset(0); setRetry(value => value + 1) }
          else setListError(cause.message)
        }).finally(() => { if (active) setLoading(false) })
        return () => { active = false }
      }, [groupId, offset, retry, updatedAt])
      const listStyle = { listStyle: 'none', margin: 0, padding: 0 }
      return React.createElement('section', { 'aria-label': '话题总览', style: { display: 'grid', gap: ui.space4 } },
        React.createElement('div', { className: 'observer-toolbar', style: { ...toolbar, flexWrap: 'wrap' } },
          React.createElement(SelectMenu, { label: '筛选话题群聊', value: groupId, options: [{ id: '', label: '全部群聊' }, ...groups.map(item => ({ id: item.groupId, label: item.name || item.groupId }))],
            onChange: value => { setGroupId(value); setOffset(0); setListing(undefined); snapshot.current = undefined; setSelection(undefined); setFixedTopics(undefined) } })),
        React.createElement('div', { className: 'observer-topics-layout', style: { display: 'grid', gridTemplateColumns: 'minmax(0, 340px) minmax(0, 1fr)', alignItems: 'start', gap: ui.space4 } },
          React.createElement('section', { className: 'observer-topic-list', 'aria-label': '话题列表', 'aria-busy': loading, style: { ...tableFrame, width: '100%', minWidth: 0, minHeight: 300 } },
            React.createElement('div', { style: { padding: '16px 16px 4px', fontSize: ui.textSm, color: colors.muted } }, '固定话题'),
            fixedError ? React.createElement(TopicPageStatus, { error: fixedError, onRetry: () => setRetry(value => value + 1) })
              : !fixedTopics ? React.createElement(TopicPageStatus, { loading: true }) : React.createElement('ul', { style: listStyle }, ...fixedTopics.map(item => React.createElement(TopicListItem, { key: item.topicId, title: item.title, selected: selection?.fixed && selection.topicId === item.topicId, onSelect: () => setSelection({ ...item, fixed: true, groupId }) }))),
            React.createElement('div', { style: { padding: '16px 16px 0' } },
              React.createElement('strong', { style: { fontSize: ui.textMd } }, '业务话题', listing ? ` · ${listing.total}` : ''),
              React.createElement(TopicPageStatus, { loading, error: listError, hasContent: !!listing, onRetry: () => setRetry(value => value + 1) })),
            listing?.topics.length ? React.createElement('ul', { style: listStyle }, ...listing.topics.map(item => React.createElement(TopicListItem, { key: `${item.groupId}:${item.topicId}`, title: item.title || '未命名话题', summary: item.summary || '暂无摘要', updatedAt: item.updatedAt, selected: !selection?.fixed && selection?.topicId === item.topicId && selection?.groupId === item.groupId, onSelect: () => setSelection(item) })))
              : listing && !loading ? emptyState('暂无业务话题', { detail: '新消息完成业务归类后会显示在这里。' }) : null,
            React.createElement(TopicPager, { page: listing, loading, onChange: setOffset, label: '话题列表分页' })),
          selection?.fixed ? React.createElement(FixedTopicDetail, { key: `${groupId}:${selection.topicId}`, topicId: selection.topicId, title: selection.title, groupId, updatedAt })
            : selection ? React.createElement(TopicOverview, { key: `${selection.groupId}:${selection.topicId}`, selection, updatedAt, onOpenTask })
              : React.createElement('section', { 'aria-label': '话题详情', style: { ...tableFrame, minHeight: 300, padding: 24, color: colors.muted, fontSize: ui.textMd } }, '选择话题，查看当前摘要和关联任务')))
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
    // 仅整理说明文字的转义换行；路径和代码原样显示，完整持久原文另可展开核对。
    const humanRequestText = value => String(value ?? '').replace(/(`[^`]*`|(?:[A-Za-z]:\\|\\\\)[^\r\n]+)|\\r\\n|\\n/g, (match, literal) => literal || '\n')
    function HumanRequestContent({ request }) {
      const question = request.question || request.requestedAction || ''
      const reason = request.reason || (request.waitingReason !== question ? request.waitingReason : '')
      const field = (label, value) => React.createElement('section', { style: { display: 'grid', gap: ui.space2, minWidth: 0 } },
        React.createElement('h3', { style: { margin: 0, fontSize: ui.textSm, color: colors.muted } }, label),
        React.createElement('div', { style: { fontSize: ui.textMd, lineHeight: 1.7, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, ...linkedTaskText(humanRequestText(value))))
      const supporting = (label, items) => Array.isArray(items) && items.length ? React.createElement('details', { style: { borderTop: `1px solid ${colors.border}`, paddingTop: ui.space3 } },
        React.createElement('summary', { style: { cursor: 'pointer', fontSize: ui.textSm, fontWeight: 600 } }, `${label} · ${items.length}`),
        React.createElement('ol', { style: { paddingLeft: ui.space6, margin: `${ui.space3}px 0 0`, display: 'grid', gap: ui.space2, fontSize: ui.textSm, lineHeight: 1.7 } }, ...items.map((item, index) => React.createElement('li', { key: index, style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, ...linkedTaskText(humanRequestText(readableValue(item))))))) : null
      return React.createElement('div', { className: 'observer-human-request', style: { display: 'grid', gap: ui.space4, minWidth: 0 } },
        field('当前进度与等待原因', reason || '该申请未说明等待原因。'),
        question ? field('需要你决定', question) : null,
        request.risk && request.risk !== '未单独说明' ? field('风险', request.risk) : null,
        supporting('证据与范围明细', request.evidence), supporting('已尝试', request.attemptedActions),
        readout('申请原文', { reason: request.reason, question: request.question, requestedAction: request.requestedAction, waitingReason: request.waitingReason, risk: request.risk, evidence: request.evidence, attemptedActions: request.attemptedActions }))
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
    function SessionLocation({ session, label, onOpenSession, compact = false, entryOnly = false, actionLabel, primaryAction }) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const pending = useRef(false)
      const nativeSession = (session?.executionBackend ?? 'dsh') === 'dsh'
      const open = async () => {
        if (pending.current || !nativeSession || !session?.sessionId || session.sessionBound === false) return
        pending.current = true; setBusy(true); setError('')
        try { await onOpenSession(session.sessionId, session.parentSessionId) }
        catch (cause) { setError(cause.message) }
        finally { pending.current = false; setBusy(false) }
      }
      const entry = nativeSession && session?.sessionId && session.sessionBound !== false ? React.createElement(Button, { type: 'button', variant: 'outline', size: 'sm', disabled: busy, onClick: open, 'aria-label': actionLabel, style: { justifySelf: 'start', minWidth: 110 } }, busy ? '正在打开…' : `打开${label}`) : null
      const failure = error ? React.createElement('p', { role: 'alert', style: { color: colors.danger } }, error) : null
      if (entryOnly) return React.createElement('div', null, nativeSession ? entry : React.createElement('span', { className: 'detail-muted' }, 'Claude Code'), failure)
      const location = React.createElement(React.Fragment, null,
        React.createElement('div', null, '会话 ID：', session?.sessionId ? `${session.sessionId}${session.sessionBound === false ? '（尚未绑定）' : ''}` : '尚未建立'),
        React.createElement('div', null, '工作目录：', session?.workspaceDir || '尚未分配'),
        compact && session?.workingDirectory ? React.createElement('div', null, '执行目录：', session.workingDirectory) : null,
        session?.document?.path ? React.createElement('div', null, `执行文档（第 ${session.document.inputVersion} 轮）：`, session.document.path) : null,
        React.createElement('div', null, '日志路径：', session?.logPath || '尚未记录'))
      return React.createElement('section', { className: compact ? 'detail-session' : undefined, 'aria-label': label, style: compact ? undefined : { ...card, display: 'grid', gap: 10, overflowWrap: 'anywhere' } },
        React.createElement('strong', null, label, nativeSession ? null : ' · Claude Code'),
        compact ? React.createElement('p', { className: 'detail-muted' }, label === '任务会话' ? '统筹目标、安排独立执行并汇总结果。' : '本次执行的独立会话、工作目录与日志。') : null,
        primaryAction ? React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } }, primaryAction, entry) : null,
        compact ? React.createElement('details', { className: 'detail-disclosure' }, React.createElement('summary', null, '会话信息与路径'), React.createElement('div', { className: 'detail-location' }, location)) : location,
        compact && nativeSession && (!session?.sessionId || session.sessionBound === false) ? React.createElement('p', { className: 'detail-muted' }, session?.sessionId ? '会话尚未绑定，暂不可打开。' : '会话尚未建立。') : null,
        primaryAction ? null : entry, failure)
    }
    function ExecutionSessionDuration({ timing }) {
      const [clock, setClock] = useState(Date.now)
      const start = timing?.startedAt ? Date.parse(timing.startedAt) : NaN
      const active = timing?.active === true && timing.endedAt === null && Number.isFinite(start)
      useEffect(() => {
        if (!active) return
        setClock(Date.now())
        const timer = setInterval(() => setClock(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [active, start])
      const end = active ? clock : timing?.active === false && timing.endedAt ? Date.parse(timing.endedAt) : NaN
      const elapsed = end - start
      const recorded = Number.isFinite(elapsed) && elapsed >= 0
      const value = recorded ? fmtDuration(elapsed) : '—'
      const description = recorded ? `最新一轮执行耗时：${value}` : '最新一轮耗时未记录：该轮尚未开始或缺少可靠的起止时间。'
      return React.createElement('span', { className: 'observer-execution-duration', title: description, 'aria-label': description, style: { color: colors.muted, fontVariantNumeric: 'tabular-nums', display: 'inline-block', minWidth: '8em', textAlign: 'right' } }, value)
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
    function HumanRequestModal({ children, onClose }) {
      const dialog = useRef(null)
      useEffect(() => {
        const element = dialog.current
        const previous = document.activeElement
        const overflow = document.documentElement.style.overflow
        element.showModal()
        document.documentElement.style.overflow = 'hidden'
        return () => {
          element.close()
          document.documentElement.style.overflow = overflow
          if (previous?.isConnected) previous.focus({ preventScroll: true })
        }
      }, [])
      return React.createElement('dialog', { ref: dialog, className: 'observer-human-modal', onKeyDown: event => {
        if (event.key !== 'Tab') return
        const controls = [...event.currentTarget.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex="0"]')].filter(element => element.getClientRects().length)
        const first = controls[0], last = controls[controls.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }, 'aria-label': '人工介入事项详情', onCancel: event => { event.preventDefault(); onClose() }, onClick: event => { if (event.target === event.currentTarget) { const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose() } } }, ...children)
    }
    function HumanRequestReply({ request, onChanged }) {
      const [reply, setReply] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
      const pending = useRef(false), attempt = useRef(null)
      const submit = async event => {
        event.preventDefault()
        if (event.nativeEvent?.isComposing || pending.current || notice || request.status !== 'waiting-reply') return
        if (!reply.trim()) { setError('请填写答复内容。'); return }
        attempt.current ||= { requestId: crypto.randomUUID(), reply: reply.trim(), expectedRequirementRevision: request.requirementRevision, expectedControlRevision: request.controlRevision }
        pending.current = true; setBusy(true); setError('')
        try {
          await post(`/tasks/${encodeURIComponent(request.taskId)}/human-requests/${encodeURIComponent(request.requestId)}/reply`, attempt.current)
          setNotice('答复已记录，原任务将继续处理。'); onChanged()
        } catch (cause) { setError(`答复未提交：${cause.message}。内容已保留，请核对当前问题后重试。`) }
        finally { pending.current = false; setBusy(false) }
      }
      if (!request.taskSessionRequest) return React.createElement('p', { role: 'status' }, '历史介入记录只读。新执行的权限请求请在对应执行会话中处理。')
      if (request.status !== 'waiting-reply') return React.createElement('p', { role: 'status' }, request.status === 'answered' ? `已答复：${request.reply || '答复已记录。'}` : '该问题已失效，请查看当前任务。')
      return React.createElement('form', { noValidate: true, onSubmit: submit, 'aria-label': '答复人工介入问题', style: { display: 'grid', gap: 12, padding: 16 } },
        React.createElement('p', { style: { margin: 0, color: colors.muted } }, '答复将作为当前问题的补充信息交回原任务，不代表批准其他操作。'),
        React.createElement('label', { className: 'observer-config-field' }, '答复内容', React.createElement('textarea', { className: 'observer-config-input', required: true, rows: 5, maxLength: 20000, value: reply, disabled: busy || !!notice, 'aria-invalid': !!error, 'aria-describedby': error ? 'human-request-reply-error' : undefined, onChange: event => { setReply(event.target.value); attempt.current = null; setError('') } })),
        error ? React.createElement('p', { id: 'human-request-reply-error', role: 'alert', style: { margin: 0, color: colors.danger } }, error) : null,
        notice ? React.createElement('p', { role: 'status', style: { margin: 0 } }, notice) : null,
        React.createElement(Button, { type: 'submit', disabled: busy || !!notice || !reply.trim(), style: { justifySelf: 'start' } }, busy ? '提交答复中…' : '提交答复'))
    }
    function TaskExecutions({ taskId, updatedAt, onOpenSession }) {
      const [offset, setOffset] = useState(0), [page, setPage] = useState(), [error, setError] = useState(''), [retry, setRetry] = useState(0)
      const [loading, setLoading] = useState(true)
      useEffect(() => {
        const controller = new AbortController(); let active = true
        setLoading(true); setError('')
        get(`/state/tasks/${encodeURIComponent(taskId)}/executions?offset=${offset}&limit=20`, { signal: controller.signal }).then(value => { if (active) { const items = value.executions || value.items || (Array.isArray(value) ? value : []); const total = value.total ?? items.length; if (offset > 0 && offset >= total) { setOffset(Math.max(0, Math.floor((total - 1) / 20) * 20)); return } setPage({ items, total, offset, refreshedAt: updatedAt }); } }, cause => { if (active) setError(cause.message) }).finally(() => { if (active) setLoading(false) })
        return () => { active = false; controller.abort() }
      }, [taskId, offset, updatedAt, retry])
      const ready = !!page
      const visibleOffset = page?.offset ?? 0
      const refreshedAt = page?.refreshedAt && Number.isFinite(new Date(page.refreshedAt).getTime()) ? page.refreshedAt : null
      return React.createElement('section', { className: 'detail-executions', 'aria-label': '动态执行列表', style: { display: 'grid', gap: 16, minHeight: 160 } },
        React.createElement('div', { className: 'detail-section-heading' }, React.createElement('h2', null, '执行会话'),
          React.createElement('div', { className: 'detail-execution-feedback' },
            React.createElement('span', { role: error ? 'alert' : 'status', className: error ? 'detail-execution-error' : 'detail-muted', tabIndex: error ? 0 : undefined },
              error ? `执行记录读取失败${ready ? '，暂显示已读取记录' : ''}：${error}` : loading && ready && page.offset !== offset ? '正在读取另一页，暂显示已读取记录…' : ''),
            React.createElement(Button, { type: 'button', variant: 'outline', size: 'sm', 'aria-label': '重试读取执行', disabled: !error || loading, style: { visibility: error ? 'visible' : 'hidden' }, onClick: () => setRetry(value => value + 1) }, '重试'))),
        React.createElement('div', { className: 'detail-pagination' }, React.createElement('span', { className: 'detail-muted detail-execution-meta', style: { marginRight: 'auto' } }, refreshedAt ? React.createElement('span', null, `更新 ${fmt(refreshedAt)}`) : null, React.createElement('span', null, ready ? `${page.total} 条执行记录 · ${page.total ? visibleOffset + 1 : 0}–${visibleOffset + page.items.length}` : '尚未读取执行记录')), React.createElement(Button, { type: 'button', variant: 'outline', disabled: loading || !ready || visibleOffset === 0, onClick: () => setOffset(Math.max(0, visibleOffset - 20)) }, '上一页'), React.createElement(Button, { type: 'button', variant: 'outline', disabled: loading || !ready || visibleOffset + page.items.length >= page.total, onClick: () => setOffset(visibleOffset + 20) }, '下一页')),
        ready ? React.createElement('ol', { className: 'detail-execution-list' }, ...page.items.map(execution => React.createElement('li', { key: execution.executionId, className: 'detail-execution' },
          React.createElement('details', null, React.createElement('summary', { className: 'detail-execution-summary' },
            React.createElement('span', { className: 'detail-execution-title' }, execution.title || execution.objective || execution.executionId),
            execution.executionBackend === 'claude-code' ? React.createElement('span', { className: 'detail-muted' }, 'Claude Code') : null,
            statusTag(taskStateLabel(execution.status), taskStateTone(execution.status)),
            React.createElement('span', { className: 'detail-execution-time' }, `创建 ${fmt(execution.createdAt)}`)),
            React.createElement('div', { className: 'detail-execution-body' },
            React.createElement('p', { className: 'detail-objective' }, execution.input?.objective || execution.objective || '尚未记录执行目标。'),
            execution.progressReview ? React.createElement('p', { className: 'detail-muted' }, `最近活动 ${fmt(execution.progressReview.lastActivityAt)} · 进展检查 ${fmt(execution.progressReview.checkedAt)}`, execution.progressReview.readError ? ` · 记录读取失败：${traceReason(execution.progressReview.readError)}` : '') : null,
            React.createElement(SessionLocation, { session: execution, label: '执行会话', onOpenSession, compact: true }),
            execution.error ? React.createElement('p', { role: 'status', style: { color: colors.danger } }, traceReason(execution.error)) : null,
            React.createElement(TaskResult, { result: execution.result }),
            React.createElement('details', { className: 'detail-disclosure' }, React.createElement('summary', null, '执行记录信息'), React.createElement('p', { className: 'detail-muted' }, `执行 ${execution.executionId} · 需求修订 ${execution.requirementRevision ?? '未记录'}`))))))) : null,
        ready && !page.items.length ? emptyState('尚无动态执行', { detail: '任务会话尚未分派执行；任务可直接形成结果。' }) : null,
        !ready ? emptyState(loading ? '正在读取执行记录' : '尚未读取到执行记录', { detail: '读取完成后在此显示独立执行。' }) : null)
    }
    function LegacyTaskOutput({ taskId, node, detailRevision }) {
      const [opened, setOpened] = useState(false)
      return React.createElement('details', { style: card, onToggle: event => { if (event.currentTarget.open) setOpened(true) } },
        React.createElement('summary', { style: { cursor: 'pointer' } }, `${node.title || node.nodeId || '历史执行'} · ${taskStateLabel(node.status)}`),
        opened ? node.outputRef ? React.createElement(TaskStepOutput, { taskId, node, detailRevision }) : React.createElement('p', null, '历史未记录产出') : null)
    }
    function LegacyTaskHistory({ task }) {
      const [page, setPage] = useState(1)
      const [collection,setCollection]=useState(task.legacyHistoryPage)
      const [loading,setLoading]=useState(!task.legacyHistoryPage)
      const [error,setError]=useState('')
      const offset=(page-1)*20
      useEffect(()=>{
        if(task.legacyHistoryPage&&page===1&&collection===task.legacyHistoryPage)return
        let active=true;setLoading(true);setError('')
        const params=new URLSearchParams({offset:String(offset),limit:'20'})
        if(page>1&&collection?.revision)params.set('revision',collection.revision)
        get(`/state/tasks/${encodeURIComponent(task.taskId)}/legacy-history?${params}`).then(value=>{if(active)setCollection(value)},cause=>{if(active){if(cause.status===409){setPage(1);setCollection(undefined)}else setError(cause.message==='legacy_history_pagination_provider_required'?'历史服务需要升级后才能按页读取。':cause.message==='OBSERVER_PAGINATION_MIGRATION_REQUIRED'?'历史数据需要先完成离线索引升级。':cause.message)}}).finally(()=>{if(active)setLoading(false)})
        return ()=>{active=false}
      },[task.taskId,task.detailRevision,page])
      const items=collection?.offset===offset?collection.items:[]
      const pages=Math.max(1,Math.ceil((collection?.total??0)/20)),current=page
      return React.createElement('section', { 'aria-label': '只读历史执行', style: { display: 'grid', gap: 12 } },
        React.createElement('p', { role: 'status' }, '历史任务只读，不再接受旧执行操作。'),
        task.session?.sessionId ? React.createElement('p', { style: { color: colors.muted } }, `历史任务会话：${task.session.sessionId}`) : null,
        ...items.map(({ execution, node }, index) => node ? React.createElement(LegacyTaskOutput, { key: node.nodeRunId || index, taskId: task.taskId, node, detailRevision: task.detailRevision })
          : React.createElement('details', { key: execution.executionId, style: card }, React.createElement('summary', { style: { cursor: 'pointer' } }, `历史执行 ${execution.executionId} · ${taskStateLabel(execution.status)}`), React.createElement('p', null, `记录时间 ${fmt(execution.createdAt)}`), ...(execution.sessions || []).map(session => React.createElement('p', { key: session.sessionId }, `历史会话 ${session.sessionId} · ${taskStateLabel(session.status)}`)), ...(execution.sessions || []).filter(session=>session.outputRef).map(session=>React.createElement(LegacyTaskOutput,{key:session.nodeRunId,taskId:task.taskId,node:{...session,nodeRunId:session.nodeRunId,runId:session.runId||execution.legacyRunId||execution.executionId},detailRevision:task.detailRevision})), execution.result ? React.createElement(TaskResult, { result: execution.result }) : null)),
        loading?React.createElement('p',{role:'status'},'正在读取历史执行…'):error?React.createElement('p',{role:'alert'},`历史执行读取失败：${error}`):!items.length ? emptyState('暂无历史执行记录') : null,
        pages > 1 ? React.createElement('div', { style: { display: 'flex', gap: 12 } }, React.createElement(Button, { type: 'button', variant: 'outline', disabled: current <= 1, onClick: () => setPage(value => value - 1) }, '上一页'), React.createElement('span', null, `${current}/${pages}`), React.createElement(Button, { type: 'button', variant: 'outline', disabled: current >= pages, onClick: () => setPage(value => value + 1) }, '下一页')) : null)
    }
    const taskProgressView = task => {
      const terminal = ['completed', 'succeeded', 'failed', 'cancelled', 'stale']
      const ended = task.legacyReadonly || terminal.includes(task.state)
      const paused = (task.controlState || task.control?.state || task.control) === 'paused' || task.state === 'paused'
      const records = new Map()
      for (const item of [...(Array.isArray(task.executions) ? task.executions : []), ...(Array.isArray(task.blockers?.executions) ? task.blockers.executions : [])]) {
        if (item.executionId) records.set(item.executionId, { ...records.get(item.executionId), ...item, sessionBound: item.sessionBound ?? records.get(item.executionId)?.sessionBound ?? false })
      }
      const executions = ended ? [] : [...records.values()].filter(item => !terminal.includes(item.status) || item.drained === false).map(item => {
        const outdated = item.requirementRevision != null && task.requirementRevision != null && item.requirementRevision !== task.requirementRevision
          || item.controlRevision != null && task.controlRevision != null && item.controlRevision !== task.controlRevision
        const stopping = item.cancelRequested || outdated
        const running = !paused && !stopping && !task.recovering && !item.recovering && item.status === 'running' && item.drained !== true
        const label = stopping ? '等待停止 / 收尾' : task.recovering || item.recovering ? '会话恢复中' : paused ? '任务已暂停' : terminal.includes(item.status) ? '执行结束，等待收尾' : taskStateLabel(item.status)
        return { ...item, running, outdated, label, objective: item.input?.objective || item.objective || item.input?.title || item.executionId }
      })
      const running = executions.filter(item => item.running).length
      const queued = executions.filter(item => ['queued', 'pending'].includes(item.status) && !item.cancelRequested && !item.outdated && !paused).length
      const summary = ended ? task.legacyReadonly ? '历史任务只读，不展示实时执行进展。' : `任务${taskStateLabel(task.state)}，当前没有正在执行的事项。`
        : paused ? '任务已暂停；以下为尚未结束的执行记录。'
        : task.recovering ? '任务会话恢复中，当前处理步骤尚未记录。'
        : ['waiting', 'blocked', 'interrupted'].includes(task.state) ? `任务${taskStateLabel(task.state)}${executions.length ? '；以下为尚未结束的执行记录。' : '，暂无活跃执行记录。'}`
        : running || queued ? `${running} 项执行中 · ${queued} 项待执行`
        : task.drained === false && taskSession(task)?.sessionBound === true && taskSession(task)?.sessionId ? '统筹会话正在处理任务，具体步骤尚未记录。'
        : '暂无当前执行进展记录。'
      return { ended, paused, executions, summary }
    }
    const taskOverallProgressView = task => {
      const ended = task.legacyReadonly || ['completed', 'succeeded', 'failed', 'cancelled'].includes(task.state)
      const paused = (task.controlState || task.control?.state || task.control) === 'paused' || task.state === 'paused'
      const decision = task.lastDecision
      const hasRecord = typeof decision?.summary === 'string' && !!decision.summary.trim()
      const verified = hasRecord && Number.isSafeInteger(task.requirementRevision) && Number.isSafeInteger(task.controlRevision)
        && decision.requirementRevision === task.requirementRevision && decision.controlRevision === task.controlRevision
        && Number.isFinite(Date.parse(decision.at))
      const currentRecord = ['wait', 'blocked'].includes(decision?.action) && verified && !ended && !paused
      const updating = currentRecord && (task.drained === false || task.recovering === true)
      const waiting = ['waiting', 'blocked', 'interrupted'].includes(task.state)
      return {
        description: ended ? task.legacyReadonly ? '历史任务只读，不展示当前工作。' : `任务${taskStateLabel(task.state)}，结果与执行记录见下方。`
          : paused ? '任务已暂停，等待后续指示。'
          : currentRecord ? decision.summary
          : task.recovering ? '任务会话恢复中，当前整体工作尚未记录。' : '当前整体工作尚未记录。',
        heading: ended || paused ? '当前状态' : updating ? '最近已确认进展' : currentRecord ? waiting ? '当前等待 / 阻塞' : '最新统筹进展' : '当前工作',
        recordedAt: currentRecord ? decision.at : null,
        missing: !ended && !paused && !currentRecord,
        updating,
        lastRecord: !ended && hasRecord ? { summary: decision.summary, at: decision.at, verified } : null,
      }
    }
    function TaskProgress({ task, onOpenSession }) {
      const view = taskProgressView(task)
      const confirmed = useRef(null)
      let overall = taskOverallProgressView(task)
      const identity = `${task.taskId}:${task.requirementRevision}:${task.controlRevision}`
      if (confirmed.current?.identity !== identity) confirmed.current = null
      if (overall.recordedAt) confirmed.current = { identity, description: overall.description, recordedAt: overall.recordedAt }
      else if (overall.missing && confirmed.current && (task.drained === false || task.recovering === true)) {
        overall = { ...overall, description: confirmed.current.description, recordedAt: confirmed.current.recordedAt,
          heading: '最近已确认进展', missing: false, updating: true }
      }
      const time = value => value ? fmt(value) : '未记录'
      return React.createElement('section', { className: 'detail-panel detail-progress', 'aria-label': '当前进展' },
        React.createElement('h2', null, '当前进展'),
        React.createElement('div', { className: 'detail-progress-content', tabIndex: 0, 'aria-label': '当前进展记录，可滚动查看' },
          React.createElement('div', { className: 'detail-overall-progress' }, React.createElement('h3', null, overall.heading), React.createElement('p', { className: 'detail-progress-state' }, overall.description), React.createElement('p', { className: 'detail-muted' }, `整体进展记录时间 ${time(overall.recordedAt)}`), overall.updating ? React.createElement('p', { className: 'detail-muted' }, '统筹正在更新；以上为最近已确认进展，不代表实时工作。') : null, React.createElement('p', { className: 'detail-muted' }, `任务状态记录更新 ${time(task.updatedAt)}`), overall.missing ? React.createElement('p', { className: 'detail-muted' }, '当前没有可确认的整体工作说明，请在任务会话中查看。') : null),
          overall.lastRecord && !overall.recordedAt ? React.createElement('details', { className: 'detail-progress-note' }, React.createElement('summary', null, overall.lastRecord.verified ? '最近统筹说明（不代表当前工作）' : '历史统筹说明（当前版本或轮次未核验）'), React.createElement('p', null, traceReason(overall.lastRecord.summary)), React.createElement('p', { className: 'detail-muted' }, `记录时间 ${time(overall.lastRecord.at)}`)) : null,
          view.executions.length ? React.createElement('details', { className: 'detail-progress-note' }, React.createElement('summary', null, `辅助：执行记录（${view.executions.length} 项）`), React.createElement('p', { className: 'detail-muted' }, '以下是执行事项与会话活动记录，不代表任务整体当前步骤。'), React.createElement('ul', { className: 'detail-progress-list' }, ...view.executions.map(item => React.createElement('li', { key: item.executionId },
            React.createElement('div', { className: 'detail-progress-heading' }, React.createElement('strong', null, item.input?.title || item.key || '执行事项'), statusTag(item.label, item.running ? 'ongoing' : view.paused || item.outdated || item.cancelRequested || item.recovering ? 'warning' : taskStateTone(item.status)), React.createElement(SessionLocation, { session: item, label: '执行会话', onOpenSession, entryOnly: true, actionLabel: `打开执行会话 ${item.input?.title || item.key || item.executionId}` })),
            React.createElement('p', { className: 'detail-objective' }, item.objective),
            React.createElement('p', { className: 'detail-muted' }, `最近活动 ${time(item.progressReview?.lastActivityAt)} · 进展检查 ${time(item.progressReview?.checkedAt)}`),
            React.createElement('p', { className: 'detail-muted' }, item.progressReview?.readError ? `进展记录读取失败：${traceReason(item.progressReview.readError)}` : Number.isSafeInteger(item.progressReview?.newEventCount) && item.progressReview.newEventCount >= 0 ? `本次检查新增 ${item.progressReview.newEventCount} 条会话事件。` : '尚无可读的当前步骤摘要。'),
            React.createElement('details', null, React.createElement('summary', null, '会话与记录信息'), React.createElement('p', { className: 'detail-muted' }, `执行记录更新 ${time(item.updatedAt)} · 会话 ${item.sessionId || '尚未建立'}`)))))) : null))
    }
    const taskDetailCss = `
      .observer-session-detail .timeline-outcomes { display: grid; gap: 12px; margin-top: 16px; padding-top: 16px; border-top: 1px solid ${colors.border}; }
      [data-dingtalk-observer] .observer-session-detail { width: 100%; box-sizing: border-box; max-width: 1100px; margin: 0 auto; padding-bottom: 24px; display: grid; gap: 24px; font-size: 14px; line-height: 1.65; overflow-wrap: anywhere; }
      .observer-session-detail :is(h1, h2, h3, p, ul) { margin: 0; }
      .observer-session-detail h1 { font-size: 24px; line-height: 1.4; font-weight: 650; }
      .observer-session-detail h2 { font-size: 16px; line-height: 1.5; font-weight: 600; }
      .observer-session-detail h3 { font-size: 14px; font-weight: 600; }
      .observer-session-detail ul { padding-left: 20px; }
      .observer-session-detail li + li { margin-top: 4px; }
      .observer-session-detail .detail-header { display: grid; gap: 12px; padding-bottom: 24px; border-bottom: 1px solid ${colors.border}; }
      .observer-session-detail .detail-topline { display: flex; gap: 12px; align-items: center; }
      .observer-session-detail .detail-title-row { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
      .observer-session-detail .detail-meta { display: flex; gap: 8px 20px; flex-wrap: wrap; color: ${colors.muted}; font-size: 12px; font-variant-numeric: tabular-nums; }
      .observer-session-detail .detail-muted { color: ${colors.muted}; font-size: 12px; }
      .observer-session-detail .detail-columns { display: grid; grid-template-columns: minmax(0, 1fr) 288px; gap: 24px; align-items: start; }
      .observer-session-detail :is(.detail-primary, .detail-sidebar) { display: grid; gap: 16px; min-width: 0; }
      .observer-session-detail :is(.detail-panel, .detail-session, .detail-records) { padding: 16px; border: 1px solid ${colors.border}; border-radius: 12px; background: ${colors.surface}; min-width: 0; }
      .observer-session-detail :is(.detail-panel, .detail-session) { display: grid; gap: 12px; }
      .observer-session-detail .detail-objective { white-space: pre-wrap; }
      .observer-session-detail .detail-requirements { display: grid; gap: 8px; padding-top: 12px; border-top: 1px solid ${colors.border}; }
      .observer-session-detail .observer-task-result { display: grid; gap: 12px; margin: 0; padding: 16px; border: 1px solid ${colors.border}; border-radius: 12px; background: ${colors.surface2}; }
      /* The shared result heading has an inline margin; only this page uses grid gaps. */
      .observer-session-detail .observer-task-result h2 { margin-bottom: 0 !important; }
      .observer-session-detail .observer-task-result h3 { margin: 0 0 8px; }
      .observer-session-detail .observer-task-result-text { max-height: 320px; overflow: auto; scrollbar-gutter: stable; }
      .observer-session-detail .detail-attention { display: grid; gap: 8px; padding: 16px; border: 1px solid color-mix(in srgb, ${colors.warning} 32%, ${colors.border}); border-left: 3px solid ${colors.warning}; border-radius: 8px; background: color-mix(in srgb, ${colors.warning} 6%, ${colors.surface}); }
      .observer-session-detail .detail-attention h2 { color: ${colors.warning}; }
      .observer-session-detail .detail-attention button { justify-self: start; }
      .observer-session-detail :is(summary, button, a) { cursor: pointer; }
      .observer-session-detail button:disabled { cursor: default; }
      .observer-session-detail summary { font-size: 12px; font-weight: 500; }
      .observer-session-detail summary:hover { color: ${colors.accent}; }
      .observer-session-detail summary:active { color: ${colors.accent}; }
      .observer-session-detail .detail-disclosure { padding-top: 12px; border-top: 1px solid ${colors.border}; }
      .observer-session-detail .detail-location { display: grid; gap: 8px; padding-top: 12px; font-size: 12px; color: ${colors.muted}; }
      .observer-session-detail .detail-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; }
      .observer-session-detail .detail-section-heading h2 { flex-shrink: 0; }
      .observer-session-detail .detail-executions { border-top: 1px solid ${colors.border}; padding-top: 24px; }
      .observer-session-detail .detail-execution-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
      .observer-session-detail .detail-execution { border: 1px solid ${colors.border}; border-radius: 8px; background: ${colors.surface}; overflow-wrap: anywhere; }
      .observer-session-detail .detail-execution-summary { padding: 12px 16px; display: grid; grid-template-columns: 12px minmax(0, 1fr) auto; gap: 4px 12px; align-items: baseline; list-style: none; }
      .observer-session-detail .detail-execution-summary::-webkit-details-marker { display: none; }
      .observer-session-detail .detail-execution-summary::before { content: '›'; grid-row: 1 / 3; font-size: 18px; line-height: 24px; color: ${colors.muted}; }
      .observer-session-detail details[open] > .detail-execution-summary::before { content: '⌄'; }
      .observer-session-detail .detail-execution-summary:hover { background: ${colors.surface2}; border-radius: 8px; }
      .observer-session-detail .detail-execution-title { font-size: 14px; font-weight: 500; color: inherit; }
      .observer-session-detail .detail-execution-time { grid-column: 2 / 4; font-size: 12px; color: ${colors.muted}; }
      .observer-session-detail .detail-execution-body { padding: 16px; display: grid; gap: 16px; border-top: 1px solid ${colors.border}; }
      .observer-session-detail .detail-pagination { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 8px; min-height: 36px; }
      .observer-session-detail .detail-execution-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; min-height: 44px; }
      .observer-session-detail .detail-execution-meta > span { white-space: nowrap; }
      .observer-session-detail .detail-pagination > span { min-width: 0; overflow-wrap: anywhere; font-size: 12px; }
      .observer-session-detail .detail-execution-feedback { height: 36px; flex: 1; min-width: 0; max-width: 520px; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; }
      .observer-session-detail .detail-execution-feedback > span { grid-column: 1; grid-row: 1; min-width: 0; max-height: 36px; overflow: auto; font-size: 12px; line-height: 18px; }
      .observer-session-detail .detail-execution-feedback > button { grid-column: 2; grid-row: 1; }
      .observer-session-detail .detail-execution-error { color: ${colors.danger}; }
      .observer-session-detail .detail-progress { height: 320px; grid-template-rows: 24px minmax(0, 1fr); }
      .observer-session-detail .detail-progress-content { min-height: 0; overflow: auto; scrollbar-gutter: stable; display: grid; gap: 8px; align-content: start; }
      .observer-session-detail .detail-progress-state { font-weight: 500; }
      .observer-session-detail .detail-overall-progress { display: grid; gap: 8px; }
      .observer-session-detail .detail-progress-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .observer-session-detail .detail-progress-heading > strong { margin-right: auto; }
      .observer-session-detail .detail-progress-list { list-style: none; padding: 0; display: grid; gap: 12px; }
      .observer-session-detail .detail-progress-list > li { margin: 0; padding-top: 12px; border-top: 1px solid ${colors.border}; display: grid; gap: 4px; }
      .observer-session-detail .detail-progress-list button { justify-self: start; margin-top: 4px; }
      .observer-session-detail .detail-progress-note { border-top: 1px solid ${colors.border}; padding-top: 8px; }
      .observer-task-detail-route .detail-fetch-error { padding: 16px; border: 1px solid ${colors.danger}; border-radius: 8px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; color: ${colors.danger}; font-size: 14px; line-height: 1.65; }
      .observer-task-detail-route .detail-fetch-state { min-height: 200px; align-content: start; }
      .observer-session-detail .detail-timeline { min-width: 0; padding: 14px 16px 8px; gap: 8px; font-family: Inter, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei UI', 'Noto Sans CJK SC', system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
      .observer-session-detail .timeline-heading { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; padding-bottom: 4px; }
      .observer-session-detail .timeline-title { display: flex; align-items: center; gap: 8px; }
      .observer-session-detail .timeline-heading h2 { font-size: 17px; font-weight: 600; line-height: 26px; letter-spacing: -.2px; }
      .observer-session-detail .timeline-count { font-size: 11px; line-height: 20px; padding: 0 7px; border-radius: 4px; background: ${colors.surface2}; color: ${colors.muted}; font-weight: 400; }
      .observer-session-detail .timeline-date { font-variant-numeric: tabular-nums; font-size: 11px; color: ${colors.muted}; }
      .observer-session-detail .timeline-heading > span, .observer-session-detail .timeline-note { font-size: 12px; }
      .observer-session-detail .timeline-note { font-size: 11px; line-height: 16px; }
      .observer-session-detail .timeline-navigator { min-width: 0; padding-bottom: 2px; }
      .observer-session-detail .timeline-range-caption { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 26px; color: ${colors.muted}; font-size: 11px; font-variant-numeric: tabular-nums; }
      .observer-session-detail .timeline-range-caption button { flex: none; color: inherit; background: transparent; border: 0; font: inherit; padding: 4px; border-radius: 4px; }
      .observer-session-detail .timeline-range-caption button:disabled { opacity: .4; }
      .observer-session-detail .timeline-range-caption button:not(:disabled):hover { color: ${colors.accent}; background: ${colors.surface2}; }
      .observer-session-detail .timeline-overview { position: relative; height: 32px; margin: 4px 9px 0; background: ${colors.surface2}; border-radius: 4px; }
      .observer-session-detail .timeline-overview-activity { position: absolute; height: 3px; min-width: 1px; opacity: .35; border-radius: 1px; pointer-events: none; }
      .observer-session-detail .timeline-range-window { position: absolute; top: 0; bottom: 0; box-sizing: border-box; background: color-mix(in srgb, #5968cf 12%, transparent); border: 1px solid #7d89df; border-radius: 4px; }
      .observer-session-detail .timeline-range-window button { position: absolute; top: -1px; bottom: -1px; touch-action: none; color: #5968cf; font: inherit; border: 0; border-radius: 3px; padding: 0; }
      .observer-session-detail .timeline-range-pan { left: 0; width: 100%; background: transparent; cursor: grab; font-size: 11px !important; }
      .observer-session-detail .timeline-range-pan:active { cursor: grabbing; }
      .observer-session-detail :is(.timeline-range-left, .timeline-range-right) { width: 18px; background: transparent; cursor: ew-resize; }
      .observer-session-detail :is(.timeline-range-left, .timeline-range-right) > span { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); box-sizing: border-box; width: 5px; height: 18px; border: 1px solid #7d89df; border-radius: 1px; background: ${colors.surface}; }
      .observer-session-detail :is(.timeline-range-left, .timeline-range-right):hover > span { border-color: #5968cf; background: color-mix(in srgb, #5968cf 12%, ${colors.surface}); }
      .observer-session-detail .timeline-range-left { left: -9px; }
      .observer-session-detail .timeline-range-right { right: -9px; }
      .observer-session-detail .timeline-range-window .timeline-range-pan:hover { background: color-mix(in srgb, #5968cf 25%, transparent); }
      .observer-session-detail :is(.timeline-range-window button, .timeline-range-caption button):focus-visible { outline: 2px solid ${colors.accent}; outline-offset: 2px; }
      .observer-session-detail .timeline-overview-labels { display: flex; justify-content: space-between; gap: 8px; margin: 3px 0 0; color: ${colors.muted}; font-size: 10px; font-variant-numeric: tabular-nums; }
      .observer-session-detail .timeline-scroll { overflow-x: auto; padding-bottom: 4px; }
      .observer-session-detail .timeline-scroll:focus-visible { outline: 2px solid ${colors.accent}; outline-offset: 2px; }
      .observer-session-detail .timeline-table { border-collapse: separate; border-spacing: 0; width: 100%; min-width: 820px; table-layout: fixed; font-size: 12px; }
      .observer-session-detail .timeline-table th { text-align: left; font-weight: 500; }
      .observer-session-detail .timeline-table th:first-child { width: 140px; padding: 1px 16px 1px 0; overflow-wrap: anywhere; line-height: 18px; position: sticky; left: 0; z-index: 10; transform: translateZ(0); background: ${colors.surface}; }
      .observer-session-detail .timeline-table thead th, .observer-session-detail .timeline-table tbody tr:first-child th { color: ${colors.muted}; font-size: 11px; font-weight: 400; }
      .observer-session-detail .timeline-table th small { display: none; }
      .observer-session-detail .timeline-name { display: block; position: relative; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 13px; font-weight: 500; line-height: 20px; padding-left: 14px; }
      .observer-session-detail .timeline-name::before { content: ''; position: absolute; left: 1px; top: 7px; width: 6px; height: 6px; border-radius: 50%; background: var(--timeline-lane-color); }
      .observer-session-detail .timeline-table tbody tr:last-child .timeline-name::before { border-radius: 2px; }
      .observer-session-detail .timeline-table th:is(:hover, :focus) { z-index: 12; }
      .observer-session-detail .timeline-table th:focus-visible { outline: 2px solid ${colors.accent}; outline-offset: -2px; }
      .observer-session-detail .timeline-table td { padding: 0; }
      .observer-session-detail .timeline-table tbody tr:first-child .timeline-track { margin-bottom: 3px; }
      .observer-session-detail .timeline-table tbody tr:last-child .timeline-track { margin-top: 3px; }
      .observer-session-detail .timeline-axis { position: relative; height: 24px; margin: 0 4px; color: ${colors.muted}; font-weight: 500; font-size: 12px; font-variant-numeric: tabular-nums; }
      .observer-session-detail .timeline-axis span { position: absolute; top: 1px; transform: translateX(-50%); width: 110px; text-align: center; font-variant-numeric: tabular-nums; }
      .observer-session-detail .timeline-axis span:first-child { transform: none; text-align: left; }
      .observer-session-detail .timeline-axis span:last-child { transform: translateX(-100%); text-align: right; }
      .observer-session-detail .timeline-table tbody tr { --timeline-lane-color: #5968cf; }
      .observer-session-detail .timeline-table tbody tr:last-child { --timeline-lane-color: #b48125; }
      .observer-session-detail .timeline-track { height: 34px; position: relative; margin: 0 4px; background: repeating-linear-gradient(to right, color-mix(in srgb, ${colors.border} 30%, transparent) 0, color-mix(in srgb, ${colors.border} 30%, transparent) 1px, transparent 1px, transparent 25%); }
      .observer-session-detail .timeline-bar { position: absolute; top: 6px; height: 22px; min-width: 2px; box-sizing: border-box; border: 0; border-radius: 5px; background: color-mix(in srgb, var(--timeline-lane-color) 20%, ${colors.surface}); color: color-mix(in srgb, var(--timeline-lane-color) 55%, currentColor); overflow: hidden; }
      .observer-session-detail .timeline-bar > span { display: flex; align-items: center; gap: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 1px 8px; font-size: 12px; font-weight: 500; line-height: 16px; }
      .observer-session-detail .timeline-bar { container-type: inline-size; }
      .observer-session-detail .timeline-activity { overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
      .observer-session-detail .timeline-duration { flex: none; font-size: 11px; font-variant-numeric: tabular-nums; }
      @container (max-width: 130px) { .observer-session-detail .timeline-activity { display: none; } .observer-session-detail .timeline-bar > span { gap: 0; padding-inline: 4px; } }
      .observer-session-detail .timeline-bar:focus-visible { outline: 2px solid ${colors.accent}; outline-offset: 2px; }
      .observer-session-detail .timeline-milestone { position: absolute; top: 6px; transform: translateX(-50%); width: 18px; height: 22px; padding: 0; border: 0; background: transparent; color: var(--timeline-lane-color); cursor: help; z-index: 3; }
      .observer-session-detail .timeline-milestone-tick { position: absolute; left: 50%; top: -3px; transform: translateX(-50%); width: 1px; height: 28px; background: currentColor; opacity: .8; }
      .observer-session-detail .timeline-milestone:is(:hover, :focus-visible) { outline: 1px solid currentColor; border-radius: 4px; }
      .observer-session-detail .timeline-total-track { height: 40px; }
      .observer-session-detail .timeline-total { top: 9px; height: 22px; border: 0; border-radius: 5px; background: color-mix(in srgb, ${colors.muted} 12%, ${colors.surface}); color: inherit; }
      .observer-session-detail .timeline-table th small.timeline-total-missing { display: block; font-size: 10px; line-height: 14px; font-weight: 400; color: ${colors.muted}; }
      .observer-session-detail .timeline-muted { border-color: ${colors.muted}; }
      .observer-session-detail .timeline-empty { position: absolute; top: 8px; left: 4px; color: ${colors.muted}; background: ${colors.surface2}; border-radius: 4px; padding: 1px 6px; font-size: 11px; line-height: 16px; }
      .observer-session-detail .timeline-details { font-size: 12px; overflow-wrap: anywhere; padding-top: 6px; }
      .observer-session-detail .timeline-details > summary { min-height: 28px; line-height: 28px; color: ${colors.muted}; }
      .observer-session-detail .timeline-details > summary:hover { color: inherit; }
      .observer-session-detail .timeline-details section { margin-top: 16px; }
      .observer-session-detail .timeline-details li { margin-top: 8px; }
      .observer-session-detail .timeline-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
      @media (max-width: 800px) { .observer-session-detail .detail-columns { grid-template-columns: minmax(0, 1fr); gap: 16px; } .observer-session-detail .detail-sidebar { grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; } }
      @media (max-width: 520px) { [data-dingtalk-observer] .observer-session-detail { gap: 16px; } .observer-session-detail .detail-sidebar { grid-template-columns: minmax(0, 1fr); } .observer-session-detail .detail-header { padding-bottom: 16px; } .observer-session-detail .detail-title-row { align-items: start; } .observer-session-detail .detail-execution-summary { padding: 12px; gap: 4px 8px; } }
    `
    const taskOutcomeRecords = (timeline, decisions = []) => {
      const records = new Map()
      for (const row of [...(timeline?.executions || []), ...(timeline?.human ? [timeline.human] : [])]) {
        for (const conclusion of row.conclusions || []) {
          const id = `conclusion:${conclusion.id}`
          records.set(id, { ...conclusion, id, type: '执行完成结论',
            source: `${row.label || row.title || row.id}${conclusion.inputVersion ? ` · 第 ${conclusion.inputVersion} 轮` : ''}` })
        }
        for (const event of row.milestones || []) {
          const id = `stage:${row.id}:${event.id}`
          records.set(id, { id, type: '阶段成果', at: event.at, summary: event.summary, source: row.label || row.title || row.id,
            evidence: event.evidence || [], activity: event.activity })
        }
      }
      for (const item of decisions) {
        if (!item.id || !(item.triggers || []).some(trigger => trigger.kind === 'execution.progress.review')) continue
        records.set(`review:${item.id}`, { id: `review:${item.id}`, type: '统筹巡查', at: item.recordedAt,
          summary: item.decision?.summary || '未记录判断正文', action: item.decision?.action,
          evidence: item.decision?.evidence || [], limitations: item.decision?.limitations || [] })
      }
      const stamp = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : -Infinity
      return [...records.values()].sort((a, b) => stamp(b.at) - stamp(a.at) || a.id.localeCompare(b.id))
    }
    function TaskOutcomeRecords({ taskId, timeline, readonly = false }) {
      const [page, setPage] = useState({ decisions: [], nextBefore: null, loaded: false })
      const [loading, setLoading] = useState(false), [error, setError] = useState(''), [request, setRequest] = useState({ before: null, revision: 0 })
      const pending = useRef(false)
      const [expanded, setExpanded] = useState(false)
      useEffect(() => { setExpanded(false) }, [taskId])
      useEffect(() => {
        if (readonly) return
        const controller = new AbortController(); let active = true
        pending.current = true; setLoading(true); setError('')
        const query = new URLSearchParams({ limit: '20', ...(request.before === null ? {} : { before: String(request.before) }) })
        get(`/state/tasks/${encodeURIComponent(taskId)}/decisions?${query}`, { signal: controller.signal }).then(value => {
          if (!active) return
          setPage(previous => {
            const records = new Map((request.before === null && !request.retainHistory ? [] : previous.decisions).map(item => [item.id, item]))
            for (const item of value.decisions || []) records.set(item.id, item)
            return { decisions: [...records.values()], nextBefore: value.nextBefore ?? null, loaded: true }
          })
        }, cause => { if (active) setError(cause.message) }).finally(() => { if (active) { pending.current = false; setLoading(false) } })
        return () => { active = false; controller.abort() }
      }, [taskId, readonly, request])
      const load = (before, retainHistory = expanded) => { if (!pending.current) { pending.current = true; setRequest(previous => ({ before, retainHistory, revision: previous.revision + 1 })) } }
      const records = taskOutcomeRecords(timeline, page.decisions)
      const visibleRecords = expanded ? records : records.slice(0, 10)
      const hasMore = !readonly && page.nextBefore !== null
      const expandEarlier = () => {
        if (pending.current) return
        setExpanded(true)
        if (hasMore && (expanded || records.length <= 10)) load(page.nextBefore, true)
      }
      const actions = { wait: '继续等待', blocked: '需要介入', complete: '提交完成判断' }
      return React.createElement('div', { className: 'timeline-outcomes', 'aria-label': '阶段成果与统筹巡查' },
        React.createElement('div', { className: 'detail-section-heading' }, React.createElement('h3', null, '阶段成果与统筹巡查'),
          !readonly ? React.createElement(Button, { type: 'button', variant: 'outline', size: 'sm', disabled: loading, onClick: () => load(null) }, '刷新记录') : null),
        React.createElement('p', { className: 'detail-muted' }, '阶段成果与执行完成结论为执行会话报告；报告本身不代表已独立核验或任务整体完成。'),
        React.createElement('p', { className: 'detail-muted', role: 'status' }, loading ? '正在读取统筹记录…' : error ? '统筹记录未全部读取，已有成果和记录仍保留。' : page.nextBefore !== null ? '仅展示已加载记录，还有更早的统筹决定可读取。' : '仅展示已落账的阶段成果、执行完成结论与巡查结论；检查触发不代表统筹已形成结论。'),
        error ? React.createElement('p', { role: 'alert' }, `统筹记录读取失败：${error}`, React.createElement(Button, { type: 'button', variant: 'outline', size: 'sm', disabled: loading, onClick: () => load(request.before) }, '重试读取记录')) : null,
        records.length ? React.createElement('ol', { style: { margin: 0, paddingLeft: 22, display: 'grid', gap: 16 } }, ...visibleRecords.map(item => React.createElement('li', { key: item.id, style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } },
          React.createElement('strong', null, `${item.type} · ${item.at ? fmt(item.at) : '时间未记录'}`),
          item.source ? React.createElement('p', { className: 'detail-muted' }, item.source) : null,
          React.createElement('p', null, ...linkedTaskText(item.summary)),
          item.activity ? React.createElement('p', { className: 'detail-muted' }, '报告时活动：', ...linkedTaskText(item.activity)) : null,
          item.action ? React.createElement('p', { className: 'detail-muted' }, `处理决定：${actions[item.action] || item.action}`) : null,
          [item.evidence, item.limitations, item.artifacts].some(values => values?.length) ? React.createElement('details', { className: 'detail-disclosure timeline-details' },
            React.createElement('summary', null, '依据、限制与产物'),
            ...(item.evidence || []).map((value, index) => React.createElement('p', { key: `e:${index}` }, '依据：', ...linkedTaskText(value))),
            ...(item.limitations || []).map((value, index) => React.createElement('p', { key: `l:${index}` }, '限制：', ...linkedTaskText(value))),
            ...(item.artifacts || []).map((value, index) => React.createElement('p', { key: `a:${index}` }, '产物：', ...linkedTaskText(value)))) : null)))
          : React.createElement('p', { className: 'detail-muted' }, readonly ? '历史记录未提供阶段成果、执行完成结论与巡查结论。' : page.loaded ? '已加载范围内暂无阶段成果或巡查结论，也无执行完成结论。' : '阶段成果、执行完成结论与巡查结论尚未完整读取。'),
        !expanded && records.length > 10 || hasMore ? React.createElement(Button, { type: 'button', variant: 'outline', size: 'sm', 'aria-expanded': expanded, disabled: loading, onClick: expandEarlier }, !expanded && records.length > 10 ? `展开更早记录（${records.length - 10} 条）` : '展开更早记录') : null,
        expanded && records.length > 10 ? React.createElement(Button, { type: 'button', variant: 'outline', size: 'sm', 'aria-expanded': true, onClick: () => setExpanded(false) }, '收起更早记录') : null)
    }
    function TaskExecutionTimeline({ timeline, taskId, readonly = false }) {
      const [now, setNow] = useState(Date.now)
      const tooltipRef = useRef(null), tooltipTarget = useRef(null)
      const [windowRange, setWindowRange] = useState(null)
      const dragRange = useRef(null), overviewRef = useRef(null)
      const hideTooltip = () => {
        const node = tooltipRef.current
        if (!node) return
        if (node.matches(':popover-open')) node.hidePopover()
        node.hidden = true
      }
      useEffect(() => {
        const onScroll = event => {
          if (event.target?.nodeType && tooltipRef.current?.contains(event.target)) return
          if (tooltipTarget.current && document.activeElement === tooltipTarget.current) placeTooltip({ currentTarget: tooltipTarget.current })
          else hideTooltip()
        }
        const onKey = event => { if (event.key === 'Escape') hideTooltip() }
        window.addEventListener('scroll', onScroll, true)
        window.addEventListener('resize', hideTooltip)
        window.addEventListener('keydown', onKey)
        return () => {
          window.removeEventListener('scroll', onScroll, true)
          window.removeEventListener('resize', hideTooltip)
          window.removeEventListener('keydown', onKey)
          tooltipRef.current?.remove()
          tooltipRef.current = null
          tooltipTarget.current = null
        }
      }, [])
      const live = timeline?.task?.active || [...(timeline?.executions || []), timeline?.human].some(row => row?.segments?.some(segment => segment.active))
      useEffect(() => {
        if (!live) return
        setNow(Date.now())
        const timer = window.setInterval(() => setNow(Date.now()), 1000)
        return () => { window.clearInterval(timer); pendingRefresh.current?.controller.abort(); pendingRefresh.current=null }
      }, [live, timeline])
      if (!timeline) return React.createElement('section', { className: 'detail-panel detail-timeline', 'aria-label': '执行时间泳道图' }, React.createElement('h2', null, '执行时间'), React.createElement('p', { className: 'detail-muted' }, '历史执行过程未记录。'), React.createElement(TaskOutcomeRecords, { taskId, timeline, readonly }))
      const rows = [...timeline.executions, timeline.human]
      const totalSegments = timeline.task.segments || [{ ...timeline.task, id: 'total', label: timeline.task.active ? '处理中' : timeline.task.status === 'completed' ? '已完成' : '已结束' }]
      const totalEvents = timeline.task.events || []
      const dates = [timeline.task.startedAt, timeline.task.endedAt, ...totalSegments.flatMap(segment => [segment.startedAt, segment.endedAt]), ...totalEvents.map(event => event.at), ...rows.flatMap(row => [...row.segments.flatMap(segment => [segment.startedAt, segment.endedAt]), ...row.milestones.map(event => event.at)])].map(value => value ? Date.parse(value) : NaN).filter(Number.isFinite)
      if (live) dates.push(now)
      const fullStart = dates.length ? Math.min(...dates) : now
      const fullEnd = Math.max(fullStart + 1000, ...dates)
      const minSpan = Math.min(1000, fullEnd - fullStart)
      const clampRange = (from, to) => {
        const span = Math.max(minSpan, Math.min(fullEnd - fullStart, to - from))
        const left = Math.max(fullStart, Math.min(from, fullEnd - span))
        return [left, left + span]
      }
      const [start, end] = windowRange ? clampRange(...windowRange) : [Math.max(fullStart, fullEnd - 3600000), fullEnd]
      const position = date => Math.max(0, Math.min(100, (Date.parse(date) - start) / (end - start) * 100))
      const overviewPosition = value => (value - fullStart) / (fullEnd - fullStart) * 100
      const axisDate = fraction => start + (end - start) * fraction
      const selectRange = (kind, delta, snapshot = [start, end]) => {
        const [from, to] = snapshot
        hideTooltip()
        setWindowRange(kind === 'left' ? [Math.max(fullStart, Math.min(to - minSpan, from + delta)), to]
          : kind === 'right' ? [from, Math.min(fullEnd, Math.max(from + minSpan, to + delta))]
            : clampRange(from + delta, to + delta))
      }
      const beginRangeDrag = (event, kind) => {
        if (event.button !== 0) return
        event.preventDefault()
        const width = overviewRef.current.getBoundingClientRect().width
        dragRange.current = { kind, x: event.clientX, range: [start, end], scale: (fullEnd - fullStart) / width }
        event.currentTarget.setPointerCapture(event.pointerId)
      }
      const moveRangeDrag = event => {
        const drag = dragRange.current
        if (drag) selectRange(drag.kind, (event.clientX - drag.x) * drag.scale, drag.range)
      }
      const endRangeDrag = () => { dragRange.current = null }
      const rangeKeyboard = (event, kind) => {
        const step = Math.max(1000, (fullEnd - fullStart) / (event.shiftKey ? 10 : 100))
        let delta
        if (event.key === 'ArrowLeft') delta = -step
        else if (event.key === 'ArrowRight') delta = step
        else if (event.key === 'Home') delta = fullStart - (kind === 'right' ? end : start)
        else if (event.key === 'End') delta = fullEnd - (kind === 'left' ? start : end)
        else return
        event.preventDefault()
        selectRange(kind, delta)
      }
      const rangeControl = (kind, label, extra = {}) => ({
        type: 'button', className: `timeline-range-${kind}`, role: 'slider', 'aria-label': label,
        'aria-valuemin': kind === 'right' ? start + minSpan : fullStart,
        'aria-valuemax': kind === 'left' ? end - minSpan : kind === 'pan' ? fullEnd - (end - start) : fullEnd,
        'aria-valuenow': kind === 'right' ? end : start,
        'aria-valuetext': `${fmt(new Date(start).toISOString())} 至 ${fmt(new Date(end).toISOString())}`,
        onPointerDown: event => beginRangeDrag(event, kind), onPointerMove: moveRangeDrag,
        onPointerUp: endRangeDrag, onPointerCancel: endRangeDrag, onLostPointerCapture: endRangeDrag,
        onKeyDown: event => rangeKeyboard(event, kind), ...extra,
      })
      const time = value => value ? fmt(value) : '未记录'
      const sameDay = new Date(start).toDateString() === new Date(end).toDateString()
      const navTime = value => new Date(value).toLocaleTimeString('zh-CN', { hour12: false })
      const overviewTime = value => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      const dateLabel = new Date(start).toLocaleDateString('zh-CN') + (sameDay ? '' : ` — ${new Date(end).toLocaleDateString('zh-CN')}`)
      const status = value => ({ completed: '已完成', recorded: '已记录', running: '执行中', queued: '排队中', succeeded: '已成功', failed: '失败', stale: '已失效', cancelled: '已取消', 'waiting-reply': '等待处理', answered: '已答复', superseded: '已失效', closed: '已关闭' })[value] || value
      const range = segment => `${time(segment.startedAt)} — ${segment.active ? '当前' : time(segment.endedAt)}`
      function placeTooltip(event) {
        const target = event.currentTarget, bounds = target.getBoundingClientRect()
        tooltipTarget.current = target
        let node = tooltipRef.current
        if (!node) {
          node = document.createElement('div')
          node.className = 'timeline-tooltip'
          node.setAttribute('role', 'tooltip')
          node.setAttribute('popover', 'manual')
          node.addEventListener('mouseleave', hideTooltip)
          document.body.appendChild(node)
          tooltipRef.current = node
        }
        const theme = window.getComputedStyle(target.closest('.detail-timeline'))
        node.replaceChildren()
        let content
        try { content = JSON.parse(target.dataset.tooltip || 'null') } catch {}
        const addText = (parent, value, className, style) => {
          if (!value) return
          const child = document.createElement('div')
          child.className = className
          child.textContent = value
          Object.assign(child.style, style)
          parent.appendChild(child)
        }
        if (content) {
          const heading = document.createElement('div')
          heading.style.display = 'flex'
          heading.style.alignItems = 'baseline'
          heading.style.gap = '8px'
          heading.style.flexWrap = 'wrap'
          node.appendChild(heading)
          addText(heading, content.title, 'timeline-tooltip-heading', { fontWeight: '600', fontSize: '13px', lineHeight: '20px', flex: '1', minWidth: '0' })
          if (content.status && content.status !== content.title) addText(heading, content.status, 'timeline-tooltip-status', { fontSize: '11px', opacity: '.8', flex: 'none' })
          addText(node, content.meta, 'timeline-tooltip-meta', { marginTop: '4px', fontSize: '11px', lineHeight: '17px', fontVariantNumeric: 'tabular-nums', opacity: '.8' })
          addText(node, content.duration, 'timeline-tooltip-duration', { marginTop: '2px', fontSize: '11px', lineHeight: '17px', fontVariantNumeric: 'tabular-nums', opacity: '.8', whiteSpace: 'nowrap' })
          addText(node, content.body, 'timeline-tooltip-body', { marginTop: '8px' })
          for (const item of content.items || []) {
            const entry = document.createElement('div')
            entry.className = 'timeline-tooltip-entry'
            entry.style.marginTop = '8px'
            addText(entry, item.at, 'timeline-tooltip-meta', { fontSize: '11px', lineHeight: '17px', fontVariantNumeric: 'tabular-nums', opacity: '.8' })
            addText(entry, item.summary, 'timeline-tooltip-body', { marginTop: '2px' })
            node.appendChild(entry)
          }
        } else node.textContent = target.getAttribute('aria-label')
        node.hidden = false
        Object.assign(node.style, {
          position: 'fixed', inset: 'auto', margin: '0', boxSizing: 'border-box',
          width: `${Math.min(320, window.innerWidth - 16)}px`,
          maxHeight: `${window.innerHeight - 16}px`, overflowY: 'auto',
          padding: '10px 12px', border: '1px solid rgba(127,127,127,.35)',
          borderRadius: '4px', background: theme.backgroundColor, color: theme.color,
          fontFamily: theme.fontFamily, fontSize: '12px', lineHeight: '18px',
          whiteSpace: 'pre-line', overflowWrap: 'anywhere', boxShadow: '0 2px 8px rgba(0,0,0,.08)',
          zIndex: '1000', left: '8px', top: '8px',
        })
        if (typeof node.showPopover === 'function' && !node.matches(':popover-open')) node.showPopover()
        const width = node.getBoundingClientRect().width, height = node.getBoundingClientRect().height
        const below = bounds.bottom + 4
        node.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8))}px`
        node.style.top = `${Math.max(8, Math.min(below + height <= window.innerHeight - 8 ? below : bounds.top - height - 4, window.innerHeight - height - 8))}px`
      }
      const leaveTooltip = event => {
        if (!event.relatedTarget?.nodeType || !tooltipRef.current?.contains(event.relatedTarget)) hideTooltip()
      }
      const elapsed = segment => fmtDuration(Math.max(0, (segment.active ? now : Date.parse(segment.endedAt)) - Date.parse(segment.startedAt)))
      const describe = (segment, total, human) => `${segment.label || '任务执行'} · ${range(segment)} · ${total ? '本次处理历时' : human ? '人工处理等待' : '执行区段历时'} ${elapsed(segment)}${segment.active ? '（进行中）' : ''}`
      const markerLayout = row => {
        const groups = []
        for (const event of [...row.milestones].filter(event => Number.isFinite(Date.parse(event.at)) && Date.parse(event.at) >= start && Date.parse(event.at) <= end).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
          const group = groups.at(-1), at = position(event.at)
          if (group && Date.parse(event.at) === Date.parse(group.events[0].at)) group.events.push(event)
          else groups.push({ at, events: [event] })
        }
        return groups
      }
      const markers = row => markerLayout(row).map(group => {
          const nearby = row.milestones.filter(event => Number.isFinite(Date.parse(event.at)) && Date.parse(event.at) >= start && Date.parse(event.at) <= end && Math.abs(position(event.at) - group.at) <= 3).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
          const content = nearby.map(event => `${time(event.at)} · 阶段成果：${event.summary}`).join('\n')
          return React.createElement(React.Fragment, { key: group.events[0].id },
            React.createElement('button', { type: 'button', className: 'timeline-milestone', style: { left: `${group.at}%` }, 'data-recorded-at': group.events[0].at, 'data-tooltip': JSON.stringify({ title: '阶段成果', items: nearby.map(event => ({ at: time(event.at), summary: event.summary })) }), 'aria-label': content, onFocus: placeTooltip, onMouseEnter: placeTooltip, onMouseLeave: leaveTooltip, onBlur: hideTooltip },
              React.createElement('span', { className: 'timeline-milestone-tick', 'aria-hidden': true })))
        })
      const bar = (segment, total = false, human = false) => {
        if (!segment.startedAt || !segment.active && !segment.endedAt) return null
        const segmentEnd = segment.active ? Math.max(now, Date.parse(segment.startedAt)) : Date.parse(segment.endedAt)
        if (segmentEnd < start || Date.parse(segment.startedAt) > end) return null
        const left = position(segment.startedAt), right = position(segment.active ? new Date(Math.max(now, Date.parse(segment.startedAt))).toISOString() : segment.endedAt)
        const description = describe(segment, total, human)
        return React.createElement(React.Fragment, { key: segment.id || 'total' },
          React.createElement('span', { className: `timeline-bar${total ? ' timeline-total' : ''}${['failed','cancelled','superseded','stale'].includes(segment.status) ? ' timeline-muted' : ''}`,
            style: { left: `${left}%`, width: `${Math.max(0, right - left)}%` }, tabIndex: 0, role: 'img', 'data-tooltip': JSON.stringify({ title: segment.label || '任务执行', status: segment.status ? status(segment.status) : null, meta: range(segment), duration: `${total ? '本次处理历时' : human ? '等待历时' : '执行历时'} ${elapsed(segment)}`, body: segment.description }), 'aria-label': description, onFocus: placeTooltip, onMouseEnter: placeTooltip, onMouseLeave: leaveTooltip, onBlur: hideTooltip },
            React.createElement('span', null, React.createElement('span', { className: 'timeline-activity' }, segment.label || '任务执行'), React.createElement('span', { className: 'timeline-duration' }, elapsed(segment)))))
      }
      return React.createElement('section', { className: 'detail-panel detail-timeline', 'aria-label': '执行时间泳道图' },
        React.createElement('div', { className: 'timeline-heading' }, React.createElement('div', { className: 'timeline-title' }, React.createElement('h2', null, '执行时间'), React.createElement('span', { className: 'timeline-count' }, `${timeline.executions.length} 个会话`)), React.createElement('span', { className: 'timeline-date', title: '时间按浏览器本地时区显示' }, dateLabel)),
        React.createElement('div', { className: 'timeline-navigator', 'aria-label': '时间范围导航器', 'data-full-start': fullStart, 'data-full-end': fullEnd, 'data-start': start, 'data-end': end },
          React.createElement('div', { className: 'timeline-range-caption' },
            React.createElement('span', null, `${navTime(start)} — ${navTime(end)} · ${fmtDuration(end - start)}`),
            React.createElement('button', { type: 'button', disabled: !windowRange, onClick: () => { hideTooltip(); setWindowRange(null) } }, '回到最新')),
          React.createElement('div', { className: 'timeline-overview', ref: overviewRef },
            ...rows.flatMap((row, rowIndex) => row.segments.map(part => React.createElement('span', { key: `${row.id}:${part.id}`, className: 'timeline-overview-activity', style: {
              left: `${overviewPosition(Date.parse(part.startedAt))}%`, width: `${Math.max(0, overviewPosition(part.active ? now : Date.parse(part.endedAt)) - overviewPosition(Date.parse(part.startedAt)))}%`,
              top: `${7 + rowIndex % 4 * 5}px`, background: row.id === 'human' ? '#b48125' : '#5968cf',
            }, 'aria-hidden': true }))),
            React.createElement('div', { className: 'timeline-range-window', style: { left: `${overviewPosition(start)}%`, width: `${overviewPosition(end) - overviewPosition(start)}%` } },
              React.createElement('button', rangeControl('pan', '平移时间范围'), React.createElement('span', { 'aria-hidden': true }, '⋮⋮')),
              React.createElement('button', rangeControl('left', '调整开始时间'), React.createElement('span', { 'aria-hidden': true })),
              React.createElement('button', rangeControl('right', '调整结束时间'), React.createElement('span', { 'aria-hidden': true })))),
          React.createElement('div', { className: 'timeline-overview-labels', 'aria-hidden': true }, React.createElement('span', null, overviewTime(fullStart)), React.createElement('span', null, overviewTime(fullEnd)))),
        React.createElement('div', { className: 'timeline-scroll', role: 'region', tabIndex: 0, 'aria-label': '时间泳道图，可横向滚动；完整活动与时间见下方明细' },
          React.createElement('table', { className: 'timeline-table' }, React.createElement('caption', { className: 'timeline-sr' }, '任务、执行会话与人工介入时间，区段之间保留空档'),
            React.createElement('thead', null, React.createElement('tr', null, React.createElement('th', { scope: 'col' }, '会话 / 时间'), React.createElement('th', { scope: 'col' }, React.createElement('div', { className: 'timeline-axis' }, ...[0, 1, 2, 3, 4].map(index => React.createElement('span', { key: index, style: { left: `${index * 25}%` } }, new Date(axisDate(index / 4)).toLocaleString('zh-CN', { ...(sameDay ? {} : { month: '2-digit', day: '2-digit' }), hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }))))))),
            React.createElement('tbody', null,
              React.createElement('tr', null, React.createElement('th', { scope: 'row' }, '任务执行', timeline.task.complete === false ? React.createElement('small', { className: 'timeline-total-missing' }, '部分历史未记录') : null), React.createElement('td', null, React.createElement('div', { className: 'timeline-track timeline-total-track' }, ...totalSegments.map(segment => bar(segment, true)), !totalSegments.length ? React.createElement('span', { className: 'timeline-empty' }, '完成 / 重开时间未完整记录') : null), React.createElement('span', { className: 'timeline-sr' }, ...totalSegments.map(segment => `${segment.label} · ${range(segment)}；`)))),
              ...rows.map(row => React.createElement('tr', { key: row.id }, React.createElement('th', { scope: 'row', tabIndex: 0, onFocus: placeTooltip, onMouseEnter: placeTooltip, onMouseLeave: leaveTooltip, onBlur: hideTooltip, 'data-tooltip': JSON.stringify({ title: row.title, status: row.status ? status(row.status) : null, body: row.complete ? null : '部分区间未记录' }), 'aria-label': `${row.title}${row.status ? ` · ${status(row.status)}` : ''}${row.complete ? '' : ' · 部分区间未记录'}` }, React.createElement('span', { className: 'timeline-name' }, row.title), row.status ? React.createElement('small', null, status(row.status)) : null, !row.complete ? React.createElement('small', null, '部分区间未记录') : null),
                React.createElement('td', null, React.createElement('div', { className: 'timeline-track' }, ...row.segments.map(segment => bar(segment, false, row.id === 'human')), ...markers(row),
                  !row.segments.length ? React.createElement('span', { className: 'timeline-empty' }, row.complete ? row.id === 'human' ? '暂无人工介入' : '尚未开始执行' : '历史区间未记录') : null),
                  React.createElement('span', { className: 'timeline-sr' }, `${row.segments.length} 个区段${row.complete ? '' : '，部分历史区间未记录'}`))))))),
        React.createElement(TaskOutcomeRecords, { taskId, timeline, readonly }),
        React.createElement('details', { className: 'detail-disclosure timeline-details' }, React.createElement('summary', null, '活动与时间明细'),
          React.createElement('p', { className: 'detail-muted timeline-note' }, '靛蓝为执行会话，金色为人工介入。贯穿色带的细刻线为阶段成果，悬停或聚焦查看附近成果的准确时间；未记录区间不推算，人工处理不表示批准。'),
          React.createElement('section', null, React.createElement('h3', null, '任务完成与重开'), timeline.task.complete === false ? React.createElement('p', null, '部分任务历史时间未记录，不推算完成或重开的时间。') : null,
            totalEvents.length ? React.createElement('ul', null, ...totalEvents.map((event, index) => React.createElement('li', { key: `${event.kind}:${index}` }, `${time(event.at)} · 第 ${event.sequence} 次处理 · ${({ created: '创建任务', completed: '任务完成', reopened: '重新打开', cancelled: '取消任务' })[event.kind] || event.kind}`))) : React.createElement('p', null, '任务历史时间未完整记录。')),
          ...rows.map(row => React.createElement('section', { key: row.id }, React.createElement('h3', null, `${row.title}${row.status ? ` · ${status(row.status)}` : ''}`), !row.complete ? React.createElement('p', null, '部分历史区间未记录；恢复时未知的结束时间不作推算。') : null,
            row.segments.length ? React.createElement('ul', null, ...row.segments.map(segment => React.createElement('li', { key: segment.id }, `${segment.label} · ${range(segment)} · ${elapsed(segment)} · ${status(segment.status)}`, segment.description ? React.createElement('p', null, segment.description) : null))) : React.createElement('p', null, row.milestones.length ? '成果见上方时间记录，活动区间未记录。' : row.complete ? row.id === 'human' ? '暂无人工介入' : '尚未开始执行' : '历史执行过程未记录。')))))
    }
    function TaskDialogue({ taskId, open: controlledOpen, onToggle, hideTrigger = false }) {
      const [localOpen, setLocalOpen] = useState(false), [draft, setDraft] = useState(''), [messages, setMessages] = useState([])
      const open = controlledOpen ?? localOpen, setOpen = onToggle ?? setLocalOpen
      const [busy, setBusy] = useState(false), [error, setError] = useState(''), [readError, setReadError] = useState(''), [writable, setWritable] = useState(false)
      const pending = useRef(false), attempt = useRef(null), editor = useRef(null)
      const merge = incoming => setMessages(current => {
        const records = new Map(current.map(item => [item.id, item]))
        for (const item of incoming) { const old = records.get(item.id); records.set(item.id, old?.reply && !item.reply ? old : item) }
        return [...records.values()].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
      })
      useEffect(() => {
        if (!open) return
        let active = true, timer, controller
        const load = async () => {
          controller = new AbortController()
          try {
            const value = await get(`/state/tasks/${encodeURIComponent(taskId)}/dialogue`, { signal: controller.signal })
            if (active) { merge(value.messages || []); setWritable(value.writable); setReadError(value.error ? `统筹暂未回复：${value.error}` : '') }
          } catch (cause) { if (active) setReadError(`对话读取失败：${cause.message}`) }
          finally { if (active) timer = setTimeout(load, 2000) }
        }
        void load(); editor.current?.focus()
        return () => { active = false; controller?.abort(); clearTimeout(timer) }
      }, [open, taskId])
      const submit = async event => {
        event.preventDefault()
        if (event.nativeEvent?.isComposing || pending.current || !writable || !draft.trim()) return
        attempt.current ||= { requestId: crypto.randomUUID(), text: draft.trim() }
        const body = attempt.current
        pending.current = true; setBusy(true); setError('')
        try {
          const message = await post(`/tasks/${encodeURIComponent(taskId)}/dialogue`, body)
          merge([message]); setDraft(''); attempt.current = null
        } catch (cause) { setError(`发送失败：${cause.message}。可重试，已保存的消息不会重复提交。`) }
        finally { pending.current = false; setBusy(false) }
      }
      const panelId = `task-dialogue-${taskId}`
      if (hideTrigger && !open) return null
      return React.createElement('div', null,
        !hideTrigger ? React.createElement(Button, { type: 'button', variant: 'outline', size: 'sm', 'aria-expanded': open, 'aria-controls': panelId, onClick: () => setOpen(value => !value) }, open ? '收起任务会话' : '介入任务会话') : null,
        open ? React.createElement('section', { id: panelId, className: 'detail-panel', 'aria-label': '与当前任务统筹对话', style: { marginTop: 12 } },
          React.createElement('h2', null, '与任务统筹对话'),
          React.createElement('p', { className: 'detail-muted' }, '可以询问进度、补充信息或提醒执行方向。消息由原统筹处理；本对话不自动改变目标、另派或取消执行。'),
          React.createElement('ol', { 'aria-label': '对话记录', style: { margin: 0, padding: 0, listStyle: 'none', maxHeight: 320, overflowY: 'auto', display: 'grid', gap: 16 } },
            ...messages.map(message => React.createElement('li', { key: message.id, style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } },
              React.createElement('strong', null, `我 · ${fmt(message.receivedAt)}`), React.createElement('p', null, ...linkedTaskText(message.text)),
              message.reply ? React.createElement(React.Fragment, null, React.createElement('strong', null, `统筹 · ${fmt(message.repliedAt)}`), React.createElement('p', null, ...linkedTaskText(message.reply)))
                : React.createElement('span', { role: 'status', className: 'detail-muted' }, '已保存，待统筹处理')))),
          !messages.length ? React.createElement('p', { className: 'detail-muted' }, '暂无对话记录。') : null,
          readError ? React.createElement('p', { role: 'alert' }, readError) : null,
          React.createElement('form', { noValidate: true, onSubmit: submit, style: { display: 'grid', gap: 12 } },
            React.createElement('label', { className: 'observer-config-field' }, '消息', React.createElement('textarea', { ref: editor, className: 'observer-config-input', rows: 3, maxLength: 10000, value: draft, disabled: busy,
              'aria-describedby': error ? `${panelId}-error` : undefined, onChange: event => { setDraft(event.target.value); attempt.current = null } })),
            error ? React.createElement('p', { id: `${panelId}-error`, role: 'alert' }, error) : null,
            !writable ? React.createElement('p', { className: 'detail-muted' }, '正在确认任务状态；已结束、暂停或归档的任务仅可回读对话。') : null,
            React.createElement(Button, { type: 'submit', disabled: busy || !writable || !draft.trim(), style: { justifySelf: 'start', minWidth: 90 } }, busy ? '保存中…' : '发送')))
          : null)
    }
    function TaskSessionDetail({ task, onOpenSession, onBack, updatedAt, onOpenHumanRequest, onOpenTask }) {
      const [dialogueTarget, setDialogueTarget] = useState('')
      const dialogueOpen = dialogueTarget === task.taskId
      const setDialogueOpen = value => setDialogueTarget(current => (typeof value === 'function' ? value(current === task.taskId) : value) ? task.taskId : '')
      const requirements = task.requirements || task.acceptanceCriteria || []
      const humanRequest = !task.legacyReadonly && task.humanRequests?.findLast(request => request.status === 'waiting-reply')
      const question = !task.legacyReadonly && (humanRequest?.question || task.lastDecision?.question)
      return React.createElement('section', { className: 'observer-session-detail', 'aria-label': '任务会话详情' },
        React.createElement('style', null, taskDetailCss),
        React.createElement('header', { className: 'detail-header' },
          React.createElement('div', { className: 'detail-topline' }, React.createElement(Button, { type: 'button', variant: 'outline', size: 'sm', onClick: onBack }, '返回看板'), React.createElement('span', { className: 'detail-muted' }, '任务详情')),
          React.createElement('div', { className: 'detail-title-row' }, React.createElement('h1', null, task.title?.trim() || taskDisplayTitle(task)), statusTag(task.legacyReadonly ? '历史只读' : taskStateLabel(task.state), taskStateTone(task.state))),
          React.createElement('div', { className: 'detail-meta' }, React.createElement('span', null, `创建 ${fmt(task.createdAt)}`), React.createElement('span', null, `更新 ${fmt(task.updatedAt)}`), !task.legacyReadonly ? React.createElement('span', null, `${task.executionCount ?? '未记录'} 次独立执行`) : null)),
        task.waitingReason || question ? React.createElement('section', { className: 'detail-attention', 'aria-label': '阻塞与待处理' },
          React.createElement('h2', null, question ? '等待答复' : '当前等待 / 阻塞'),
          question ? React.createElement(HumanRequestContent, { request: humanRequest || { reason: traceReason(task.waitingReason), question, evidence: task.lastDecision?.evidence } })
            : React.createElement('p', null, ...linkedTaskText(traceReason(task.waitingReason))),
          question ? React.createElement(Button, { type: 'button', variant: 'outline', onClick: () => onOpenHumanRequest(task.taskId) }, '查看人工介入问题') : null) : null,
        React.createElement('div', { className: 'detail-columns' },
          React.createElement('div', { className: 'detail-primary' },
            React.createElement('section', { className: 'detail-panel', 'aria-label': '目标与要求' }, React.createElement('h2', null, '目标与要求'), React.createElement('p', { className: 'detail-objective' }, task.objective || '尚未记录任务目标。'),
              requirements.length ? React.createElement('div', { className: 'detail-requirements' }, React.createElement('h3', null, '验收要求'), React.createElement('ul', null, ...requirements.map((item, index) => React.createElement('li', { key: index }, readableValue(item))))) : null,
              task.context ? React.createElement('details', { className: 'detail-disclosure' }, React.createElement('summary', null, '参考资料'), React.createElement('p', { className: 'detail-objective' }, readableValue(task.context))) : null),
            React.createElement(TaskResult, { result: task.result })),
          React.createElement('aside', { className: 'detail-sidebar', 'aria-label': '统筹会话与记录' },
            !task.legacyReadonly ? React.createElement(SessionLocation, { session: taskSession(task), label: '任务会话', onOpenSession, compact: true,
              primaryAction: React.createElement(Button, { type: 'button', variant: 'outline', size: 'sm', style: { justifySelf: 'start', minWidth: 110 }, 'aria-expanded': dialogueOpen, 'aria-controls': `task-dialogue-${task.taskId}`, onClick: () => setDialogueOpen(value => !value) }, dialogueOpen ? '收起任务会话' : '介入任务会话') }) : null,
            React.createElement('details', { className: 'detail-records' }, React.createElement('summary', null, '任务记录与修订'), React.createElement('div', { className: 'detail-location' },
              React.createElement('div', null, `任务 ID：${task.taskId}`), React.createElement('div', null, `需求修订 ${task.requirementRevision ?? task.inputVersion ?? '未记录'}`), React.createElement('div', null, `控制修订 ${task.controlRevision ?? '未记录'}`), React.createElement('div', null, `控制状态 ${taskStateLabel(task.controlState || task.control?.state || task.state)}`),
              task.blockers ? readout('待排空记录（原始信息）', task.blockers) : null)))),
        !task.legacyReadonly ? React.createElement(TaskDialogue, { key: `dialogue:${task.taskId}`, taskId: task.taskId, open: dialogueOpen, onToggle: setDialogueOpen, hideTrigger: true }) : null,
        React.createElement(TaskExecutionTimeline, { key: `timeline:${task.taskId}`, timeline: task.timeline, taskId: task.taskId, readonly: task.legacyReadonly }),
        task.legacyReadonly ? React.createElement('div', { className: 'detail-panel' }, React.createElement('h2', null, '历史执行'), React.createElement(LegacyTaskHistory, { key: task.taskId, task }))
          : React.createElement(TaskExecutions, { key: task.taskId, taskId: task.taskId, updatedAt, onOpenSession }))
    }
    function FeedbackNotice({ text, error = false }) {
      const [visible, setVisible] = useState(true)
      useEffect(() => {
        setVisible(true)
        if (error) return
        const timer = window.setTimeout(() => setVisible(false), 5000)
        return () => window.clearTimeout(timer)
      }, [text, error])
      if (!visible) return null
      return React.createElement('div', { role: error ? 'alert' : 'status', style: { ...card, display: 'flex', alignItems: 'center', gap: 12, color: error ? colors.danger : colors.muted, ...(error ? { borderColor: colors.danger } : {}) } },
        React.createElement('span', { style: { flex: 1, minWidth: 0, overflowWrap: 'anywhere' } }, text),
        React.createElement(Button, { type: 'button', variant: 'ghost', size: 'sm', 'aria-label': '关闭提示', onClick: () => setVisible(false) }, '关闭'))
    }
    function CardExecutionPage({ task, updatedAt, navigate, navigatingSessionId }) {
      const [offset, setOffset] = useState(0), [page, setPage] = useState(), [error, setError] = useState(''), [retry, setRetry] = useState(0)
      const pending = useRef()
      const pageKey = `${task.taskId}:${offset}`
      useEffect(() => { setError(''); return () => { pending.current?.controller.abort(); pending.current = undefined } }, [task.taskId,offset])
      useEffect(() => {
        let active = true
        if (!pending.current) {
          const controller = new AbortController()
          const request = { controller, promise: get(`/state/tasks/${encodeURIComponent(task.taskId)}/executions?summary=true&offset=${offset}&limit=10`, {signal:controller.signal}) }
          pending.current = request
          request.promise.finally(() => { if (pending.current === request) pending.current = undefined }).catch(() => {})
        }
        pending.current.promise.then(value => {
          if (!active) return
          if (offset && offset >= value.total) { setOffset(Math.max(0,Math.floor((value.total-1)/10)*10)); return }
          setError(''); setPage({...value,key:pageKey})
        },cause=>{if(active)setError(cause.message)})
        return ()=>{active=false}
      },[task.taskId,offset,updatedAt,retry])
      const visiblePage = page?.key === pageKey ? page : undefined
      const sessions = visiblePage?.executions || [], session = taskSession(task)
      return React.createElement('div', { 'aria-busy': !visiblePage && !error, style: { minHeight: Math.max(1, Math.min(10, Number(task.executionCount) || sessions.length)) * 28, fontSize: 11 } },
        error ? React.createElement('p',{role:'alert',style:{margin:'6px 0',color:colors.danger}},`读取执行记录失败：${error}`, React.createElement(Button,{type:'button',variant:'outline',size:'sm',onClick:()=>setRetry(value=>value+1)},'重试')) : !visiblePage ? React.createElement('span',{role:'status','aria-label':'正在加载执行会话',style:{display:'inline-flex',alignItems:'center',gap:6,minHeight:28,color:colors.muted,fontSize:11}},React.createElement(StateDot,{state:'ongoing',size:7}),'加载中') : null,
        visiblePage && !sessions.length ? React.createElement('p',{role:'status',style:{margin:'6px 0',color:colors.muted}},'暂无执行记录') : null,
        React.createElement('div', { style: { display: 'grid', gap: 2, paddingTop: 6 } }, ...sessions.map(execution => {
              const done = ['succeeded', 'completed'].includes(execution.status)
              const running = execution.status === 'running'
              const active = running && !execution.drained && !execution.recovering
              const failed = execution.status === 'failed'
              const nativeSession = (execution.executionBackend ?? 'dsh') === 'dsh'
              const tone = done ? 'var(--dsw-alias-state-success-primary, #248a3d)' : running ? colors.accent : failed ? colors.danger : colors.muted
              return React.createElement(nativeSession ? 'button' : 'div', { key: execution.sessionId || execution.executionId, className: 'observer-execution-session', ...(nativeSession ? { type: 'button', disabled: !execution.sessionId || navigatingSessionId === execution.sessionId, 'aria-busy': navigatingSessionId === execution.sessionId, onClick: () => navigate(execution.sessionId, session.sessionId) } : {}), style: { display: 'grid', gridTemplateColumns: '14px minmax(0, 1fr) auto', alignItems: 'start', gap: 7, minWidth: 0, padding: '6px 0', border: 0, borderRadius: 4, background: 'transparent', color: 'inherit', fontFamily: 'inherit', fontSize: 11, lineHeight: 1.5, textAlign: 'left', cursor: nativeSession && execution.sessionId ? 'pointer' : 'default' } },
                active ? React.createElement('span', { role: 'img', 'aria-label': taskStateLabel(execution.status), title: taskStateLabel(execution.status), style: { display: 'inline-flex', width: 14, height: 14, marginTop: 1 } }, React.createElement(StateDot, { state: 'ongoing', size: 14 })) : React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: tone, strokeWidth: 1.3, role: 'img', 'aria-label': taskStateLabel(execution.status), style: { marginTop: 1 } },
                  React.createElement('title', null, taskStateLabel(execution.status)),
                  React.createElement('circle', { cx: 8, cy: 8, r: 5.6, fill: done ? tone : 'none' }),
                  done ? React.createElement('path', { d: 'm5 8 2 2 4-4', stroke: 'white' }) : running ? React.createElement('circle', { cx: 8, cy: 8, r: 2, fill: tone, stroke: 'none' }) : failed ? React.createElement('path', { d: 'M8 4.5v4M8 10v1' }) : null),
                React.createElement('span', { title: execution.title, style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, execution.title, nativeSession ? null : ' · Claude Code'),
                React.createElement('span', { style: { whiteSpace: 'nowrap', color: tone, fontSize: 10.5 } }, React.createElement(ExecutionSessionDuration, { timing: execution.latestRoundTiming })))
            })),
        visiblePage && visiblePage.total > 10 ? React.createElement('nav',{'aria-label':'执行会话分页',style:{display:'flex',gap:8}},
          React.createElement(Button,{type:'button',variant:'outline',size:'sm',disabled:offset===0,onClick:()=>setOffset(value=>Math.max(0,value-10))},'上一页'),
          React.createElement('span',null,`${Math.floor(offset/10)+1}/${Math.max(1,Math.ceil(visiblePage.total/10))}`),
          React.createElement(Button,{type:'button',variant:'outline',size:'sm',disabled:visiblePage.nextOffset===null,onClick:()=>setOffset(visiblePage.nextOffset)},'下一页')) : null)
    }
    function ObserverContent({ openSession }) {
      const [activePage, updateActivePage] = useState(readActivePage)
      const setActivePage = useCallback(page => {
        sessionNavigationVersion++
        setNavigatingSessionId('')
        updateActivePage(page)
        // 导航属于看板，不能随宿主 conversation 插槽重挂载而丢失。
        try { window.sessionStorage.setItem(activePageStorageKey, page) }
        catch { /* 浏览器禁用存储时仍允许正常切页。 */ }
      }, [])
      const [topicTarget, setTopicTarget] = useState()
      const [data, setData] = useState()
      const [expandedTaskId, setExpandedTaskId] = useState('')
      const expansionInitialized = useRef(false)
      const archivedTasksRef = useRef(new Map())
      const archivePending = useRef(new Set())
      const [archivingIds, setArchivingIds] = useState([])
      const [archiveFeedback, setArchiveFeedback] = useState(null)
      useEffect(() => {
        if (!data) return
        const visible = data.tasks.filter(task => !task.archivedAt && !task.legacyReadonly)
        if (!expansionInitialized.current) {
          expansionInitialized.current = true
          setExpandedTaskId(visible.filter(task => task.state === 'running').sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0]?.taskId || '')
        } else setExpandedTaskId(id => visible.some(task => task.taskId === id) ? id : '')
      }, [data])
      const archiveTask = async task => {
        if (archivePending.current.has(task.taskId)) return
        archivePending.current.add(task.taskId); setArchivingIds([...archivePending.current]); setArchiveFeedback(null)
        try {
          const archived = await post(`/tasks/${encodeURIComponent(task.taskId)}/archive`)
          if (!archived?.archivedAt || archived.taskId !== task.taskId) throw new Error('归档响应无效，请刷新核对')
          archivedTasksRef.current.set(task.taskId, { archivedAt: archived.archivedAt, archivedBy: archived.archivedBy })
          setData(current => ({ ...current, tasks: current.tasks.map(item => item.taskId === task.taskId ? { ...item, ...archived } : item) }))
          setExpandedTaskId(id => id === task.taskId ? '' : id)
          setArchiveFeedback({ text: `已归档：${task.title || task.taskId}` })
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          setArchiveFeedback({ error: true, text: /NOT_QUIESCENT/.test(message) ? '归档失败：任务须已完成或已取消，且所有执行已结束；归档不会停止活动执行。' : `归档失败：${message}` })
        } finally { archivePending.current.delete(task.taskId); setArchivingIds([...archivePending.current]) }
      }
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
      const authorizationIdentity=useRef(null),[authorizationDetailData,setAuthorizationDetailData]=useState(),[authorizationDetailError,setAuthorizationDetailError]=useState('')
      const openAuthorization=item=>{if(!item)return;authorizationIdentity.current={taskId:item.taskId,requestId:item.requestId};setAuthorizationDetailData(item);setSelectedAuthorizationId(item.requestId)}
      const pendingRefresh = useRef(null), pageSnapshots = useRef({})
      const refresh = useCallback(() => {
        const key = JSON.stringify([activePage,taskPages,historyPage,selectedGroupId,messagePage,outboxPage,messageDeliveryFilter,outboxStatusFilter,authorizationPage,authorizationFilter,alertType,alertView,resolvedAlertPage])
        if (pendingRefresh.current?.key === key) return pendingRefresh.current.promise
        pendingRefresh.current?.controller.abort()
        const revisions = {}
        for (const bucket of taskBuckets) {
          const prior = pageSnapshots.current[bucket.state], offset = ((taskPages[bucket.state] || 1)-1)*10
          if (offset && prior && prior.offset !== offset) revisions[bucket.state] = prior.revision
        }
        const previousArchive = pageSnapshots.current.archive
        if (historyPage > 1 && previousArchive && previousArchive.offset !== (historyPage-1)*20) revisions.archive = previousArchive.revision
        for(const [collection,page,filter] of [['messages',messagePage,messageDeliveryFilter],['outbox',outboxPage,outboxStatusFilter]]){
          const prior=pageSnapshots.current[collection]
          if(page>1&&prior&&(!selectedGroupId||prior.groupId===selectedGroupId)&&prior.filter===filter&&prior.offset!==(page-1)*10)revisions[collection]=prior.revision
        }
const previousAuthorization=pageSnapshots.current.authorizations
        if(activePage==='authorizations'&&authorizationPage>1&&previousAuthorization?.filter===authorizationFilter&&previousAuthorization.offset!==(authorizationPage-1)*10)revisions.authorizations=previousAuthorization.revision
        const request = {key,controller:new AbortController()}
        request.promise = load({activePage,signal:request.controller.signal,taskPages,historyPage,revisions,selectedGroupId,messagePage,outboxPage,messageDeliveryFilter,outboxStatusFilter,authorizationPage,authorizationFilter,alertType,resolvedAlertPage}).then(value => {
          if (pendingRefresh.current !== request) return
          pageSnapshots.current = {...pageSnapshots.current, ...(activePage==='tasks'?value.taskCollections:{}), ...(activePage==='archive'?{archive:value.archiveCollection}:{}), ...value.groupCollections, ...(activePage==='authorizations'?{authorizations:{...value.authorizationCollection,filter:authorizationFilter}}:{})}
          setData({ ...value, tasks: (value.tasks || []).map(task => archivedTasksRef.current.has(task.taskId) ? { ...task, ...archivedTasksRef.current.get(task.taskId) } : task) })
          const clamped = {...taskPages}; let changed = false
          for (const bucket of taskBuckets) {
            const maximum = Math.max(1,Math.ceil(value.taskCollections[bucket.state].total/10))
            if ((clamped[bucket.state] || 1)>maximum) {clamped[bucket.state]=maximum;changed=true}
          }
          if(changed&&activePage==='tasks')setTaskPages(clamped)
          if(activePage==='archive'&&(historyPage-1)*20>=value.archiveCollection.total && historyPage>1)setHistoryPage(Math.max(1,Math.ceil(value.archiveCollection.total/20)))
          for(const [name,setPage,page] of [['messages',setMessagePage,messagePage],['outbox',setOutboxPage,outboxPage]]){const collection=value.groupCollections?.[name];if(collection&&page>1&&(page-1)*10>=collection.total)setPage(Math.max(1,Math.ceil(collection.total/10)))}
          if(activePage==='authorizations'&&authorizationPage>1&&(authorizationPage-1)*10>=value.authorizationCollection.total)setAuthorizationPage(Math.max(1,Math.ceil(value.authorizationCollection.total/10)))
          const alertTotal=value.alertCollections?.[alertView]?.total
          if(activePage==='alerts'&&resolvedAlertPage>1&&alertTotal!==undefined&&(resolvedAlertPage-1)*10>=alertTotal)setResolvedAlertPage(Math.max(1,Math.ceil(alertTotal/10)))
          setUpdatedAt(new Date());setError(undefined)
        },cause=>{
          if(pendingRefresh.current !== request||cause.name==='AbortError')return
          if(cause.status===409){pageSnapshots.current={};setTaskPages({});setHistoryPage(1);setMessagePage(1);setOutboxPage(1);setAuthorizationPage(1);setResolvedAlertPage(1);setError('列表已更新，已返回第一页，请重新翻页。')}
          else setError(cause instanceof Error ? cause.message : String(cause))
        }).finally(()=>{if(pendingRefresh.current===request)pendingRefresh.current=null})
        pendingRefresh.current=request
        return request.promise
      }, [activePage,taskPages,historyPage,selectedGroupId,messagePage,outboxPage,messageDeliveryFilter,outboxStatusFilter,authorizationPage,authorizationFilter,alertType,alertView,resolvedAlertPage])
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
        return () => { window.clearInterval(timer); pendingRefresh.current?.controller.abort(); pendingRefresh.current=null }
      }, [refresh])
      useEffect(() => {
        const closeForSession = (event) => {
          if (event.target instanceof Element && event.target.closest('[role="treeitem"]')) setOpen(false)
        }
        document.addEventListener('click', closeForSession, true)
        return () => { sessionNavigationVersion++; document.removeEventListener('click', closeForSession, true) }
      }, [])
      useEffect(()=>{
        const identity=authorizationIdentity.current
        if(!selectedAuthorizationId||identity?.requestId!==selectedAuthorizationId)return
        const controller=new AbortController();let active=true;setAuthorizationDetailError('')
        get(`/state/authorizations/${encodeURIComponent(identity.requestId)}?taskId=${encodeURIComponent(identity.taskId)}`,{signal:controller.signal}).then(value=>{if(active)setAuthorizationDetailData(value)},cause=>{if(active)setAuthorizationDetailError(cause.message)})
        return()=>{active=false;controller.abort()}
      },[selectedAuthorizationId,updatedAt])
      const groupsById = new Map((data?.groups || []).map((group) => [group.groupId, group]))
      const tasksById = new Map((data?.tasks || []).map(task => [task.taskId, task]))
      const topicsById = new Map((data?.topics || []).map((topic) => [`${topic.groupId}:${topic.topicId}`, topic]))
      const navigate = async (sessionId, parentSessionId) => {
        const version = ++sessionNavigationVersion
        const isCurrent = () => open && version === sessionNavigationVersion
        try {
          setNavigationError(undefined); setNavigatingSessionId(sessionId)
          await openSession(sessionId, parentSessionId, { isCurrent })
          if (isCurrent()) setOpen(false)
        } catch (cause) { if (isCurrent()) setNavigationError(cause instanceof Error ? cause.message : String(cause)) }
        finally { if (version === sessionNavigationVersion || !open) setNavigatingSessionId('') }
      }
      const openTask = task => { setSelectedTaskId(task.taskId); setActivePage('tasks') }
      const returnFromTask = () => { sessionNavigationVersion++; setNavigatingSessionId(''); setSelectedTaskId('') }
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
      const messageCollection=data?.groupCollections?.messages
      const selectedMessages=messageCollection&&messageCollection.groupId===selectedGroup?.groupId&&messageCollection.filter===messageDeliveryFilter?messageCollection.items:[]
      const messageWorkflowState = (message) => {
        if (['routing', 'processing', 'needs_clarification', 'processed', 'failed', 'unknown'].includes(message.processingState)) return message.processingState
        if (message.routingStatus === 'failed') return 'failed'
        if (message.routingStatus !== 'routed') return 'routing'
        return 'unknown'
      }
      const filteredMessages = selectedMessages
      const pageSize = 10
      const pageCount = Math.max(1, Math.ceil((messageCollection?.total||0) / pageSize))
      const currentMessagePage = Math.min(messagePage, pageCount)
      const messagesLoading=!messageCollection||messageCollection.groupId!==selectedGroup?.groupId||messageCollection.filter!==messageDeliveryFilter||messageCollection.offset!==(currentMessagePage-1)*pageSize
      const visibleMessages = messageCollection?.offset===(currentMessagePage-1)*pageSize?filteredMessages:[]
      const delivery = {
        routing: { label: '待归类', state: 'ongoing' },
        processing: { label: '处理中', state: 'ongoing' },
        needs_clarification: { label: '待澄清', state: 'waiting' },
        processed: { label: '语义完成', state: 'done' },
        failed: { label: '处理失败', state: 'error' },
        unknown: { label: '状态未知', state: 'waiting' },
      }
      const messageRows = visibleMessages.map((message, rowIndex) => {
        const workflowState = messageWorkflowState(message)
        const status = delivery[workflowState]
        const recovery = message.processingRecovery
        const recoveryBody = recovery ? { messageVersion: message.messageVersion, activeUnitRefs: message.activeUnitRefs || [], phase: recovery.phase, requestId: recovery.requestId, token: recovery.token } : null
        const conclusion = message.processingConclusion ? `${workflowState === 'needs_clarification' ? '待补充' : '结论'}：${message.processingConclusion}`
          : workflowState === 'processed' ? '结论未记录'
          : workflowState === 'needs_clarification' ? '等待补充必要信息'
          : workflowState === 'failed' ? '未完成，需排查后按原请求恢复'
            : message.processingRetrying ? '等待自动重试，尚未完成'
              : workflowState === 'unknown' ? '处理状态未记录' : '尚未处理完成'
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
          React.createElement('td', { style: { ...tableBodyCell, width: 160 } }, React.createElement('div', { style: { display: 'flex', gap: 4, minWidth: 0, overflow: 'hidden' } }, ...(message.taskSessionRefs || []).map(taskId => React.createElement(Button, { key: `task:${taskId}`, type: 'button', variant: 'outline', size: 'sm', onClick: () => openTask(tasksById.get(taskId) || { taskId }), style: { maxWidth: 140, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }, 'aria-label': `查看任务 ${message.taskTitles?.[taskId] || tasksById.get(taskId)?.title || taskId}` }, taskDisplayTitle({title:message.taskTitles?.[taskId] || tasksById.get(taskId)?.title || taskId}))), ...(message.topicRefs?.length ? message.topicRefs.map((ref) => React.createElement('button', { key: ref.topicId, type: 'button', title: ref.title, 'aria-label': `话题 ${ref.title}`, onClick: () => { setTopicTarget({ groupId: selectedGroup.groupId, topicId: ref.topicId, revision: ref.revision }); setActivePage('topics') }, style: { ...pill(colors.accent), display: 'inline-block', flex: '0 1 auto', minWidth: 0, maxWidth: 120, border: 0, padding: '2px 7px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer', fontFamily: 'inherit' } }, ref.title)) : message.taskSessionRefs?.length ? [] : [React.createElement('span', { key: 'unrouted', style: { color: colors.muted, fontSize: 12 } }, workflowState === 'processed' ? '—' : workflowState === 'needs_clarification' ? '关联待确认' : workflowState === 'unknown' ? '关联未记录' : '待归类')]))),
          React.createElement('td', { title: message.text, style: tableBodyCell }, clampTableContent(message.text || '（空消息）'),
            React.createElement('div', { 'aria-label': '处理结论与历时', style: { display: 'flex', gap: 12, minWidth: 0, marginTop: 4, height: 20, lineHeight: '20px', fontSize: 12, color: colors.muted } },
              React.createElement('span', { title: conclusion, tabIndex: 0, 'aria-label': conclusion, style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, conclusion),
              React.createElement('span', { title: '消息发生至本轮语义决策结束，不是业务执行耗时', style: { flex: '0 0 auto', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } }, ['processed', 'needs_clarification'].includes(workflowState) ? messageProcessingElapsed(message) : '—'))),
          React.createElement('td', { style: { ...tableBodyCell, width: 240 } }, singleLineTableContent(React.createElement('code', { title: message.messageId, style: { fontSize: 14, color: colors.muted, whiteSpace: 'nowrap' } }, `#${message.sequence ?? '—'} · ${short(message.messageId)}`)), message.runId ? React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', onClick: () => setSelectedMessageRunId(message.runId), style: { marginTop: 5 } }, '处理过程') : null, recovery && workflowState !== 'processed' ? React.createElement(MessageRecovery, { key: recovery.requestId, path: `/config/groups/${encodeURIComponent(selectedGroup.groupId)}/messages/${encodeURIComponent(message.messageId)}/retry`, body: recoveryBody, token: recovery.token, onChanged: refresh }) : workflowState === 'failed' ? React.createElement('div', { style: { marginTop: 6, fontSize: 11, color: colors.muted } }, messageFailureHint(message.processingFailureCode)) : null, messageFacts))
      })
      const outboxCollection=data?.groupCollections?.outbox
      const selectedOutbox=outboxCollection&&outboxCollection.groupId===selectedGroup?.groupId&&outboxCollection.filter===outboxStatusFilter?outboxCollection.items:[]
      const filteredOutbox=selectedOutbox,outboxPageSize=10
      const outboxPageCount=Math.max(1,Math.ceil((outboxCollection?.total||0)/outboxPageSize)),currentOutboxPage=Math.min(outboxPage,outboxPageCount)
      const outboxLoading=!outboxCollection||outboxCollection.groupId!==selectedGroup?.groupId||outboxCollection.filter!==outboxStatusFilter||outboxCollection.offset!==(currentOutboxPage-1)*outboxPageSize
      const visibleOutbox=outboxCollection?.offset===(currentOutboxPage-1)*outboxPageSize?filteredOutbox:[]
      const outboxRows = visibleOutbox.map((message, rowIndex) => {
        const status = outboxDelivery(message)
        const recovery = message.notificationRecovery
        return React.createElement('tr', { key: message.outboundId, style: { background: rowIndex % 2 ? `color-mix(in srgb, ${colors.surface2} 55%, transparent)` : colors.cardSurface } },
          React.createElement('td', { title: status.hint, style: { ...tableBodyCell, width: 124 } }, clampTableContent(tableStatusTag(status.label, status.state, { fontWeight: 600 }))),
          React.createElement('td', { style: { ...tableBodyCell, width: 180 } }, message.deliveredAt ? fmt(message.deliveredAt) : '未记录'),
          React.createElement('td', { title: message.text, style: tableBodyCell }, clampTableContent(message.text || '（空消息）'),
            status.detail ? React.createElement('div', { style: { marginTop: 6, fontSize: 12, color: status.state === 'error' ? colors.danger : colors.muted, overflowWrap: 'anywhere' } }, status.detail) : null,
            status.replacementId || status.recall.id !== 'none' ? React.createElement('div', { style: { marginTop: 3, display: 'flex', gap: 12, fontSize: 11, color: colors.muted } },
              status.replacementId ? React.createElement('span', null, '已替代') : null,
              status.recall.id !== 'none' ? React.createElement('span', null, `撤回：${status.recall.label}${status.recall.detail ? `（${status.recall.detail}）` : ''}`) : null) : null,
            !status.retryDisabled && (status.id === 'confirmation' || status.id === 'failed' && message.notificationKnownNotSent === true) && message.notificationRetryAt ? React.createElement('div', { style: { marginTop: 3, fontSize: 11, color: colors.muted } }, `计划${status.id === 'confirmation' ? '核验' : '重试'} ${fmt(message.notificationRetryAt)}`) : null),
          React.createElement('td', { style: { ...tableBodyCell, width: 220 } },
            singleLineTableContent(React.createElement('span', { style: { fontSize: 12, color: colors.muted } }, message.replyToMessageId ? '回复群消息' : message.notificationTaskId ? '任务通知' : message.sourceMessageId ? '群消息' : '来源未记录')),
            recovery?.action && !status.retryDisabled ? React.createElement(MessageRecovery, { path: `/config/groups/${encodeURIComponent(selectedGroup.groupId)}/notifications/${encodeURIComponent(message.outboundId)}/retry`, body: { expectedToken: recovery.expectedToken }, token: recovery.expectedToken, readback: recovery.action === 'readback', onChanged: refresh }) : null,
            React.createElement('details', { style: { marginTop: 5, fontSize: 11, color: colors.muted, overflowWrap: 'anywhere' } }, React.createElement('summary', { style: { cursor: 'pointer' } }, '消息记录'),
              React.createElement('div', null, `来源 ID：${message.sourceMessageId || '未记录'}`),
              message.replyToMessageId ? React.createElement('div', null, `引用消息 ID：${message.replyToMessageId}`) : null,
              React.createElement('div', null, `投递 ID：${message.deliveredMessageId || '尚未确认'}`),
              React.createElement('div', null, `发信 ID：${message.outboundId}`),
              message.deliveryPendingReason ? React.createElement('div', null, `原因记录：${message.deliveryPendingReason}`) : null,
              status.replacementId ? React.createElement('div', null, `替代通知：${status.replacementId}`) : null,
              typeof message.deliveryError === 'string' && message.deliveryError ? React.createElement('div', null, `${status.id === 'confirmed' ? '历史诊断' : '诊断'}：${message.deliveryError}`) : null,
              typeof message.recallError === 'string' && message.recallError ? React.createElement('div', null, `撤回诊断：${message.recallError}`) : null,
              message.deliveryAttemptedAt ? React.createElement('div', null, `最近尝试 ${fmt(message.deliveryAttemptedAt)} · 共 ${message.deliveryAttemptCount || 1} 次`) : null)))
      })
      const renderTaskCard = task => {
        const sourceGroup = groupsById.get(task.sourceGroupId || task.groupId)
        const groupLabel = sourceGroup?.name || (task.groupId?.startsWith('web:') ? 'Web 任务' : task.groupId) || '未关联群聊'
        const historical = task.legacyReadonly || task.archivedAt
        const hovered = hoveredTaskId === task.taskId
        const queued = task.state === 'queued'
        const sessions = historical ? [] : task.executionSessions || []
        const completedSessions = historical ? 0 : task.completedExecutionCount ?? sessions.filter(item => ['succeeded', 'completed'].includes(item.status)).length
        const sessionCount = historical ? 0 : task.executionCount ?? sessions.length
        const displayObjective = String(task.objective || '').startsWith('[TASK_SOURCE_EVIDENCE]') ? (task.title || task.objective) : task.objective
        return React.createElement('article', { key: task.taskId, onClick: event => { if (!event.target.closest('button, summary, details')) openTask(task) }, onMouseEnter: () => setHoveredTaskId(task.taskId), onMouseLeave: () => setHoveredTaskId(''), style: { width: '100%', minWidth: 0, boxSizing: 'border-box', border: `1px solid ${colors.border}`, borderRadius: 12, background: colors.cardSurface, boxShadow: hovered ? '0 8px 20px rgba(15,23,42,.08), 0 2px 6px rgba(15,23,42,.05)' : 'var(--dsw-shadow-card, 0 1px 2px rgba(0,0,0,.08))', padding: '11px 13px', color: 'inherit', display: 'grid', gap: 6, opacity: queued ? 0.72 : 1, transition: 'box-shadow 180ms ease' } },
          React.createElement('button', { type: 'button', onClick: () => openTask(task), style: { width: '100%', minWidth: 0, boxSizing: 'border-box', border: 0, padding: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', textAlign: 'left', display: 'grid', gap: 6, fontFamily: 'inherit' } },
            React.createElement('strong', { title: task.title || task.objective, style: { fontSize: 13, lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' } }, taskDisplayTitle(task))),
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, overflow: 'hidden' } },
            React.createElement('span', { title: groupLabel, style: { ...pill(colors.muted), flex: '0 1 auto', maxWidth: 150, padding: '2px 7px', fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, groupLabel),
            task.legacyReadonly ? React.createElement('span', { style: { color: colors.muted, fontSize: 10.5, whiteSpace: 'nowrap' } }, '历史只读') : null,
            ...(task.topicRefs || []).map(ref => {
              const groupId = ref.groupId || task.sourceGroupId || task.groupId
              const label = ref.title || topicsById.get(`${groupId}:${ref.topicId}`)?.title || '话题名称未记录'
              return React.createElement('button', { key: `${groupId}:${ref.topicId}`, type: 'button', title: label, 'aria-label': `话题 ${label}`, onClick: event => { event.stopPropagation(); setTopicTarget({ groupId, topicId: ref.topicId, revision: ref.revision }); setActivePage('topics') }, style: { ...pill(colors.accent), display: 'inline-block', border: 0, fontFamily: 'inherit', flex: '0 1 auto', minWidth: 0, maxWidth: 96, padding: '2px 7px', fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' } }, label)
            })),
          React.createElement('button', { type: 'button', title: displayObjective, 'aria-label': '查看完整任务目标', onClick: () => openTask(task), style: { border: 0, padding: 0, background: 'transparent', color: 'inherit', textAlign: 'left', fontFamily: 'inherit', cursor: 'pointer', minWidth: 0, display: 'block', maxHeight: '4.5em', overflow: 'hidden', overflowWrap: 'anywhere', fontSize: 11, lineHeight: 1.5 } },
            React.createElement('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, style: { display: 'inline-block', verticalAlign: -2, marginRight: 5, color: colors.muted } }, React.createElement('circle', { cx: 8, cy: 8, r: 5.5 }), React.createElement('circle', { cx: 8, cy: 8, r: 2 }), React.createElement('path', { d: 'M8 1v2M15 8h-2' })), displayObjective),
          !historical && sessionCount ? React.createElement('details', { className: 'observer-card-sessions', open: expandedTaskId === task.taskId, 'aria-label': '全部执行会话', style: { minWidth: 0, padding: '8px 9px', border: `1px solid ${colors.border}`, borderRadius: 8, background: colors.surface2 } },
            React.createElement('summary', { onClick: event => { event.preventDefault(); event.stopPropagation(); setExpandedTaskId(id => id === task.taskId ? '' : task.taskId) }, style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, cursor: 'pointer', fontSize: 11, color: colors.muted, listStyle: 'none' } },
              React.createElement('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, 'aria-hidden': true }, React.createElement('path', { d: 'M2 3h2v2H2zM6 4h8M2 7h2v2H2zM6 8h8M2 11h2v2H2zM6 12h8' })),
              React.createElement('span', null, '执行会话'),
              React.createElement('meter', { min: 0, max: sessionCount, value: completedSessions, 'aria-label': '已完成执行会话数量', style: { flex: 1, minWidth: 20, maxWidth: 80, height: 5, marginLeft: 'auto' } }),
              React.createElement('span', { style: { fontVariantNumeric: 'tabular-nums' } }, `${completedSessions}/${sessionCount}`),
              React.createElement('svg', { className: 'observer-card-session-chevron', width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true }, React.createElement('path', { d: 'm4 6 4 4 4-4' }))),
            expandedTaskId === task.taskId ? React.createElement(CardExecutionPage, {task,updatedAt,navigate,navigatingSessionId}) : null) : null,
          task.waitingReason ? React.createElement('div', { style: { fontSize: 11, lineHeight: 1.5, color: colors.warning, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' } }, task.waitingReason) : null,
          React.createElement('div', { style: { minWidth: 0, paddingTop: 6, borderTop: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', gap: 4, fontSize: 10.5, color: colors.muted } },
            React.createElement('svg', { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-label': '最后活动时间' }, React.createElement('circle', { cx: 12, cy: 12, r: 9 }), React.createElement('path', { d: 'M12 7v5l3 2' })), fmt(task.updatedAt), React.createElement('span', { style: { marginLeft: 'auto' } }, !task.legacyReadonly && !task.archivedAt && ['completed', 'cancelled', 'succeeded', 'failed'].includes(task.state) ? React.createElement(Button, { type: 'button', variant: 'outline', size: 'sm', title: '归档任务（仅限已完成或已取消且执行已结束的任务）', 'aria-label': `归档任务：${task.title || task.taskId}`, 'aria-busy': archivingIds.includes(task.taskId), disabled: archivingIds.includes(task.taskId), onClick: event => { event.stopPropagation(); archiveTask(task) }, style: { minWidth: 58, fontSize: 10.5, cursor: archivingIds.includes(task.taskId) ? 'wait' : 'pointer' } }, React.createElement('svg', { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': true, style: { verticalAlign: -2, marginRight: 4 } }, React.createElement('path', { d: 'M3 3h18v5H3zM5 8v13h14V8M9 12h6' })), '归档') : React.createElement('span', { style: { color: colors.muted, fontSize: 10.5 } }, task.legacyReadonly ? '历史只读' : task.archivedAt ? '已归档' : ''))))
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
      const activeAlerts=data?.alertCollections?.active?.items||[],resolvedAlerts=data?.alertCollections?.resolved?.items||[]
      const filteredActiveAlerts=activeAlerts,filteredResolvedAlerts=resolvedAlerts,resolvedAlertPageSize=10
      const selectedAlertCollection=data?.alertCollections?.[alertView]
      const resolvedAlertPageCount=Math.max(1,Math.ceil((selectedAlertCollection?.total||0)/10)),currentResolvedAlertPage=Math.min(resolvedAlertPage,resolvedAlertPageCount)
      const visibleResolvedAlerts=selectedAlertCollection?.offset===(currentResolvedAlertPage-1)*10?resolvedAlerts:[]
      const bucketColumns = taskBuckets.map(bucket => {
        const tasks = (data?.tasks || []).filter(task => (bucket.state === 'completed' ? ['completed', 'cancelled', 'succeeded', 'failed'].includes(task.state) : bucket.state === 'waiting' ? ['waiting', 'paused', 'blocked', 'interrupted'].includes(task.state) : task.state === bucket.state) && !task.archivedAt && !task.legacyReadonly).sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
        const collection = data?.taskCollections?.[bucket.state]
        const total = collection?.total ?? 0
        const totalPages = Math.max(1, Math.ceil(total / 10)), page = Math.min(taskPages[bucket.state] || 1, totalPages)
        const loadingCollection=!collection||collection.offset!==(page-1)*10
        const visible = collection?.offset === (page - 1) * 10 ? tasks : []
        return React.createElement('section', { key: bucket.state, style: { boxSizing: 'border-box', borderRadius: 14, background: bucket.background, padding: '8px 4px', minWidth: 0, display: 'flex', flexDirection: 'column', height: 'calc(100dvh - 164px)', minHeight: 420, maxHeight: 'calc(100dvh - 164px)', overflow: 'hidden' } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px 10px' } }, React.createElement('strong', { style: { display: 'inline-flex', alignItems: 'center', borderRadius: 999, padding: '3px 9px', fontSize: 11.5, fontWeight: 650, lineHeight: 1.4, color: 'var(--dsw-alias-label-primary-inverted, #fff)', background: bucket.tone } }, bucket.label), React.createElement('span', { style: { borderRadius: 999, background: colors.cardSurface, padding: '2px 7px', fontSize: 10.5, color: colors.muted } }, total)),
          React.createElement('div', { style: { flex: 1, minHeight: 0, padding: '8px 8px 12px 8px', display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto', scrollbarWidth: 'none' } }, ...(visible.length ? visible.map(renderTaskCard) : [React.createElement('div', { key: 'empty', style: { border: `1px dashed ${colors.border}`, borderRadius: 10, minHeight: 90, display: 'grid', placeItems: 'center', color: colors.muted, fontSize: 12 } }, error?'任务读取失败，请刷新重试':loadingCollection?'正在读取任务…':'暂无任务')])),
          totalPages > 1 ? React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8 } }, React.createElement(Button, { type: 'button', variant: 'outline', size: 'sm', disabled: page <= 1, onClick: () => setTaskPages(value => ({ ...value, [bucket.state]: page - 1 })) }, '上一页'), React.createElement('span', null, `${page}/${totalPages}`), React.createElement(Button, { type: 'button', variant: 'outline', size: 'sm', disabled: page >= totalPages, onClick: () => setTaskPages(value => ({ ...value, [bucket.state]: page + 1 })) }, '下一页')) : null)
      })
      const menu = React.createElement('nav', { 'aria-label': '运行看板视图', style: { minWidth: 0, height: 27, display: 'flex', alignItems: 'stretch', gap: 36, overflowX: 'auto', padding: '0 0 0 8px' } },
        ...pages.map((page) => React.createElement('button', { key: page.id, type: 'button', onClick: () => setActivePage(page.id), 'aria-current': activePage === page.id ? 'page' : undefined, style: navigationTabStyle(activePage === page.id) }, page.label)))
      const refreshIcon = React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, style: refreshState === 'refreshing' ? { animation: 'spin 800ms linear infinite' } : undefined }, React.createElement('path', { d: 'M20 11a8 8 0 1 0-2.34 5.66' }), React.createElement('path', { d: 'M20 4v7h-7' }))
      const header = React.createElement('header', { style: { position: 'sticky', top: 0, zIndex: 2, boxSizing: 'border-box', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 4, padding: '12px 28px 0 20px', borderBottom: `1px solid ${colors.border}`, background: colors.surface, pointerEvents: 'auto' } },
        React.createElement('div', { style: { minHeight: 32, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24 } },
          React.createElement('div', { 'aria-label': updatedAt ? `运行正常，最近更新 ${fmt(updatedAt)}` : '正在连接运行时', style: { minWidth: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, color: colors.muted, fontSize: 12, lineHeight: '18px', whiteSpace: 'nowrap' } },
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
        ...[{ id: 'messages', label: `收信箱 · ${messageCollection?.total||0}` }, { id: 'outbox', label: `发信箱 · ${outboxCollection?.total||0}` }].map((item) => React.createElement('button', { key: item.id, role: 'tab', 'aria-selected': groupTableView === item.id, type: 'button', onClick: () => setGroupTableView(item.id), style: navigationTabStyle(groupTableView === item.id, { paddingBottom: 4 }) }, item.label)))
      const groupTableToolbar = React.createElement('div', { style: { ...toolbar, flexWrap: 'wrap' } },
        dataViewTabs,
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' } },
          (data?.groups || []).length ? React.createElement(SelectMenu, { label: '选择群聊', value: selectedGroup?.groupId || '', options: (data?.groups || []).map((group) => ({ id: group.groupId, label: group.name || group.groupId })), onChange: (value) => { setSelectedGroupId(value); setMessagePage(1); setOutboxPage(1); setSelectedMessageRunId('') }, fitContent: true }) : null,
          selectedGroup?.coordinator?.sessionId ? React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: navigatingSessionId === selectedGroup.coordinator.sessionId,
            onClick: () => navigate(selectedGroup.coordinator.sessionId) }, navigatingSessionId === selectedGroup.coordinator.sessionId ? '正在打开…' : '打开群常驻会话') : null,
          groupTableView === 'messages'
            ? React.createElement(SelectMenu, { label: '筛选处理状态', value: messageDeliveryFilter, options: [{ id: 'all', label: '全部处理状态' }, { id: 'routing', label: '待归类' }, { id: 'processing', label: '处理中' }, { id: 'needs_clarification', label: '待澄清' }, { id: 'processed', label: '语义完成' }, { id: 'failed', label: '处理失败' }, { id: 'unknown', label: '状态未知' }], onChange: (value) => { setMessageDeliveryFilter(value); setMessagePage(1) } })
            : React.createElement(SelectMenu, { label: '筛选发送状态', value: outboxStatusFilter, options: [{ id: 'all', label: '全部状态' }, ...[
              { notificationState: 'prepared' }, { notificationState: 'starting' }, { notificationState: 'unknown' }, { notificationState: 'delivered' }, { notificationState: 'superseded', notificationKnownNotSent: true }, { notificationState: 'failed' },
            ].map(message => { const { id, label } = outboxDelivery(message); return { id, label } })], onChange: value => { setOutboxStatusFilter(value); setOutboxPage(1) } })))
      const messagesTable = React.createElement(React.Fragment, null,
        React.createElement('div', { style: { overflowX: 'auto' } }, React.createElement('table', { style: { width: '100%', minWidth: 1040, borderCollapse: 'collapse', tableLayout: 'fixed' } },
          React.createElement('thead', null, React.createElement('tr', { style: { background: colors.surface2, textAlign: 'left' } }, React.createElement('th', { style: { ...tableHeadCell, width: 144 } }, '处理状态'), React.createElement('th', { style: { ...tableHeadCell, width: 160 } }, '发送人 / 时间'), React.createElement('th', { style: { ...tableHeadCell, width: 160 } }, '关联任务 / 历史话题'), React.createElement('th', { style: tableHeadCell }, '消息内容'), React.createElement('th', { style: { ...tableHeadCell, width: 240 } }, '消息'))),
          React.createElement('tbody', null, ...(messageRows.length ? messageRows : [React.createElement('tr', { key: 'empty' }, React.createElement('td', { colSpan: 9, style: { ...tableBodyCell, padding: 36, textAlign: 'center', color: colors.muted } }, error?'群聊消息读取失败，请刷新重试':messagesLoading?'正在读取群聊消息…':'暂无符合条件的群聊消息'))])))),
        React.createElement('div', { style: tableFooter }, React.createElement('span', { style: { marginRight: 'auto', fontSize: 11, color: colors.muted } }, `${messageCollection?.total||0} 条 · 每页 ${pageSize} 条`), React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: currentMessagePage <= 1, onClick: () => setMessagePage((page) => Math.max(1, page - 1)) }, '上一页'), React.createElement('span', { style: { fontSize: 11, color: colors.muted } }, `${currentMessagePage} / ${pageCount}`), React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: currentMessagePage >= pageCount, onClick: () => setMessagePage((page) => Math.min(pageCount, page + 1)) }, '下一页')))
      const outboxTable = React.createElement(React.Fragment, null,
        React.createElement('div', { style: { overflowX: 'auto' } }, React.createElement('table', { style: { width: '100%', minWidth: 1040, borderCollapse: 'collapse', tableLayout: 'fixed' } },
          React.createElement('thead', null, React.createElement('tr', { style: { background: colors.surface2, textAlign: 'left' } }, React.createElement('th', { style: { ...tableHeadCell, width: 124 } }, '状态'), React.createElement('th', { style: { ...tableHeadCell, width: 180 } }, '送达时间'), React.createElement('th', { style: tableHeadCell }, '消息内容'), React.createElement('th', { style: { ...tableHeadCell, width: 220 } }, '来源'))),
          React.createElement('tbody', null, ...(outboxRows.length ? outboxRows : [React.createElement('tr', { key: 'empty' }, React.createElement('td', { colSpan: 4, style: { ...tableBodyCell, padding: 36, textAlign: 'center', color: colors.muted } }, '暂无符合条件的 Agent 发件记录'))])))),
        React.createElement('div', { style: tableFooter }, React.createElement('span', { style: { marginRight: 'auto', fontSize: 11, color: colors.muted } }, `${outboxCollection?.total||0} 条 · 每页 ${outboxPageSize} 条`), React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: currentOutboxPage <= 1, onClick: () => setOutboxPage((page) => Math.max(1, page - 1)) }, '上一页'), React.createElement('span', { style: { fontSize: 11, color: colors.muted } }, `${currentOutboxPage} / ${outboxPageCount}`), React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: currentOutboxPage >= outboxPageCount, onClick: () => setOutboxPage((page) => Math.min(outboxPageCount, page + 1)) }, '下一页')))
      const groupsPage = selectedMessageRunId ? React.createElement(TraceDetail, { runId: selectedMessageRunId, onOpenSession: navigate, onBack: () => setSelectedMessageRunId('') }) : React.createElement('section', { style: { minWidth: 0 } }, React.createElement('div', { style: { ...tableFrame, minWidth: 0 } }, groupTableToolbar, groupTableView === 'messages' ? messagesTable : outboxTable))
      const selectedTask = taskDetail?.taskId === selectedTaskId ? taskDetail : undefined
      const tasksPage = selectedTaskId ? React.createElement('div', { className: 'observer-task-detail-route', style: { maxWidth: 1100, margin: '0 auto', display: 'grid', gap: 16 } },
          React.createElement('style', null, taskDetailCss),
          detailError ? React.createElement('div', { className: 'detail-fetch-error', role: 'alert' }, `${selectedTask ? '详情刷新失败，已读取内容可能过期' : '详情读取失败'}：${detailError}`, React.createElement(Button, { type: 'button', variant: 'outline', onClick: () => setDetailRetry(value => value + 1) }, '重试读取详情')) : null,
          selectedTask ? React.createElement(TaskSessionDetail, { task: selectedTask, onOpenSession: navigate, onBack: returnFromTask, onOpenTask: openTask, updatedAt, onOpenHumanRequest: taskId => { openAuthorization((data?.authorizations||[]).find(item=>item.taskId===taskId&&item.status==='waiting-reply')||((taskDetail?.humanRequests||[]).find(item=>item.status==='waiting-reply')?{...taskDetail.humanRequests.find(item=>item.status==='waiting-reply'),taskId,groupId:taskDetail.groupId}:undefined));setActivePage('authorizations') } })
            : React.createElement('section', { className: 'observer-session-detail detail-fetch-state', 'aria-label': '任务详情读取状态' }, React.createElement('div', { className: 'detail-topline' }, React.createElement(Button, { type: 'button', variant: 'outline', size: 'sm', onClick: returnFromTask }, '返回看板'), React.createElement('span', { className: 'detail-muted' }, '任务详情')), React.createElement('h1', null, '任务详情'), !detailError ? React.createElement('span', { role: 'status' }, '正在读取任务详情…') : React.createElement('p', { className: 'detail-muted' }, '未读取到任务内容，请重试或返回看板。')))
        : React.createElement('section', { style: { display: 'grid', gap: 16 } }, React.createElement('div', { className: 'observer-task-board', style: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(300px, 1fr))', gap: ui.space3, overflowX: 'auto', alignItems: 'start', paddingBottom: ui.space2 } }, ...bucketColumns))
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
        ? item.taskSessionRequest ? { label: '已答复', state: 'done' } : authorizationDecision[item.decision] || authorizationStatus.answered
        : authorizationStatus[item.status] || { label: '状态异常', state: 'error' }
      const authorizationItems=data?.authorizations||[]
      const filteredAuthorizationItems=authorizationItems,authorizationPageSize=10
      const authorizationPageCount=Math.max(1,Math.ceil((data?.authorizationCollection?.total||0)/10)),currentAuthorizationPage=Math.min(authorizationPage,authorizationPageCount)
      const authorizationLoading=!data?.authorizationCollection||data.authorizationCollection.filter!==authorizationFilter||data.authorizationCollection.offset!==(currentAuthorizationPage-1)*10
      const visibleAuthorizationItems=data?.authorizationCollection?.filter===authorizationFilter&&data?.authorizationCollection?.offset===(currentAuthorizationPage-1)*10?authorizationItems:[]
      const selectedAuthorization = authorizationDetailData?.requestId===selectedAuthorizationId?authorizationDetailData:authorizationItems.find(item=>item.requestId===selectedAuthorizationId)
      const authorizationDetailField = (label, value) => React.createElement('div', { style: { display: 'grid', gap: 5 } },
        React.createElement('strong', { style: { fontSize: 11, color: colors.muted } }, label),
        React.createElement('div', { style: { fontSize: 13, lineHeight: 1.65, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, ...linkedTaskText(value || '—')))
      const authorizationRows = visibleAuthorizationItems.map((item, rowIndex) => {
        const status = authorizationPresentation(item)
        const group = groupsById.get(item.groupId)
        return React.createElement('div', { key: item.requestId, style: { width: '100%', minWidth: 0, boxSizing: 'border-box', display: 'grid', gridTemplateColumns: '104px minmax(220px, 1.1fr) minmax(280px, 1.5fr) 126px 52px', alignItems: 'center', gap: 16, borderTop: `1px solid ${colors.border}`, background: rowIndex % 2 ? `color-mix(in srgb, ${colors.surface2} 55%, transparent)` : colors.cardSurface, color: 'inherit', padding: '12px 16px', fontSize: 14 } },
          React.createElement('div', { style: { justifySelf: 'start' } }, tableStatusTag(status.label, status.state, { fontWeight: 600 })),
          React.createElement('span', { style: { minWidth: 0 } }, React.createElement('strong', { title: item.objective, style: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14, fontWeight: 600, lineHeight: 1.5 } }, item.objective), React.createElement('span', { style: { display: 'block', marginTop: 3, color: colors.muted, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, group?.name || item.groupId)),
          React.createElement('span', { style: { minWidth: 0 } }, React.createElement('span', { title: item.requestedAction || item.question || item.reason, style: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14, lineHeight: 1.55, color: colors.muted } }, item.requestedAction || item.question || item.reason), item.risk && item.risk !== '未单独说明' ? React.createElement('span', { style: { display: 'block', marginTop: 3, color: colors.danger, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `风险 · ${item.risk}`) : null),
          React.createElement('span', { style: { color: colors.muted, fontSize: 11, lineHeight: 1.5 } }, fmt(item.createdAt)),
          React.createElement(Button, { variant: 'ghost', size: 'sm', type: 'button', onClick: () => openAuthorization(item) }, '查看'))
      })
      const authorizationDetail = selectedAuthorization ? React.createElement(HumanRequestModal, { key: selectedAuthorization.requestId, onClose: () => setSelectedAuthorizationId('') },authorizationDetailError?React.createElement('p',{role:'alert'},`详情刷新失败，已显示的数据可能过期：${authorizationDetailError}`):null,
          React.createElement('header', { style: { flex: '0 0 auto', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 24, padding: '24px 24px 20px', borderBottom: `1px solid ${colors.border}`, background: colors.surface } },
            React.createElement('div', { style: { minWidth: 0 } }, React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 } }, statusTag(authorizationPresentation(selectedAuthorization).label, authorizationPresentation(selectedAuthorization).state), React.createElement('span', { style: { color: colors.muted, fontSize: 11.5 } }, fmt(selectedAuthorization.createdAt))), React.createElement('h3', { style: { margin: 0, fontSize: 18, fontWeight: 600, lineHeight: 1.5, overflowWrap: 'anywhere', maxHeight: '15dvh', overflowY: 'auto' } }, selectedAuthorization.objective || '人工介入事项'), React.createElement('code', { style: { display: 'block', marginTop: 10, color: colors.muted, fontSize: 10.5, overflowWrap: 'anywhere' } }, selectedAuthorization.requestId)),
            React.createElement(Button, { variant: 'ghost', size: 'sm', type: 'button', 'aria-label': '关闭人工介入事项', onClick: () => setSelectedAuthorizationId(''), style: { flex: '0 0 auto', minWidth: 52, whiteSpace: 'nowrap' } }, '关闭')),
          React.createElement('div', { style: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', scrollbarGutter: 'stable', padding: '0 24px 24px' } },
            React.createElement('section', { style: { padding: '24px 0', borderBottom: `1px solid ${colors.border}` } }, React.createElement(HumanRequestContent, { request: selectedAuthorization })),
            React.createElement('section', { style: { padding: '20px 0', borderBottom: `1px solid ${colors.border}` } }, authorizationDetailField('关联信息', `Task ID：${selectedAuthorization.taskId || '—'}\n群聊：${groupsById.get(selectedAuthorization.groupId)?.name || selectedAuthorization.groupId || '—'}`)),
            selectedAuthorization.status === 'answered' ? React.createElement('section', { style: { padding: '20px 0' } }, authorizationDetailField('处理结果', `${selectedAuthorization.taskSessionRequest ? '已答复' : selectedAuthorization.decision === 'approved' ? '继续任务' : selectedAuthorization.decision === 'rejected' ? '不执行' : selectedAuthorization.decision || '已处理'}\n处理渠道：${selectedAuthorization.decisionSource === 'web' ? '运行看板' : selectedAuthorization.decisionSource === 'dingtalk' ? '钉钉私聊' : selectedAuthorization.decisionSource || '历史迁移'}\n处理时间：${fmt(selectedAuthorization.decidedAt)}\n处理意见：${selectedAuthorization.reply || '—'}`)) : null),
          selectedAuthorization.notification?.recall ? React.createElement('p', { role: selectedAuthorization.notification.recall.state === 'failed' ? 'alert' : 'status', style: { color: selectedAuthorization.notification.recall.state === 'failed' ? colors.danger : colors.muted } }, selectedAuthorization.notification.recall.state === 'recalled' ? '对应私聊通知已撤回。' : selectedAuthorization.notification.recall.state === 'failed' ? '申请已处理，私聊通知撤回失败，将重试。' : '申请已处理，正在撤回对应私聊通知。') : null,
          React.createElement(HumanRequestReply, { key: selectedAuthorization.requestId, request: selectedAuthorization, onChanged: () => { setDetailRetry(value => value + 1); void refresh() } })) : null
      const authorizationsPage = React.createElement(React.Fragment, null, React.createElement('section', null,
        React.createElement('div', { style: tableFrame },
          React.createElement('div', { style: { ...toolbar, justifyContent: 'flex-end' } }, React.createElement(SelectMenu, { label: '筛选处理状态', value: authorizationFilter, options: [{ id: 'all', label: '全部处理状态' }, { id: 'pending', label: '等待处理' }, { id: 'answered', label: '已答复' }, { id: 'approved', label: '已继续' }, { id: 'rejected', label: '不执行' }, { id: 'superseded', label: '已失效' }], onChange: (value) => { setAuthorizationFilter(value); setAuthorizationPage(1) }, fitContent: true })),
          React.createElement('div', { style: { height: 42, boxSizing: 'border-box', display: 'grid', gridTemplateColumns: '104px minmax(220px, 1.1fr) minmax(280px, 1.5fr) 126px 52px', alignItems: 'center', gap: 16, padding: '0 16px', background: colors.surface2, color: colors.muted, fontSize: 13, fontWeight: 600 } }, React.createElement('span', null, '状态'), React.createElement('span', null, '任务'), React.createElement('span', null, '阻塞事项'), React.createElement('span', null, '提出时间'), React.createElement('span', null, '操作')),
          React.createElement('div', null, ...(authorizationRows.length ? authorizationRows : [React.createElement('div', { key: 'empty', style: { padding: 36, textAlign: 'center', color: colors.muted, fontSize: 12 } }, error?'人工介入列表读取失败，请刷新重试':authorizationLoading?'正在读取人工介入事项…':'暂无人工介入事项')])),
          React.createElement('div', { style: tableFooter },
            React.createElement('span', { style: { marginRight: 'auto', fontSize: 11, color: colors.muted } }, `当前显示 ${data?.authorizationCollection?.total||0} 条 · 每页 ${authorizationPageSize} 条`),
            React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: currentAuthorizationPage <= 1, onClick: () => setAuthorizationPage((page) => Math.max(1, page - 1)) }, '上一页'),
            React.createElement('span', { style: { fontSize: 11, color: colors.muted } }, `${currentAuthorizationPage} / ${authorizationPageCount}`),
            React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: currentAuthorizationPage >= authorizationPageCount, onClick: () => setAuthorizationPage((page) => Math.min(authorizationPageCount, page + 1)) }, '下一页')))
      ), authorizationDetail)
      const archivedTasks = (data?.tasks || []).filter(task => task.legacyReadonly || task.archivedAt).sort((left, right) => String(right.updatedAt || right.archivedAt).localeCompare(String(left.updatedAt || left.archivedAt)))
      const historyPageCount = Math.max(1, Math.ceil((data?.archiveCollection?.total || 0) / 20)), currentHistoryPage = Math.min(historyPage, historyPageCount)
      const archiveLoading=!data?.archiveCollection||data.archiveCollection.offset!==(currentHistoryPage-1)*20
      const visibleArchivedTasks=archiveLoading?[]:archivedTasks
      const archivePage = React.createElement('section', { style: { display: 'grid', gap: 16 } },
        React.createElement('p', { role: 'status', style: { margin: 0, color: colors.muted } }, '历史任务只读。旧流程、参数和执行操作已停止。'),
        React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', gap: 12 } }, ...visibleArchivedTasks.map(renderTaskCard)),
        !visibleArchivedTasks.length ? emptyState(error?'历史任务读取失败，请刷新重试':archiveLoading?'正在读取历史任务…':'暂无历史任务') : null,
        React.createElement('div', { style: { display: 'flex', gap: 12, alignItems: 'center' } }, React.createElement('span', { style: { marginRight: 'auto' } }, `${data?.archiveCollection?.total || 0} 条 · ${currentHistoryPage}/${historyPageCount}`), React.createElement(Button, { type: 'button', variant: 'outline', disabled: currentHistoryPage <= 1, onClick: () => setHistoryPage(value => value - 1) }, '上一页'), React.createElement(Button, { type: 'button', variant: 'outline', disabled: currentHistoryPage >= historyPageCount, onClick: () => setHistoryPage(value => value + 1) }, '下一页')))
      const alertsPage = React.createElement(React.Fragment, null,
        React.createElement('section', null, React.createElement('div', { style: tableFrame },
          React.createElement('div', { style: toolbar },
            React.createElement('div', { role: 'tablist', 'aria-label': '告警状态视图', style: { display: 'flex', alignSelf: 'stretch', gap: 20 } }, ...[{ id: 'active', label: `当前异常 · ${data?.alertCollections?.active?.total||0}` }, { id: 'resolved', label: `恢复历史 · ${data?.alertCollections?.resolved?.total||0}` }].map((item) => React.createElement('button', { key: item.id, role: 'tab', 'aria-selected': alertView === item.id, type: 'button', onClick: () => {setAlertView(item.id);setResolvedAlertPage(1)}, style: navigationTabStyle(alertView === item.id, { paddingBottom: 4 }) }, item.label))),
            React.createElement(SelectMenu, { label: '筛选告警类型', value: alertType, options: alertCategories.map((category) => ({ id: category.id, label: category.label })), onChange: (value) => { setAlertType(value); setResolvedAlertPage(1) }, fitContent: true })),
          React.createElement('div', { style: { padding: '0 16px' } }, ...(alertView === 'active' ? (filteredActiveAlerts.length ? filteredActiveAlerts.map(renderAlert) : [React.createElement('div', { key: 'empty', style: { padding: '36px 0', textAlign: 'center', color: colors.muted, fontSize: 12 } }, '当前没有此类型异常')]) : (visibleResolvedAlerts.length ? visibleResolvedAlerts.map(renderAlert) : [React.createElement('div', { key: 'empty', style: { padding: '36px 0', textAlign: 'center', color: colors.muted, fontSize: 12 } }, '暂无此类型恢复记录')]))),
          selectedAlertCollection ? React.createElement('div', { style: tableFooter }, React.createElement('span', { style: { marginRight: 'auto', fontSize: 11, color: colors.muted } }, `${data?.alertCollections?.resolved?.total||0} 条 · 每页 ${resolvedAlertPageSize} 条`), React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: currentResolvedAlertPage <= 1, onClick: () => setResolvedAlertPage((page) => Math.max(1, page - 1)) }, '上一页'), React.createElement('span', { style: { fontSize: 11, color: colors.muted } }, `${currentResolvedAlertPage} / ${resolvedAlertPageCount}`), React.createElement(Button, { variant: 'outline', size: 'sm', type: 'button', disabled: currentResolvedAlertPage >= resolvedAlertPageCount, onClick: () => setResolvedAlertPage((page) => Math.min(resolvedAlertPageCount, page + 1)) }, '下一页')) : null))
      )
      const topicsPage = React.createElement(TopicBrowser, { groups: data?.groups || [], target: topicTarget, updatedAt, onOpenTask: openTask })
      const pageContent = activePage === 'topics' ? topicsPage : activePage === 'tasks' ? tasksPage : activePage === 'authorizations' ? authorizationsPage : activePage === 'archive' ? archivePage : activePage === 'alerts' ? alertsPage : groupsPage
      const pageViewport = React.createElement('div', { style: { width: '100%', maxWidth: 1320, ...(activePage === 'groups' ? { minWidth: 0 } : {}), minHeight: 400, boxSizing: 'border-box', margin: '0 auto' } }, pageContent)
      const main = React.createElement('main', { className: 'observer-main', style: { width: '100%', minHeight: 'calc(100dvh - 90px)', boxSizing: 'border-box', padding: activePage === 'tasks' ? `${ui.space6}px ${ui.space6}px 0` : `${ui.space6}px ${ui.space6}px ${ui.space6 + ui.space2}px`, display: 'grid', alignContent: 'start', gap: ui.space6, pointerEvents: 'auto' } },
        error ? React.createElement(FeedbackNotice, { text: `无法连接 resident 插件：${error}`, error: true }) : null,
        archiveFeedback ? React.createElement(FeedbackNotice, { text: archiveFeedback.text, error: Boolean(archiveFeedback.error) }) : null,
        navigationError ? React.createElement(FeedbackNotice, { text: `操作失败：${navigationError}`, error: true }) : null,
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
            disposeContent = ctx.slots.register({ name: 'main.conversation', priority: -10, inject: () => ({ openSession: async (sessionId, parentSessionId, { isCurrent = () => true } = {}) => {
              if (!isCurrent()) return
              if (parentSessionId) {
                let address = ctx.sessions.subagentAddress(sessionId)
                if (!address) { await ctx.sessions.refreshProjections(parentSessionId); if (!isCurrent()) return; address = ctx.sessions.subagentAddress(sessionId) }
                if (address) { ctx.uiWorkspace.openSession(address); return }
              }
              await ctx.sessions.refresh()
              if (isCurrent()) ctx.uiWorkspace.openSession(sessionId)
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
