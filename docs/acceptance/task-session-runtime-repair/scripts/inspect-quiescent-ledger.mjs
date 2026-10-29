import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync, lstatSync, openSync, fstatSync, closeSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
const localRequire = createRequire(import.meta.url)
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
// 独立运维助手只依赖标准库，复制到 launchers 后仍按持久后端读取原排空证据。
function inspectClaudeHistory(workspace, row) {
  const fail = code => { throw Error(`DEPLOY_CLAUDE_${code}`) }
  const identity = ['taskId','executionId','sessionId','inputVersion','inputDigest','requirementRevision','controlRevision','leaseEpoch','claudeSessionMode']
  const inputKeys = ['inputVersion','inputDigest','requirementRevision','controlRevision']
  const same = (a,b,keys=identity) => keys.every(key=>a?.[key]===b?.[key])
  const uuid = /^task-execution-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu.exec(row.sessionId)?.[1]
  const taskSegment = value => typeof value==='string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value)
    && !/[.]$/u.test(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value)
  if (!uuid || !taskSegment(row.taskId) || typeof row.executionId!=='string' || !/^[a-zA-Z0-9_-]+$/u.test(row.executionId)) fail('IDENTITY_INVALID')
  if (row.claudeSessionMode !== undefined && row.claudeSessionMode !== 'interactive-team-v1') fail('SESSION_MODE_INVALID')
  if (row.sessionBound!==true || row.drained!==true || !Number.isSafeInteger(row.leaseEpoch) || row.leaseEpoch<1 || !Array.isArray(row.inputHistory)) fail('BINDING_INVALID')
  const inputs = new Map()
  for (const input of [...row.inputHistory,row]) {
    if (!Number.isSafeInteger(input.inputVersion) || input.inputVersion<1 || input.inputVersion>row.inputVersion || inputs.has(input.inputVersion)
      || !/^[a-f0-9]{64}$/u.test(input.inputDigest ?? '') || !['requirementRevision','controlRevision'].every(key=>Number.isSafeInteger(input[key]) && input[key]>=1)) fail('INPUT_HISTORY_INVALID')
    inputs.set(input.inputVersion,input)
  }
  if (inputs.size!==row.inputVersion) fail('INPUT_HISTORY_INVALID')
  const path = join(resolve(workspace),'tasks',row.taskId,'outputs',row.executionId,'claude-events.jsonl')
  for (let directory=dirname(path);;directory=dirname(directory)) {
    const info=lstatSync(directory)
    if (info.isSymbolicLink() || !info.isDirectory()) fail('LOG_PATH_INVALID')
    if (dirname(directory)===directory) break
  }
  const before=lstatSync(path)
  if (before.isSymbolicLink() || !before.isFile() || before.nlink!==1) fail('LOG_PATH_INVALID')
  const descriptor=openSync(path,'r')
  let text
  try {
    const actual=fstatSync(descriptor)
    if (!actual.isFile() || actual.nlink!==1 || actual.dev!==before.dev || actual.ino!==before.ino) fail('LOG_PATH_CHANGED')
    text=readFileSync(descriptor,'utf8')
  } finally { closeSync(descriptor) }
  if (!text || !text.endsWith('\n')) fail('LOG_INCOMPLETE')
  let events
  try { events=text.slice(0,-1).split('\n').map(line=>JSON.parse(line)) } catch { fail('LOG_INVALID') }
  let start, previous, bound=false
  for (const [index,event] of events.entries()) {
    if (event?.provider!=='claude-code' || event.binding?.kind!=='task-execution' || !same(event.binding,row,['taskId','executionId','sessionId','claudeSessionMode'])) fail('LOG_IDENTITY')
    if (event.sequence!==index+1) fail('LOG_SEQUENCE')
    if (event.type==='start') {
      const binding=event.binding, input=inputs.get(binding.inputVersion)
      if (!input || !same(binding,input,inputKeys) || !Number.isSafeInteger(binding.leaseEpoch) || binding.leaseEpoch<1 || binding.leaseEpoch>row.leaseEpoch
        || (start && (previous?.type!=='drained' || binding.inputVersion<start.inputVersion || binding.leaseEpoch<=start.leaseEpoch))) fail('LOG_GENERATION')
      if (event.data?.providerSessionId!==uuid) fail('PROVIDER_IDENTITY')
      start=binding
    } else if (!start || !same(event.binding,start)) fail('LOG_GENERATION')
    if (event.type==='session.bound') {
      if (event.data?.providerSessionId!==uuid) fail('PROVIDER_IDENTITY')
      bound=true
    }
    if (event.type==='cli' && event.data?.session_id && event.data.session_id!==uuid) fail('PROVIDER_IDENTITY')
    previous=event
  }
  if (!bound || previous?.type!=='drained') fail('NOT_DRAINED')
  if (same(previous.binding,row)) return null
  // 连续 continue 不领取就不增租约；历史连续、同租约末轮已排空且没有较新 start 才证明新输入未启动。
  const prior=inputs.get(previous.binding.inputVersion)
  const unstartedState=row.status==='queued' || (['cancelled','stale'].includes(row.status) && row.cancelRequested===true)
  if (unstartedState && previous.binding.inputVersion<row.inputVersion && previous.binding.leaseEpoch===row.leaseEpoch
    && same(previous.binding,prior,inputKeys) && !events.some(event=>event.type==='start' && event.binding.inputVersion>previous.binding.inputVersion)) {
    return { executionId:row.executionId,sessionId:row.sessionId,inputVersion:row.inputVersion,leaseEpoch:row.leaseEpoch,
      previousInputVersion:previous.binding.inputVersion,previousDrainedSequence:previous.sequence,currentInputStartAbsent:true }
  }
  fail('DRAIN_BINDING_MISMATCH')
}

