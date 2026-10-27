import { createHash } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const observationKind = 'dingtalk-skill-read'
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const skillDigest = value => digest([value.provider, value.resourceBase, value.content])

/**
 * 跟踪本会话真正读过的技能和引用，在下一模型步骤提示变化。
 * 复用原生 registry / filesystem，不注入正文、不自动执行脚本，也不把提示当成已读。
 * 会话恢复只重建摘要；原生 tool/result 和版本观察都保留在原审计中。
 */
export function installSessionSkillRefresh(ctx, agent, { cwd, signal }) {
  const skills = ctx.get('skills')
  const loader = ctx.tools.get('skill', agent)
  if (!skills || !loader) return
  const filesystem = ctx.get('agentPresets')?.serviceFor?.(agent, 'fs') ?? ctx.get('fs')
  const reader = ctx.tools.get('read', agent)
  const loaded = new Map(), references = new Map(), observations = new Map(), prepared = new Map(), checked = new Map()
  const legacy = new Set(), calls = new Map(), successful = new Set()
  const remember = record => {
    if (record.kind === 'skill') {
      if (digest(loaded.get(record.key)?.resourceBase ?? null) !== digest(record.resourceBase ?? null)) {
        for (const [key, ref] of references) if (ref.name === record.name) references.delete(key)
      }
      loaded.set(record.key, record)
      checked.set(record.key, record.version)
      legacy.delete(record.name)
    } else references.set(record.key, record)
  }
  for (const event of agent.session.snapshotEvents()) {
    if (event.type === 'tool/call' && event.data.name === 'skill') {
      try {
        const args = typeof event.data.arguments === 'string' ? JSON.parse(event.data.arguments) : event.data.arguments
        if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args?.name)) calls.set(event.data.callId, args.name)
      } catch { /* 无法解释的旧参数不作为版本证据。 */ }
    }
    if (event.type === 'tool/result') {
      const results = event.data?.message?.role === 'tool' ? [event.data.message] : event.data?.message?.content ?? []
      for (const result of results) if (!result.isError) {
        successful.add(result.toolCallId)
        if (calls.has(result.toolCallId)) legacy.add(calls.get(result.toolCallId))
      }
    }
  }
  for (const event of agent.session.snapshotEvents()) {
    if (event.type !== 'user/message' || event.data.source?.kind !== observationKind) continue
    // result 观察先于宿主落盘；只有对应原生成功结果也存在才恢复版本基线。
    if (successful.has(event.data.source.callId)) remember(event.data.source.record)
    else legacy.add(event.data.source.record.name)
  }
  let pending = [], refresh = true
  ctx.on('skills/change', () => { refresh = true })
  ctx.systemPrompt.context({ name: 'dingtalk:skill-refresh', order: 21, required: true, text: () => [
    pending.length ? `本会话已读技能或引用有变化：${JSON.stringify(pending)}。继续相关操作前，用原生 skill 重读对应入口、read 按需重读相关引用；缺失或读取失败如实说明。此提示不是已读取的证据，不扩大授权，也不要求重做已经有效完成的操作。` : '',
    legacy.size ? `历史成功技能调用尚无可核对版本记录：${JSON.stringify([...legacy])}。先按当前目录判断本阶段适用项，再用原生 skill 重读；不把旧同名工具回执当成当前规则。` : '',
  ].filter(Boolean).join('\n') })

  // 仅观察准确的原生 read 对象；同名替换不继承技能版本记录资格。
  if (filesystem && reader) ctx.on('fs/observed', (target, observation, exec) => {
    if (exec?.agent === agent && exec.name === 'read' && ctx.tools.get('read', agent) === reader
      && observation.kind === 'present' && observation.version !== undefined) {
      observations.set(exec.token, { path: filesystem.processPath(target), version: observation.version })
    }
  })
  // post-execute 是可等待的阶段。result 观察者不可 await，因此先准备只读元数据，
  // 再由最终成功结果同步落账，避免下一模型步骤或会话排空抢在记录之前。
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const observation = observations.get(exec.token)
    observations.delete(exec.token)
    if (exec.agent !== agent || result.isError || decision.kind !== 'accept') return decision
    let record
    if (exec.name === 'skill' && ctx.tools.get('skill', agent) === loader
      && result.value?.name === exec.arguments.name && typeof result.value?.content === 'string') {
      const value = result.value
      record = { kind: 'skill', key: value.name, name: value.name, version: skillDigest(value), ...(value.resourceBase ? { resourceBase: value.resourceBase } : {}) }
    } else if (observation && typeof result.value?.path === 'string') {
      try {
        const target = await filesystem.resolve(observation.path, { cwd, signal })
        for (const skill of loaded.values()) {
          if (skill.resourceBase?.kind !== 'directory') continue
          const root = await filesystem.resolve(skill.resourceBase.path, { cwd, signal })
          if (!filesystem.contains(root, target)) continue
          record = { kind: 'reference', key: observation.path, name: skill.name, ...observation }
          break
        }
      } catch (error) {
        if (signal.aborted) throw error
        // 附加元数据观察不能推翻原 read 的成功；显式保留记录缺口。
        for (const skill of loaded.values()) legacy.add(skill.name)
      }
    }
    if (record) prepared.set(exec.token, { record, valueDigest: digest(result.value) })
    return decision
  })
  ctx.on('tools/result', (exec, result) => {
    const item = prepared.get(exec.token)
    prepared.delete(exec.token)
    if (!item || result.isError || digest(result.value) !== item.valueDigest) return
    const previous = (item.record.kind === 'skill' ? loaded : references).get(item.record.key)
    remember(item.record)
    if (previous && digest(previous) === digest(item.record)) return
    // 使用宿主原生上下文记录，避免扩展 Session 事件格式或依赖跨安装实例的私有类。
    agent.session.append('user/message', createUserMessage({ source: { kind: observationKind, callId: exec.callId, record: item.record },
      content: [{ type: 'text', text: `已通过原生工具读取相关指引（${item.record.name}）。此记录只用于后续版本核对，不是授权或完成证明。` }] }), { surfaceOp: 'append' })
  })

  ctx.on('agent/pre-step', async (_event, next) => {
    const changed = []
    // 正文仅在恢复或原生 provider 报告变化后检查；普通模型步骤不重复加载正文。
    if (refresh) {
      refresh = false
      for (const record of loaded.values()) {
        let version
        try {
          const value = await skills.get(record.name, { cwd, scope: agent, signal })
          version = value?.invocation?.modelInvocable !== false && value ? skillDigest(value) : 'unavailable'
        } catch (error) { if (signal.aborted) throw error; version = 'unreadable' }
        checked.set(record.key, version)
      }
    }
    for (const record of loaded.values()) if (checked.get(record.key) !== record.version) changed.push({ key: record.key, name: record.name, version: checked.get(record.key) })
    if (filesystem) for (const record of references.values()) {
      let version
      try {
        const target = await filesystem.resolve(record.path, { cwd, signal })
        const root = await filesystem.resolve(loaded.get(record.name).resourceBase.path, { cwd, signal })
        version = filesystem.contains(root, target) ? (await filesystem.stat(target, signal))?.version ?? 'unavailable' : 'unavailable'
      } catch (error) { if (signal.aborted) throw error; version = 'unreadable' }
      if (version !== record.version) changed.push({ key: record.key, name: record.name, path: record.path, version })
    }
    pending = changed
    return next()
  })
}
