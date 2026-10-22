import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, lstatSync, readFileSync, writeFileSync, realpathSync, openSync, fsyncSync, closeSync } from 'node:fs'
import { join, resolve, parse } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const deferred = Symbol('deferred model content')
const digest = json => 'sha256:' + createHash('sha256').update(json).digest('hex')
const ordered = value => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value
export const modelContentScope = header => digest(JSON.stringify([header.id, header.createdAt])).slice(7)
export const modelContentRoot = header => resolve(header.cwd ?? process.cwd(), '.dsh/model-content')
const fail = code => { throw Object.assign(new Error(code), { code }) }
export const deferModelContent = value => ({ [deferred]: value })
// The SDK has already durably recorded the unmodified steer in inbox/spliced.
// Only the admitted model message is projected; link it to that original ID.
export const modelHostMessage = (message, value) => createUserMessage({
  source: { ...message.source, rawHostMessageId: message.id },
  content: [{ type: 'text', text: JSON.stringify(value) }, ...message.content.slice(1)],
})
export const modelHostInput = message => JSON.parse(message.content[0].text)
const fields = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]))
const terminal = new Set(['succeeded', 'failed', 'cancelled'])
const terminalExecutions = new Set([...terminal, 'stale'])
const contentFields = new Set(['text', 'body', 'reply', 'request', 'objective', 'context', 'goalText', 'policy', 'groupResponsibility', 'question', 'summary', 'answer', 'title'])
// scope、摘要和字典键本身有成本，短文本直接展示比建立引用更小。
const indexText = value => Buffer.byteLength(value) >= 512
const syncDirectory = path => {
  if (process.platform === 'win32') return
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

export const modelContextInstructions = `Host输入和只读工具使用contentRef标识精确内容。Host的contextRef是超预算视图的完整不可变快照；contextPath是相对该contextRef的JSON Pointer，用model_content_read的contentRef及path参数读取对应字段，必要时继续解析其中的引用。contextReadRequired/readRequired表示相关目标、来源身份/作者/版本/授权更正、未处理要求、未知效果和恢复信息尚待读取核对，不得把引用当作已知或没有要求；先读取与当前判断相关的字段。相同正文不等于同一作者、来源版本或授权，历史资料不改变当前授权。执行document.path是本成员当前inputVersion轮次的执行文档，日常进度与交接优先用原生文件工具读取它，核对文档内身份和版本；当前轮会更新，sha256只标识本次投影时的内容，新轮使用独立路径并保留旧轮。document不携带新增授权。执行resultInCatalog表示完整结果在catalogRef的/executions/<原ID>/result，文档缺证据、版本矛盾或异常时按问题定位原始证据或诊断，不必例行整包读取。当前目标或要求为sourceId时，从对应sources.textFile定位原文；若来源在当前窗口外，沿catalogRef的/materials按sourceId定位textPath或/sources/<原ID>读取原始来源；requestIdentityInCatalog表示完整请求身份在相应source目录的/requestIdentity，不得省略授权核对。统筹快照catalogRef是完整原始目录：/task、/sources/<sourceId>、/executions/<executionId>、/operations/<operationId>、/materials、/wakes；例如/executions/<executionId>/input/objective。路径段的~与/须分别转义为~0与~1。sources保守保留近期及原授权来源，sourceCount可大于展示数量；核对目录中仍有效的要求/授权/撤销，不能把未展开当作不存在。当前task/sources/executions中的readRequired=true表示长正文无损延迟，表示本轮要求/证据尚待核对：优先用既有原生文件工具读取path、textFile或sourceFile，定位与当前判断相关的字段/段落，不必整文件回灌；重要新要求、撤销及授权条件必须核对，未读部分不能当作已知。统筹executions只展示运行/未排空、本轮唤醒关联或当前结果，历史执行仍完整可读；operations只展示unknown及本轮事件关联的操作，其他状态用operationCounts计数，blockers保留未决成员准确ID，未展开不是无阻塞。阶段wake仅有executionId/sequence时，有document时从对应本轮文档读取报告，否则对应executions.stageProgress就是经过全部字段核对的同一报告；有reportRef时须读取该次原报告，可能早于当前阶段，不可混用。执行会话仍用executionHistory.catalogRef及sourceCatalog等原目录。过长且无法精简的正文、结果、证据、诊断与日志只提供已有不可变JSON文件path（文本内容为JSON字符串，按字段解析后定位），不以contentIndex自动展开；用户长消息优先使用原source JSON及原文txt文件。使用已有原生文件/shell能力，注意原生read的行长/总量截断提示，按需定位或分段读取；不要把截断当全文。contentRef与model_content_read仅保留兼容读取，不要求按其分页把长正文整包读回。显式读取返回正文，不能把引用或未读内容当证据。引用不是丢弃或截断。`

// contentRef remains a native-session capability. Paths point only to existing
// admitted immutable files; native filesystem permission policy remains unchanged.
export function createModelContentIndex(session, { root = modelContentRoot(session.header) } = {}) {
  root = resolve(root)
  const values = new Map()
  const decoded = new Map()
  const pages = new Map()
  const objects = new Set()
  const scope = modelContentScope(session.header)
  const scopes = new Map([[scope, root], ...session.snapshotEvents().filter(event => event.type === 'plugin:dingtalk/group-coordinator-session' && event.data.parentContentScope)
    .map(event => [event.data.parentContentScope, event.data.parentContentRoot ?? root])])
  function checkedDirectory(path, create = true) {
    if (!existsSync(path)) {
      if (!create) fail('MODEL_CONTENT_MISSING')
      const parent = resolve(path, '..')
      if (parent !== path) checkedDirectory(parent)
      try { mkdirSync(path) } catch (error) { if (error.code !== 'EEXIST') throw error }
      syncDirectory(parent)
    }
    if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) fail('MODEL_CONTENT_DIRECTORY_INVALID')
    const canonical = realpathSync(path), expected = resolve(path)
    if ((process.platform === 'win32' ? canonical.toLowerCase() !== expected.toLowerCase() : canonical !== expected) && parse(path).root !== path) fail('MODEL_CONTENT_DIRECTORY_INVALID')
  }
  checkedDirectory(resolve(root)); checkedDirectory(join(root, scope))
  const filename = ref => {
    const match = /^([a-f0-9]{64}):sha256:([a-f0-9]{64})$/.exec(ref)
    if (!match || !scopes.has(match[1])) fail('MODEL_CONTENT_NOT_ADMITTED')
    const directory = join(scopes.get(match[1]), match[1])
    checkedDirectory(directory, false)
    return join(directory, match[2] + '.json')
  }
  function load(ref) {
    if (values.has(ref)) return values.get(ref)
    const path = filename(ref)
    if (!existsSync(path)) fail('MODEL_CONTENT_MISSING')
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink()) fail('MODEL_CONTENT_FILE_INVALID')
    const json = readFileSync(path, 'utf8')
    if (!ref.endsWith(digest(json))) fail('MODEL_CONTENT_DIGEST_MISMATCH')
    values.set(ref, json)
    return json
  }
  function store(value) {
    const json = JSON.stringify(value, (_key, child) => ordered(child))
    if (json === undefined) fail('MODEL_CONTENT_VALUE_INVALID')
    const ref = scope + ':' + digest(json)
    if (!values.has(ref)) {
      const path = filename(ref)
      try {
        const fd = openSync(path, 'wx', 0o600)
        try { writeFileSync(fd, json); fsyncSync(fd) } finally { closeSync(fd) }
        syncDirectory(join(root, scope))
      }
      catch (error) { if (error.code !== 'EEXIST') throw error; if (load(ref) !== json) fail('MODEL_CONTENT_DIGEST_MISMATCH') }
      values.set(ref, json)
    }
    return { contentRef: ref, path: filename(ref), format: typeof value === 'string' ? 'text' : 'json', bytes: Buffer.byteLength(json) }
  }
  function project(value, { reuseVisible = true } = {}) {
    const localObjects = reuseVisible ? objects : new Set()
    const reference = value => { const stored = store(value); return { contentRef: stored.contentRef, path: stored.path, format: 'json' } }
    function visit(item, key) {
      if (item && Object.hasOwn(item, deferred)) return reference(item[deferred])
      if (item && typeof item === 'object' && ['entries', 'events', 'logs', 'diagnostics', 'context', 'results', 'payload', 'output', 'data', 'evidence'].includes(key)
        && Buffer.byteLength(JSON.stringify(item)) >= 2048) return reference(item)
      if (typeof item === 'string' && indexText(item)) {
        const ref = reference(item)
        // The immutable file is the definition; never eagerly reinject a long body.
        return ref
      }
      if (item && typeof item === 'object') {
        let hasDeferred = false
        const json = JSON.stringify(item, (_key, child) => {
          if (child && Object.hasOwn(child, deferred)) { hasDeferred = true; return null }
          return ordered(child)
        })
        if (!hasDeferred && json.length >= 240) {
          const ref = scope + ':' + digest(json)
          if (localObjects.has(ref)) return reference(item)
          localObjects.add(ref); objects.add(ref)
        }
      }
      if (Array.isArray(item)) {
        if (key === undefined && Buffer.byteLength(JSON.stringify(item)) >= 2048) return reference(item)
        return item.map(child => visit(child))
      }
      if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, key === 'contentRef' ? child : visit(child, key)]))
      return item
    }
    const projected = visit(value)
    return projected
  }
  function selected(contentRef, path) {
    if (typeof path !== 'string' || path && !path.startsWith('/')) fail('MODEL_CONTENT_READ_INVALID')
    if (!decoded.has(contentRef)) decoded.set(contentRef, JSON.parse(load(contentRef)))
    let value = decoded.get(contentRef)
    for (const encoded of path ? path.slice(1).split('/') : []) {
      if (/~(?![01])/u.test(encoded)) fail('MODEL_CONTENT_PATH_INVALID')
      const key = encoded.replaceAll('~1', '/').replaceAll('~0', '~')
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) fail('MODEL_CONTENT_PATH_INVALID')
      value = value[key]
    }
    return value
  }
  function read({ contentRef, path = '', offset = 0, limit = 4000 }) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 16000) fail('MODEL_CONTENT_READ_INVALID')
    const pageKey = JSON.stringify([contentRef, path])
    if (!pages.has(pageKey)) {
      const value = selected(contentRef, path)
      pages.set(pageKey, { text: typeof value === 'string' ? value : JSON.stringify(value), format: typeof value === 'string' ? 'text' : 'json', resolvedRef: store(value) })
    }
    const { text, format, resolvedRef } = pages.get(pageKey)
    if (offset > text.length) fail('MODEL_CONTENT_READ_INVALID')
    const end = Math.min(offset + limit, text.length)
    return { contentRef, path, format, offset, totalLength: text.length,
      text: text.slice(offset, end), nextOffset: end < text.length ? end : null, resolvedRef }
  }
  function install(agentCtx, isCurrent = async () => true) {
    agentCtx.systemPrompt.section({ name: 'dingtalk:model-content', order: 20, text: modelContextInstructions })
    agentCtx.tools.register({ name: 'model_content_read', effectClass: 'read', description: '读取本会话已准入contentRef的精确内容。支持JSON Pointer和分页；未知引用不能读取。',
      parameters: { type: 'object', properties: { contentRef: { type: 'string' }, path: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 16000 } }, required: ['contentRef'], additionalProperties: false },
      // An explicit read is the leaf of the index. Re-projecting its `text`
      // changes the page contract into another reference instead of evidence.
      output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args, exec) {
        exec.signal.throwIfAborted(); if (!await isCurrent()) fail('MODEL_CONTENT_SESSION_STALE')
        const value = selected(args.contentRef, args.path ?? '')
        if (value && typeof value === 'object') {
          const offset = args.offset ?? 0, limit = Math.min(args.limit ?? 20, 20), entries = Object.entries(value)
          if (!Number.isSafeInteger(offset) || offset < 0 || offset > entries.length || !Number.isSafeInteger(limit) || limit < 1) fail('MODEL_CONTENT_READ_INVALID')
          const end = Math.min(offset + limit, entries.length)
          return { contentRef: args.contentRef, path: args.path ?? '', format: 'json-index', valueKind: Array.isArray(value) ? 'array' : 'object', totalEntries: entries.length,
            entries: entries.slice(offset, end).map(([key, child]) => ({ key, ...(child && typeof child === 'object' || typeof child === 'string' && (child.length >= 120 || contentFields.has(key))
              ? { valueRef: store(child) } : { value: child }) })), nextOffset: end < entries.length ? end : null }
        }
        // Explicit repeated reads must return the same requested page, even if
        // a prior Host/tool message already contains the original definition.
        return read(args)
      } })
  }
  const render = value => [{ type: 'text', text: JSON.stringify(host(value, { reuseVisible: true })) }]
  function wrapOutput(output) {
    return { ...output, render: (args, value) => output.render(args, value).map(block => {
      if (block.type !== 'text') return block
      let payload
      try { payload = JSON.parse(block.text) } catch { payload = { text: block.text } }
      return { ...block, text: JSON.stringify(host(payload, { reuseVisible: true })) }
    }) }
  }
  function instruction(text, label = '详细上下文') {
    if (typeof text !== 'string' || !indexText(text)) return text
    const file = store(text)
    return `${label}已保存在${file.path}（JSON字符串；contentRef=${file.contentRef}）。按当前问题用已有文件能力定位相关段落，先核对授权边界，不必整包回灌；未读取部分不能当作已知。`
  }
  // Budget the actual serialized Host text, after all field-level projection.
  // One immutable definition carries overflow; pointers never imply it was read.
  function host(value, { reuseVisible = false, projected: alreadyProjected = false } = {}) {
    const projected = alreadyProjected ? value : project(value, { reuseVisible })
    const bytes = value => Buffer.byteLength(JSON.stringify(value) ?? '')
    if (bytes(projected) <= 3000) return projected
    const snapshot = store(projected)
    if (Object.hasOwn(projected, 'contextRef') || Object.hasOwn(projected, 'contextReadRequired'))
      return { contextRef: snapshot.contentRef, contextReadRequired: true }
    const result = { ...projected, contextRef: snapshot.contentRef, contextReadRequired: true }
    const pointer = key => '/' + key.replaceAll('~', '~0').replaceAll('/', '~1')
    const candidates = Object.keys(projected).sort((a, b) => bytes(projected[b]) - bytes(projected[a]))
    for (const key of candidates) {
      if (bytes(result) <= 2800) break
      const reference = { contextPath: pointer(key), readRequired: true }
      if (bytes(reference) < bytes(result[key])) result[key] = reference
    }
    // Arbitrarily many or long keys must also fit without dropping their data.
    return bytes(result) <= 3000 ? result : { contextRef: snapshot.contentRef, contextReadRequired: true }
  }
  function hostSources(input) {
    if (Array.isArray(input.sources)) return input.sources
    if (!input.contextRef) return undefined
    const snapshot = selected(input.contextRef, '')
    return Array.isArray(snapshot.sources) ? snapshot.sources : undefined
  }
  return { project, host, hostSources, store, read, install, render, wrapOutput, instruction }
}