export function inspectLedger(dbPath, workspace, offline = false, expectedOwnerPid, maintenanceProposal) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error('DEPLOY_DATABASE_CORRUPT')
    const owner = db.prepare("SELECT value FROM dynamic_meta WHERE key='owner'").get()?.value
    const tables = Object.fromEntries(['tasks','executions','groups','operations','notifications'].map(name => [name, db.prepare(`SELECT body FROM dynamic_${name}`).all().map(row => JSON.parse(row.body))]))
    const maintenance = maintenanceProposal ? localRequire('../../../../scripts/native-restart-maintenance.mjs').inspectRetainedRestart({ tables, workspace, proposal: maintenanceProposal, ownerPid: expectedOwnerPid ?? Number(owner?.split(':')[0]) }) : null
    const preserved = new Set(maintenance?.preservedSessionIds ?? [])
    const busy = ['executions','groups'].flatMap(name => tables[name].filter(row => row.drained === false).map(row => ({ table: name, id: row.taskId ?? row.executionId ?? row.groupId })))
    if (busy.some(row => row.table !== 'executions' || !tables.executions.some(execution => preserved.has(execution.sessionId) && execution.taskId === row.id)) || tables.operations.some(row => row.state === 'starting') || tables.notifications.some(row => row.state === 'starting')) throw Error('DEPLOY_NOT_DRAINED')
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
    const unstartedCliExecutions = []
    for (const row of tables.executions) if (!['dsh','claude-code'].includes(row.definition?.executionBackend === undefined ? 'dsh' : row.definition.executionBackend)) throw Error('DEPLOY_EXECUTION_BACKEND_INVALID')
    const unstartedTaskClaims = []
    if (tables.tasks.some(row => row.drained === false && !row.sessionBound)) throw Error('DEPLOY_NOT_DRAINED')
    for (const row of [...tables.tasks, ...tables.executions].filter(row => row.sessionBound)) {
      if (tables.executions.includes(row) && preserved.has(row.sessionId)) { verifiedSessions++; continue }
      if (tables.executions.includes(row) && row.definition?.executionBackend==='claude-code') {
        const unstarted=inspectClaudeHistory(workspace,row)
        if (unstarted) unstartedCliExecutions.push(unstarted)
        verifiedSessions++
        continue
      }
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
      drained: unstartedTaskClaims.length === 0 && !busy.length, maintenanceCutoverReady: !!maintenance && unstartedTaskClaims.length === 0, maintenance, unstartedTaskClaims, unstartedCliExecutions, verifiedSessions, unknownOperations: tables.operations.filter(row => row.state === 'unknown').length, unknownNotifications: tables.notifications.filter(row => row.state === 'unknown').length }
  } finally { db.close() }
}
// 普通换包只核对当前控制事实；历史日志完整性审计仍由 inspectLedger 承担。
export function inspectCurrentControl(dbPath, mode, expectedOwnerPid, maintenanceOptions) {
  if (!['online', 'offline'].includes(mode)) throw Error('DEPLOY_CONTROL_MODE_INVALID')
  if (!Number.isSafeInteger(expectedOwnerPid) || expectedOwnerPid < 1) throw Error('DEPLOY_EXPECTED_PID_REQUIRED')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    db.exec('BEGIN')
    const owner = db.prepare("SELECT value FROM dynamic_meta WHERE key='owner'").get()?.value
    const ownerPid = owner ? Number(owner.split(':')[0]) : undefined
    if (owner && ownerPid !== expectedOwnerPid) throw Error('DEPLOY_OWNER_IDENTITY')
    let alive = true
    try { process.kill(expectedOwnerPid, 0) } catch (error) { if (error.code !== 'ESRCH') throw error; alive = false }
    if (mode === 'online' && (!owner || !alive)) throw Error('DEPLOY_OWNER_IDENTITY')
    if (mode === 'offline' && alive) throw Error('DEPLOY_OWNER_NOT_RELEASED')
    const count = (table, field, value) => db.prepare(`SELECT count(*) AS count FROM dynamic_${table} WHERE json_extract(body, '$.${field}') = ?`).get(value).count
    const pending = Object.fromEntries(['tasks', 'executions', 'groups'].map(table => [table, count(table, 'drained', 0)]))
    let maintenance
    if (maintenanceOptions) {
      if (maintenanceOptions.freeze && mode !== 'online') throw Error('DEPLOY_MAINTENANCE_FREEZE_REQUIRES_LIVE_OWNER')
      maintenance = localRequire('../../../../scripts/native-restart-maintenance.mjs').inspectDrainFailureMaintenance({
        db, ownerPid: expectedOwnerPid, ...maintenanceOptions })
    } else if (Object.values(pending).some(Boolean)) throw Error('DEPLOY_NOT_DRAINED')
    const startingOperations = count('operations', 'state', 'starting'), startingNotifications = count('notifications', 'state', 'starting')
    if (startingOperations || startingNotifications) throw Error('DEPLOY_STARTING_EFFECT')
    return { scope: 'current-control', quiescent: maintenance ? !alive : true, candidateOnly: mode === 'online', drained: !Object.values(pending).some(Boolean), pending,
      ...(maintenance ? { maintenanceReady: true, maintenance } : {}),
      ownerReleased: !owner, ownerProcessExited: !alive, staleOwner: !!owner && !alive,
      unknownOperations: count('operations', 'state', 'unknown'), unknownNotifications: count('notifications', 'state', 'unknown') }
  } finally { db.close() }
}
// 冷启动走正式 Host 的恢复事务，不把部署要求的 turn/end 当作崩溃恢复前提。
export function inspectStartup(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
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
  try {
    const readProposal = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''))
    const command = process.argv[2]
    const result = command === 'freeze-drain-maintenance'
      ? inspectCurrentControl(process.argv[3], 'online', Number(process.argv[5]), { workspace: process.argv[4], proposal: readProposal(process.argv[6]), freeze: true }).maintenance.proposal
      : command === 'current-control' ? inspectCurrentControl(process.argv[3], process.argv[4], Number(process.argv[5]), process.argv[7] ? { workspace: process.argv[6], proposal: readProposal(process.argv[7]) } : undefined)
      : command === 'startup' ? inspectStartup(process.argv[3]) : command === 'package' ? inspectPackage(...process.argv.slice(3))
      : inspectLedger(process.argv[2], process.argv[3], process.argv[4] === 'offline', process.argv[5] === undefined ? undefined : Number(process.argv[5]), process.argv[6] === undefined ? undefined : readProposal(process.argv[6]))
    console.log(JSON.stringify(result))
  }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
