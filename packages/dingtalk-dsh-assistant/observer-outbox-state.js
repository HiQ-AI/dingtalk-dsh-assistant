export function observerOutboxState(message) {
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
      return id
}
