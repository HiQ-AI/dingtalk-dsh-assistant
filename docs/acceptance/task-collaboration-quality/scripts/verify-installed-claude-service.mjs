// 安装后真实 DSH 原生统筹驱动 + 已安装插件 + 真实交互 Claude；DSH模型决策固定，无外发。
import assert from 'node:assert/strict'
import { mkdir, lstat, readFile, writeFile } from 'node:fs/promises'
import { resolve, join, dirname, relative, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { nativeTaskHost, latestInput, topicTaskCalls } from '../../../../test/fixtures/task-session-native-host.js'

const [profileArgument, outputArgument] = process.argv.slice(2)
assert.ok(profileArgument && outputArgument, 'profile/package.json fresh-output-directory required; --check optional')
const root = resolve(outputArgument), profilePath = resolve(profileArgument)
const relativeOutput = relative(resolve('docs/tmp'), root)
assert.ok(relativeOutput && !relativeOutput.startsWith('..') && !isAbsolute(relativeOutput), 'output must be a fresh child of this checkout docs/tmp')
assert.ok(process.env.DSH_NATIVE_TEST_PROFILE, 'DSH_NATIVE_TEST_PROFILE is required')
assert.equal(resolve(process.env.DSH_NATIVE_TEST_PROFILE), profilePath, 'native fixture and plugin must resolve the same profile')
const profile = createRequire(profilePath)
const packageRoot = dirname(profile.resolve('@zzusp/dingtalk-dsh-assistant/package.json'))
const { openTaskSessionService } = await import(pathToFileURL(join(packageRoot, 'task-session-service.js')))
if (process.argv.includes('--check')) {
  console.log(JSON.stringify({ status: 'PASS', writes: 0, modelCalls: 0, profilePath, packageRoot }))
} else {
  await assert.rejects(lstat(root), { code: 'ENOENT' }); await mkdir(root)
  const report = { wrapperPid: process.pid, profilePath, packageRoot, status: 'FAIL', startedAt: new Date().toISOString() }
  let h, task, didRead = false, timer
  const call = (name, args) => ({ name, args })
  const finish = action => call('task_session_submit', { decision: { action, summary: '安装后原生统筹与Claude执行链核验', evidence: [], limitations: ['DSH模型为固定决策；没有钉钉业务外发'] } })
  try {
    h = await nativeTaskHost(root, async request => {
      const topic = topicTaskCalls(request); if (topic) return topic
      const input = latestInput(request)
      assert.ok(request.tools.some(tool => tool.name === 'task_delegate'), 'execution must use Claude, not scripted native executor')
      if (!input.executions.length) return [call('task_delegate', { key: 'installed-claude', objective: '安装后隔离验证：不要创建队友，不执行原生文件或命令工具。用execution_report_progress报告简短计划，然后execution_submit提交completed，summary必须为DSH_NATIVE_OWNER_CLAUDE_OK，evidence说明本轮仅验证链路，artifacts为空，limitations说明无业务验证。不要自行退出。' }), finish('wait')]
      const execution = input.executions[0]
      if (!execution.drained) return [finish('wait')]
      assert.equal(execution.status, 'succeeded', JSON.stringify(execution.result))
      if (!didRead) {
        didRead = true
        const member = (await h.service.taskExecutions(input.task.taskId)).executions[0]
        report.documentPath = member.document.path
        assert.ok(request.tools.some(tool => tool.name === 'read'), 'native owner must expose the real read tool')
        return [call('read', { file_path: member.document.path })]
      }
      assert.ok(JSON.stringify(request.messages.filter(message => message.role === 'tool')).includes('DSH_NATIVE_OWNER_CLAUDE_OK'), 'owner must receive actual execution document as tool output, not repeat the instruction marker')
      assert.ok(h.toolResults.some(item => item.name === 'read' && item.result?.isError !== true && JSON.stringify(item.result).includes('DSH_NATIVE_OWNER_CLAUDE_OK')), 'native read must actually return the execution document')
      return [finish('complete')]
    }, { agentConfig: { executionBackend: 'claude-code' }, serviceFactory: openTaskSessionService })
    const deadline = new Promise((_resolve, reject) => { timer = setTimeout(() => { report.timedOut = true; reject(Object.assign(new Error('installed smoke timed out'), { code: 'INSTALLED_SMOKE_TIMEOUT' })) }, 240000) })
    await Promise.race([(async () => {
      task = await h.service.createTask({ groupId: 'native-group', requestId: 'installed-claude-smoke', objective: '安装后核验：DSH原生统筹分派交互Claude，读取其本轮文档后完成' })
      await h.service.whenIdle()
    })(), deadline])
    const detail = await h.service.taskDetail(task.taskId)
    const member = (await h.service.taskExecutions(task.taskId)).executions[0]
    assert.equal(report.timedOut, undefined)
    assert.equal(member.result?.summary, 'DSH_NATIVE_OWNER_CLAUDE_OK', 'persisted Claude result must match the requested smoke result')
    assert.equal(member.executionBackend, 'claude-code'); assert.equal(member.drained, true); assert.equal(member.status, 'succeeded')
    assert.equal(didRead, true)
    assert.equal(detail.status, 'completed', 'whenIdle is not proof of business completion')
    assert.equal(detail.session.sessionBound, true, 'owner must have a real native DSH session')
    const bytes = await readFile(report.documentPath)
    assert.match(bytes.toString(), /DSH_NATIVE_OWNER_CLAUDE_OK/)
    report.taskId = task.taskId; report.taskStatus = detail.status; report.execution = member
    report.documentSha256 = createHash('sha256').update(bytes).digest('hex')
    report.ownerNativeRequests = h.requests.length
    report.externalMessagesSent = 0
    report.localNotificationReceipts = h.sent.length
    report.status = 'PASS'
  } catch (error) { report.failure = { code: error.code, message: error.message, stack: error.stack }; process.exitCode = 1 }
  finally {
    clearTimeout(timer)
    try { await h?.close(); report.closed = true }
    catch (error) { report.closed = false; report.status = 'FAIL'; report.cleanupFailure = { code: error.code, message: error.message }; process.exitCode = 1 }
    report.completedAt = new Date().toISOString()
    await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ status: report.status, failure: report.failure, taskId: report.taskId, packageRoot }))
  }
}
