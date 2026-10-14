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
const contentFields = new Set(['text', 'body', 'reply', 'request', 'objective', 'context', 'goalText', 'policy', 'groupResponsibility', 'question', 'summary', 'answer', 'title'])
const syncDirectory = path => {
  if (process.platform === 'win32') return
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

export const modelContextInstructions = `Host输入和只读工具使用contentRef标识精确内容。contentIndex只定义正文一次；相同正文的作者、来源版本、授权与更正关系仍由各自记录决定，内容相同不等于同一授权。没有内联定义的引用须用model_content_read读取；path为JSON Pointer，json-index按条目、文本按字符分页直到nextOffset=null，不能将目录、摘要或未读取的内容当作完整证据。历史来源/结果不改变当前授权。目录仅列前20项，catalogRef可读取全部记录（按ID访问）。必须核对未展示的未处理要求及仍有效授权/更正，不能把未展开当作不存在；执行按小目标选择所需内容。引用不是丢弃或截断。`

// References are capabilities of this native session, not filesystem paths or
// globally readable hashes. Original inputs/ledger receipts are never rewritten.
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
    return { contentRef: ref, format: typeof value === 'string' ? 'text' : 'json', bytes: Buffer.byteLength(json) }
  }
  function visibleDefinitions() {
    const refs = new Set(), events = session.snapshotEvents()
    for (const seq of session.surface.nodes) {
      const message = session.deriveEventMessage(events[seq])
      for (const block of message?.content ?? []) if (block.type === 'text') {
        try {
          for (const [ref, text] of Object.entries(JSON.parse(block.text)?.contentIndex ?? {})) {
            const match = /^([a-f0-9]{64}):sha256:([a-f0-9]{64})$/.exec(ref)
            if (match && scopes.has(match[1]) && typeof text === 'string' && ref.endsWith(digest(JSON.stringify(text)))) refs.add(ref)
          }
        } catch { /* ordinary prose */ }
      }
    }
    return refs
  }
  function project(value, { reuseVisible = true } = {}) {
    const known = reuseVisible ? visibleDefinitions() : new Set(), contentIndex = {}
    const localObjects = reuseVisible ? objects : new Set()
    function visit(item, key) {
      if (item && Object.hasOwn(item, deferred)) return store(item[deferred])
      if (typeof item === 'string' && (item.length >= 120 || contentFields.has(key))) {
        const reference = store(item)
        if (!known.has(reference.contentRef)) contentIndex[reference.contentRef] = item
        known.add(reference.contentRef)
        return reference
      }
      if (item && typeof item === 'object') {
        let hasDeferred = false
        const json = JSON.stringify(item, (_key, child) => {
          if (child && Object.hasOwn(child, deferred)) { hasDeferred = true; return null }
          return ordered(child)
        })
        if (!hasDeferred && json.length >= 240) {
          const ref = scope + ':' + digest(json)
          if (localObjects.has(ref)) return store(item)
          localObjects.add(ref); objects.add(ref)
        }
      }
      if (Array.isArray(item)) return item.map(child => visit(child))
      if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, key === 'contentRef' ? child : visit(child, key)]))
      return item
    }
    const projected = visit(value)
    return Object.keys(contentIndex).length ? { ...(Array.isArray(projected) ? { value: projected } : projected), contentIndex } : projected
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
      output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(project(value)) }] },
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
        const page = read(args)
        if (visibleDefinitions().has(page.resolvedRef.contentRef)) {
          const { text: _text, ...metadata } = page
          return { ...metadata, alreadyVisible: true, nextOffset: null }
        }
        return page
      } })
  }
  const render = value => [{ type: 'text', text: JSON.stringify(project(value)) }]
  function wrapOutput(output) {
    return { ...output, render: (args, value) => output.render(args, value).map(block => {
      if (block.type !== 'text') return block
      let payload
      try { payload = JSON.parse(block.text) } catch { payload = { text: block.text } }
      return { ...block, text: JSON.stringify(project(payload)) }
    }) }
  }
  return { project, store, read, install, render, wrapOutput }
}

