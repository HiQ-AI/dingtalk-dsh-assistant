import { createHash } from 'node:crypto'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { z } from 'zod'

const owner = 'dingtalk-dsh-assistant'
const digest = value => createHash('sha256').update(value).digest('hex')
const instanceIdentity = z.string().refine(value => !!value.trim())
const maxValueBytes = 64 * 1024, maxDocumentBytes = 4 * 1024 * 1024, maxVariables = 100
const forbiddenNames = new Set(['__proto__', 'prototype', 'constructor'])
// 内部执行定义必须能冻结空快照，但不作为用户可配置的工作流绑定入口。
const internalWorkflowIds = new Set(['task-general-capability'])
const variableName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u).refine(value => !forbiddenNames.has(value))
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1)
const workflowId = z.string().regex(/^[a-z][a-z0-9-]{0,159}$/u)
const kind = z.enum(['plain', 'secret']), format = z.enum(['text', 'json'])
const valueSchema = z.string().refine(value => Buffer.byteLength(value, 'utf8') <= maxValueBytes)
const bindingSchema = z.strictObject({ alias: variableName, name: variableName })
export const workflowVariableInputSchema = z.strictObject({ name: variableName, kind, format, description: z.string().max(500), value: valueSchema, expectedRevision: revision })
export const workflowVariableEnabledSchema = z.strictObject({ name: variableName, enabled: z.boolean(), expectedRevision: revision })
export const workflowBindingInputSchema = z.strictObject({ workflowId, variables: z.array(bindingSchema).max(maxVariables), expectedRevision: revision })
const variableSchema = z.strictObject({ name: variableName, kind, format, description: z.string().max(500), revision: revision.refine(value => value > 0), enabled: z.boolean(),
  versions: z.array(z.strictObject({ revision: revision.refine(value => value > 0), value: valueSchema })).min(1) })
const documentSchema = z.strictObject({ schemaVersion: z.literal(1), instanceId: instanceIdentity, revision, variables: z.array(variableSchema).max(maxVariables),
  bindings: z.array(z.strictObject({ workflowId, variables: z.array(bindingSchema).max(maxVariables) })) })
const runSchema = z.strictObject({ runId: z.string().min(1).max(300).refine(value => !/[\0\r\n]/u.test(value)), workflowId })
const referenceSchema = bindingSchema.extend({ kind, format, revision: revision.refine(value => value > 0) })
const snapshotSchema = runSchema.extend({ schemaVersion: z.literal(1), instanceId: instanceIdentity, catalogWorkflowId: workflowId, revision, variables: z.array(referenceSchema).max(maxVariables) })
const codes = new Set(['WORKFLOW_CONFIG_ARGUMENT_INVALID', 'WORKFLOW_CONFIG_FORBIDDEN', 'WORKFLOW_CONFIG_UNAVAILABLE', 'WORKFLOW_CONFIG_READONLY',
  'WORKFLOW_CONFIG_STORAGE_FAILED', 'WORKFLOW_CONFIG_STORED_INVALID', 'WORKFLOW_CONFIG_REVISION_CONFLICT', 'WORKFLOW_CONFIG_KIND_IMMUTABLE',
  'WORKFLOW_CONFIG_FORMAT_IMMUTABLE', 'WORKFLOW_CONFIG_JSON_INVALID', 'WORKFLOW_CONFIG_SECRET_REQUIRED', 'WORKFLOW_CONFIG_LIMIT_EXCEEDED',
  'WORKFLOW_CONFIG_VARIABLE_UNKNOWN', 'WORKFLOW_CONFIG_VARIABLE_DISABLED', 'WORKFLOW_CONFIG_WORKFLOW_UNKNOWN', 'WORKFLOW_CONFIG_ALIAS_DUPLICATE',
  'WORKFLOW_CONFIG_SNAPSHOT_REQUIRED', 'WORKFLOW_CONFIG_RUN_MISMATCH', 'WORKFLOW_CONFIG_BINDING_REQUIRED', 'WORKFLOW_CONFIG_KIND_MISMATCH'])
