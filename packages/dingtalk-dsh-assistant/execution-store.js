import { Worker } from 'node:worker_threads'
import { isAbsolute, dirname, join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'

// Host进程出生身份：worker重开不变，不能由HTTP/调用者options提供。
const incarnationKey = Symbol.for('dsh.execution.process-incarnation')
if (!Object.hasOwn(process, incarnationKey)) Object.defineProperty(process, incarnationKey, { value: `${process.pid}:${randomUUID()}` })
const processIncarnation = process[incarnationKey]

const MAX_PENDING = 64
const REQUEST_TIMEOUT_MS = 10_000
const error = (code, message = code) => Object.assign(new Error(message), { code })
const deserializeError = value => Object.assign(new Error(value.message), value)

/**
 * 单一执行控制账。调用者是已认证的 Host 内部服务，不向 Agent 暴露命令写口。
 * inputRef/outputRef/evidenceRef 是相对内容寻址引用，业务内容由 Controller 校验。
 * command: {id,kind,args}；receipt 重投只返回历史结果，dispatchEligible 恒为 false。
 * node.claim.result.binding 含先落盘的 sessionId；创建原生会话后再 node.sessionBound。
 * node.drained 是 Host 确认工具/句柄已退出的记录，不是模型自报。
 * 正常开库不建表；initialize 只用于显式新实例。父目录须由安装流程准备。
 * @param {{dbPath:string,instanceId:string,initialize?:boolean}} options
 */
export async function openExecutionStore(options) {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype
    || Object.keys(options).some(key => !['dbPath', 'instanceId', 'initialize'].includes(key))
    || typeof options.dbPath !== 'string' || !isAbsolute(options.dbPath)
    || typeof options.instanceId !== 'string' || !options.instanceId.trim()
    || (options.initialize !== undefined && typeof options.initialize !== 'boolean')) throw error('INVALID_STORE_OPTIONS')
  const worker = new Worker(new URL('./execution-store-worker.js', import.meta.url), {
    workerData: { dbPath: options.dbPath, instanceId: options.instanceId, initialize: options.initialize === true, processIncarnation },
  })
  let healthy = false, closed = false, closing = false, nextId = 0, info
  let firstFailure = null, readyReceived = false
  let resolveReady, rejectReady, resolveExit
  const pending = new Map()
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const exited = new Promise(resolve => { resolveExit = resolve })
  // 启动等待 worker 的真实 ready/fatal/error/exit；完整性校验耗时不是提交结果未知。

  function unavailable(cause, diagnostic = {}) {
    if (!firstFailure && !(closing && diagnostic.origin === 'worker-exit' && diagnostic.exitCode === 0)) {
      const original = diagnostic.cause ?? cause
      const machineCode = value => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_.-]{0,80}$/.test(value) ? value : null
      firstFailure = Object.freeze({ at: new Date().toISOString(), origin: diagnostic.origin ?? 'worker-error',
        code: machineCode(original.code) ?? 'STORE_ERROR', sqliteCode: Number.isSafeInteger(original.sqliteCode) ? original.sqliteCode : null,
        exitCode: Number.isSafeInteger(diagnostic.exitCode) ? diagnostic.exitCode : null,
        action: machineCode(diagnostic.action), kind: machineCode(diagnostic.kind), requestDigest: diagnostic.requestDigest ?? null })
      // 首因跨Resident重开保留；只记录机器码与摘要，绝不输出原错误正文或请求参数。
      if (readyReceived) {
        try { appendFileSync(join(dirname(options.dbPath), 'execution-store-failures.jsonl'), JSON.stringify(firstFailure) + '\n', { encoding: 'utf8' }) }
        catch { console.error('[execution-store] FAILURE_TRACE_WRITE_FAILED') }
      }
      console.error('[execution-store] ' + JSON.stringify(firstFailure))
    }
    healthy = false
    rejectReady(cause)
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(cause) }
    pending.clear()
  }
  worker.on('message', message => {
    if (message.type === 'ready') {
      readyReceived = true
      healthy = true
      info = Object.freeze(message.info)
      resolveReady()
    } else if (message.type === 'fatal') unavailable(deserializeError(message.error), { origin: 'worker-fatal' })
    else if (message.type === 'response') {
      const item = pending.get(message.requestId)
      if (!item) return
      clearTimeout(item.timer)
      pending.delete(message.requestId)
      if (message.error) {
        const cause = deserializeError(message.error)
        item.reject(cause)
        if (message.unhealthy) {
          unavailable(error('STORE_UNAVAILABLE', '数据库写入结果不明；必须关闭后重新打开并恢复'), { ...item.diagnostic, origin: 'worker-response', cause })
          void worker.terminate()
        }
      } else item.resolve(message.value)
    }
  })
  worker.on('error', cause => unavailable(cause, { origin: 'worker-error' }))
  worker.on('exit', code => {
    closed = true
    unavailable(error('STORE_UNAVAILABLE', `execution worker exited (${code})`), { origin: 'worker-exit', exitCode: code })
    resolveExit()
  })

  async function rpc(action, value) {
    if (!healthy || closed || (closing && action !== 'close')) throw error('STORE_UNAVAILABLE')
    if (pending.size >= MAX_PENDING) throw error('STORE_QUEUE_FULL')
    try { JSON.stringify(value ?? null) } catch { throw error('INVALID_REQUEST') }
    const requestId = ++nextId
    const diagnostic = { action, kind: value?.kind ?? null,
      requestDigest: createHash('sha256').update(JSON.stringify({ action, value: value ?? null })).digest('hex') }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // 不是未提交：所有待答复命令都必须按原 ID 在重开后读回。
        unavailable(error('COMMIT_ACK_UNKNOWN', '控制事务回执超时，禁止派生新效果'), { ...diagnostic, origin: 'rpc-timeout' })
        void worker.terminate()
      }, REQUEST_TIMEOUT_MS)
      pending.set(requestId, { resolve, reject, timer, diagnostic })
      try { worker.postMessage({ requestId, action, value }) }
      catch (cause) { clearTimeout(timer); pending.delete(requestId); reject(error('INVALID_REQUEST', cause.message)) }
    })
  }
  try { await ready } catch (cause) { await worker.terminate(); await exited; throw cause }
  return Object.freeze({
    get info() { return info },
    get healthy() { return healthy && !closing && !closed },
    get failure() { return firstFailure },
    command(command) { return rpc('command', command) },
    query(query) { return rpc('query', query) },
    async close() {
      if (!closing && !closed) {
        closing = true
        try { if (healthy) await rpc('close'); else await worker.terminate() }
        catch { await worker.terminate() }
      }
      await exited
    },
  })
}