function directory(records, identity, summary) {
  return { total: records.length, items: records.slice(0, 20).map(summary),
    catalogRef: deferModelContent(Object.fromEntries(records.map((record, index) => [record[identity] ?? 'unidentified-' + index, record]))) }
}
export function executionDirectory(executions) {
  return directory(executions, 'executionId', execution => ({ ...fields(execution,
    ['executionId', 'sessionId', 'taskId', 'key', 'status', 'drained', 'recovering', 'cancelRequested', 'inputVersion', 'inputDigest', 'leaseEpoch', 'requirementRevision', 'controlRevision', 'progressReview', 'stageProgress', 'providerRecovery']),
    input: fields(execution.input ?? {}, ['title', 'objective', 'recoveryReadOnly', 'readbackOperationId', 'skillNames']),
    // Keep the Host recovery decision visible without reinjecting the full result.
    ...(execution.result ? { result: fields(execution.result, ['current', 'requirementRevision', 'controlRevision', 'leaseEpoch', 'inputVersion', 'receivedAt', 'recovery']), resultRef: deferModelContent(execution.result) } : {}) }))
}
export function operationDirectory(operations) {
  return directory(operations, 'operationId', operation => ({ ...fields(operation, ['operationId', 'executionId', 'state', 'requirementRevision', 'controlRevision', 'resourceKeys', 'evidenceRef', 'authorizationRef']),
    toolName: operation.definition?.toolName ?? operation.definition?.tool, effectClass: operation.definition?.effectClass,
    terminal: terminal.has(operation.state), evidence: deferModelContent(operation) }))
}
export function taskModelInput(input) {
  const task = input.task ?? {}, operations = input.operations ?? [], executions = input.executions ?? []
  const executionIndex = executionDirectory(executions), operationIndex = operationDirectory(operations.filter(operation => !terminal.has(operation.state)))
  const blockerExecutions = executionDirectory(input.blockers?.executions ?? []), blockerOperations = operationDirectory(input.blockers?.operations ?? [])
  return { ...input, task: { ...fields(task, ['taskId', 'sessionId', 'groupId', 'title', 'request', 'status', 'control', 'ownerActorId', 'requirementRevision', 'controlRevision', 'leaseEpoch', 'drained', 'runSequence', 'updatedAt']),
    ...(task.lastDecision ? { lastDecision: fields(task.lastDecision, ['action', 'summary', 'question', 'audience', 'at', 'recordedAt', 'requirementRevision', 'controlRevision', 'binding']), lastDecisionRef: deferModelContent(task.lastDecision) } : {}),
    authorizationSourceId: task.metadata?.authorizationSourceId, fullRecord: deferModelContent(task),
    humanRequests: (task.humanRequests ?? []).filter((request, index, requests) => request.status === 'waiting-reply' || index === requests.length - 1) },
    sourceCatalog: { total: (input.sources ?? []).length, catalogRef: deferModelContent(Object.fromEntries((input.sources ?? []).map(source => [source.sourceId, source]))) },
    sources: (input.sources ?? []).slice(0, 20).map(source => ({ ...source, requestIdentity: undefined,
      ...(source.requestIdentity ? { requestIdentityRef: deferModelContent(source.requestIdentity) } : {}) })),
    materialCatalogRef: deferModelContent(input.materials ?? []),
    materials: (input.materials ?? []).slice(0, 20).map(material => ({ ...material, text: undefined, quote: undefined,
      ...(material.text !== undefined ? { textRef: deferModelContent(material.text) } : {}),
      ...(material.quote !== undefined ? { quoteRef: deferModelContent(material.quote) } : {}) })),
    executions: executionIndex.items, executionIndex: { total: executionIndex.total, catalogRef: executionIndex.catalogRef },
    operations: operationIndex.items, operationIndex: { total: operationIndex.total, catalogRef: operationIndex.catalogRef },
    operationHistory: { total: operations.length, catalogRef: deferModelContent(Object.fromEntries(operations.map(operation => [operation.operationId, operation]))) },
    blockers: { ...input.blockers, executions: blockerExecutions.items, executionIndex: { total: blockerExecutions.total, catalogRef: blockerExecutions.catalogRef },
      operations: blockerOperations.items, operationIndex: { total: blockerOperations.total, catalogRef: blockerOperations.catalogRef } } }
}
export function executionModelInput(input, binding) {
  const all = input.sources ?? [], selected = new Set([input.task?.authorizationSourceId].filter(Boolean))
  const correction = all.findLast(source => source.actorId && source.actorId === input.task?.ownerActorId)
  if (correction?.sourceId) selected.add(correction.sourceId)
  const history = executionDirectory((input.previousExecutions ?? []).filter(execution => execution.executionId !== binding.executionId))
  return { ...input, sourceReviewRequired: true, sources: all.filter(source => selected.has(source.sourceId)).map(source => ({ ...source, requestIdentity: undefined,
    ...(source.requestIdentity ? { requestIdentityRef: deferModelContent(source.requestIdentity) } : {}) })), sourceCatalog: {
    total: all.length, items: all.slice(0, 20).map(source => fields(source, ['sourceId', 'actorId', 'version', 'messageId', 'corrects', 'supersedes'])),
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