const fail = code => { throw Object.assign(new Error(code), { code }) }
export const workflowConfigurationErrorCode = error => codes.has(error?.code) ? error.code : 'WORKFLOW_CONFIG_STORAGE_FAILED'
const parse = (schema, input, code = 'WORKFLOW_CONFIG_ARGUMENT_INVALID') => {
  const result = schema.safeParse(input)
  if (!result.success) fail(code)
  return result.data
}
const emptyDocument = instanceId => ({ schemaVersion: 1, instanceId, revision: 0, variables: [], bindings: [] })
const unique = items => new Set(items).size === items.length
const validateValue = ({ kind, format, value }) => {
  if (kind === 'secret' && !value.trim()) fail('WORKFLOW_CONFIG_SECRET_REQUIRED')
  if (format !== 'json') return value
  try {
    const parsed = JSON.parse(value)
    JSON.stringify(parsed, (_, item) => { if (typeof item === 'number' && !Number.isFinite(item)) throw Error(); return item })
    return parsed
  } catch { fail('WORKFLOW_CONFIG_JSON_INVALID') }
}
function readDocument(record, instanceId) {
  if (record === undefined) return emptyDocument(instanceId)
  if (record.kind !== 'grant') fail('WORKFLOW_CONFIG_STORED_INVALID')
  const document = parse(documentSchema, record.payload, 'WORKFLOW_CONFIG_STORED_INVALID')
  if (document.instanceId !== instanceId || Buffer.byteLength(JSON.stringify(document)) > maxDocumentBytes || !unique(document.variables.map(item => item.name))
    || !unique(document.bindings.map(item => item.workflowId))) fail('WORKFLOW_CONFIG_STORED_INVALID')
  for (const variable of document.variables) {
    if (variable.versions.some((item, index) => item.revision !== index + 1) || variable.revision !== variable.versions.length) fail('WORKFLOW_CONFIG_STORED_INVALID')
    for (const version of variable.versions) validateValue({ ...variable, value: version.value })
  }
  for (const binding of document.bindings) {
    if (!unique(binding.variables.map(item => item.alias)) || binding.variables.some(item => !document.variables.some(variable => variable.name === item.name))) fail('WORKFLOW_CONFIG_STORED_INVALID')
  }
  return document
}
const publicState = (document, writable) => ({ revision: document.revision, writable, variables: document.variables.map(({ versions, ...variable }) => ({
  ...variable, ...(variable.kind === 'plain' ? { value: versions.at(-1).value } : {}),
})), bindings: structuredClone(document.bindings) })

