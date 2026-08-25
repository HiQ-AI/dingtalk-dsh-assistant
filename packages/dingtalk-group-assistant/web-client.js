window.__ModuleLoader__.load({
  id: '@zzusp/dingtalk-dsh-assistant',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const { useCallback, useEffect, useState } = React

    const name = 'dingtalk-group-assistant-client'
    const inject = ['slots']
    const ENDPOINT = 'http://127.0.0.1:18998'
    const colors = { border: 'var(--dsw-alias-stroke-border-2, rgba(127,127,127,.28))', muted: 'var(--dsw-alias-label-secondary, #737373)', accent: 'var(--dsw-alias-brand-primary, #4d6bfe)', danger: 'var(--dsw-alias-status-error, #c33)' }
    const panel = { border: `1px solid ${colors.border}`, borderRadius: 12, padding: 16, display: 'grid', gap: 12 }
    const row = { display: 'flex', justifyContent: 'space-between', gap: 16, fontSize: 13 }
    const input = { width: '100%', boxSizing: 'border-box', border: `1px solid ${colors.border}`, borderRadius: 8, padding: '8px 10px', background: 'transparent', color: 'inherit', font: 'inherit' }
    const button = { border: `1px solid ${colors.border}`, borderRadius: 8, padding: '7px 12px', background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit' }

    async function request(path, options) {
      const response = await fetch(`${ENDPOINT}${path}`, { headers: { accept: 'application/json', 'content-type': 'application/json' }, ...options })
      const value = await response.json()
      if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`)
      return value
    }
    async function readResidentOverview() {
      const [health, groups, tasks, alerts, environment, agentConfig] = await Promise.all(['/health', '/state/groups', '/state/tasks', '/state/supervisor/alerts', '/state/environment', '/state/agent-config'].map((path) => request(path)))
      return { health, groups, tasks, alerts, environment, agentConfig }
    }

    function Environment({ value }) {
      return React.createElement('section', { style: panel },
        React.createElement('strong', null, '环境检查'),
        React.createElement('div', { style: row }, React.createElement('span', { style: { color: colors.muted } }, 'dws'), React.createElement('span', null, value?.dws?.installed ? '已安装' : '未安装')),
        React.createElement('div', { style: row }, React.createElement('span', { style: { color: colors.muted } }, '登录状态'), React.createElement('span', null, value?.dws?.authenticated && value?.dws?.tokenValid ? `已登录 · ${value.dws.user ?? ''}` : '未登录或登录失效')),
        value?.dws?.executable ? React.createElement('code', { style: { fontSize: 12, color: colors.muted, overflowWrap: 'anywhere' } }, value.dws.executable) : null
      )
    }

    function DingTalkGroupAssistantCard() {
      const [overview, setOverview] = useState()
      const [drafts, setDrafts] = useState({})
      const [agentWorkspace, setAgentWorkspace] = useState('')
      const [agentNames, setAgentNames] = useState('')
      const [agentModel, setAgentModel] = useState({ model: '', reasoningEffort: 'low' })
      const [proxyUrl, setProxyUrl] = useState('')
      const [taskGuidance, setTaskGuidance] = useState({ taskExecutionGuidance: '', taskEvidenceGuidance: '' })
      const [maxConcurrentTasks, setMaxConcurrentTasks] = useState(5)
      const [newGroup, setNewGroup] = useState({ groupId: '', name: '', responsibility: '' })
      const [query, setQuery] = useState('')
      const [searchResults, setSearchResults] = useState([])
      const [error, setError] = useState()
      const refresh = useCallback(async () => {
        try { const next = await readResidentOverview(); setOverview(next); setAgentWorkspace(next.agentConfig.workspaceDir); setAgentNames((next.agentConfig.agentNames ?? []).join(',')); setAgentModel({ model: next.agentConfig.model, reasoningEffort: next.agentConfig.reasoningEffort ?? '' }); setProxyUrl(next.agentConfig.proxyUrl ?? ''); setTaskGuidance({ taskExecutionGuidance: next.agentConfig.taskExecutionGuidance ?? '', taskEvidenceGuidance: next.agentConfig.taskEvidenceGuidance ?? '' }); setMaxConcurrentTasks(next.agentConfig.maxConcurrentTasks ?? 5); setDrafts(Object.fromEntries(next.groups.map((group) => [group.groupId, group.responsibility]))); setError(undefined) }
        catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
      }, [])
      useEffect(() => { refresh() }, [refresh])
      const mutate = async (operation) => { try { await operation(); await refresh() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } }
      const activeTasks = overview?.tasks?.filter((task) => task.state === 'running' || task.state === 'waiting').length ?? 0
      return React.createElement('div', { style: { display: 'grid', gap: 16 } },
        React.createElement('section', { style: panel },
          React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, React.createElement('div', null, React.createElement('strong', null, '钉钉群聊个人助理'), React.createElement('div', { style: { color: colors.muted, fontSize: 12 } }, 'resident runtime')), React.createElement('button', { type: 'button', style: button, onClick: refresh }, '刷新')),
          error ? React.createElement('div', { style: { color: colors.danger, fontSize: 13 } }, error) : null,
          React.createElement('div', { style: row }, React.createElement('span', { style: { color: colors.muted } }, '运行状态'), React.createElement('span', null, overview?.health?.status ?? '连接中')),
          React.createElement('div', { style: row }, React.createElement('span', { style: { color: colors.muted } }, '渠道 / 活动 Task / 告警'), React.createElement('span', null, `${overview?.health?.transport ?? '-'} / ${activeTasks} / ${overview?.alerts?.length ?? 0}`)),
          React.createElement('div', { style: row }, React.createElement('span', { style: { color: colors.muted } }, '群消息接收与处理'), React.createElement('span', null, overview?.health?.inboundProcessing ? '已启用' : '未启用')),
          React.createElement('div', { style: row }, React.createElement('span', { style: { color: colors.muted } }, '自动回复群聊'), React.createElement('span', null, overview?.health?.outboundAuthorized ? '已启用' : '未启用')),
          React.createElement('div', { style: row }, React.createElement('span', { style: { color: colors.muted } }, '处理模型'), React.createElement('span', null, overview?.health?.modelMode === 'real' ? '真实模型' : '测试模型'))),
        React.createElement(Environment, { value: overview?.environment }),
        React.createElement('section', { style: panel }, React.createElement('strong', null, 'Agent 配置'),
          React.createElement('strong', { style: { fontSize: 13 } }, 'Agent 名称 / 别名'),
          React.createElement('input', { 'aria-label': 'Agent 名称和别名', placeholder: '例如 数字助理,小助手', style: input, value: agentNames, onChange: (event) => setAgentNames(event.target.value) }),
          React.createElement('div', { style: { fontSize: 12, color: colors.muted } }, '多个名称使用英文逗号分隔；任一名称被明确提及时可参与新任务判断。'),
          React.createElement('strong', { style: { fontSize: 13 } }, '工作目录'),
          React.createElement('input', { 'aria-label': 'Agent 工作区目录', placeholder: '现有绝对目录', style: input, value: agentWorkspace, onChange: (event) => setAgentWorkspace(event.target.value) }),
          React.createElement('div', { style: { fontSize: 12, color: colors.muted } }, '所有常驻群主会话和新建叶子任务共用此工作区；AGENTS.md 由 dsh 原生发现。'),
          React.createElement('strong', { style: { fontSize: 13, borderTop: `1px solid ${colors.border}`, paddingTop: 12 } }, '默认处理模型'),
          React.createElement('input', { 'aria-label': 'Agent 默认模型', placeholder: '例如 gpt-5.6-sol', style: input, value: agentModel.model, onChange: (event) => setAgentModel((current) => ({ ...current, model: event.target.value })) }),
          React.createElement('select', { 'aria-label': 'Agent 推理深度', style: input, value: agentModel.reasoningEffort, onChange: (event) => setAgentModel((current) => ({ ...current, reasoningEffort: event.target.value })) },
            React.createElement('option', { value: '' }, '模型默认'), React.createElement('option', { value: 'low' }, '轻度'), React.createElement('option', { value: 'medium' }, '中度'), React.createElement('option', { value: 'high' }, '高度'), React.createElement('option', { value: 'xhigh' }, '极高')),
          React.createElement('div', { style: { fontSize: 12, color: colors.muted } }, '通过 dsh 原生默认模型设置保存；活动 Task 存在时禁止切换。'),
          React.createElement('strong', { style: { fontSize: 13 } }, '叶子任务并行上限'),
          React.createElement('input', { type: 'number', min: 1, max: 50, step: 1, 'aria-label': '叶子任务并行上限', style: input, value: maxConcurrentTasks, onChange: (event) => setMaxConcurrentTasks(Number(event.target.value)) }),
          React.createElement('div', { style: { fontSize: 12, color: colors.muted } }, '默认 5；调低不会中断正在运行的任务，空出的名额按 FIFO 启动待执行任务。'),
          React.createElement('strong', { style: { fontSize: 13, borderTop: `1px solid ${colors.border}`, paddingTop: 12 } }, '网络代理'),
          React.createElement('input', { 'aria-label': 'Agent 网络代理', placeholder: '例如 http://127.0.0.1:10808；留空表示不使用', style: input, value: proxyUrl, onChange: (event) => setProxyUrl(event.target.value) }),
          React.createElement('div', { style: { fontSize: 12, color: colors.muted } }, '用于 resident Agent 调用模型；保存后写入插件配置并立即应用，重启后仍保留。'),
          React.createElement('strong', { style: { fontSize: 13, borderTop: `1px solid ${colors.border}`, paddingTop: 12 } }, '任务流程引导'),
          React.createElement('textarea', { 'aria-label': '任务流程引导', rows: 7, style: { ...input, resize: 'vertical' }, placeholder: '描述不同类型任务如何推进；由叶子会话根据任务目标选择适用段落。', value: taskGuidance.taskExecutionGuidance, onChange: (event) => setTaskGuidance((current) => ({ ...current, taskExecutionGuidance: event.target.value })) }),
          React.createElement('strong', { style: { fontSize: 13 } }, '完成证据要求'),
          React.createElement('textarea', { 'aria-label': '完成证据要求', rows: 7, style: { ...input, resize: 'vertical' }, placeholder: '描述不同类型任务完成时必须提交的可核验证据。', value: taskGuidance.taskEvidenceGuidance, onChange: (event) => setTaskGuidance((current) => ({ ...current, taskEvidenceGuidance: event.target.value })) }),
          React.createElement('div', { style: { fontSize: 12, color: colors.muted } }, '两项仅通过 dsh systemPrompt.section 注入叶子会话；不注入常驻主会话。'),
          React.createElement('button', { type: 'button', style: { ...button, justifySelf: 'end', background: colors.accent, color: '#fff', borderColor: colors.accent }, disabled: !agentModel.model.trim() || !Number.isInteger(maxConcurrentTasks) || maxConcurrentTasks < 1 || maxConcurrentTasks > 50 || (agentNames === (overview?.agentConfig?.agentNames ?? []).join(',') && agentWorkspace === overview?.agentConfig?.workspaceDir && agentModel.model === overview?.agentConfig?.model && agentModel.reasoningEffort === (overview?.agentConfig?.reasoningEffort ?? '') && proxyUrl === (overview?.agentConfig?.proxyUrl ?? '') && taskGuidance.taskExecutionGuidance === (overview?.agentConfig?.taskExecutionGuidance ?? '') && taskGuidance.taskEvidenceGuidance === (overview?.agentConfig?.taskEvidenceGuidance ?? '') && maxConcurrentTasks === (overview?.agentConfig?.maxConcurrentTasks ?? 5)), onClick: () => mutate(() => request('/config/agent', { method: 'PUT', body: JSON.stringify({ agentNames: agentNames.split(',').map((name) => name.trim()).filter(Boolean), workspaceDir: agentWorkspace, ...agentModel, proxyUrl, ...taskGuidance, maxConcurrentTasks }) })) }, '保存配置')),
        React.createElement('section', { style: panel }, React.createElement('strong', null, '常驻群与会话职责'),
          ...(overview?.groups ?? []).map((group) => React.createElement('div', { key: group.groupId, style: { borderTop: `1px solid ${colors.border}`, paddingTop: 12, display: 'grid', gap: 8 } },
            React.createElement('div', null, group.name ? React.createElement('strong', { style: { fontSize: 13 } }, group.name) : null, React.createElement('code', { style: { display: 'block', fontSize: 12, overflowWrap: 'anywhere', color: colors.muted } }, group.groupId)),
            React.createElement('textarea', { 'aria-label': `${group.groupId} 会话职责`, rows: 4, style: { ...input, resize: 'vertical' }, value: drafts[group.groupId] ?? '', onChange: (event) => setDrafts((current) => ({ ...current, [group.groupId]: event.target.value })) }),
            React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
              React.createElement('button', { type: 'button', style: { ...button, color: colors.danger }, onClick: () => { if (window.confirm(`确认删除常驻群 ${group.groupId}？历史群配置将被移除。`)) mutate(() => request(`/config/groups/${encodeURIComponent(group.groupId)}`, { method: 'DELETE' })) } }, '删除'),
              React.createElement('button', { type: 'button', style: { ...button, background: colors.accent, color: '#fff', borderColor: colors.accent }, disabled: drafts[group.groupId] === group.responsibility, onClick: () => mutate(() => request(`/config/groups/${encodeURIComponent(group.groupId)}`, { method: 'PUT', body: JSON.stringify({ responsibility: drafts[group.groupId] }) })) }, '保存职责')))),
          React.createElement('div', { style: { borderTop: `1px solid ${colors.border}`, paddingTop: 12, display: 'grid', gap: 8 } },
            React.createElement('strong', { style: { fontSize: 13 } }, '添加常驻群'),
            React.createElement('div', { style: { display: 'flex', gap: 8 } },
              React.createElement('input', { 'aria-label': '按群名称搜索', placeholder: '输入至少两个字搜索群聊', style: input, value: query, onChange: (event) => setQuery(event.target.value) }),
              React.createElement('button', { type: 'button', style: button, disabled: query.trim().length < 2, onClick: () => mutate(async () => { const result = await request(`/config/groups/search?q=${encodeURIComponent(query.trim())}`); setSearchResults(result.groups) }) }, '搜索')),
            ...searchResults.map((group) => React.createElement('button', { key: group.groupId, type: 'button', style: { ...button, textAlign: 'left', background: newGroup.groupId === group.groupId ? 'color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 12%, transparent)' : 'transparent' }, onClick: () => setNewGroup((current) => ({ ...current, groupId: group.groupId, name: group.name })) }, `${group.name} · ${group.memberCount ?? '-'}人\n${group.groupId}`)),
            newGroup.groupId ? React.createElement('div', { style: { fontSize: 12, color: colors.muted } }, `已选择：${newGroup.name}（${newGroup.groupId}）`) : null,
            React.createElement('textarea', { 'aria-label': '新群会话职责', placeholder: '描述该群中个人助理的职责、参与条件和升级边界', rows: 4, style: { ...input, resize: 'vertical' }, value: newGroup.responsibility, onChange: (event) => setNewGroup((current) => ({ ...current, responsibility: event.target.value })) }),
            React.createElement('button', { type: 'button', style: { ...button, justifySelf: 'end', background: colors.accent, color: '#fff', borderColor: colors.accent }, disabled: !newGroup.groupId.trim() || !newGroup.responsibility.trim(), onClick: () => mutate(async () => { await request('/config/groups', { method: 'POST', body: JSON.stringify(newGroup) }); setNewGroup({ groupId: '', name: '', responsibility: '' }); setSearchResults([]); setQuery('') }) }, '添加并开始常驻'))))
    }

    function apply(ctx) {
      ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({ name: 'settings.plugins.tab', id: 'dingtalk-group-assistant', order: 10, label: () => '钉钉群聊个人助理', inject: () => ({}) }, DingTalkGroupAssistantCard))
    }

    module.exports = { apply, inject, name, readResidentOverview, DingTalkGroupAssistantCard }
    return module.exports
  },
})