function directory(records, identity, summary) {
  return { total: records.length, items: records.slice(0, 20).map(summary),
    catalogRef: deferModelContent(Object.fromEntries(records.map((record, index) => [record[identity] ?? 'unidentified-' + index, record]))) }
}
export function executionDirectory(executions, { historical = false } = {}) {
  return directory(executions, 'executionId', execution => terminalExecutions.has(execution.status) ? {
    ...fields(execution, ['executionId', 'key', 'status', 'drained', 'inputVersion', 'requirementRevision', 'controlRevision', 'document']),
    input: executionInputDirectory(execution.input, true),
    ...(execution.result ? { result: fields(execution.result, ['current', 'receivedAt', 'recovery']), resultRef: deferModelContent(execution.result) } : {}),
  } : ({ ...fields(execution,
    ['executionId', 'sessionId', 'taskId', 'key', 'status', 'drained', 'recovering', 'cancelRequested', 'inputVersion', 'inputDigest', 'leaseEpoch', 'requirementRevision', 'controlRevision', 'progressReview', 'providerRecovery', 'document']),
    ...(execution.stageProgress ? { stageProgress: execution.stageProgress } : {}),
    input: executionInputDirectory(execution.input, historical),
    // Keep the Host recovery decision visible without reinjecting the full result.
    ...(execution.result ? { result: fields(execution.result, ['current', 'requirementRevision', 'controlRevision', 'leaseEpoch', 'inputVersion', 'receivedAt', 'recovery']), resultRef: deferModelContent(execution.result) } : {}) }))
}
function executionInputDirectory(input = {}, historical = false) {
  return { ...fields(input, ['title', 'recoveryReadOnly', 'readbackOperationId', 'skillNames']),
    ...(!historical && input.objective !== undefined ? { objective: input.objective } : {}) }
}
// A blocker is membership, not another copy of the execution/operation record.
function mergeRecords(records, blockers, identity) {
  const merged = new Map(records.map(record => [record[identity], record]))
  for (const record of blockers) if (!merged.has(record[identity])) merged.set(record[identity], record)
  return [...merged.values()]
}
function stageWake(wake) {
  if (wake.kind !== 'execution.stage.progress' || !wake.payload) return wake
  return { ...wake, payload: { ...fields(wake.payload, ['executionId', 'sequence', 'inputVersion', 'leaseEpoch', 'requirementRevision', 'controlRevision']),
    reportRef: deferModelContent(wake.payload) } }
}
export function operationDirectory(operations) {
  return directory(operations, 'operationId', operation => ({ ...fields(operation, ['operationId', 'executionId', 'state', 'requirementRevision', 'controlRevision', 'resourceKeys', 'evidenceRef', 'authorizationRef']),
    toolName: operation.definition?.toolName ?? operation.definition?.tool, effectClass: operation.definition?.effectClass }))
}
// 保留各已接纳作者的近期补充；最初需求人未必是后来调整授权范围的操作人。
function currentTaskSources(sources, authorizationSourceId) {
  const selected = new Set(sources.slice(-19))
  const original = sources.find(source => source.sourceId === authorizationSourceId)
  if (original) selected.add(original)
  return sources.filter(source => selected.has(source))
}
function sourceContext(source) {
  return { ...fields(source, ['sourceId', 'actorId', 'senderName', 'channel', 'messageId', 'version', 'timestamp', 'corrects', 'supersedes', 'text', 'body', 'quote', 'resources']),
    ...(source.requestIdentity ? { requestIdentityRef: deferModelContent(source.requestIdentity) } : {}) }
}
// The catalog retains the unabridged records under their original identities.
const recordsById = (records, identity) => Object.fromEntries(records.map((record, i) => [record[identity] ?? 'unidentified-' + i, record]))
function decisionContent(value) {
  let readRequired = false
  function visit(item, key) {
    if (typeof item === 'string' && indexText(item) && (key === undefined || contentFields.has(key))) { readRequired = true; return deferModelContent(item) }
    if (Array.isArray(item)) {
      if (Buffer.byteLength(JSON.stringify(item)) >= 2048) { readRequired = true; return deferModelContent(item) }
      return item.map(child => visit(child, key))
    }
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child, key)]))
    return item
  }
  return { value: visit(value), readRequired }
}
function taskSourceContext(source, material) {
  if (material?.path && typeof source.text === 'string' && indexText(source.text)) {
    const { text: _text, quote: _quote, requestIdentityRef: _requestIdentity, ...identity } = sourceContext(source)
    return { ...identity,
      textFile: material.textPath ?? material.path, readRequired: true,
      ...(source.requestIdentity ? { requestIdentityInCatalog: true } : {}),
      ...(source.quote || source.resources?.length ? { sourceFile: material.path } : {}),
      ...(source.quote ? { quoteInSourceFile: true } : {}) }
  }
  const projected = sourceContext(source)
  let readRequired = false
  for (const key of ['text', 'body', 'quote']) if (Object.hasOwn(projected, key)) {
    const content = decisionContent(projected[key])
    projected[key] = content.value; readRequired ||= content.readRequired
  }
  return { ...projected, ...(readRequired ? { readRequired: true } : {}) }
}
export function taskModelInput(input) {
  const task = input.task ?? {}, sources = input.sources ?? [], wakes = input.wakes ?? [],
    operations = mergeRecords(input.operations ?? [], input.blockers?.operations ?? [], 'operationId'),
    executions = mergeRecords(input.executions ?? [], input.blockers?.executions ?? [], 'executionId')
  const wokenExecutions = new Set(wakes.map(wake => wake.payload?.executionId).filter(Boolean))
  const wokenOperations = new Set(wakes.map(wake => wake.payload?.operationId).filter(Boolean))
  // Only definitely historical terminal records leave the default decision view.
  // A current result is not presumed reviewed from a timestamp or lastDecision.
  const relevant = executions.filter(execution => !terminalExecutions.has(execution.status) || !execution.drained
    || wokenExecutions.has(execution.executionId) || execution.status !== 'stale' && execution.result?.current !== false)
  const currentExecutions = relevant.map(execution => {
    // 日常交接从本轮文档读取完整职责、进度和证据；原账仍保存在 catalog。
    if (execution.document) return { ...fields(execution,
      ['executionId', 'key', 'status', 'drained', 'recovering', 'cancelRequested', 'inputVersion', 'leaseEpoch', 'requirementRevision', 'controlRevision', 'providerRecovery', 'document']),
      input: fields(execution.input, ['title', 'recoveryReadOnly', 'readbackOperationId', 'skillNames']),
      ...(execution.result ? { result: fields(execution.result, ['current', 'inputVersion', 'leaseEpoch', 'requirementRevision', 'controlRevision', 'receivedAt', 'recovery']), resultInCatalog: true } : {}) }
    const active = !terminalExecutions.has(execution.status)
    const source = sources.find(source => source.text === execution.input?.objective && indexText(source.text ?? ''))
    const material = source && (input.materials ?? []).find(material => material.sourceId === source.sourceId && material.path)
    const objective = material ? { value: { sourceId: source.sourceId }, readRequired: true } : decisionContent(execution.input?.objective)
    const stage = decisionContent(execution.stageProgress)
    // 当前团队成员的职责和自述用于定位/续办；完整证据仍在原目录中验收。
    const summary = decisionContent(execution.result?.payload?.output?.summary)
    return { ...fields(execution,
      ['executionId', 'key', 'status', 'drained', 'recovering', 'cancelRequested', 'inputVersion', 'leaseEpoch', 'requirementRevision', 'controlRevision', 'providerRecovery']),
      input: { ...executionInputDirectory(execution.input),
        ...(execution.input?.objective !== undefined ? { objective: objective.value } : {}) },
      ...(active && execution.stageProgress ? { stageProgress: stage.value } : {}),
      ...(objective.readRequired || summary.readRequired || active && stage.readRequired ? { readRequired: true } : {}),
      ...(execution.result ? { result: { ...fields(execution.result, ['current', 'inputVersion', 'leaseEpoch', 'requirementRevision', 'controlRevision', 'receivedAt', 'recovery']),
        ...(summary.value === undefined ? {} : { reportedSummary: summary.value }) }, resultInCatalog: true } : {}) }
  })
  const projectedWakes = wakes.map(wake => {
    if (wake.kind !== 'execution.stage.progress' || !wake.payload) return wake
    const execution = relevant.find(item => item.executionId === wake.payload.executionId)
    const { executionId, ...report } = wake.payload
    const canonical = value => JSON.stringify(value, (_key, child) => ordered(child))
    if (execution && !execution.document && !terminalExecutions.has(execution.status) && canonical(execution.stageProgress) === canonical(report))
      return { ...wake, payload: { executionId, sequence: report.sequence } }
    return stageWake(wake)
  })
  const goal = task.objective ?? task.request
  const goalSource = sources.find(source => source.text === goal && indexText(source.text ?? ''))
  const goalMaterial = goalSource && (input.materials ?? []).find(material => material.sourceId === goalSource.sourceId && material.path)
  const objective = goalMaterial ? { value: { sourceId: goalSource.sourceId }, readRequired: true } : decisionContent(goal), requirements = decisionContent(task.requirements)
  if (Array.isArray(task.requirements)) {
    const mapped = task.requirements.map(requirement => {
    const source = sources.find(source => source.text === requirement && indexText(source.text ?? ''))
    const file = source && (input.materials ?? []).find(material => material.sourceId === source.sourceId && material.path)
    return file ? { sourceId: source.sourceId } : requirement
    })
    Object.assign(requirements, decisionContent(mapped))
  }
  const currentTask = { ...fields(task, ['taskId', 'sessionId', 'groupId', 'title', 'status', 'control', 'ownerActorId', 'requirementRevision', 'controlRevision', 'leaseEpoch', 'drained', 'runSequence']),
    ...(task.objective !== undefined || task.request !== undefined ? { objective: objective.value } : {}),
    ...(task.requirements !== undefined ? { requirements: requirements.value } : {}),
    ...(objective.readRequired || requirements.readRequired ? { readRequired: true } : {}),
    ...(task.lastDecision ? { lastDecision: fields(task.lastDecision, ['action', 'summary', 'question', 'audience', 'at', 'recordedAt', 'requirementRevision', 'controlRevision', 'binding']) } : {}),
    authorizationSourceId: task.metadata?.authorizationSourceId,
    humanRequests: (task.humanRequests ?? []).filter((request, i, all) => request.status === 'waiting-reply' || i === all.length - 1)
      .map(request => ({ ...fields(request, ['requestId', 'status', 'audience', 'requirementRevision', 'controlRevision', 'sourceId', 'responseSourceId']),
        ...(request.status === 'waiting-reply' ? fields(request, ['reason', 'question']) : {}) })) }
  const materials = (input.materials ?? []).filter(material => material.resources?.length).map(material => fields(material, ['sourceId', 'path', 'resources']))
  return { task: currentTask, sources: currentTaskSources(sources, task.metadata?.authorizationSourceId).map(source => taskSourceContext(source, (input.materials ?? []).find(material => material.sourceId === source.sourceId))), sourceCount: sources.length, sourceReviewRequired: true,
    ...(materials.length ? { materials } : {}), executionCount: executions.length,
    ...(input.dialogue ? { dialogue: input.dialogue } : {}),
    ...(input.coordinationAssessments?.length ? {coordinationAssessments:input.coordinationAssessments} : {}),
    wakes: projectedWakes, executions: currentExecutions,
    // Ordinary pending operations need no coordinator decision yet; their exact
    // identities remain in blockers and the catalog. Unknown effects stay visible.
    operations: operations.filter(operation => operation.state === 'unknown' || wokenOperations.has(operation.operationId))
      .map(operation => operationDirectory([operation]).items[0]),
    operationCounts: Object.fromEntries(Object.entries(Object.groupBy(operations, operation => operation.state)).map(([state, items]) => [state, items.length])),
    blockers: { ...input.blockers,
      executions: (input.blockers?.executions ?? []).map(record => ({ executionId: record.executionId })),
      operations: (input.blockers?.operations ?? []).map(record => ({ operationId: record.operationId })) },
    catalogRef: deferModelContent({ ...input, task, sources: recordsById(sources, 'sourceId'), executions: recordsById(executions, 'executionId'),
      operations: recordsById(operations, 'operationId'), materials: input.materials ?? [] }) }
}

