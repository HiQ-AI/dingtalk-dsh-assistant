import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { stableId } from './topic-model.js'
import { hostCheckEvidenceSchema, taskArtifactSchema } from './task-plan.js'
import { toToolJsonSchema } from './tool-schema.js'

const MAX_BYTES = 16 * 1024 * 1024
export const taskCheckSchema = z.object({ checkerId: z.literal('artifact-sha256'), checkerVersion: z.literal('1'), artifactId: z.string().min(1), expectedDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export const taskCheckJsonSchema = toToolJsonSchema(taskCheckSchema)
const inside = (root, target) => { const relative = path.relative(root, target); return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative) }
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs

// 仅注册的只读检查器；路径、验收项和 receipt 身份由 Host 绑定，模型无命令执行入口。
export async function runTaskCheck(value, { receiptId, criterionIds, workspaceRoot, artifacts, observedAt = new Date().toISOString(), maxBytes = MAX_BYTES }) {
  const request = taskCheckSchema.parse(value)
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) throw new Error('task_check_size_limit_invalid')
  const matches = artifacts.filter(item => item.artifactId === request.artifactId)
  if (matches.length !== 1) throw new Error('task_check_artifact_unregistered')
  const artifact = taskArtifactSchema.parse(matches[0])
  const uri = new URL(artifact.uri)
  if (uri.protocol !== 'file:' || uri.username || uri.password || uri.search || uri.hash) throw new Error('task_check_artifact_not_local_file')
  const filename = fileURLToPath(uri)
  const root = await realpath(workspaceRoot)
  if (!inside(root, path.resolve(filename))) throw new Error('task_check_path_outside_workspace')
  const result = (outcome, reason) => hostCheckEvidenceSchema.parse({ evidenceId: stableId('evidence', receiptId), producerKind: 'checker', criterionIds, artifactRefs: [artifact.artifactId], sourceRef: receiptId, observedAt, outcome, reason, checkerId: request.checkerId, checkerVersion: request.checkerVersion, receiptId })
  // 先验证 Host 身份，再访问文件；失败信息不携带内容或系统异常中的敏感路径。
  result('unknown', '检查尚未完成')
  let resolved
  try { resolved = await realpath(filename) } catch { return result('unknown', 'artifact_unavailable') }
  if (!inside(root, resolved)) throw new Error('task_check_path_outside_workspace')
  let handle
  try {
    const before = await stat(resolved)
    if (!before.isFile()) return result('unknown', 'artifact_not_regular_file')
    if (before.size > maxBytes) return result('unknown', 'artifact_size_limit')
    handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    if (!sameFile(before, await handle.stat()) || await realpath(filename) !== resolved) return result('unknown', 'artifact_changed')
    const digest = createHash('sha256'), buffer = Buffer.alloc(Math.min(maxBytes + 1, 64 * 1024))
    let bytes = 0
    while (true) {
      const read = await handle.read(buffer, 0, Math.min(buffer.length, maxBytes - bytes + 1), null)
      if (!read.bytesRead) break
      bytes += read.bytesRead
      if (bytes > maxBytes) return result('unknown', 'artifact_size_limit')
      digest.update(buffer.subarray(0, read.bytesRead))
    }
    if (!sameFile(before, await handle.stat()) || !sameFile(before, await stat(resolved)) || await realpath(filename) !== resolved) return result('unknown', 'artifact_changed')
    return result(digest.digest('hex') === request.expectedDigest ? 'pass' : 'fail', 'artifact_sha256_comparison')
  } catch { return result('unknown', 'artifact_read_failed') } finally { await handle?.close() }
}
