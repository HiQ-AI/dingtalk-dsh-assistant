import { createHash } from 'node:crypto'
import { extname, isAbsolute, resolve } from 'node:path'
import { executionDigest, executionError } from './execution-artifacts.js'

const sha256 = content => createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const identity = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value)
  && !/[.]$/u.test(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value)
const fileNameValid = value => typeof value === 'string' && value.length > 0 && value.length <= 180
  && !/[\x00-\x1f\x7f<>:"/\\|?*]/u.test(value) && !/[. ]$/u.test(value)
  && !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/iu.test(value)
  && ['.md', '.txt', '.sql', '.csv', '.json'].includes(extname(value).toLowerCase())
const inputValid = input => input && Object.keys(input).length === 3
  && typeof input.role === 'string' && !!input.role.trim() && input.role.length <= 180
  && !/[\x00-\x1f\x7f<>:"/\\|?*]/u.test(input.role)
  && !/[. ]$/u.test(input.role) && !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/iu.test(input.role)
  && fileNameValid(input.fileName) && input.fileName.toLowerCase() !== 'descriptor.json'
  && typeof input.content === 'string' && !!input.content.trim()
  && Buffer.byteLength(input.content, 'utf8') <= 65536
const admitted = (input, scope) => !!inputValid(input)
  && Number.isSafeInteger(scope?.requirementRevision) && scope.requirementRevision >= 1
  && Array.isArray(scope.artifactFiles)
  && scope.artifactFiles.some(item => item?.role === input.role && item.fileName === input.fileName)
const invalid = () => { throw executionError('TASK_ARTIFACT_WRITE_PREPARED_INVALID') }

/** 仅生成明确授权的文本产物；二进制由受信生成器另行登记。 */
export function createTaskArtifactWriteAdapter({ files }) {
  if (typeof files?.register !== 'function' || typeof files?.inspect !== 'function')
    throw executionError('TASK_ARTIFACT_WRITE_FILES_REQUIRED')
  function operation(body) {
    return executionDigest({ taskId: body.taskId, runId: body.runId, nodeRunId: body.nodeRunId,
      generation: body.generation, requirementDigest: body.requirementDigest,
      requirementRevision: body.requirementRevision, role: body.role, fileName: body.fileName,
      contentDigest: body.contentDigest })
  }
  function validate(prepared) {
    const { digest, ...body } = prepared ?? {}
    if (Object.keys(body).length !== 14 || body.version !== 1 || body.action !== 'artifact'
      || !identity(body.taskId) || !identity(body.runId) || !identity(body.nodeRunId)
      || !Number.isSafeInteger(body.generation) || body.generation < 0
      || !hex(body.requirementDigest) || !Number.isSafeInteger(body.requirementRevision) || body.requirementRevision < 1
      || !inputValid({ role: body.role, fileName: body.fileName, content: body.content })
      || body.contentDigest !== sha256(body.content) || body.operationId !== operation(body)
      || body.resourceKey !== `file:${body.taskId}:${body.operationId}` || digest !== executionDigest(body)) invalid()
  }
  function registration(prepared) {
    return { taskId: prepared.taskId, requirementRevision: prepared.requirementRevision,
      producer: { runId: prepared.runId, nodeRunId: prepared.nodeRunId, outputRef: `operation:${prepared.operationId}` },
      role: prepared.role, fileName: prepared.fileName, bytes: Buffer.from(prepared.content, 'utf8') }
  }
  function observation(artifact) {
    return { status: 'succeeded', result: { artifact }, evidenceRef: `task-artifact:${artifact.taskId}:${artifact.artifactId}:${artifact.sha256}` }
  }
  function prepare({ input, scope, binding }) {
    if (!admitted(input, scope)) throw executionError('TASK_ARTIFACT_WRITE_SCOPE_DENIED')
    const body = { version: 1, action: 'artifact', taskId: binding?.taskId, runId: binding?.runId,
      nodeRunId: binding?.nodeRunId, generation: binding?.generation, requirementDigest: binding?.requirementDigest,
      requirementRevision: scope.requirementRevision, role: input.role, fileName: input.fileName,
      content: input.content, contentDigest: sha256(input.content) }
    body.operationId = operation(body)
    body.resourceKey = `file:${body.taskId}:${body.operationId}`
    const prepared = { ...body, digest: executionDigest(body) }
    validate(prepared)
    return prepared
  }
  async function reconcile(prepared) {
    validate(prepared)
    const artifact = await files.inspect(registration(prepared))
    return artifact ? observation(artifact) : { status: 'failed', reason: 'TASK_ARTIFACT_WRITE_NOT_FOUND' }
  }
  async function execute(prepared) {
    validate(prepared)
    return observation(await files.register(registration(prepared)))
  }
  return { prepare, execute, reconcile }
}

export function createGeneralArtifactWriteCapability({ fileAdapter }) {
  if (typeof fileAdapter?.prepare !== 'function' || typeof fileAdapter?.reconcile !== 'function')
    throw executionError('GENERAL_ARTIFACT_ADAPTER_REQUIRED')
  return {
    id: 'write-task-file', effectClass: 'file.write', action: 'artifact', identity: 'write-task-file-v1',
    description: '生成当前需求精确授权的 Markdown、文本、SQL、CSV、JSON 文件，UTF-8 最多 64 KiB，并独立核验原字节',
    authorize: async ({ input, scope }) => admitted(input, scope),
    prepare: ({ input, scope, binding }) => fileAdapter.prepare({ input, scope, binding }),
    async verify({ input, scope, prepared, output }) {
      if (!admitted(input, scope) || prepared?.role !== input.role || prepared?.fileName !== input.fileName
        || prepared?.content !== input.content || prepared?.requirementRevision !== scope.requirementRevision)
        return { passed: false }
      const observation = await fileAdapter.reconcile(prepared)
      return { passed: observation.status === 'succeeded' && executionDigest(observation) === executionDigest(output),
        inputDigest: executionDigest({ capabilityId: 'write-task-file', input, scope }),
        outputDigest: executionDigest(observation), sourceRefs: observation.status === 'succeeded' ? [observation.evidenceRef] : [] }
    },
  }
}

const importInputValid = input => input && Object.keys(input).length === 3
  && inputValid({ role: input.role, fileName: 'scope-check.txt', content: 'scope-check' })
  && typeof input.fileName === 'string' && input.fileName.length > 0 && input.fileName.length <= 180
  && !/[\x00-\x1f\x7f<>:"/\\|?*]/u.test(input.fileName) && !/[. ]$/u.test(input.fileName)
  && !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/iu.test(input.fileName)
  && !['.', '..', 'descriptor.json'].includes(input.fileName.toLowerCase())
  && typeof input.relativePath === 'string' && !!input.relativePath && !isAbsolute(input.relativePath)
  && !input.relativePath.includes(':') && !input.relativePath.split(/[\\/]/u).some(part => !part || part === '.' || part === '..')
  && extname(input.fileName).toLowerCase() === extname(input.relativePath).toLowerCase()
const importScopeAdmitted = (input, scope) => !!importInputValid(input)
  && Number.isSafeInteger(scope?.requirementRevision) && scope.requirementRevision >= 1
  && Array.isArray(scope.artifactFiles) && scope.artifactFiles.some(item => item?.role === input.role && item.fileName === input.fileName)
  && Array.isArray(scope.readableFiles) && scope.readableFiles.includes(input.relativePath)

/** 源根与路径白名单由 Host 提供；预备只读取，效果执行时才登记二进制原字节。 */
export function createTaskArtifactImportAdapter({ files, sourceRoot, readablePaths }) {
  if (typeof files?.prepareImport !== 'function' || typeof files?.describeIdentity !== 'function'
    || typeof files?.importFile !== 'function' || typeof files?.resolve !== 'function'
    || typeof sourceRoot !== 'string' || !isAbsolute(sourceRoot) || !Array.isArray(readablePaths)
    || !readablePaths.length || readablePaths.some(path => typeof path !== 'string'
      || !importInputValid({ role: 'source', fileName: `source${extname(path)}`, relativePath: path })))
    throw executionError('TASK_ARTIFACT_IMPORT_CONFIG_INVALID')
  const root = resolve(sourceRoot), permitted = new Set(readablePaths)
  const source = prepared => ({ taskId: prepared.taskId, requirementRevision: prepared.requirementRevision,
    producer: { runId: prepared.runId, nodeRunId: prepared.nodeRunId, outputRef: `operation:${prepared.operationId}` },
    role: prepared.role, fileName: prepared.fileName, sourceRoot: root, relativePath: prepared.relativePath })
  const operation = body => executionDigest({ taskId: body.taskId, runId: body.runId, nodeRunId: body.nodeRunId,
    generation: body.generation, requirementDigest: body.requirementDigest, requirementRevision: body.requirementRevision,
    role: body.role, fileName: body.fileName, sourceRoot: body.sourceRoot, relativePath: body.relativePath,
    contentDigest: body.contentDigest, size: body.artifact.size })
  function validate(prepared) {
    const { digest, ...body } = prepared ?? {}
    if (Object.keys(body).length !== 17 || body.version !== 1 || body.action !== 'artifact' || body.kind !== 'import'
      || !identity(body.taskId) || !identity(body.runId) || !identity(body.nodeRunId)
      || !Number.isSafeInteger(body.generation) || body.generation < 0 || !hex(body.requirementDigest)
      || !Number.isSafeInteger(body.requirementRevision) || body.requirementRevision < 1
      || !importInputValid({ role: body.role, fileName: body.fileName, relativePath: body.relativePath })
      || body.sourceRoot !== root || !permitted.has(body.relativePath) || !body.artifact
      || body.contentDigest !== body.artifact.sha256 || !hex(body.contentDigest)
      || body.operationId !== operation(body) || body.resourceKey !== `file:${body.taskId}:${body.operationId}`
      || digest !== executionDigest(body)) throw executionError('TASK_ARTIFACT_IMPORT_PREPARED_INVALID')
    const expected = files.describeIdentity({ ...source(body), size: body.artifact.size, sha256: body.contentDigest })
    if (executionDigest(expected) !== executionDigest(body.artifact)) throw executionError('TASK_ARTIFACT_IMPORT_PREPARED_INVALID')
  }
  const observation = artifact => ({ status: 'succeeded', result: { artifact },
    evidenceRef: `task-artifact:${artifact.taskId}:${artifact.artifactId}:${artifact.sha256}` })
  async function prepare({ input, scope, binding }) {
    if (!importScopeAdmitted(input, scope) || !permitted.has(input.relativePath)) throw executionError('TASK_ARTIFACT_IMPORT_SCOPE_DENIED')
    const inspected = await files.prepareImport({ ...input, sourceRoot: root, taskId: binding?.taskId,
      requirementRevision: scope.requirementRevision,
      producer: { runId: binding?.runId, nodeRunId: binding?.nodeRunId, outputRef: 'source-inspection' } })
    const body = { version: 1, action: 'artifact', kind: 'import', taskId: binding.taskId, runId: binding.runId,
      nodeRunId: binding.nodeRunId, generation: binding.generation, requirementDigest: binding.requirementDigest,
      requirementRevision: scope.requirementRevision, role: input.role, fileName: input.fileName,
      sourceRoot: root, relativePath: input.relativePath, contentDigest: inspected.sha256, artifact: inspected }
    body.operationId = operation(body)
    body.resourceKey = `file:${body.taskId}:${body.operationId}`
    body.artifact = files.describeIdentity({ ...source(body), size: inspected.size, sha256: inspected.sha256 })
    const prepared = { ...body, digest: executionDigest(body) }
    validate(prepared)
    return prepared
  }
  async function reconcile(prepared) {
    validate(prepared)
    try { await files.resolve(prepared.artifact); return observation(prepared.artifact) }
    catch (error) { if (error.code === 'ENOENT') return { status: 'failed', reason: 'TASK_ARTIFACT_IMPORT_NOT_FOUND' }; throw error }
  }
  async function execute(prepared) {
    validate(prepared)
    const prior = await reconcile(prepared)
    if (prior.status === 'succeeded') return prior
    const artifact = await files.importFile({ ...source(prepared), expectedSha256: prepared.contentDigest })
    if (executionDigest(artifact) !== executionDigest(prepared.artifact)) throw executionError('TASK_ARTIFACT_IMPORT_IDENTITY_MISMATCH')
    return observation(artifact)
  }
  return { prepare, execute, reconcile,
    identity: `import-task-file-v1:${executionDigest({ sourceRoot: root, readablePaths: [...permitted].sort() })}`,
    authorize: async ({ input, scope }) => importScopeAdmitted(input, scope) && permitted.has(input.relativePath) }
}

export function createGeneralArtifactImportCapability({ fileAdapter }) {
  if (typeof fileAdapter?.prepare !== 'function' || typeof fileAdapter?.reconcile !== 'function' || typeof fileAdapter?.authorize !== 'function')
    throw executionError('GENERAL_ARTIFACT_IMPORT_ADAPTER_REQUIRED')
  return {
    id: 'import-task-file', effectClass: 'file.write', action: 'artifact', identity: fileAdapter.identity,
    description: '登记当前任务明确授权、Host白名单中已有文件的真实原字节；可传输图片、Office、PDF，不能代替文件生成器',
    authorize: async ({ input, scope }) => importScopeAdmitted(input, scope) && await fileAdapter.authorize({ input, scope }) === true,
    prepare: ({ input, scope, binding }) => fileAdapter.prepare({ input, scope, binding }),
    async verify({ input, scope, prepared, output }) {
      if (!importScopeAdmitted(input, scope) || prepared?.role !== input.role || prepared?.fileName !== input.fileName
        || prepared?.relativePath !== input.relativePath || prepared?.requirementRevision !== scope.requirementRevision)
        return { passed: false }
      const observation = await fileAdapter.reconcile(prepared)
      return { passed: observation.status === 'succeeded' && executionDigest(observation) === executionDigest(output),
        inputDigest: executionDigest({ capabilityId: 'import-task-file', input, scope }),
        outputDigest: executionDigest(observation), sourceRefs: observation.status === 'succeeded' ? [observation.evidenceRef] : [] }
    },
  }
}
