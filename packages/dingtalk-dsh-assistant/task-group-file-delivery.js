import { executionDigest, executionError } from './execution-artifacts.js'

const fail = code => { throw executionError(`TASK_GROUP_FILE_${code}`) }
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value)
const nonempty = value => typeof value === 'string' && !!value.trim()
const keyFor = body => executionDigest({ taskId: body.taskId, requirementRevision: body.requirementRevision,
  requirementDigest: body.requirementDigest, profile: body.profile, groupId: body.groupId,
  artifactId: body.artifact.artifactId, sha256: body.artifact.sha256 })

/** 唯一文件外发适配器；DWS cwd 来自已核验的受管产物目录。 */
export function createTaskGroupFileAdapter({ files, createAdapter, profile, canDisclose }) {
  if (typeof files?.resolve !== 'function' || typeof createAdapter !== 'function'
    || !nonempty(profile) || typeof canDisclose !== 'function') fail('CONFIG_INVALID')
  function validate(prepared) {
    const { digest, ...body } = prepared ?? {}
    if (body.action !== 'message' || body.version !== 1 || !id(body.taskId) || !id(body.runId) || !id(body.nodeRunId)
      || !Number.isSafeInteger(body.generation) || body.generation < 0 || !hex(body.requirementDigest)
      || !Number.isSafeInteger(body.requirementRevision) || body.requirementRevision < 1
      || body.profile !== profile || !nonempty(body.groupId) || !body.artifact || body.artifact.taskId !== body.taskId
      || body.artifact.requirementRevision !== body.requirementRevision || !hex(body.artifact.artifactId) || !hex(body.artifact.sha256)
      || !Number.isSafeInteger(body.artifact.size) || body.artifact.size < 1 || body.deliveryKey !== keyFor(body)
      || body.resourceKey !== `message:${body.deliveryKey}` || digest !== executionDigest(body)) fail('PREPARED_INVALID')
  }
  async function prepare({ input, binding }) {
    if (!input || input.profile !== undefined && input.profile !== profile) fail('PROFILE_DENIED')
    const body = { version: 1, action: 'message', taskId: binding.taskId, runId: binding.runId,
      nodeRunId: binding.nodeRunId, generation: binding.generation, requirementDigest: binding.requirementDigest,
      requirementRevision: input.requirementRevision, groupId: input.groupId, profile, artifact: structuredClone(input.file) }
    body.deliveryKey = keyFor(body); body.resourceKey = `message:${body.deliveryKey}`
    const prepared = { ...body, digest: executionDigest(body) }
    validate(prepared)
    await files.resolve(prepared.artifact)
    if (await canDisclose({ prepared: structuredClone(prepared) }) !== true) fail('DISCLOSURE_DENIED')
    return prepared
  }
  async function admitted(prepared) {
    validate(prepared)
    if (await canDisclose({ prepared: structuredClone(prepared) }) !== true) fail('DISCLOSURE_DENIED')
    const file = await files.resolve(prepared.artifact)
    return createAdapter({ directory: file.directory, profile })
  }
  async function execute(prepared) {
    const adapter = await admitted(prepared)
    const ack = await adapter.sendGroupFile({ groupId: prepared.groupId, fileName: prepared.artifact.fileName,
      idempotencyKey: prepared.deliveryKey })
    return { status: 'unknown', reason: 'MESSAGE_READBACK_REQUIRED', result: { ack } }
  }
  async function reconcile(prepared, { previousObservation } = {}) {
    validate(prepared)
    const ack = previousObservation?.result?.ack
    const openTaskId = ack?.sendReceipt?.openTaskId ?? ack?.result?.result?.openTaskId
    if (!nonempty(openTaskId)) return { status: 'unknown', reason: 'MESSAGE_ACK_UNAVAILABLE' }
    let sendMessageRef
    const pending = reason => ({ status: 'unknown', reason, result: { ack, ...(sendMessageRef ? { sendMessageRef } : {}) } })
    try {
      const adapter = await admitted(prepared)
      const status = await adapter.querySendStatus(openTaskId)
      const groupId = status.messageRef?.openConversationId ?? status.result?.openConversationId
      const messageId = status.messageRef?.openMessageId ?? status.result?.openMessageId
      if (status.result?.sendStatus !== 'SUCCESS' || !nonempty(groupId) || !nonempty(messageId)) return pending('MESSAGE_DELIVERY_UNCONFIRMED')
      if (groupId !== prepared.groupId) return pending('MESSAGE_TARGET_MISMATCH')
      sendMessageRef = { conversationId: groupId, messageId, openTaskId }
      const verified = await adapter.readMessageFile({ groupId, messageId,
        expected: { size: prepared.artifact.size, sha256: prepared.artifact.sha256 } })
      if (verified.size !== prepared.artifact.size || verified.sha256 !== prepared.artifact.sha256
        || verified.message?.conversationId !== groupId || verified.message?.messageId !== messageId
        || !['fileId', 'mediaId'].includes(verified.resourceRef?.type) || !nonempty(verified.resourceRef?.resourceId)) return pending('MESSAGE_FILE_UNVERIFIED')
      const result = { deliveryKey: prepared.deliveryKey, taskId: prepared.taskId,
        requirementRevision: prepared.requirementRevision, artifactId: prepared.artifact.artifactId,
        fileName: prepared.artifact.fileName, role: prepared.artifact.role, sha256: verified.sha256, size: verified.size,
        groupId, conversationId: groupId, profile, messageId, openTaskId,
        resourceRef: { type: verified.resourceRef.type, resourceId: verified.resourceRef.resourceId } }
      return { status: 'succeeded', result, evidenceRef: `message:${prepared.deliveryKey}:${messageId}:${verified.sha256}` }
    } catch (error) { return pending(error.code ?? 'MESSAGE_READBACK_FAILED') }
  }
  return { prepare, execute, reconcile }
}