export function executionModelInput(input, binding) {
  const all = input.sources ?? [], current = currentTaskSources(all, input.task?.authorizationSourceId)
  const selected = new Set(current.map(source => source.sourceId))
  const history = executionDirectory((input.previousExecutions ?? []).filter(execution => execution.executionId !== binding.executionId), { historical: true })
  const { sourceFiles, ...rest } = input
  if (sourceFiles) {
    rest.task = { ...input.task }
    for (const source of current) {
      const file = sourceFiles[source.sourceId]
      if (!file?.path || typeof source.text !== 'string' || !indexText(source.text)) continue
      const reference = { sourceId: source.sourceId, path: file.textPath ?? file.path }
      for (const key of ['objective', 'request']) if (rest.task[key] === source.text) rest.task[key] = reference
      for (const key of ['objective', 'context']) if (rest[key] === source.text) rest[key] = reference
      if (Array.isArray(rest.task.requirements)) rest.task.requirements = rest.task.requirements.map(item => item === source.text ? reference : item)
    }
  }
  return { ...rest, sourceReviewRequired: true, sources: current.map(source => taskSourceContext(source, sourceFiles?.[source.sourceId])), sourceCatalog: {
    total: all.length, items: current.map(source => fields(source, ['sourceId', 'actorId', 'version', 'messageId', 'corrects', 'supersedes'])),
    catalogRef: deferModelContent(Object.fromEntries(all.map(source => [source.sourceId, source]))) },
    materialPaths: (input.materialPaths ?? []).filter((_path, index) => selected.has(all[index]?.sourceId)),
    materialCatalogRef: deferModelContent(Object.fromEntries(all.map((source, index) => [source.sourceId, { sourceId: source.sourceId, path: input.materialPaths?.[index] }]))),
    previousExecutions: history.items, executionHistory: { total: history.total, catalogRef: history.catalogRef },
    ...(input.originalOperation ? { originalOperation: { ...fields(input.originalOperation, ['operationId', 'state', 'evidenceRef']), evidence: deferModelContent(input.originalOperation) } } : {}) }
}

export function operationModelReadback(value, reference = deferModelContent) {
  if (!value?.operation) return value
  const operation = operationDirectory([value.operation]).items[0]
  return { ...value, operation: { ...operation, evidence: reference(value.operation) } }
}
