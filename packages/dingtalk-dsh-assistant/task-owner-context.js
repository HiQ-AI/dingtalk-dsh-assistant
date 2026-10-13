import { executionDigest } from './execution-artifacts.js'

export const ownerContextInstructions = 'Host投影：ownerContextBase与本轮字段合成当前上下文，sameAs是该上下文内完整正文路径。contextRef用task_owner_read_artifact按nextOffset读完；requiredRefs须提交前读完，previouslyReadRefs正文已完整保留，不重复读取。未读材料不算核验。材料索引按需分页，历史材料不扩大授权；materialAccess按当前queryContext读取，读取错误自行纠正，不要求重发附件。保留目标、约束、授权及未处理要求；来源原文与执行补充事实分开，web-context不等于钉钉真人原话，执行总结不授予权限。superseded仅历史审计，不是当前要求；当前状态优先于旧证据，旧证据身份不变。工具结果可直接分析，evidenceRef仅为执行凭据，不等于业务验收通过。'

export const ownerContextBaseFields = ['goal', 'currentSources', 'acceptanceItems', 'workflowCatalog', 'capabilities', 'sharedMaterials', 'materialAccess']

// A model projection only. Host decisions, authorization and evidence use the original input.
export async function projectOwnerContext(input, artifacts) {
  const refs = new Map(), required = new Set()
  const save = async (value, path, mandatory) => {
    value = JSON.parse(JSON.stringify(value))
    const digest = executionDigest(value)
    if (!refs.has(digest)) refs.set(digest, artifacts.put({ kind: 'owner-context-section', value }, { taskId: input.taskId }).then(saved => saved.ref))
    const ref = await refs.get(digest)
    if (mandatory) required.add(ref)
    return { contextRef: ref, requiredBeforeSubmit: mandatory }
  }
  const deferred = new Map([['constraintHistory', 4096], ['queryEvidence', 4096], ['stageArtifacts', 4096],
    ['completionEvidenceRefs', 2048], ['workflowCatalog', 2048]])
  const visit = async (value, path = []) => {
    if (path.join('.') === 'sharedMaterials' && value?.logicalTaskId) return { logicalTaskId: value.logicalTaskId,
      indexTool: 'task_owner_list_materials' }
    if (path.join('.') === 'materialAccess' && value?.verification === 'current-source-identity-and-material-ledger') {
      const { instruction, ...access } = value
      return access
    }
    const mandatory = path[0] === 'goal' && !['materials', 'constraintHistory'].includes(path[1])
      || ['maintenanceConstraints', 'currentExecution', 'correction', 'currentSources', 'acceptanceItems'].includes(path[0])
    if (path.join('.') === 'goal.sourceInstructions' && Array.isArray(value)) {
      const versions = input.goal?.scope?.sourceVersions ?? {}
      const authorizationSources = input.goal?.stageAuthorizations ?? []
      const history = value.filter(source => Number.isSafeInteger(versions[source.sourceKey]) && versions[source.sourceKey] > source.sourceVersion
        && !authorizationSources.some(auth => auth.sourceKey === source.sourceKey && auth.sourceVersion === source.sourceVersion))
      if (history.length) {
        const current = value.filter(source => !history.includes(source))
        return { current: await Promise.all(current.map(source => visit(source, [...path, value.indexOf(source)]))),
          history: await save(history, ['goal', 'sourceInstructions', 'history'], false),
          instruction: 'current保留当前或授权绑定来源；history仅是明确旧版本原文。当前有效约束仍完整保留在constraints。' }
      }
    }
    if (value !== null && typeof value === 'object' && deferred.has(path.at(-1)) && JSON.stringify(value).length > deferred.get(path.at(-1)))
      return save(value, path, false)
    if (typeof value === 'string' && value.length > 2048) return save(value, path, mandatory)
    if (Array.isArray(value)) return Promise.all(value.map((entry, index) => visit(entry, [...path, index])))
    if (value && typeof value === 'object') return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, entry]) => [key, await visit(entry, [...path, key])])))
    return value
  }
  const modelInput = await visit(input)
  // 只合并完全相同的来源正文；身份、版本、附件和新增要求仍各自保留。
  const sourceTexts = new Map()
  const remember = (source, path) => {
    if (typeof source?.text !== 'string') return
    const previous = sourceTexts.get(source.text)
    if (previous && source.text.length > JSON.stringify({ sameAs: previous }).length)
      source.text = { sameAs: previous }
    else sourceTexts.set(source.text, path)
  }
  const sources = modelInput.goal?.sourceInstructions
  const current = Array.isArray(sources) ? sources : sources?.current
  current?.forEach((source, index) => remember(source, ['goal', 'sourceInstructions', ...(Array.isArray(sources) ? [] : ['current']), index, 'text']))
  modelInput.currentSources?.forEach((source, index) => remember(source, ['currentSources', index, 'text']))
  const requestPath = sourceTexts.get(modelInput.goal?.request)
  if (requestPath && modelInput.goal.request.length > JSON.stringify({ sameAs: requestPath }).length)
    modelInput.goal.request = { sameAs: requestPath }
  modelInput.contextAccess = {
    version: 1, requiredRefs: [...required].sort(),
  }
  return { modelInput, readableRefs: (await Promise.all(refs.values())).sort(), requiredRefs: [...required].sort() }
}

export function measureOwnerContext(input) {
  const fields = []
  const visit = (value, path) => {
    fields.push({ path: path.join('.') || '$', chars: JSON.stringify(value)?.length ?? 0 })
    if (value && typeof value === 'object' && !Array.isArray(value)) for (const [key, entry] of Object.entries(value)) visit(entry, [...path, key])
  }
  visit(input, [])
  return fields.sort((a, b) => b.chars - a.chars)
}
