window.__ModuleLoader__.load({
  id: '@zzusp/dingtalk-dsh-assistant',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const { useCallback, useEffect, useState } = React

    const name = 'dingtalk-dsh-assistant-client'
    const inject = ['slots']
    const ENDPOINT = 'http://127.0.0.1:18998'
    const colors = { border: 'var(--dsw-alias-stroke-border-2, rgba(127,127,127,.28))', muted: 'var(--dsw-alias-label-secondary, #737373)', accent: 'var(--dsw-alias-brand-primary, #4d6bfe)', danger: 'var(--dsw-alias-status-error, #c33)' }
    const ui = { textSm: 12, textMd: 14, textLg: 16, textXl: 20, space1: 4, space2: 8, space3: 12, space4: 16, space6: 24, radiusSm: 8, radiusMd: 12 }
    const panel = { border: `1px solid ${colors.border}`, borderRadius: ui.radiusMd, padding: ui.space4, display: 'grid', gap: ui.space3 }
    const row = { display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: ui.space2, fontSize: ui.textMd }
    const input = { width: '100%', minWidth: 0, boxSizing: 'border-box', border: `1px solid ${colors.border}`, borderRadius: ui.radiusSm, padding: `${ui.space2}px ${ui.space3}px`, background: 'transparent', color: 'inherit', font: 'inherit' }
    const button = { border: `1px solid ${colors.border}`, borderRadius: ui.radiusSm, padding: `${ui.space2}px ${ui.space3}px`, background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit' }
    const settingsCss = `
      [data-dingtalk-assistant-settings] :is(button, input, select, textarea, summary, a):focus-visible {
        outline: 2px solid var(--dsw-alias-brand-primary, #4d6bfe) !important;
        outline-offset: 2px !important;
      }
      @media (max-width: 720px) {
        [data-dingtalk-assistant-settings] { gap: 12px !important; }
        [data-dingtalk-assistant-settings] section { padding: 12px !important; }
        [data-dingtalk-assistant-settings] .assistant-inline-form { align-items: stretch !important; flex-direction: column !important; }
        [data-dingtalk-assistant-settings] .assistant-inline-form > button { width: 100%; }
      }
    `
    const UPDATE_PROMPT = '请按 https://github.com/HiQ-AI/dingtalk-dsh-assistant 的 docs/ops/npm-release.md 与 docs/ops/resident-review-local-deployment.md 升级本机 web profile。先核对当前安装形态、目标正式版本和在途任务；按规程完成零写预检、维护排空、安全停机与备份，再安装同一版本的精确包。重启后分别回读安装内容、进程、Runtime 与认证 Web；任何门禁失败即停止并报告。'

    const IconRefreshOutline16 = ({ size = 16 }) => React.createElement('span', { 'aria-hidden': true, style: { fontSize: size } }, '↻')

    function UpdateDot() {
      return React.createElement('span', { 'aria-hidden': true, style: { width: 7, height: 7, borderRadius: '50%', background: colors.danger, flex: 'none' } })
    }

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

    function DingTalkDshAssistantCard() {
      const [overview, setOverview] = useState()
      const [drafts, setDrafts] = useState({})
      const [agentWorkspace, setAgentWorkspace] = useState('')
      const [agentNames, setAgentNames] = useState('')
      const [agentModel, setAgentModel] = useState({ model: '', reasoningEffort: 'low' })
          const [proxyUrl, setProxyUrl] = useState('')
      const [deletingGroupId, setDeletingGroupId] = useState('')
      const [newGroup, setNewGroup] = useState({ groupId: '', name: '', responsibility: '' })
      const [query, setQuery] = useState('')
      const [searchResults, setSearchResults] = useState([])
      const [groupFeedback, setGroupFeedback] = useState({ kind: 'hint', message: '先搜索并选择一个群聊，再填写会话职责。' })
      const [addingGroup, setAddingGroup] = useState(false)
      const [error, setError] = useState()
      const [updateFeedback, setUpdateFeedback] = useState()
      const [checkingVersion, setCheckingVersion] = useState(false)
      const refresh = useCallback(async () => {
        try { const next = await readResidentOverview(); setOverview(next); request('/state/version').then((version) => setOverview((current) => ({ ...current, version }))).catch((cause) => setOverview((current) => ({ ...current, version: { error: cause instanceof Error ? cause.message : String(cause) } }))); setAgentWorkspace(next.agentConfig.workspaceDir); setAgentNames((next.agentConfig.agentNames ?? []).join(',')); setAgentModel({ model: next.agentConfig.model, reasoningEffort: next.agentConfig.reasoningEffort ?? '' }); setProxyUrl(next.agentConfig.proxyUrl ?? ''); setDrafts(Object.fromEntries(next.groups.map((group) => [group.groupId, group.responsibility]))); setError(undefined) }
        catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
      }, [])
      useEffect(() => { refresh() }, [refresh])
      const checkVersion = async () => {
        setCheckingVersion(true)
        try {
          const version = await request('/state/version')
          setOverview((current) => ({ ...current, version }))
        } catch (cause) {
          setOverview((current) => ({ ...current, version: { error: cause instanceof Error ? cause.message : String(cause) } }))
        } finally {
          setCheckingVersion(false)
        }
      }
      const mutate = async (operation) => { try { await operation(); await refresh() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } }
      const addGroup = async () => {
        if (!newGroup.groupId.trim()) return setGroupFeedback({ kind: 'error', message: '请先从搜索结果中选择要常驻的群聊。' })
        if (!newGroup.responsibility.trim()) return setGroupFeedback({ kind: 'error', message: '请填写该群的会话职责后再添加。' })
        setAddingGroup(true)
        setGroupFeedback({ kind: 'hint', message: '正在创建常驻会话…' })
        try {
          const result = await request('/config/groups', { method: 'POST', body: JSON.stringify(newGroup) })
          if (!result.created) return setGroupFeedback({ kind: 'error', message: '该群已经是常驻群，无需重复添加。' })
          await refresh()
          setNewGroup({ groupId: '', name: '', responsibility: '' })
          setSearchResults([])
          setQuery('')
          setGroupFeedback({ kind: 'success', message: '常驻群已添加，会话已开始运行。' })
        } catch (cause) {
          setGroupFeedback({ kind: 'error', message: `添加失败：${cause instanceof Error ? cause.message : String(cause)}` })
        } finally {
          setAddingGroup(false)
        }
      }
      const activeTasks = overview?.tasks?.filter((task) => task.state === 'running' || task.state === 'waiting').length ?? 0
      const agentConfigChanged = agentNames !== (overview?.agentConfig?.agentNames ?? []).join(',') || agentWorkspace !== overview?.agentConfig?.workspaceDir || agentModel.model !== overview?.agentConfig?.model || agentModel.reasoningEffort !== (overview?.agentConfig?.reasoningEffort ?? '') || proxyUrl !== (overview?.agentConfig?.proxyUrl ?? '')
      const saveAgentConfig = () => mutate(() => request('/config/agent', { method: 'PUT', body: JSON.stringify({ agentNames: agentNames.split(',').map(name => name.trim()).filter(Boolean), workspaceDir: agentWorkspace, ...agentModel, proxyUrl }) }))
      return React.createElement('div', { 'data-dingtalk-assistant-settings': '', style: { display: 'grid', gap: ui.space4 } }, React.createElement('style', null, settingsCss),
        React.createElement('section', { style: panel },
          React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, React.createElement('div', null, React.createElement('strong', null, '钉钉个人助理'), React.createElement('div', { style: { color: colors.muted, fontSize: 12 } }, 'resident runtime')), React.createElement('button', { type: 'button', style: button, onClick: refresh }, '刷新')),
          error ? React.createElement('div', { style: { color: colors.danger, fontSize: 13 } }, error) : null,
          React.createElement('div', { style: row }, React.createElement('span', { style: { color: colors.muted } }, '运行状态'), React.createElement('span', null, overview?.health?.status ?? '连接中')),
          React.createElement('div', { style: row }, React.createElement('span', { style: { color: colors.muted } }, '渠道 / 活动 Task / 告警'), React.createElement('span', null, `${overview?.health?.transport ?? '-'} / ${activeTasks} / ${overview?.alerts?.length ?? 0}`)),
          React.createElement('div', { style: row }, React.createElement('span', { style: { color: colors.muted } }, '群消息接收与处理'), React.createElement('span', null, overview?.health?.inboundProcessing ? '已启用' : '未启用')),
          React.createElement('div', { style: row }, React.createElement('span', { style: { color: colors.muted } }, '自动回复群聊'), React.createElement('span', null, overview?.health?.outboundAuthorized ? '已启用' : '未启用')),
          React.createElement('div', { style: row }, React.createElement('span', { style: { color: colors.muted } }, '处理模型'), React.createElement('span', null, overview?.health?.modelMode === 'real' ? '真实模型' : '测试模型'))),
        React.createElement('section', { style: panel },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 } },
            React.createElement('strong', null, '版本与更新'),
            React.createElement('button', { type: 'button', style: { ...button, display: 'inline-flex', alignItems: 'center', gap: 6 }, disabled: checkingVersion, onClick: checkVersion }, checkingVersion ? '检查中…' : '检查更新', React.createElement(IconRefreshOutline16, { size: 16 }))),
          React.createElement('div', { style: row }, React.createElement('span', { style: { color: colors.muted } }, '当前版本'), React.createElement('span', null, overview?.version?.currentVersion ?? '读取中')),
          overview?.version?.error
            ? React.createElement('div', { style: { color: colors.danger, fontSize: 13 } }, `新版本检查失败：${overview.version.error}`)
            : React.createElement('div', { style: row },
              React.createElement('span', { style: { color: colors.muted } }, '最新版本'),
              React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 8 } },
                overview?.version?.updateAvailable ? React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 22, boxSizing: 'border-box', padding: '2px 8px', border: `1px solid color-mix(in srgb, ${colors.danger} 28%, transparent)`, borderRadius: 999, color: colors.danger, background: `color-mix(in srgb, ${colors.danger} 10%, transparent)`, fontSize: 11, fontWeight: 500, lineHeight: 1.4, whiteSpace: 'nowrap' } }, React.createElement(UpdateDot), '可更新') : null,
                overview?.version?.latestVersion === null ? '尚无正式 Release' : (overview?.version?.latestVersion ?? '检查中'))),
          React.createElement('div', { style: { display: 'grid', gap: 8, borderTop: `1px solid ${colors.border}`, paddingTop: 12 } },
            React.createElement('div', { style: { color: colors.muted, fontSize: 12 } }, '升级提示词 · 复制给工程助手'),
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minHeight: 34, padding: '4px 4px 4px 10px', border: `1px solid ${colors.border}`, borderRadius: 8, background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,.06))' } },
              React.createElement('code', { style: { minWidth: 0, flex: 1, fontSize: 11, lineHeight: 1.5, overflowWrap: 'anywhere', userSelect: 'all' } }, UPDATE_PROMPT),
              React.createElement('button', { type: 'button', style: { ...button, padding: '5px 10px', whiteSpace: 'nowrap' }, onClick: async () => { try { await navigator.clipboard.writeText(UPDATE_PROMPT); setUpdateFeedback('升级提示词已复制。') } catch { setUpdateFeedback(`请复制提示词：${UPDATE_PROMPT}`) } } }, '复制提示词'))),
          updateFeedback ? React.createElement('div', { role: 'status', style: { color: colors.muted, fontSize: 12, overflowWrap: 'anywhere' } }, updateFeedback) : null,
          overview?.version?.changelogUrl ? React.createElement('a', { href: overview.version.changelogUrl, target: '_blank', rel: 'noreferrer', style: { color: colors.accent } }, '查看 CHANGELOG') : null),
        React.createElement(Environment, { value: overview?.environment }),
        React.createElement('section', { style: panel }, React.createElement('strong', null, 'Agent 配置'),
          React.createElement('strong', { style: { fontSize: 13 } }, 'Agent 名称 / 别名'),
          React.createElement('input', { 'aria-label': 'Agent 名称和别名', placeholder: '例如 数字助理,小助手', style: input, value: agentNames, onChange: (event) => setAgentNames(event.target.value) }),
          React.createElement('div', { style: { fontSize: 12, color: colors.muted } }, '多个名称使用英文逗号分隔；任一名称被明确提及时可参与新任务判断。'),
          React.createElement('strong', { style: { fontSize: 13 } }, '工作目录'),
          React.createElement('input', { 'aria-label': 'Agent 工作区目录', placeholder: '现有绝对目录', style: input, value: agentWorkspace, onChange: (event) => setAgentWorkspace(event.target.value) }),
          React.createElement('div', { style: { fontSize: 12, color: colors.muted } }, '群常驻会话使用此工作区；每个任务及其动态执行使用独立工作目录。'),
          React.createElement('strong', { style: { fontSize: 13, borderTop: `1px solid ${colors.border}`, paddingTop: 12 } }, '默认处理模型'),
          React.createElement('input', { 'aria-label': 'Agent 默认模型', placeholder: '例如 gpt-5.6-sol', style: input, value: agentModel.model, onChange: (event) => setAgentModel((current) => ({ ...current, model: event.target.value })) }),
          React.createElement('select', { 'aria-label': 'Agent 推理深度', style: input, value: agentModel.reasoningEffort, onChange: (event) => setAgentModel((current) => ({ ...current, reasoningEffort: event.target.value })) },
            React.createElement('option', { value: '' }, '模型默认'), React.createElement('option', { value: 'low' }, '轻度'), React.createElement('option', { value: 'medium' }, '中度'), React.createElement('option', { value: 'high' }, '高度'), React.createElement('option', { value: 'xhigh' }, '极高')),
          React.createElement('div', { style: { fontSize: 12, color: colors.muted } }, '通过 dsh 原生默认模型设置保存；保存后从下一次模型请求起生效，不中断当前在途请求。'),
          React.createElement('strong', { style: { fontSize: 13, borderTop: `1px solid ${colors.border}`, paddingTop: 12 } }, '网络代理'),
          React.createElement('input', { 'aria-label': 'Agent 网络代理', placeholder: '例如 http://127.0.0.1:10808；留空表示不使用', style: input, value: proxyUrl, onChange: (event) => setProxyUrl(event.target.value) }),
          React.createElement('div', { style: { fontSize: 12, color: colors.muted } }, '用于 resident Agent 调用模型；保存后写入插件配置并立即应用，重启后仍保留。'),
    React.createElement('button', { type: 'button', style: { ...button, justifySelf: 'end', background: colors.accent, color: '#fff', borderColor: colors.accent }, disabled: !agentModel.model.trim() || !agentConfigChanged, onClick: saveAgentConfig }, '保存配置')),
        React.createElement('div', { style: { color: colors.muted, fontSize: ui.textSm } }, '在“运行看板 → 任务看板”查看任务会话、动态执行、结果与日志路径。'),
        React.createElement('section', { style: panel }, React.createElement('strong', null, '常驻群与会话职责'),
          ...(overview?.groups ?? []).map((group) => React.createElement('div', { key: group.groupId, style: { borderTop: `1px solid ${colors.border}`, paddingTop: 12, display: 'grid', gap: 8 } },
            React.createElement('div', null, group.name ? React.createElement('strong', { style: { fontSize: 13 } }, group.name) : null, React.createElement('code', { style: { display: 'block', fontSize: 12, overflowWrap: 'anywhere', color: colors.muted } }, group.groupId)),
            React.createElement('textarea', { 'aria-label': `${group.groupId} 会话职责`, rows: 4, style: { ...input, resize: 'none' }, value: drafts[group.groupId] ?? '', onChange: (event) => setDrafts((current) => ({ ...current, [group.groupId]: event.target.value })) }),
            deletingGroupId === group.groupId ? React.createElement('section', { 'aria-label': '确认删除常驻群', style: { ...panel, borderColor: colors.danger } },
              React.createElement('p', null, `删除 ${group.name || group.groupId} 的常驻配置？历史引用或在途事项未清理时服务会拒绝删除。`),
              React.createElement('button', { type: 'button', style: button, onClick: () => setDeletingGroupId('') }, '保留常驻群'),
              React.createElement('button', { type: 'button', style: { ...button, color: colors.danger }, onClick: () => { setDeletingGroupId(''); mutate(() => request(`/config/groups/${encodeURIComponent(group.groupId)}`, { method: 'DELETE' })) } }, '确认删除')) : null,
          React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
              React.createElement('button', { type: 'button', style: { ...button, color: colors.danger }, onClick: () => setDeletingGroupId(group.groupId) }, '删除'),
              React.createElement('button', { type: 'button', style: { ...button, background: colors.accent, color: '#fff', borderColor: colors.accent }, disabled: drafts[group.groupId] === group.responsibility, onClick: () => mutate(() => request(`/config/groups/${encodeURIComponent(group.groupId)}`, { method: 'PUT', body: JSON.stringify({ responsibility: drafts[group.groupId] }) })) }, '保存职责')))),
          React.createElement('div', { style: { borderTop: `1px solid ${colors.border}`, paddingTop: 12, display: 'grid', gap: 8 } },
            React.createElement('strong', { style: { fontSize: 13 } }, '添加常驻群'),
            React.createElement('div', { className: 'assistant-inline-form', style: { display: 'flex', gap: ui.space2 } },
              React.createElement('input', { 'aria-label': '按群名称搜索', placeholder: '输入至少两个字搜索群聊', style: input, value: query, onChange: (event) => setQuery(event.target.value) }),
              React.createElement('button', { type: 'button', style: button, disabled: query.trim().length < 2, onClick: () => mutate(async () => { const result = await request(`/config/groups/search?q=${encodeURIComponent(query.trim())}`); setSearchResults(result.groups) }) }, '搜索')),
            ...searchResults.map((group) => React.createElement('button', { key: group.groupId, type: 'button', style: { ...button, textAlign: 'left', background: newGroup.groupId === group.groupId ? 'color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 12%, transparent)' : 'transparent' }, onClick: () => { setNewGroup((current) => ({ ...current, groupId: group.groupId, name: group.name })); setGroupFeedback({ kind: 'hint', message: `已选择“${group.name}”，填写会话职责后即可开始常驻。` }) } }, `${group.name} · ${group.memberCount ?? '-'}人\n${group.groupId}`)),
            newGroup.groupId ? React.createElement('div', { style: { fontSize: 12, color: colors.muted } }, `已选择：${newGroup.name}（${newGroup.groupId}）`) : null,
            React.createElement('textarea', { 'aria-label': '新群会话职责', placeholder: '描述该群中个人助理的职责、参与条件和升级边界', rows: 4, style: { ...input, resize: 'none' }, value: newGroup.responsibility, onChange: (event) => setNewGroup((current) => ({ ...current, responsibility: event.target.value })) }),
            React.createElement('div', { role: groupFeedback.kind === 'error' ? 'alert' : 'status', style: { fontSize: 12, color: groupFeedback.kind === 'error' ? colors.danger : groupFeedback.kind === 'success' ? 'var(--dsw-alias-status-success, #168544)' : colors.muted } }, groupFeedback.message),
            React.createElement('button', { type: 'button', style: { ...button, justifySelf: 'end', background: addingGroup ? colors.border : colors.accent, color: '#fff', borderColor: addingGroup ? colors.border : colors.accent, cursor: addingGroup ? 'wait' : 'pointer' }, disabled: addingGroup, onClick: addGroup }, addingGroup ? '正在添加…' : '添加并开始常驻'))))
    }

    function apply(ctx) {
      ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({ name: 'settings.plugins.tab', id: 'dingtalk-dsh-assistant', order: 10, label: () => '钉钉个人助理', inject: () => ({}) }, DingTalkDshAssistantCard))
    }

    module.exports = { apply, inject, name, readResidentOverview, DingTalkDshAssistantCard }
    return module.exports
  },
})
