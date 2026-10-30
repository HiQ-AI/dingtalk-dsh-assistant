import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { finalNotificationFields, finalNotificationRouting } from './group-notification.js'
import { toToolJsonSchema } from './tool-schema.js'
import { sessionWorkspace } from './session-workspaces.js'
import { createTaskArtifactFiles } from './task-artifact-files.js'

export const platformReplySchema = z.strictObject({ text: z.string().trim().min(1).nullable(), ...finalNotificationFields,
  files: z.array(z.strictObject({ path: z.string().min(1), caption: z.string().trim().min(1).max(1000) })).max(20).optional(),
})
export const platformReplyParameters = toToolJsonSchema(platformReplySchema)

// A bounded identity/context view, not an automatic audience. Same-group real
// sender evidence supplies IDs; neither names nor model-generated text do.
export function platformNotificationContext(group, message) {
  return [...new Map([message, ...group.messages.filter(item => item.senderOpenDingTalkId && !['web', 'internal'].includes(item.sourceKind)).slice(-20)]
    .map(item => [item.messageId, item])).values()].map(item => ({ messageId: item.messageId, senderOpenDingTalkId: item.senderOpenDingTalkId,
    senderName: item.senderName, sourceKind: item.sourceKind, text: item.text?.slice(0, 400) }))
}

/** Platform-only source admission; all formatting, parts and transport are shared. */
export function createPlatformNotifier({ store, root, appendOutbox }) {
  const files = createTaskArtifactFiles({ root: join(root, 'delivery-files') })
  return async ({ groupId, outboundId, message, unit, decision, sessionId, preflight }) => {
    const previous = store.getGroup(groupId).outbox.find(item => item.outboundId === outboundId)
    let content
    if (previous) content = { text: previous.text, replyToMessageId: previous.replyToMessageId,
      replyToSenderOpenDingTalkId: previous.replyToSenderOpenDingTalkId, atOpenDingTalkIds: previous.atOpenDingTalkIds ?? [],
      ...(previous.atAll ? { atAll: true } : {}), ...(previous.sourceRef ? { sourceRef: previous.sourceRef } : {}), artifactFiles: previous.artifactFiles ?? [] }
    else {
      decision = platformReplySchema.parse(decision)
      if (decision.text === null) throw new Error('platform_reply_empty')
      // Bound the model's initial view, not the admissible identity set: a
      // legitimate participant read from older context must still be usable.
      const { recipients, atAll } = finalNotificationRouting(store.getGroup(groupId).messages, decision)
      const artifactFiles = [], directory = await sessionWorkspace(root, 'platform')
      const platformSource = { requestId: outboundId, sessionId, groupId, messageId: message.messageId, messageVersion: message.messageVersion,
        unitId: unit.unitId, unitRevision: unit.unitRevision }
      for (const item of decision.files ?? []) {
        const path = resolve(directory, item.path), relativePath = relative(directory, path)
        if (!relativePath || isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes('..')) throw new Error('PLATFORM_DELIVERY_ARTIFACT_OUTSIDE_SESSION')
        const input = { platformSource, role: 'final-delivery', fileName: basename(path), sourceRoot: directory, relativePath }
        const prepared = await files.prepareImport(input), artifact = await files.importFile({ ...input, expectedSha256: prepared.sha256 })
        if (!artifactFiles.some(file => file.artifact.artifactId === artifact.artifactId)) artifactFiles.push({ artifact, caption: item.caption })
      }
      if (artifactFiles.length) await files.validateManifest(artifactFiles.map(file => file.artifact), { platformSource })
      content = { text: decision.text,
        atOpenDingTalkIds: recipients, ...(atAll ? { atAll: true } : {}), artifactFiles,
        sourceRef: { messageId: message.messageId, actorId: message.senderOpenDingTalkId, messageVersion: message.messageVersion } }
    }
    return appendOutbox({ groupId, outboundId, sourceMessageId: outboundId, topicRefs: [], taskIds: [],
      fixedTopic: unit.fixedTopic, sourceVersion: message.messageVersion, preflight,
      matterSourceMessageIds: [message.messageId], matterUnitRefs: [{ unitId: unit.unitId, unitRevision: unit.unitRevision }],
      replyKind: 'substantive', ...content })
  }
}