const objectSchema = { type: 'object' }
function assertReceipts(input) {
  if (!Array.isArray(input.files) || !input.files.length || !Array.isArray(input.receipts)
    || input.receipts.length !== input.files.length) fail('RECEIPTS_INCOMPLETE')
  for (const [index, file] of input.files.entries()) {
    const receipt = input.receipts[index]
    if (receipt?.status !== 'succeeded' || !nonempty(receipt.evidenceRef)
      || receipt.result?.artifactId !== file.artifactId || receipt.result?.sha256 !== file.sha256
      || receipt.result?.size !== file.size || receipt.result?.taskId !== file.taskId
      || receipt.result?.role !== file.role || receipt.result?.fileName !== file.fileName
      || receipt.result?.profile !== input.profile || !hex(receipt.result?.deliveryKey)
      || receipt.result?.requirementRevision !== input.requirementRevision
      || receipt.result?.groupId !== input.groupId || receipt.result?.conversationId !== input.groupId
      || !nonempty(receipt.result?.messageId)) fail('RECEIPT_MISMATCH')
  }
}

/** 固定三个 code 节点；每件独立效果，未知项中断后续发送。 */
export function createTaskGroupFileDeliveryWorkflow({ files, messageAdapter }) {
  if (typeof files?.validateManifest !== 'function' || typeof messageAdapter?.prepare !== 'function') fail('WORKFLOW_CONFIG_INVALID')
  const rulesDigest = executionDigest({ contract: 'task-group-file-delivery-v1' })
  return { id: 'task-group-file-delivery', version: '1', nodes: [
    { id: 'prepare-delivery', version: '1', executor: 'code', allowedEffects: ['read'],
      inputSchema: objectSchema, outputSchema: objectSchema, rulesDigest,
      mapInput: ({ requirement }) => requirement,
      async execute({ input, taskId, signal }) {
        signal?.throwIfAborted()
        if (!nonempty(input.groupId) || !nonempty(input.profile)) fail('TARGET_INVALID')
        const verified = await files.validateManifest(input.files, { taskId, requirementRevision: input.requirementRevision })
        return { files: verified, groupId: input.groupId, profile: input.profile, requirementRevision: input.requirementRevision }
      } },
    { id: 'send-files', version: '1', executor: 'code', allowedEffects: ['message.send'],
      inputSchema: objectSchema, outputSchema: objectSchema, rulesDigest,
      mapInput: ({ previousOutput }) => previousOutput,
      async execute({ input, taskId, runId, nodeRunId, generation, requirementDigest, perform, signal }) {
        const receipts = []
        for (const file of input.files) {
          signal?.throwIfAborted()
          const prepared = await messageAdapter.prepare({ input: { file, groupId: input.groupId, profile: input.profile,
            requirementRevision: input.requirementRevision }, binding: { taskId, runId, nodeRunId, generation, requirementDigest } })
          const receipt = await perform({ action: 'message', prepared })
          if (receipt?.status !== 'succeeded') fail('DELIVERY_UNCONFIRMED')
          receipts.push(receipt)
        }
        return { ...input, receipts }
      } },
    { id: 'verify-delivery', version: '1', executor: 'code', allowedEffects: ['read'],
      inputSchema: objectSchema, outputSchema: objectSchema, rulesDigest,
      mapInput: ({ previousOutput }) => previousOutput,
      async execute({ input, taskId }) {
        await files.validateManifest(input.files, { taskId, requirementRevision: input.requirementRevision })
        assertReceipts(input)
        return { deliveryStatus: 'files_verified', groupId: input.groupId, profile: input.profile,
          requirementRevision: input.requirementRevision, files: input.files, receipts: input.receipts,
          evidenceRefs: input.receipts.map(item => item.evidenceRef) }
      } },
  ], ownerContract: { id: 'task-group-file-delivery-result', version: '1', rulesDigest,
    validateCompletion: async ({ output }) => {
      try { assertReceipts(output); return output.deliveryStatus === 'files_verified' } catch { return false }
    } } }
}