/** 值仅保存在宿主原生凭据记录。默认 provider 是明文持久存储，Web 只返回脱敏投影。 */
export function createWorkflowConfiguration({ credentials, instanceId, workflowIds, webActorId }) {
  parse(instanceIdentity, instanceId)
  // 原生凭据文件可被多个profile共享；控制库的受信instanceId是持久命名空间。
  const namespace = digest(instanceId)
  const documentKey = credentialKey(owner, `workflow-configuration-${namespace}`)
  if (!Array.isArray(workflowIds)) fail('WORKFLOW_CONFIG_ARGUMENT_INVALID')
  const registered = new Set(workflowIds)
  if (!workflowIds.length || registered.size !== workflowIds.length || workflowIds.some(id => !workflowId.safeParse(id).success)) fail('WORKFLOW_CONFIG_ARGUMENT_INVALID')
  const available = () => {
    if (!credentials || ['readRecord', 'describeRecord', 'modifyRecord'].some(method => typeof credentials[method] !== 'function')) fail('WORKFLOW_CONFIG_UNAVAILABLE')
  }
  const authorize = identity => {
    if (!webActorId || identity?.channel !== 'web' || identity.actorId !== webActorId) fail('WORKFLOW_CONFIG_FORBIDDEN')
    available()
  }
  const canonical = id => {
    const normalized = /^task-engineering-(?:(?:revision|checkpoint|reissue)-)?[a-f0-9]{32,40}$/u.test(id) ? 'task-engineering' : id
    if (!registered.has(normalized)) fail('WORKFLOW_CONFIG_WORKFLOW_UNKNOWN')
    return normalized
  }
  const guarded = async action => {
    try { return await action() } catch (error) { fail(workflowConfigurationErrorCode(error)) }
  }
  const read = () => guarded(async () => { available(); return readDocument(await credentials.readRecord(documentKey), instanceId) })
  const mutate = (expectedRevision, identity, transform) => guarded(async () => {
    authorize(identity)
    if (!(await credentials.describeRecord(documentKey)).writable) fail('WORKFLOW_CONFIG_READONLY')
    const saved = await credentials.modifyRecord(documentKey, async record => {
      const document = readDocument(record, instanceId)
      if (document.revision !== expectedRevision) fail('WORKFLOW_CONFIG_REVISION_CONFLICT')
      if (document.revision >= Number.MAX_SAFE_INTEGER - 1) fail('WORKFLOW_CONFIG_LIMIT_EXCEEDED')
      transform(document)
      document.revision += 1
      if (document.variables.length > maxVariables || Buffer.byteLength(JSON.stringify(document)) > maxDocumentBytes) fail('WORKFLOW_CONFIG_LIMIT_EXCEEDED')
      return { kind: 'grant', payload: document }
    })
    return publicState(readDocument(saved, instanceId), true)
  })
  const snapshotKey = runId => credentialKey(owner, `workflow-run-${namespace}-${digest(runId)}`)
  const checkedSnapshot = (record, input) => {
    if (record?.kind !== 'grant') fail('WORKFLOW_CONFIG_STORED_INVALID')
    const snapshot = parse(snapshotSchema, record.payload, 'WORKFLOW_CONFIG_STORED_INVALID')
    if (snapshot.instanceId !== instanceId || snapshot.runId !== input.runId || snapshot.catalogWorkflowId !== canonical(input.workflowId)
      || canonical(snapshot.workflowId) !== snapshot.catalogWorkflowId) fail('WORKFLOW_CONFIG_RUN_MISMATCH')
    if (!unique(snapshot.variables.map(item => item.alias))) fail('WORKFLOW_CONFIG_STORED_INVALID')
    return snapshot
  }
  return {
    state: identity => guarded(async () => {
      authorize(identity)
      return publicState(await read(), (await credentials.describeRecord(documentKey)).writable === true)
    }),
    saveVariable: (input, identity) => guarded(async () => {
      authorize(identity)
      const value = parse(workflowVariableInputSchema, input)
      validateValue(value)
      return mutate(value.expectedRevision, identity, document => {
        const existing = document.variables.find(item => item.name === value.name)
        if (existing?.kind && existing.kind !== value.kind) fail('WORKFLOW_CONFIG_KIND_IMMUTABLE')
        if (existing?.format && existing.format !== value.format) fail('WORKFLOW_CONFIG_FORMAT_IMMUTABLE')
        if (existing) {
          existing.description = value.description
          existing.revision += 1
          existing.versions.push({ revision: existing.revision, value: value.value })
        } else document.variables.push({ name: value.name, kind: value.kind, format: value.format, description: value.description,
          revision: 1, enabled: true, versions: [{ revision: 1, value: value.value }] })
      })
    }),
    setVariableEnabled: (input, identity) => guarded(async () => {
      authorize(identity)
      const value = parse(workflowVariableEnabledSchema, input)
      return mutate(value.expectedRevision, identity, document => {
        const variable = document.variables.find(item => item.name === value.name)
        if (!variable) fail('WORKFLOW_CONFIG_VARIABLE_UNKNOWN')
        variable.enabled = value.enabled
      })
    }),
    bindWorkflow: (input, identity) => guarded(async () => {
      authorize(identity)
      const value = parse(workflowBindingInputSchema, input)
      if (!registered.has(value.workflowId) || internalWorkflowIds.has(value.workflowId)) fail('WORKFLOW_CONFIG_WORKFLOW_UNKNOWN')
      if (!unique(value.variables.map(item => item.alias))) fail('WORKFLOW_CONFIG_ALIAS_DUPLICATE')
      return mutate(value.expectedRevision, identity, document => {
        for (const item of value.variables) {
          const variable = document.variables.find(candidate => candidate.name === item.name)
          if (!variable) fail('WORKFLOW_CONFIG_VARIABLE_UNKNOWN')
          if (!variable.enabled) fail('WORKFLOW_CONFIG_VARIABLE_DISABLED')
        }
        document.bindings = document.bindings.filter(item => item.workflowId !== value.workflowId)
        document.bindings.push({ workflowId: value.workflowId, variables: value.variables })
      })
    }),
    snapshot: input => guarded(async () => {
      available()
      const value = parse(runSchema, input), catalogWorkflowId = canonical(value.workflowId)
      const record = await credentials.modifyRecord(snapshotKey(value.runId), async current => {
        if (current !== undefined) { checkedSnapshot(current, value); return undefined }
        // modifyRecord 已持有原生文档锁；此处只读配置，不能嵌套 modifyRecord。
        const document = await read()
        const variables = (document.bindings.find(item => item.workflowId === catalogWorkflowId)?.variables ?? []).map(item => {
          const variable = document.variables.find(candidate => candidate.name === item.name)
          if (!variable) fail('WORKFLOW_CONFIG_VARIABLE_UNKNOWN')
          if (!variable.enabled) fail('WORKFLOW_CONFIG_VARIABLE_DISABLED')
          return { ...item, kind: variable.kind, format: variable.format, revision: variable.revision }
        })
        return { kind: 'grant', payload: { schemaVersion: 1, instanceId, ...value, catalogWorkflowId, revision: document.revision, variables } }
      })
      const { schemaVersion: _schemaVersion, ...metadata } = checkedSnapshot(record, value)
      return metadata
    }),
    forRun: input => {
      const readBound = (alias, expectedKind) => guarded(async () => {
        available()
        const value = parse(runSchema, input)
        parse(variableName, alias)
        const record = await credentials.readRecord(snapshotKey(value.runId))
        if (record === undefined) fail('WORKFLOW_CONFIG_SNAPSHOT_REQUIRED')
        const snapshot = checkedSnapshot(record, value), reference = snapshot.variables.find(item => item.alias === alias)
        if (!reference) fail('WORKFLOW_CONFIG_BINDING_REQUIRED')
        if (reference.kind !== expectedKind) fail('WORKFLOW_CONFIG_KIND_MISMATCH')
        const document = await read(), variable = document.variables.find(item => item.name === reference.name)
        const version = variable?.versions.find(item => item.revision === reference.revision)
        if (!version || variable.kind !== reference.kind || variable.format !== reference.format) fail('WORKFLOW_CONFIG_STORED_INVALID')
        return validateValue({ ...reference, value: version.value })
      })
      return Object.freeze({ read: alias => readBound(alias, 'plain'), readSecret: alias => readBound(alias, 'secret') })
    },
  }
}
