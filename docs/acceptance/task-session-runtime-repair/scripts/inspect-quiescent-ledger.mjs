import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
// 复用旧部署 checker 的逐文件算法；旧入口无条件打开退役控制库，不能直接调用。
export function inspectPackage(packagePath, source, installed) {
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  const contents = spawnSync('tar', ['-tf', packagePath], { encoding: 'utf8', windowsHide: true })
  if (contents.status !== 0) throw Error('PACKAGE_UNREADABLE')
  const names = contents.stdout.trim().split(/\r?\n/u)
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  const published = manifest.files ?? readdirSync(source, { withFileTypes: true }).filter(entry => entry.isFile() && !entry.name.startsWith('.')).map(entry => entry.name)
  if (!Array.isArray(published) || published.some(file => !/^[\w.-]+$/u.test(file))) throw Error('PACKAGE_FILE_LIST_INVALID')
  const files = [...new Set([...published, 'package.json'])]
  for (const file of files) {
    if (names.filter(name => name === 'package/' + file).length !== 1) throw Error('PACKAGE_FILE_MISSING:' + file)
    const packed = spawnSync('tar', ['-xOf', packagePath, 'package/' + file], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
    if (packed.status !== 0) throw Error('PACKAGE_EXTRACT_FAILED')
    const expected = readFileSync(join(source, file))
    const same = (a, b) => file === 'package.json' ? JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b)) : hash(a) === hash(b)
    if (!same(packed.stdout, expected)) throw Error('PACKAGE_SOURCE_MISMATCH:' + file)
    if (installed && !same(readFileSync(join(installed, file)), expected)) throw Error('INSTALLED_SOURCE_MISMATCH:' + file)
  }
  if (names.some(name => (name.endsWith('.js') || name.endsWith('.ps1')) && !files.includes(name.slice('package/'.length)))) throw Error('PACKAGE_UNEXPECTED_SOURCE')
  return { verifiedFiles: files.length, sha256: hash(readFileSync(packagePath)) }
}
export function inspectLedger(dbPath, workspace, offline = false, expectedOwnerPid) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error('DEPLOY_DATABASE_CORRUPT')
    const owner = db.prepare("SELECT value FROM dynamic_meta WHERE key='owner'").get()?.value
    const tables = Object.fromEntries(['tasks','executions','groups','operations','notifications'].map(name => [name, db.prepare(`SELECT body FROM dynamic_${name}`).all().map(row => JSON.parse(row.body))]))
    const busy = ['executions','groups'].flatMap(name => tables[name].filter(row => row.drained === false).map(row => ({ table: name, id: row.taskId ?? row.executionId ?? row.groupId })))
    if (busy.length || tables.operations.some(row => row.state === 'starting') || tables.notifications.some(row => row.state === 'starting')) throw Error('DEPLOY_NOT_DRAINED')
    let ownerProcessExited = !owner
    const processExited = pid => { try { process.kill(pid, 0); return false } catch (error) { if (error.code === 'ESRCH') return true; throw error } }
    if (offline) {
      if (!Number.isSafeInteger(expectedOwnerPid) || expectedOwnerPid < 1) throw Error('DEPLOY_EXPECTED_OWNER_PID_REQUIRED')
      if (!processExited(expectedOwnerPid)) throw Error('DEPLOY_OWNER_NOT_RELEASED')
    }
    if (owner) {
      const ownerPid = Number(owner.split(':')[0])
      if (!Number.isSafeInteger(ownerPid) || ownerPid < 1) throw Error('DEPLOY_OWNER_INVALID')
      if (offline && ownerPid !== expectedOwnerPid) throw Error('DEPLOY_OWNER_IDENTITY_MISMATCH')
      try { process.kill(ownerPid, 0) } catch (error) { if (error.code === 'ESRCH') ownerProcessExited = true; else throw error }
    }
    // 与动态库自身启动接管合同一致：保留失效owner行，由正式启动事务接管，绝不手工清账。
    // 下方仍独立核验所有持久回合结束；部署脚本另核验精确旧进程及子进程均退出。
    if (offline && !ownerProcessExited) throw Error('DEPLOY_OWNER_NOT_RELEASED')
    let verifiedSessions = 0
    const unstartedTaskClaims = []
    if (tables.tasks.some(row => row.drained === false && !row.sessionBound)) throw Error('DEPLOY_NOT_DRAINED')
    for (const row of [...tables.tasks, ...tables.executions].filter(row => row.sessionBound)) {
      const root = join(workspace, 'tasks', row.taskId, '.dsh', 'sessions')
      const matches = []
      function walk(directory) {
        if (lstatSync(directory).isSymbolicLink()) throw Error('DEPLOY_LOG_REPARSE_POINT')
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const file = join(directory, entry.name)
          if (entry.isSymbolicLink()) throw Error('DEPLOY_LOG_REPARSE_POINT')
          if (entry.isDirectory()) walk(file)
          else if (/^session\.v4\.jsonl(?:\.zst)?$/u.test(entry.name)) {
            let bytes = readFileSync(file)
            if (file.endsWith('.zst')) bytes = zstdDecompressSync(bytes)
            const events = bytes.toString('utf8').trim().split(/\r?\n/u).map(line => JSON.parse(line))
            if (events[0]?.id === row.sessionId) matches.push(events)
          }
        }
      }
      walk(root)
      if (matches.length !== 1) throw Error('DEPLOY_NATIVE_LOG_IDENTITY')
      const events = matches[0], start = events.findLastIndex(event => event.type === 'turn/start'), end = events.findLastIndex(event => event.type === 'turn/end')
      if (start < 0 || end < start) throw Error('DEPLOY_NATIVE_TURN_NOT_ENDED')
      if (tables.tasks.includes(row) && row.drained === false) {
        if (!Number.isSafeInteger(row.leaseEpoch) || row.leaseEpoch < 2 || !events.some(event => event.type === 'plugin:dingtalk/task-session'
          && event.data?.taskId === row.taskId && event.data?.sessionId === row.sessionId)) throw Error('DEPLOY_NATIVE_LOG_IDENTITY')
        const inputs = events.flatMap((event, index) => (event.type === 'user/message' ? [event.data]
          : event.type === 'agent/inbox/spliced' ? event.data?.inserted ?? [] : []).map(message => ({ message, index })))
          .filter(item => item.message?.source?.taskSession)
        if (inputs.some(item => item.message.source.taskSession.leaseEpoch >= row.leaseEpoch)) throw Error('DEPLOY_TASK_CLAIM_ALREADY_STARTED')
        const previousInput = inputs.at(-1), previous = previousInput?.message.source.taskSession
        if (previous?.leaseEpoch !== row.leaseEpoch - 1 || previous.sessionId !== row.sessionId || previous.taskId !== row.taskId || previousInput.index >= end) throw Error('DEPLOY_TASK_PREVIOUS_LEASE_UNPROVEN')
        const completed = new Set(events.filter(event => event.type === 'tool/result').flatMap(event => {
          const message = event.data?.message
          return (message?.role === 'tool' ? [message] : message?.content ?? []).map(result => result.toolCallId)
        }))
        if (events.some(event => event.type === 'tool/call' && !completed.has(event.data?.callId))) throw Error('DEPLOY_NATIVE_TOOL_NOT_ENDED')
        unstartedTaskClaims.push({ taskId: row.taskId, sessionId: row.sessionId, leaseEpoch: row.leaseEpoch,
          requirementRevision: row.requirementRevision, controlRevision: row.controlRevision,
          previousInputLeaseEpoch: previous.leaseEpoch, previousTurnEndSequence: events[end].seq,
          lastNativeSequence: events.at(-1)?.seq, currentLeaseInputAbsent: true })
      }
      verifiedSessions++
    }
    return { quiescent: true, candidateOnly: !offline, ownerReleased: !owner, ownerProcessExited, staleOwner: !!owner && ownerProcessExited,
      drained: unstartedTaskClaims.length === 0, unstartedTaskClaims, verifiedSessions, unknownOperations: tables.operations.filter(row => row.state === 'unknown').length, unknownNotifications: tables.notifications.filter(row => row.state === 'unknown').length }
  } finally { db.close() }
}
// 冷启动走正式 Host 的恢复事务，不把部署要求的 turn/end 当作崩溃恢复前提。
export function inspectStartup(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error('START_DATABASE_CORRUPT')
    const meta = Object.fromEntries(db.prepare('SELECT key,value FROM dynamic_meta').all().map(row => [row.key, row.value]))
    const marker = JSON.parse(readFileSync(dbPath + '.initialized', 'utf8'))
    if (marker.version !== 1 || !meta.instanceId || !meta.initToken || marker.phase !== 'initialized' || marker.instanceId !== meta.instanceId || marker.initToken !== meta.initToken
      || (marker.ingressEpoch ?? null) !== (meta.ingressEpoch ?? null)) throw Error('START_INITIALIZATION_IDENTITY')
    if (meta.owner) {
      const pid = Number(meta.owner.split(':')[0])
      if (!Number.isSafeInteger(pid) || pid < 1) throw Error('START_OWNER_INVALID')
      try { process.kill(pid, 0); throw Error('START_OWNER_STILL_ALIVE') }
      catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    const rows = table => db.prepare(`SELECT body FROM dynamic_${table}`).all().map(row => JSON.parse(row.body))
    return { ownerProcessExited: true, recoveryHandledByHost: true,
      pendingSessions: ['tasks', 'executions', 'groups'].flatMap(rows).filter(row => row.drained === false).length,
      startingOperations: rows('operations').filter(row => row.state === 'starting').length,
      unknownNotifications: rows('notifications').filter(row => row.state === 'unknown').length }
  } finally { db.close() }
}
if (process.argv[1]?.endsWith('inspect-quiescent-ledger.mjs')) {
  try { console.log(JSON.stringify(process.argv[2] === 'startup' ? inspectStartup(process.argv[3]) : process.argv[2] === 'package' ? inspectPackage(...process.argv.slice(3)) : inspectLedger(process.argv[2], process.argv[3], process.argv[4] === 'offline', process.argv[5] === undefined ? undefined : Number(process.argv[5])))) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
