import { messageTimestamp, normalizeMessageTime, normalizeResourceRefs } from './dws-bridge.js'
import { isNamedAgentDirection, isDirectedToOtherParticipants } from './decision.js'
import { acceptanceCriteriaSchema, taskTitle } from './task-input-contract.js'
import { sessionWorkspace, taskFilePath, checkedTaskDirectory } from './session-workspaces.js'
import { isTerminalUatBuildFailure } from './execution-delivery.js'
import { join } from 'node:path'
import { transientRecoveryReasons } from './execution-recovery-policy.js'
import { inspectLegacyTurnFailure } from './execution-session.js'
import { openExecutionRuntime, closeExecutionResources } from './execution.js'
import { createTaskOwnerController } from './task-owner-controller.js'
import { defineExecutionWorkflow } from './execution-controller.js'
import { executionDigest, executionError } from './execution-artifacts.js'
import { createGeneralCapabilityStageContract, createGeneralFileReadCapability, createGeneralCapabilityStepWorkflow, createGeneralMarkdownWriteCapability, createDomainAcceptanceCheck, verifyTaskAcceptance } from './task-general-workflow.js'
import { assertRetiredWorkflowsDrained } from './task-readonly-workflows.js'
import { createTaskStageContracts, createTaskWorkflowContracts } from './task-workflow-contracts.js'
export { createEngineeringFailureRepair } from './workflow-engineering.js'
import { createTaskMarkdownFileAdapter } from './task-markdown-file.js'
import { createTaskArtifactFiles } from './task-artifact-files.js'
import { createTaskArtifactWriteAdapter, createGeneralArtifactWriteCapability, createTaskArtifactImportAdapter, createGeneralArtifactImportCapability } from './task-artifact-write.js'
import { createFileDeliveryStageContract, createTaskGroupFileAdapter, createTaskGroupFileDeliveryWorkflow, createLegacyTaskGroupFileDeliveryWorkflow, selectTaskDeliveryFiles, verifyFileDeliveryOutput } from './task-group-file-delivery.js'
import { createMessageWorkflow } from './message-workflow.js'
import { createMessageCoordinator } from './message-coordinator.js'
import { isPassiveTaskProgress } from './message-ledger.js'
import { taskWorkflowCatalog, messageAnswerArguments, candidateCards, referencedResourceIds } from './message-context.js'
import { createWorkflowNotifications, executeNotificationOperation, workflowResultText, groupStatusText, groupActionText, taskDecisionConditionText } from './workflow-notifications.js'
import { createEngineeringStageContract, createEngineeringRegistry, engineeringWorkflowOwnerContract, createEngineeringCompletionPolicy, readEngineeringDeliveryProof, uatBranchFor } from './workflow-engineering.js'
import { createDataChangeTaskWorkflow, createDataChangeApprovalResumeWorkflow, createDataChangeTaskWorkflowV6, createDataChangeTaskWorkflowV5, createDataChangeTaskWorkflowV4, createLegacyDataChangeTaskWorkflow, simpleDroppedColumnDefinition, columnDeletionImpact, dataChangeProposalRepairConstraints, assertDataChangeProposalRepairInput } from './workflow-data-change.js'
import { createExternalStageContracts, createReleaseTaskWorkflow, createLegacyReleaseTaskWorkflow, releaseWorkflowKinds, externalWorkflowOwnerContract, legacyExternalWorkflowOwnerContract, nativeDataChangeOwnerContract, createNativeDataChangeCompletionPolicy, createScopedNativeDataChangeCompletionPolicy } from './task-release-workflows.js'
import { createUatPrMergeTaskWorkflow, createUatPrMergeTaskWorkflowV2, createLegacyUatPrMergeTaskWorkflow, createMainPrMergeTaskWorkflow } from './task-uat-pr-merge.js'
import { createWorkflowApprovalService } from './workflow-approval.js'
import { queryConversationTaskProgress, singleTaskProgressResult, taskProgressQueryDefinition } from './task-progress-query.js'
import { describeVerificationChecks } from './execution-check-job.js'
import { createMessageAgentController } from './message-agent.js'
import { createAgentQueryTools, verifyAgentEvidence } from './agent-query-tools.js'
import { createAgentResourceReadCapability } from './agent-query-resources.js'
import { createAgentDatabaseReadCapability, createRegisteredPostgresConnector } from './agent-query-database.js'
import { createAgentStatusReadCapability } from './agent-query-status.js'
import { sameDwsFileProjection } from './coordination-resources.js'

const readableNodeOutputRef = node => node.outputRef ?? (node.waitReason?.reference?.startsWith('LOCAL_ACCEPTANCE_') ? node.evidenceRefs?.at(-1) : null)

export function groupTaskExecutions(physical, families) {
  const byId = new Map(physical.map(task => [task.taskId, task]))
  return families.flatMap(family => {
    const members = family.taskIds.map(id => byId.get(id)).filter(Boolean)
    if (!members.length) return []
    const latest = members.at(-1)
    // 既有并发分叉不能被后来的终态遮住：优先保留活动执行在看板上。
    const active = members.filter(task => task.state !== 'completed')
    const displayed = active.at(-1) ?? latest
    const source = members.find(task => task.groupId && !task.groupId.startsWith('web:'))
    return [{ ...displayed, logicalTaskId: members[0].taskId, latestTaskId: latest.taskId,
      sourceGroupId: source?.groupId ?? null,
      topicRefs: displayed.topicRefs?.length ? displayed.topicRefs : source?.topicRefs ?? [],
      executionCount: members.length, executionNumber: members.indexOf(displayed) + 1,
      activeExecutionCount: active.length,
      archivedAt: members.every(task => task.archivedAt) ? latest.archivedAt : undefined }]
  })
}

const isWebDevelopmentDelivery = origin => origin?.channel === 'web'
  && JSON.stringify(origin.run?.request?.stages) === JSON.stringify(['task-engineering', 'task-uat-pr-merge', 'task-uat-deployment'])

export function bindFileDelivery(candidate, source) {
  if (!candidate) return null
  if (typeof source !== 'string' || typeof candidate.sourceQuote !== 'string') throw executionError('TASK_FILE_DELIVERY_AUTHORIZATION_REQUIRED')
  const quote = candidate.sourceQuote.trim()
  const ranges = []
  if (quote) for (let start = source.indexOf(quote); start !== -1; start = source.indexOf(quote, start + 1)) ranges.push([start, start + quote.length])
  // 校验引用覆盖的完整源句，保留引用之外的否定与群范围上下文。
  const clauses = [...source.matchAll(/[^。！？；\n]+[。！？；\n]?/gu)]
    .filter(match => ranges.some(([start, end]) => match.index < end && match.index + match[0].length > start))
    .map(match => match[0])
  if (!quote || !clauses.length || clauses.some(clause => /不要|不用|不必|不需|不(?:发送|发|传)|禁止|不得|取消|暂停|(?:另一个|其他|其它|别的)群/u.test(clause))
    || !/(?:发送|发|上传|传到).*(?:群|群聊)|(?:群|群聊).*(?:发送|发|传)/u.test(quote)
    || !/文件|文档|附件|markdown|sql|图片|\.(?:md|sql|pdf|docx|xlsx|pptx|png|jpe?g|webp)\b/iu.test(quote)) throw executionError('TASK_FILE_DELIVERY_AUTHORIZATION_REQUIRED')
  const files = candidate.files
  if (!Array.isArray(files) || !files.length || files.length > 20
    || files.some(file => !file.role?.trim() || !file.fileName?.trim() || /[\\/\x00-\x1f<>:"|?*]/u.test(file.fileName))
    || new Set(files.map(file => file.role)).size !== files.length
    || new Set(files.map(file => file.fileName)).size !== files.length) throw executionError('TASK_FILE_DELIVERY_MANIFEST_INVALID')
  return { sourceQuote: quote, files: files.map(file => ({ role: file.role, fileName: file.fileName })) }
}

export { selectTaskDeliveryFiles, verifyFileDeliveryOutput } from './task-group-file-delivery.js'

/** 只替换明确失败的部署后缀；成功工程与合并 Run 保持不变。 */
export async function continueFailedUatStage({ taskId, plan, store, controller, external }) {
  if (!plan || plan.task.controlState !== 'active' || plan.stages.length !== 3
    || !plan.stages[0].workflowId.startsWith('task-engineering-')
    || plan.stages[1].workflowId !== 'task-uat-pr-merge'
    || plan.stages.slice(0, 2).some(stage => stage.status !== 'succeeded' || !stage.runId || !stage.outputRef)
    || typeof external?.prepareUatRebuildFromFailure !== 'function') return plan
  let current = plan.stages[2]
  const replacing = current.workflowId === 'task-uat-deployment' && current.status === 'blocked' && current.runId && current.attempt === 1
  const binding = current.workflowId === 'task-uat-rebuild' && current.status === 'ready' && !current.requirementRef
    && plan.task.planRevision > 1 && current.attempt === 2
  if (!replacing && !binding || !isWebDevelopmentDelivery(await store.query({ kind: 'task.origin', taskId }))) return plan
  const failedRunId = replacing ? current.runId : controller.plannedTaskStageRunId({ taskId,
    planRevision: plan.task.planRevision - 1, stageId: current.stageId, attempt: current.attempt - 1 })
  const input = await external.prepareUatRebuildFromFailure({ taskId, runId: failedRunId, mergeRunId: plan.stages[1].runId })
  if (replacing) {
    await controller.reviseTaskPlan({ commandId: `uat-rebuild-plan:${failedRunId}`, taskId,
      expectedPlanRevision: plan.task.planRevision, expectedControlRevision: plan.task.controlRevision,
      requirementRevision: plan.task.requirementRevision, affectedFrom: 2,
      stages: plan.stages.map((stage, index) => ({ stageId: stage.stageId,
        workflowId: index === 2 ? 'task-uat-rebuild' : stage.workflowId, gate: stage.gate })) })
    plan = await controller.taskPlan(taskId)
    current = plan.stages[2]
  }
  if (current.status === 'ready' && !current.requirementRef) {
    await controller.bindTaskStageInput({ commandId: `uat-rebuild-input:${failedRunId}`, taskId,
      planRevision: plan.task.planRevision, expectedControlRevision: plan.task.controlRevision,
      stageId: current.stageId, predecessorOutputRef: plan.stages[1].outputRef, input })
    return controller.advanceTaskPlan(taskId)
  }
  return plan
}

async function verifiedUatRebuildCompletion({ taskId, plan, origin, artifacts, external, controller }) {
  if (!isWebDevelopmentDelivery(origin) || plan.stages.length !== 3
    || !plan.stages[0].workflowId.startsWith('task-engineering-') || plan.stages[1].workflowId !== 'task-uat-pr-merge'
    || plan.stages[2].workflowId !== 'task-uat-rebuild' || plan.stages[2].attempt !== 2
    || typeof external?.prepareUatRebuildFromFailure !== 'function') return false
  const input = await artifacts.read(plan.stages[2].requirementRef)
  const markers = input.evidenceRefs?.filter(ref => ref.startsWith(`uat-failed-task:${taskId}:`)) ?? []
  if (markers.length !== 1) return false
  const runId = markers[0].slice(`uat-failed-task:${taskId}:`.length)
  if (runId !== controller.plannedTaskStageRunId({ taskId, planRevision: plan.task.planRevision - 1,
    stageId: plan.stages[2].stageId, attempt: plan.stages[2].attempt - 1 })) return false
  const expected = await external.prepareUatRebuildFromFailure({ taskId, runId, mergeRunId: plan.stages[1].runId })
  return executionDigest(input.target) === executionDigest(expected.target)
    && input.request === expected.request && executionDigest(input.constraints) === executionDigest(expected.constraints)
}

/** 将持久节点工件转换为可读产出；不推断未落盘的文件或外部执行结果。 */
export function describeTaskNodeOutput(node, output, context = {}) {
  if (output?.capabilityId === 'write-task-markdown' && output.output?.status === 'succeeded'
    && output.verification?.passed === true) {
    const file = output.output.result
    return { overview: 'Markdown 文件已保存并独立读回',
      text: `Markdown 文件\n${file.path}\n\n文件大小\n${file.bytes} 字节\n\nSHA-256\n${file.contentDigest}` }
  }
  if (output?.deliveryStatus === 'files_verified') {
    const receipts = output.receipts ?? []
    return { overview: `已核验送达 ${receipts.length} 个文件`, text: receipts.map(item => {
      const receipt = item.result
      return `${receipt.fileName}（${receipt.size} 字节）\nSHA-256：${receipt.sha256}\n消息 ID：${receipt.messageId}`
    }).join('\n\n') }
  }
  if (node.nodeId === 'apply-changes' && output?.changeDisposition === 'no-change' && output.status === 'succeeded') {
    return { overview: '现有实现符合要求，无需修改源码；继续构建与验收',
      text: `判断依据\n${output.reason}\n\n已核对文件\n${(output.reviewedPaths ?? []).join('\n')}` }
  }
  if (node.nodeId === 'define-local-acceptance' && output?.localContext) {
    return { overview: `已核对 ${output.localContext.criteria.length} 项任务验收条件`, text: `目标环境\n${output.localContext.uatEnvironment}\n\n数据环境\n共享 UAT 数据库\n\n任务验收条件\n${output.localContext.criteria.map(item => `${item.id}：${item.description}`).join('\n')}` }
  }
  if (node.nodeId === 'plan-local-acceptance' && Array.isArray(output?.cases)) {
    const text = output.cases.map((item, index) => `${index + 1}. ${item.criterionId} · ${item.scenarioId}\n操作步骤：\n${item.steps.map((step, i) => `${i + 1}. ${step}`).join('\n')}\n预期：${item.expected}`).join('\n\n')
    return { overview: `已编写 ${output.cases.length} 项本地验收用例`, text }
  }
  if (node.nodeId === 'prepare-local-acceptance' && output?.localPrepared) {
    const prepared = output.localPrepared
    return { overview: '已准备本地验收目录与任务数据标识', text: `验收目录\n${prepared.directory}\n\n目标环境\n${prepared.uatEnvironment}\n\n数据环境\n共享 UAT 数据库\n\n任务数据标识\n${prepared.namespace}` }
  }
  if (['run-local-acceptance', 'finalize-local-acceptance'].includes(node.nodeId) && output?.localAcceptance) {
    const receipt = output.localAcceptance
    const passed = receipt.passed === true && receipt.cleanup?.dataCleaned === true && receipt.cleanup?.processStopped === true
    const cleanupDescription = receipt.cleanup?.mode === 'read-only' && receipt.cleanup.createdResources === 0 ? '无业务数据写入，会话已清理' : '已清理'
    if (node.nodeId === 'finalize-local-acceptance') return { overview: passed ? `本地业务验收通过，${cleanupDescription}、服务已停止` : '本地验收或清理未确认，不能提交代码', text: passed ? `已核对 ${receipt.checks.length} 项验收结果及清理回执，允许进入代码提交。` : '验收结果或清理回执不完整，后续提交保持阻断。' }
    const duration = ms => {
      if (!Number.isFinite(ms) || ms < 0) return '耗时未记录'
      const seconds = Math.floor(ms / 1000)
      return seconds >= 3600 ? `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分 ${seconds % 60} 秒` : seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`
    }
    const phases = (receipt.phases ?? []).map(phase => `${phase.title}：${({ succeeded: '完成', passed: '通过', failed: '失败', skipped: '未执行', running: '执行中' })[phase.status] ?? '结果未确认'} · ${duration(phase.elapsedMs)}`).join('\n')
    const checks = (receipt.checks ?? []).map((item, index) => `${index + 1}. ${item.criterionId} · ${item.scenarioId}\n操作步骤：\n${(item.steps ?? []).map((step, i) => `${i + 1}. ${step}`).join('\n')}\n预期：${item.expected}\n实际：${item.actual ?? '未取得实际结果'}\n结果：${item.passed === true ? '通过' : '未通过'}`).join('\n\n')
    const text = `目标环境\n${receipt.uatEnvironment}\n\n数据环境\n共享 UAT 数据库\n\n执行阶段\n${phases || '未记录阶段结果'}\n\n业务验收\n${checks || '未记录实际验收结果'}\n\n清理结果\n任务数据：${receipt.cleanup?.dataCleaned === true ? cleanupDescription : '未确认清理完成'}\n本地服务：${receipt.cleanup?.processStopped === true ? '已停止' : '未确认停止'}`
    return { overview: `本地业务验收${passed ? '通过' : '未通过'} · ${(receipt.checks ?? []).length} 项`, text, document: { name: '本地验收报告.md', content: `# 本地验收报告\n\n${text}` } }
  }
  if (node.nodeId === 'business-acceptance' && output?.acceptance) {
    const items = output.acceptance.checks.map(check => {
      const { acceptance } = JSON.parse(check.log)
      return `${acceptance.criterion}\n预期：${acceptance.expected}\n实际：${acceptance.actual ?? '未取得实际结果'}\n结果：${check.passed ? '通过' : '未通过'}`
    })
    return { overview: `业务验收${output.acceptance.passed ? '通过' : '未通过'} · ${items.length} 项`, text: items.join('\n\n') }
  }
  if (node.nodeId === 'prepare-workspace') {
    const workspace = output?.workspace ?? context.workspace
    return { overview: workspace?.status === 'succeeded' ? '已创建独立 Git 工作目录' : '工作目录回执未记录',
      text: workspace ? `工作目录\n${workspace.directory}${workspace.developmentBranch ? `\n\n开发分支\n${workspace.developmentBranch}（${workspace.branchDisposition === 'reused' ? '复用已有分支' : '新建分支，待提交推送'}）\n\n提测目标分支\n${workspace.targetBranch}` : ''}\n\n来源仓库\n${workspace.sourceRepository ?? '未记录'}\n\n隔离方式\n独立 Git 仓库，未使用 git worktree；修改不会写入源仓库工作目录` : '该节点旧输出仅保存了任务输入，未找到属于本次节点的成功目录回执。' }
  }
  if (node.nodeId === 'prepare-generation') {
    const point = output?.startingPoint ?? context.startingPoint, requirement = output?.requirement ?? output
    return { overview: requirement?.expectedRemoteSha ? '从上一轮已推送的版本继续修改' : '从项目起始版本开始本轮修改',
      text: `处理内容\n核对已选项目、工作分支和本轮修改起点，确认远端状态允许继续。\n\n项目\n${point?.repository ?? '历史记录未提供项目名称'}\n\n工作分支\n${point?.workBranch ?? '未记录'}\n\n起点版本\n${requirement?.baseCommit ?? '未记录'}` }
  }
  if (['verify-candidate', 'prepare-commit'].includes(node.nodeId) && output?.verification) {
    const report = describeVerificationChecks(output.verification)
    if (node.nodeId === 'verify-candidate') {
      const text = report.map(check => `${check.title}\n${check.passed ? '通过' : '未通过'}\n${check.steps.map(step => `${step.title}：${step.passed ? '通过' : '未通过'}${step.limitation ? `；${step.limitation}` : ''}`).join('\n')}\n${check.limitation}`).join('\n\n')
      return { overview: report.map(check => `${check.title}${check.passed ? '通过' : '未通过'}`).join('；'), text,
        document: { name: '构建检查报告.md', content: `# 构建检查报告\n\n${text}` } }
    }
  }
  const sections = []
  const fileSummaries = []
  let overview = ''
  const summarizeFiles = (label, paths) => {
    const count = new Set(paths.filter(path => typeof path === 'string')).size
    if (count) fileSummaries.push(`${label} ${count} 个文件`)
  }
  const add = (label, value) => { if (typeof value === 'string' && value.trim()) sections.push(`${label}\n${value.trim()}`) }
  add('产出摘要', workflowResultText(output))
  if (typeof output === 'string') add('正文', output)
  add('正文', output?.markdown)
  add('任务要求', output?.request)
  for (const [label, values] of [['发现', output?.findings], ['限制与未确认事项', output?.limitations], ['执行范围', output?.constraints], ['相关文件', output?.paths], ['已有文件', output?.existingPaths], ['新建文件', output?.newPaths]]) {
    if (Array.isArray(values)) add(label, values.map(item => typeof item === 'string' ? item : item?.statement).filter(item => typeof item === 'string').join('\n'))
    if (Array.isArray(values) && ['相关文件', '已有文件', '新建文件'].includes(label)) summarizeFiles(({ '相关文件': '已选择', '已有文件': '选择已有', '新建文件': '计划新建' })[label], values)
  }
  if (Array.isArray(output?.materials)) add('材料正文', output.materials.map(item => item?.text).filter(item => typeof item === 'string').join('\n\n'))
  if (Array.isArray(output?.files)) {
    const label = node.nodeId === 'apply-changes' && output.status === 'succeeded' ? '已修改' : node.nodeId === 'read-files' ? '已读取' : '涉及'
    summarizeFiles(label, output.files.filter(item => item?.text !== null).map(item => item?.path))
    summarizeFiles('尚不存在', output.files.filter(item => item?.text === null).map(item => item?.path))
    add(`${label}文件`, output.files.filter(item => typeof item?.path === 'string').map(item => `${item.path}${item.text === null ? '（尚不存在）' : ''}`).join('\n'))
  }
  if (Array.isArray(output?.changes) || Array.isArray(output?.replacements)) summarizeFiles('修改方案涉及', [...(Array.isArray(output?.changes) ? output.changes : []), ...(Array.isArray(output?.replacements) ? output.replacements : [])].map(item => item?.path))
  if (Array.isArray(output?.changes)) for (const change of output.changes) {
    if (typeof change?.path !== 'string') continue
    add('文件变更', `${change.content === null ? '删除' : '写入'} ${change.path}${typeof change.content === 'string' ? `\n文件内容：\n${change.content}` : ''}`)
  }
  if (Array.isArray(output?.replacements)) for (const replacement of output.replacements) {
    if (typeof replacement?.path !== 'string' || typeof replacement.from !== 'string' || typeof replacement.to !== 'string') continue
    add('修改方案', `文件：${replacement.path}\n修改前：\n${replacement.from}\n修改后：\n${replacement.to}`)
  }
  if (Array.isArray(output?.verification?.checks)) add('检查结果', describeVerificationChecks(output.verification).map(item => `${item.title}：${item.passed ? '通过' : '未通过'}；${item.limitation}`).join('\n'))
  if (node.nodeId === 'index-files' && Array.isArray(output?.directories)) {
    const paths = output.directories.flatMap(item => typeof item?.directory === 'string' && Array.isArray(item.names) ? item.names.filter(name => typeof name === 'string').map(name => item.directory + name) : [])
    summarizeFiles('已索引', paths)
    if (Number.isSafeInteger(output.excludedCount) && output.excludedCount >= 0) fileSummaries.push(`排除 ${output.excludedCount} 个文件`)
    add('文件索引', paths.join('\n'))
  }
  if (['prepare-commit', 'commit', 'prepare-push', 'push', 'prepare-pr', 'create-pr', 'finalize'].includes(node.nodeId)) {
    const prepared = ['commit', 'push', 'create-pr'].includes(node.nodeId) ? output?.prepared : output
    const receipt = node.nodeId === 'finalize' ? output : output?.receipt
    const action = { 'prepare-commit': '待提交', commit: '已提交', 'prepare-push': '待推送', push: '已推送' }[node.nodeId]
    if (Array.isArray(prepared?.changedPaths)) {
      summarizeFiles(receipt && receipt.status !== 'succeeded' ? '涉及' : action || '涉及', prepared.changedPaths)
      add('变更文件', prepared.changedPaths.join('\n'))
    }
    add('提交说明', prepared?.message)
    add('分支', prepared?.ref)
    add('远端', prepared?.remote)
    add('提交版本', receipt?.commitId ?? prepared?.commitId)
    if (['prepare-commit', 'prepare-push'].includes(node.nodeId)) overview = node.nodeId === 'prepare-commit' ? '已生成提交计划' : '已生成推送计划'
    if (['commit', 'push'].includes(node.nodeId)) {
      overview = receipt?.status === 'succeeded' ? node.nodeId === 'commit' ? '已创建本地提交' : '已推送至远端' : '执行结果待核对'
      add('执行结果', overview)
    }
    if (['prepare-pr', 'create-pr', 'finalize'].includes(node.nodeId)) {
      add('PR 标题', prepared?.title)
      add('目标仓库', receipt?.repo ?? prepared?.repo)
      add('来源分支', receipt?.head ?? prepared?.head)
      add('目标分支', receipt?.base ?? prepared?.base)
      if (node.nodeId === 'prepare-pr') { overview = '已生成 PR 草稿'; add('PR 正文', prepared?.body) }
      else {
        overview = receipt?.status === 'succeeded' ? `${node.nodeId === 'finalize' ? '已回读' : '已创建'} PR${Number.isSafeInteger(receipt.number) ? ` #${receipt.number}` : ''}` : 'PR 结果待核对'
        add('PR 地址', receipt?.url)
        add('PR 状态', ({ open: '待合并', closed: '已关闭', merged: '已合并', OPEN: '待合并', CLOSED: '已关闭', MERGED: '已合并' })[receipt?.state] ?? receipt?.state)
      }
    }
  }
  let text = sections.join('\n\n'), document
  if (['inspect-and-propose', 'propose-changes', 'validate-proposal'].includes(node.nodeId)) {
    document = output?.document?.markdown ? { name: '修改方案.md', content: output.document.markdown }
      : { name: '修改记录.md', content: `# 已保存的修改记录\n\n历史节点没有保存方案说明文档。以下从实际补丁整理，不包含未记录的修改理由或验证计划。\n\n${text}` }
    text = document.content
    overview = output?.document?.markdown ? '修改方案.md' : '修改记录.md（原节点未保存方案说明）'
  }
  if (node.nodeId === 'prepare-pr' && typeof output?.body === 'string') document = { name: '合并请求.md', content: `# ${output.title ?? '合并请求'}\n\n${output.body}` }
  return { text, overview: [overview, ...fileSummaries].filter(Boolean).join('；'), ...(document ? { document } : {}) }
}

export const describeMessageTraceItem = (item) => {
  const input = item.input ?? {}, output = item.output ?? {}
  const text = value => typeof value === 'string' ? value : ''
  const rows = []
  const add = (label, value) => { if (text(value)) rows.push({ label, value }) }
  const actionNames = { create: '创建任务', research: '开展排查', answer: '回答问题', status: '查询进展', result: '查询结果', fact: '补充话题事实', no_action: '不采取动作', revise: '调整任务', reopen: '重新打开任务', pause: '暂停任务', cancel: '取消任务', resume: '继续任务', report: '调整报告', clarification: '答复澄清', approve: '处理审批' }
  let title = { split: '拆分事项', route: '关联话题', intent: '判断下一步', command: '接纳动作', agent: '查询与答复' }[item.kind] ?? (item.nodeId === 'material' ? '读取补充材料' : '处理记录')
  let conclusion = '尚未记录判断结论'
  if (item.kind === 'split' && Array.isArray(output.units)) {
    conclusion = `拆分为 ${output.units.length} 个事项`
    output.units.forEach((unit, i) => add(`事项 ${i + 1}`, unit.goalText ?? unit.text))
  } else if (item.kind === 'route' && output.kind === 'binding') {
    const candidate = input.candidates?.find(candidate => candidate.candidateId === output.candidateId)
    conclusion = { existing: '关联到已有话题或任务', new: '判断为新话题', conversation: '关联到当前群的任务集合' }[output.disposition] ?? '已记录关联判断'
    add('当前事项', input.goalText)
    add('关联对象', candidate?.title ?? candidate?.goal)
    if (!candidate && output.candidateId) add('关联对象', '历史记录未提供关联对象名称')
    if (Array.isArray(output.evidence)) output.evidence.forEach(value => add('关联依据', value))
  } else if (item.kind === 'intent') {
    const decisions = Array.isArray(output.decisions) ? output.decisions : [{ intent: output }]
    let count = 0
    for (const decision of decisions) {
      const intent = decision.intent ?? {}, unit = input.units?.find(unit => unit.unitId === decision.unitId)
      const sourceIndex = item.sourceMessages?.findIndex(message => message.runId === unit?.runId) ?? -1
      add(sourceIndex >= 0 ? `消息 ${sourceIndex + 1} 的事项` : '对应事项', unit?.input?.goalText ?? unit?.input?.source?.text)
      for (const action of intent.actions ?? []) {
        count++
        add(actionNames[action.intent] ?? '其他动作', action.arguments?.objective ?? action.arguments?.text ?? action.arguments?.answer ?? actionNames[action.intent] ?? '具体内容未记录')
      }
      if (intent.kind === 'needs_clarification') add('需要确认', intent.question ?? intent.reason)
      if (intent.kind === 'needs_context') add('需要材料', intent.reason)
      for (const constraint of intent.constraints ?? []) add('执行限制', typeof constraint === 'string' ? constraint : constraint.text)
    }
    conclusion = count ? `提出 ${count} 项处理决定` : '已记录判断，等待补充信息或后续处理'
  } else if (item.kind === 'agent') {
    conclusion = { running: '正在查询并组织答复', waiting_user: '等待必要补充', succeeded: '答复已生成，送达情况见发信箱', blocked: '查询受阻，尚未完成答复', failed: '本次查询未完成', cancelled: '本次查询已取消', cancelling: '正在停止查询', superseded: '已由新问题替代', interrupted: '等待恢复原会话', ready: '等待继续执行' }[item.status] ?? '等待开始查询'
    add('答复摘要', text(output.reply).slice(0, 240))
    add('待补充', input.question)
  } else if (item.kind === 'command') {
    const action = actionNames[input.kind] ?? '处理动作'
    conclusion = `${action} · ${({applied:'已接纳',running:'处理中',unknown:'结果待核对',failed:'失败'}[item.status] ?? '状态未记录')}`
    add('处理目标', input.args?.arguments?.objective ?? input.args?.arguments?.text)
    if (input.kind !== 'answer') add('处理结果', output.reply ?? output.summary)
    if (output.taskId) add('后续任务', '已记录任务身份；实际执行进展请查看任务看板')
  } else if (item.nodeId === 'material') {
    conclusion = output.complete === true ? '本页材料读取完成' : '材料完整性尚未确认'
    for (const fact of output.facts ?? []) add('原文依据', fact.quote)
  }
  if (output.kind === 'needs_clarification') { conclusion = '需要进一步确认'; add('待确认问题', output.question ?? output.reason) }
  if (output.kind === 'needs_context') { conclusion = '需要补充材料'; add('原因', output.reason) }
  if (['needs_relink', 'needs_resegmentation'].includes(output.kind)) { conclusion = output.kind === 'needs_relink' ? '需要重新关联话题' : '需要重新拆分事项'; add('原因', output.reason) }
  if (['failed', 'blocked'].includes(item.status)) conclusion = '本步未完成，请查看阻塞原因'
  return { title, conclusion, rows }
}

const sourceKey = (profile, groupId, messageId) => `dws:${executionDigest([profile, groupId, messageId])}`
// 这里仅核对被点名的接收者；语义动作已经由 I/IB 判定，执行批准仍走阶段批准。
export const isDirectedTaskRequest = (body, agentNames = []) => typeof body === 'string' && isNamedAgentDirection(body, agentNames)
const requireText = (value, code) => { if (typeof value !== 'string' || !value.trim()) throw executionError(code); return value }
const authorizationAnswer = value => ({ '同意': 'approved', '批准': 'approved', approved: 'approved',
  '拒绝': 'rejected', '不同意': 'rejected', rejected: 'rejected' })[String(value).trim()]
// 环境来自有效来源；模型填写的参数不能为缺失的交付目标制造授权。
const engineeringTarget = (target, texts, prior = {}) => {
  const body = texts.filter(Boolean).join('\n')
  const named = [...new Set(body.toLowerCase().match(/\buat[1-9]\b/g) ?? [])]
  const selected = named.length === 1 && !/uat[1-9]\s*[~～至到-]\s*(?:uat)?[1-9]/i.test(body) ? named[0] : undefined
  const result = { ...prior, ...target }
  delete result.uatEnvironment
  if (selected) result.uatEnvironment = selected
  else if (!named.length && target.uatEnvironment === undefined && prior.uatEnvironment) result.uatEnvironment = prior.uatEnvironment
  return result
}
// 目标摘要可用于展示；执行要求取已接纳事项的原文，避免模型附加的调查方法升级为交付前提。
const taskSourceRequest = ({ run, unit }) => requireText(unit.spans.map(span => run.body.slice(span.start, span.end)).join('\n'), 'WORKFLOW_SOURCE_REQUEST_REQUIRED')
const sourceRequestCriterion = '完成当前事项原文要求的交付'
const terminal = status => ['succeeded', 'failed', 'cancelled'].includes(status)
const catalogById = new Map(taskWorkflowCatalog.map(item => [item.id, item]))
const readOnlyCatalog = taskWorkflowCatalog.filter(item => item.mode === 'read-only').map(({ id, purpose }) => ({ id, purpose }))
const generalCatalog = taskWorkflowCatalog.filter(item => item.mode === 'general').map(({ id, purpose }) => ({ id, purpose }))
const externalLabels = Object.freeze(Object.fromEntries(taskWorkflowCatalog.filter(item => item.mode === 'external').map(item => [item.id, item.purpose])))

export function createSourceDossierCapability(sourceRead) {
  const capability = {
    id: 'organize-topic-sources', effectClass: 'read', description: '将已授权消息逐字整理为带来源键的 Markdown 摘录，不推断未给出的事实',
    identity: 'organize-topic-sources-v1',
    authorize: ({ input, scope }) => sourceRead.authorize({ input, scope }),
    async execute({ input }) {
      const fresh = await sourceRead.execute({ input })
      const markdown = fresh.sources.map(source => `### ${source.sourceKey}\n\n${source.text.split('\n')
        .map(line => `> ${line}`).join('\n')}`).join('\n\n')
      return { markdown, sourceKeys: fresh.sources.map(source => source.sourceKey) }
    },
    async verify({ input, scope, output }) {
      if (!await capability.authorize({ input, scope })) return { passed: false }
      const fresh = await capability.execute({ input })
      return { passed: executionDigest(fresh) === executionDigest(output),
        outputDigest: executionDigest(fresh), sourceRefs: fresh.sourceKeys }
    },
  }
  return capability
}

/** 仅沿当前 Task 冻结的消息来源和该消息明确引用读取平台文本。 */
export function createTaskMessageResourceCapability({ store, readMessage, readResource }) {
  if (typeof readMessage !== 'function' || typeof readResource !== 'function') return null
  const identify = async (input, scope) => {
    if (!input || !scope || typeof input.sourceKey !== 'string' || !Array.isArray(scope.sourceKeys)
      || !scope.sourceKeys.includes(input.sourceKey) || !['mediaId', 'fileId', 'dingtalkDoc'].includes(input.type)
      || typeof input.resourceId !== 'string' || !input.resourceId) return null
    const source = await store.query({ kind: 'task.source', sourceKey: input.sourceKey })
    if (!source || source.status === 'superseded' || source.conversationId !== scope.conversationId
      || source.sourceVersion !== scope.sourceVersions?.[input.sourceKey]
      || typeof source.context?.sourceMessageId !== 'string') return null
    const ref = input.type === 'dingtalkDoc'
      ? normalizeResourceRefs([], source.body).find(item => item.type === input.type && item.resourceId === input.resourceId)
      : source.context.attachments?.find(item => item.source?.type === input.type
        && item.source.resourceId === input.resourceId)?.source
    return ref ? { source, ref } : null
  }
  const load = async (input, scope) => {
    const bound = await identify(input, scope)
    if (!bound) throw executionError('GENERAL_RESOURCE_SCOPE_DENIED')
    const { source, ref } = bound
    const remote = await readMessage(scope.conversationId, source.context.sourceMessageId)
    if (!remote || remote.messageId !== source.context.sourceMessageId
      || (remote.conversationId ?? remote.groupId) !== scope.conversationId
      || (remote.text !== source.body && !sameDwsFileProjection({ sourceKind: 'dingtalk', text: source.body }, remote)) || remote.complete === false || remote.hasMore === true
      || remote.failures?.length
      || !(input.type === 'dingtalkDoc' ? normalizeResourceRefs([], remote.text) : remote.resourceRefs ?? [])
        .some(item => item.type === input.type && item.resourceId === input.resourceId))
      throw executionError('GENERAL_RESOURCE_SOURCE_CHANGED')
    const value = await readResource(scope.conversationId, remote.messageId, ref)
    if (!value || typeof value.text !== 'string' || value.complete === false || value.hasMore === true
      || value.coverage?.complete === false || value.projection?.complete === false
      || value.failures?.length || value.mediaUnavailable?.length) throw executionError('GENERAL_RESOURCE_READ_INCOMPLETE')
    if (!await identify(input, scope)) throw executionError('GENERAL_RESOURCE_SOURCE_CHANGED')
    const markdown = `### ${input.sourceKey} / ${remote.messageId} / ${input.type}:${input.resourceId}\n\n${value.text.split('\n').map(line => `> ${line}`).join('\n')}`
    const metadata = Object.fromEntries(['nodeId', 'name', 'extension', 'sizeBytes', 'modifyTime', 'sourceSha256']
      .filter(key => value.metadata?.[key] !== undefined).map(key => [key, value.metadata[key]]))
    return { markdown, sourceKey: input.sourceKey, messageId: remote.messageId,
      resource: { type: input.type, resourceId: input.resourceId }, contentDigest: executionDigest(value.text),
      ...(Object.keys(metadata).length ? { metadata } : {}) }
  }
  return { id: 'read-task-message-resource', effectClass: 'read', identity: 'read-task-message-resource-v2',
    parameters: { type: 'object', properties: { sourceKey: { type: 'string' }, type: { type: 'string', enum: ['mediaId', 'fileId', 'dingtalkDoc'] }, resourceId: { type: 'string' } }, required: ['sourceKey', 'type', 'resourceId'], additionalProperties: false },
    description: '只读当前业务任务已冻结消息明确引用的钉钉文档、文本或工作簿附件，完整保留正文结构与元数据；返回带精确来源和内容摘要的 Markdown。钉钉文档读取失败须按实际错误判断，不将标题或登录页视为正文。',
    authorize: async ({ input, scope }) => Boolean(await identify(input, scope)),
    execute: ({ input, scope }) => load(input, scope),
    async verify({ input, scope, output }) {
      const fresh = await load(input, scope)
      return { passed: executionDigest(fresh) === executionDigest(output), outputDigest: executionDigest(fresh),
        sourceRefs: [input.sourceKey, `${input.sourceKey}:${fresh.messageId}:${input.type}:${input.resourceId}:${fresh.contentDigest}`] }
    },
  }
}

export async function verifyDefaultGeneralCompletion({ request, acceptanceCriteria, scope, evidence, report }) {
  const isPureCompilation = text => /^(整理|汇总|摘录)/u.test(text)
    && /消息|材料|原文|内容|记录/u.test(text)
    && !/排查|查明|原因|修复|部署|发布|创建|更新|删除|发送|审批|数据库|代码|文件写入/u.test(text)
  const pureCompilation = isPureCompilation(request) && acceptanceCriteria.every(isPureCompilation)
  const dossier = evidence.find(item => item.capabilityId === 'organize-topic-sources'
    && report.evidenceIds.includes(item.evidenceId) && item.verification.passed === true)
  if (!pureCompilation || !dossier || !scope.sourceKeys.every(key => dossier.output.sourceKeys.includes(key))
    || report.summary !== dossier.output.markdown || report.limitations.length)
    return { status: 'unverified', resultVerified: false, criteria: [] }
  return { status: 'satisfied', resultVerified: true,
    criteria: acceptanceCriteria.map(criterion => ({ criterion, passed: true,
      evidenceIds: [dossier.evidenceId] })) }
}

export function rankMessageCandidates(cards, goalText, recentSourceKey = null) {
  const words = [...new Set((goalText ?? '').toLowerCase().match(/[a-z0-9_-]+|[\u4e00-\u9fff]{2}/g) ?? [])]
  const score = card => card.explicitReferenceMatches.length * 10000
    + (recentSourceKey && card.topicId && card.sourceRefs.includes(recentSourceKey) ? 5000 : 0)
    + words.filter(word => card.goal?.toLowerCase().includes(word)).length
  return cards.sort((a, b) => score(b) - score(a) || String(b.relevantTime).localeCompare(String(a.relevantTime)))
}

function createExternalRegistry(external, selected) {
  const configured = !!external && (!!external.dataChangeAdapter || !!external.uatMergeAdapter || !!external.mainMergeAdapter || !!external.releaseAdapters && Object.keys(external.releaseAdapters).length > 0)
  if (!configured) return { workflows: [], records: new Map(), byId: new Map() }
  if (typeof external.operationAdapter?.execute !== 'function' || typeof external.operationAdapter?.reconcile !== 'function'
    || typeof external.authorizeExternal !== 'function' || typeof external.prepareRequirement !== 'function') throw executionError('EXTERNAL_WORKFLOW_GATE_REQUIRED')
  const workflows = [], records = new Map(), byId = new Map()
  const add = (workflow, adapter, modelConfig = null) => {
    if (catalogById.get(workflow.id)?.mode !== 'external' || byId.has(workflow.id)) throw executionError('EXTERNAL_WORKFLOW_CATALOG_MISMATCH')
    workflow = { ...workflow, ownerContract: workflow.id === 'task-data-change-approval-resume' || workflow.id === 'task-data-change' && ['4', '5', '6', '7'].includes(workflow.version) ? createScopedNativeDataChangeCompletionPolicy(adapter) : externalWorkflowOwnerContract }
    const definition = defineExecutionWorkflow(workflow)
    const config = { ownerContractVersion: workflow.ownerContract.version, kind: 'external', registryVersion: '1', adapterId: adapter.id, adapterVersion: adapter.version,
      rulesDigest: adapter.rulesDigest, ...(modelConfig ? { modelConfig } : {}) }
    workflows.push(workflow); records.set(workflow.id, { workflowId: workflow.id, definitionVersion: workflow.version, digest: definition.digest, config })
    byId.set(workflow.id, { workflow, adapter })
  }
  if (external.dataChangeAdapter) add(createDataChangeTaskWorkflow({ ...selected, adapter: external.dataChangeAdapter }), external.dataChangeAdapter, selected)
  if (external.dataChangeAdapter?.pluginApproval) add(createDataChangeApprovalResumeWorkflow({ ...selected, adapter: external.dataChangeAdapter }), external.dataChangeAdapter, selected)
  if (external.uatMergeAdapter) add(createUatPrMergeTaskWorkflow({ adapter: external.uatMergeAdapter }), external.uatMergeAdapter)
  if (external.mainMergeAdapter) add(createMainPrMergeTaskWorkflow({ adapter: external.mainMergeAdapter }), external.mainMergeAdapter)
  for (const kind of releaseWorkflowKinds) if (external.releaseAdapters?.[kind]) {
    const adapter = external.releaseAdapters[kind]
    add(createReleaseTaskWorkflow({ kind, adapter }), adapter)
  }
  if (external.releaseAdapters && Object.keys(external.releaseAdapters).some(kind => !releaseWorkflowKinds.includes(kind))) throw executionError('EXTERNAL_WORKFLOW_KIND_UNKNOWN')
  return { workflows, records, byId }
}

export async function openWorkflowService({ ctx, config, legacy, coordinatorSessions, readMessage, readResource, notifications, fileTransport, engineeringGhCommand, external, generalCapabilities = [], generalCompletionCheck, generalCompletionIdentity, execution: suppliedExecution, taskOwnerSessions, messageAgentSessions }) {
  if (!Array.isArray(config.groupIds) || !config.groupIds.length || new Set(config.groupIds).size !== config.groupIds.length) throw executionError('WORKFLOW_GROUPS_REQUIRED')
  if (generalCompletionCheck && (!generalCompletionIdentity || typeof generalCompletionIdentity !== 'string')) throw executionError('GENERAL_COMPLETION_IDENTITY_REQUIRED')
  const groups = new Set(config.groupIds)
  const ownerActorId = requireText(config.ownerActorId, 'WORKFLOW_OWNER_REQUIRED')
  const modelConfig = () => {
    const value = legacy.getAgentConfig()
    return { provider: value.provider, model: value.model, ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}) }
  }
  const getTaskDirectories = (taskId, options) => generalArtifacts.current?.getTaskDirectories?.(taskId, options) ?? null
  async function taskSessionWorkspace(purpose, binding) {
    const root = legacy.getAgentConfig().workspaceDir
    const directories = binding?.taskId ? await getTaskDirectories(binding.taskId) : null
    if (!directories) return sessionWorkspace(root, purpose)
    return checkedTaskDirectory(taskFilePath(root, directories.logicalTaskId, 'work', binding.taskId,
      purpose, binding.sessionId), true)
  }
  const engineering = createEngineeringRegistry({ repositories: config.repositories ?? [], ownerActorId, modelConfig, author: config.gitAuthor, ghCommand: engineeringGhCommand, getTaskDirectories })
  const selectedExternal = createExternalRegistry(external, modelConfig())
  const externalWorkflows = [...selectedExternal.byId.keys()].map(id => ({ id, purpose: externalLabels[id],
    ...(external?.availableTargets ? { targetIds: external.availableTargets.filter(item => item.workflowId === id).map(item => item.targetId) } : {}) }))
  const unavailableWorkflows = Object.entries(externalLabels).filter(([id]) => !selectedExternal.byId.has(id)).map(([, label]) => label)
  const generalStore = { current: suppliedExecution?.store ?? null }
  const generalArtifacts = { current: suppliedExecution?.artifacts ?? null }
  const sourceRead = {
    id: 'read-topic-sources', effectClass: 'read', description: '只读核对当前话题已授权的消息原文', identity: 'read-topic-sources-v1',
    parameters: { type: 'object', properties: { sourceKeys: { type: 'array', items: { type: 'string' } } }, required: ['sourceKeys'], additionalProperties: false },
    async authorize({ input, scope }) {
      if (!Array.isArray(input.sourceKeys) || !input.sourceKeys.length
        || !Array.isArray(scope.sourceKeys) || input.sourceKeys.some(key => !scope.sourceKeys.includes(key))) return false
      const sources = await Promise.all(input.sourceKeys.map(sourceKey => generalStore.current.query({ kind: 'task.source', sourceKey })))
      return sources.every(source => source?.conversationId === scope.conversationId && source.status !== 'superseded'
        && (!scope.sourceVersions || source.sourceVersion === scope.sourceVersions[source.sourceKey]))
    },
    async execute({ input }) {
      const sources = await Promise.all(input.sourceKeys.map(sourceKey => generalStore.current.query({ kind: 'task.source', sourceKey })))
      const projected = sources.map(source => ({ sourceKey: source.sourceKey, sourceVersion: source.sourceVersion, text: source.body }))
      return { sources: projected }
    },
    async verify({ input, scope, output }) {
      if (await sourceRead.authorize({ input, scope }) !== true) return { passed: false }
      const fresh = await sourceRead.execute({ input })
      return { passed: executionDigest(fresh) === executionDigest(output), outputDigest: executionDigest(fresh),
        sourceRefs: fresh.sources.map(source => source.sourceKey) }
    },
  }
  const predecessorRead = {
    id: 'read-predecessor-artifact', effectClass: 'read', description: '只读核对本任务前一阶段的已验收产物',
    identity: 'read-predecessor-artifact-v1',
    parameters: { type: 'object', properties: { outputRef: { type: 'string' } }, required: ['outputRef'], additionalProperties: false },
    async authorize({ input, scope }) {
      return typeof input.outputRef === 'string' && input.outputRef === scope.predecessorOutputRef
    },
    async execute({ input }) { return { outputRef: input.outputRef,
      value: await generalArtifacts.current.read(input.outputRef) } },
    async verify({ input, scope, output }) {
      if (!await predecessorRead.authorize({ input, scope })) return { passed: false }
      const fresh = await predecessorRead.execute({ input })
      return { passed: executionDigest(fresh) === executionDigest(output),
        outputDigest: executionDigest(fresh), sourceRefs: [input.outputRef] }
    },
  }
  const sourceDossier = createSourceDossierCapability(sourceRead)
  const messageResourceRead = createTaskMessageResourceCapability({ store: { query: (...args) => generalStore.current.query(...args) }, readMessage, readResource })
  const readableFiles = config.generalFileRead?.readablePaths ?? []
  const fileRead = config.generalFileRead ? createGeneralFileReadCapability(config.generalFileRead) : null
  const markdownFileAdapter = config.taskOutputDirectory || config.artifactDirectory
    ? createTaskMarkdownFileAdapter({ root: config.taskOutputDirectory ?? config.artifactDirectory, getTaskDirectories }) : null
  const markdownWrite = markdownFileAdapter ? createGeneralMarkdownWriteCapability({ fileAdapter: markdownFileAdapter }) : null
  const effectiveArtifactDirectory = config.artifactDirectory ?? (fileTransport ? suppliedExecution?.artifacts?.root : undefined)
  const managedFiles = effectiveArtifactDirectory ? createTaskArtifactFiles({ root: join(effectiveArtifactDirectory, 'task-files'), getTaskDirectories }) : null
  const artifactWriter = managedFiles ? createTaskArtifactWriteAdapter({ files: managedFiles }) : null
  const artifactImporter = managedFiles && config.generalFileRead ? createTaskArtifactImportAdapter({ files: managedFiles,
    sourceRoot: config.generalFileRead.root, readablePaths: config.generalFileRead.readablePaths }) : null
  const artifactAdapter = artifactWriter ? {
    execute: prepared => (prepared.kind === 'import' ? artifactImporter : artifactWriter)?.execute(prepared),
    reconcile: prepared => (prepared.kind === 'import' ? artifactImporter : artifactWriter)?.reconcile(prepared),
  } : null
  const artifactWrite = artifactWriter ? createGeneralArtifactWriteCapability({ fileAdapter: artifactWriter }) : null
  const artifactImport = artifactImporter ? createGeneralArtifactImportCapability({ fileAdapter: artifactImporter }) : null
  const messageFileAdapter = managedFiles && fileTransport ? createTaskGroupFileAdapter({ files: managedFiles,
    createAdapter: fileTransport.createAdapter, profile: config.profile,
    canDisclose: async ({ prepared }) => config.groupIds.includes(prepared.groupId) && prepared.profile === config.profile }) : null
  const fileWorkflow = messageFileAdapter ? createTaskGroupFileDeliveryWorkflow({ files: managedFiles, messageAdapter: messageFileAdapter }) : null
  const legacyFileWorkflow = messageFileAdapter ? createLegacyTaskGroupFileDeliveryWorkflow({ files: managedFiles, messageAdapter: messageFileAdapter }) : null
  const capabilities = [sourceRead, predecessorRead, sourceDossier, ...(messageResourceRead ? [messageResourceRead] : []), ...(fileRead ? [fileRead] : []), ...(markdownWrite ? [markdownWrite] : []), ...(artifactWrite ? [artifactWrite] : []), ...(artifactImport ? [artifactImport] : []), ...generalCapabilities]
  const queryConfig = config.directQueries ?? { resources: [], databases: [] }
  if (Object.hasOwn(queryConfig, 'grants')) throw executionError('QUERY_CONFIG_MEMBER_GRANTS_REMOVED')
  if (queryConfig.permissions && (Object.keys(queryConfig.permissions).some(key => !['resourceIds', 'databaseIds', 'statusIds'].includes(key))
    || ['resourceIds', 'databaseIds', 'statusIds'].some(key => !Array.isArray(queryConfig.permissions[key])
      || queryConfig.permissions[key].some(id => typeof id !== 'string' || !id)))) throw executionError('QUERY_CONFIG_PERMISSIONS_INVALID')
  const queryCapabilities = [...capabilities.filter(item => item.effectClass === 'read' && item.parameters),
    ...(queryConfig.resources?.length ? [createAgentResourceReadCapability({ resources: queryConfig.resources })] : []),
    ...(queryConfig.statusResources?.length ? [createAgentStatusReadCapability({ resources: queryConfig.statusResources })] : []),
    ...(queryConfig.databases?.length ? [createAgentDatabaseReadCapability({ resources: queryConfig.databases,
      connectDatabase: createRegisteredPostgresConnector({ credentialsPath: queryConfig.credentialsPath }) })] : [])]
  const queryToolNames = queryCapabilities.map(item => item.id)
  const queryCapabilityIdentity = executionDigest(queryCapabilities.map(item => ({ id: item.id, identity: item.identity })))
  function queryScope(base) {
    const permissions = queryConfig.permissions ?? {}
    return { ...base, queryCapabilityIdentity, resourceIds: [...new Set(permissions.resourceIds ?? [])],
      databaseIds: [...new Set(permissions.databaseIds ?? [])],
      statusIds: [...new Set(permissions.statusIds ?? [])] }
  }
  async function resolveQueryScope({ binding, input }) {
    const scope = input.scope
    if (!scope?.actorId || !scope.conversationId) throw executionError('QUERY_SCOPE_DENIED')
    if (binding.kind === 'message-unit') {
      const current = await generalStore.current.query({ kind: 'message.run', runId: binding.runId })
      if (current.run.actorId !== scope.actorId || current.run.conversationId !== scope.conversationId
        || current.run.status === 'superseded') throw executionError('QUERY_SCOPE_DENIED')
    } else {
      const origin = await generalStore.current.query({ kind: 'task.origin', taskId: binding.taskId })
      if (origin?.run.actorId !== scope.actorId || origin.run.conversationId !== scope.conversationId) throw executionError('QUERY_SCOPE_DENIED')
      if (binding.kind === 'task-owner') {
        const owner = await generalStore.current.query({ kind: 'task.owner', taskId: binding.taskId })
        const plan = await controller.taskPlan(binding.taskId)
        if (owner.status !== 'running' || owner.sessionId !== binding.sessionId || owner.turnId !== binding.turnId
          || owner.leaseEpoch !== binding.leaseEpoch || owner.ownerEpoch !== binding.ownerEpoch
          || plan.task.controlState !== 'active' || plan.task.requirementRevision !== binding.requirementRevision)
          throw executionError('QUERY_SCOPE_DENIED')
      }
    }
    if (executionDigest(queryScope(scope)) !== executionDigest(scope)) throw executionError('QUERY_SCOPE_CHANGED')
    return scope
  }
  async function resolveTaskQueryInput({ taskId, requirement }) {
    const origin = await generalStore.current.query({ kind: 'task.origin', taskId })
    if (!origin || !requirement?.scope) throw executionError('QUERY_SCOPE_DENIED')
    const readableMessageResources = await taskMessageResources(requirement, origin)
    const scope = queryScope({ ...requirement.scope, actorId: origin.run.actorId,
      sourceKeys: [...new Set([...requirement.scope.sourceKeys, ...readableMessageResources.map(item => item.sourceKey)])],
      sourceVersions: { ...requirement.scope.sourceVersions, ...Object.fromEntries(readableMessageResources.map(item => [item.sourceKey, item.sourceVersion])) } })
    return { scope, context: { target: requirement.target, readableMessageResources, ...queryCatalog(scope) } }
  }
  const queryTools = artifacts => createAgentQueryTools({ capabilities: queryCapabilities, resolveScope: resolveQueryScope, artifacts })
  function queryCatalog(scope) {
    return {
      databaseGuidance: '需要生产数据库结构或数据事实时，使用context.databases中environment=production的登记只读连接，通过query_readonly_database查询；先用tables定位，再用columns核验结构。metadataSchemas是结构查询授权范围，数据select仍限tables内的列。QUERY_SCOPE_DENIED不等于数据库不可用，不得改走主库或将可自主查询的结构当作缺用户材料。',
      resources: (queryConfig.resources ?? []).filter(item => scope.resourceIds.includes(item.id))
        .map(item => ({ id: item.id, description: item.description ?? '', version: item.commit ?? null,
          paths: [...item.paths] })),
      databases: (queryConfig.databases ?? []).filter(item => scope.databaseIds.includes(item.id))
        .map(item => ({ id: item.id, description: item.description ?? '', environment: item.environment ?? null,
          connectionId: item.connectionId, metadataSchemas: item.metadataSchemas ?? [], tables: item.tables })),
      statusResources: (queryConfig.statusResources ?? []).filter(item => scope.statusIds.includes(item.id))
        .map(item => ({ id: item.id, description: item.description ?? '' })),
    }
  }
  const stepCapabilities = capabilities.filter(item => item.effectClass === 'file.write')
  const acceptanceModel = modelConfig()
  const domainAcceptanceCheck = createDomainAcceptanceCheck({ llm: ctx.llm, modelConfig: acceptanceModel })
  const ownerAcceptanceInputs = new WeakSet()
  const completionCheck = generalCompletionCheck ?? (async (input, context) => {
    const deterministic = await verifyDefaultGeneralCompletion(input)
    if (deterministic.status === 'satisfied') return deterministic
    const acceptanceInput = ownerAcceptanceInputs.has(input) ? input : { ...input,
      evidence: input.evidence.map(({ hostExecution, ...evidence }) => evidence) }
    const assessment = await domainAcceptanceCheck(acceptanceInput, context)
    // 调用故障是系统错误，不能折叠成业务证据不足并要求人工补证明。
    if (assessment.reason && ownerAcceptanceInputs.has(input)) throw executionError(assessment.reason)
    if (assessment.status !== 'satisfied' && ownerAcceptanceInputs.has(input)) {
      const taskIds = [...new Set(input.evidence.map(item => item.hostExecution?.taskId ?? item.hostQuery?.taskId).filter(Boolean))]
      if (taskIds.length !== 1) throw executionError('DOMAIN_ACCEPTANCE_INPUT_INVALID')
      const diagnostic = await artifacts.put({ kind: 'domain-acceptance-rejection', version: 1,
        taskId: taskIds[0], assessment, request: input.request, acceptanceItems: input.acceptanceItems,
        evidence: input.evidence, report: input.report }, { taskId: taskIds[0], reference: input.evidence[0].evidenceId })
      const failed = assessment.criteria.filter(item => !item.passed)
        .map(item => `${item.criterion}${item.reason ? `（${item.reason}）` : ''}`).join('；').slice(0, 1600)
      throw Object.assign(executionError('TASK_OWNER_COMPLETION_UNVERIFIED',
        `领域验收实际判定：${assessment.status}${failed ? `；未满足：${failed}` : ''}。原始验收结果与证据：${diagnostic.ref}`),
      { diagnosticRef: diagnostic.ref })
    }
    return assessment
  })
  const completionIdentity = generalCompletionIdentity ?? executionDigest({ policy: 'domain-items-v1', model: acceptanceModel,
    native: createDomainAcceptanceCheck.toString(), deterministic: verifyDefaultGeneralCompletion.toString() })
  const stepWorkflow = stepCapabilities.length ? createGeneralCapabilityStepWorkflow({ capabilities: stepCapabilities, completionCheck,
    completionIdentity }) : null
  const legacyStepWorkflows = ['4', '5'].map(workflowVersion => stepCapabilities.length
    ? createGeneralCapabilityStepWorkflow({ capabilities: stepCapabilities, completionCheck,
      completionIdentity: generalCompletionIdentity ?? 'task-result-verification-v3', workflowVersion }) : null).filter(Boolean)
  const visibleDefinitions = new Map([stepWorkflow, fileWorkflow, ...selectedExternal.workflows]
    .filter(Boolean).map(workflow => [workflow.id, workflow]))
  const execution = suppliedExecution ?? await openExecutionRuntime({
    ctx, getWorkspaceDir: ({ binding }) => taskSessionWorkspace('execution', binding),
    taskWorkspaceRoot: legacy.getAgentConfig().workspaceDir,
    dbPath: config.dbPath, instanceId: config.instanceId, artifactDirectory: config.artifactDirectory,
    readTools: ['engineering_repo_inspect', ...queryToolNames], repositoryInspect: engineering.repositoryInspect,
    tools: ({ artifacts }) => queryTools(artifacts),
    deliveryOptions: { ...engineering.deliveryOptions,
      ...(markdownFileAdapter ? { fileAdapter: markdownFileAdapter } : {}),
      ...(artifactAdapter ? { artifactAdapter } : {}),
      ...(messageFileAdapter ? { messageAdapter: messageFileAdapter } : {}),
      authorizeMessage: async ({ binding, prepared }) => {
        const plan = await generalStore.current.query({ kind: 'task.plan', taskId: binding.taskId })
        const stage = plan?.stages.find(item => item.runId === binding.runId && item.workflowId === 'task-group-file-delivery')
        if (!stage || stage.status !== 'running' || plan.task.controlState !== 'active'
          || plan.task.planRequirementRevision !== plan.task.requirementRevision) return false
        const requirement = await generalArtifacts.current.read(plan.task.requirementRef)
        const input = await generalArtifacts.current.read(stage.requirementRef)
        if (!requirement.fileDelivery || prepared.groupId !== requirement.scope.conversationId
          || prepared.requirementRevision !== plan.task.requirementRevision || prepared.profile !== config.profile
          || !input.files.some(file => file.artifactId === prepared.artifact.artifactId)
          || !requirement.fileDelivery.files.some(file => file.role === prepared.artifact.role && file.fileName === prepared.artifact.fileName)) return false
        return { principalId: requirement.scope.actorId, authorizationRef: plan.task.requirementRef }
      },
      authorizeFile: async ({ binding, action, prepared }) => {
        if (!['file', 'artifact'].includes(action) || !binding?.taskId || prepared?.taskId !== binding.taskId
          || prepared.runId !== binding.runId || prepared.nodeRunId !== binding.nodeRunId
          || prepared.generation !== binding.generation || prepared.requirementDigest !== binding.requirementDigest) return false
        const plan = await generalStore.current.query({ kind: 'task.plan', taskId: binding.taskId })
        const origin = await generalStore.current.query({ kind: 'task.origin', taskId: binding.taskId })
        const stage = plan?.stages.find(item => item.runId === binding.runId && item.workflowId === 'task-general-capability')
        const run = stage ? await generalStore.current.query({ kind: 'run', runId: binding.runId }) : null
        if (!plan || !origin || !stage || !run || stage.status !== 'running' || run.run.status !== 'running'
          || run.run.requirementRef !== stage.requirementRef || plan.task.controlState !== 'active') return false
        const current = await generalArtifacts.current.read(plan.task.requirementRef)
        const step = await generalArtifacts.current.read(stage.requirementRef)
        const { predecessorOutputRef: _predecessorOutputRef, requirementRevision: _revision, ...stepScope } = step.scope ?? {}
        if (executionDigest(current.scope) !== executionDigest(stepScope)) return false
        if (action === 'artifact') {
          if (prepared.requirementRevision !== plan.task.requirementRevision || !current.fileDelivery
            || !current.scope.artifactFiles?.some(file => file.role === prepared.role && file.fileName === prepared.fileName)) return false
        } else if (!current.scope?.writeMarkdown || !step.scope?.writeMarkdown) return false
        return { principalId: origin.run.actorId, authorizationRef: plan.task.requirementRef }
      },
      externalAdapter: {
        execute: prepared => prepared.workflowKind === 'local-acceptance' ? engineering.deliveryOptions.externalAdapter.execute(prepared) : external?.operationAdapter?.execute(prepared),
        reconcile: prepared => prepared.workflowKind === 'local-acceptance' ? engineering.deliveryOptions.externalAdapter.reconcile(prepared) : external?.operationAdapter?.reconcile(prepared),
        closeReadonlyApproval: prepared => external?.operationAdapter?.closeReadonlyApproval(prepared),
      },
      authorizeExternal: request => request.prepared.workflowKind === 'local-acceptance'
        ? engineering.deliveryOptions.authorizeExternal(request) : external?.authorizeExternal?.(request),
    },
    workflows: async (store, artifacts) => {
      generalStore.current = store
      generalArtifacts.current = artifacts
      const selected = modelConfig()
      const workflows = [stepWorkflow, fileWorkflow].filter(Boolean)
      const definitions = new Map(workflows.map(workflow => [workflow.id, defineExecutionWorkflow(workflow)]))
      const prior = await store.query({ kind: 'workflow.list' })
      const activeDefinitions = new Set(), requiredDefinitions = new Set(), pendingStages = []
      let beforeSequenceId
      for (;;) {
        const page = await store.query({ kind: 'run.list', limit: 200,
          ...(beforeSequenceId ? { beforeSequenceId } : {}) })
        for (const run of page) if (!terminal(run.status))
          activeDefinitions.add(`${run.workflowId}:${run.workflowDigest}`)
        if (page.length < 200) break
        beforeSequenceId = page.at(-1).sequenceId
      }
      beforeSequenceId = undefined
      for (;;) {
        const page = await store.query({ kind: 'task.plans.pending', limit: 200,
          ...(beforeSequenceId ? { beforeSequenceId } : {}) })
        for (const task of page) {
          const plan = await store.query({ kind: 'task.plan', taskId: task.taskId })
          for (const stage of plan.stages) if (stage.status !== 'invalidated') {
            if (stage.status !== 'succeeded') {
              pendingStages.push(stage)
              if (stage.workflowDigest) activeDefinitions.add(`${stage.workflowId}:${stage.workflowDigest}`)
            }
            if (stage.workflowDigest) requiredDefinitions.add(`${stage.workflowId}:${stage.workflowDigest}`)
          }
        }
        if (page.length < 200) break
        beforeSequenceId = page.at(-1).sequenceId
      }
      // 成功前序仍是交接和 Owner 验收的输入，不能只恢复正在运行的定义。
      beforeSequenceId = undefined
      for (;;) {
        const page = await store.query({ kind: 'task.owners.list', limit: 100,
          ...(beforeSequenceId ? { beforeSequenceId } : {}) })
        for (const owner of page) {
          if (owner.decision?.action === 'complete' && owner.applicationStatus === 'applied' && owner.status === 'idle') continue
          const plan = await store.query({ kind: 'task.plan', taskId: owner.taskId })
          // 已取消任务只保留历史，不会再交接或验收；暂停任务仍需要冻结定义以便恢复。
          if (plan?.task.controlState === 'cancelled') continue
          for (const stage of plan?.stages ?? []) if (stage.status !== 'invalidated' && stage.workflowDigest)
            requiredDefinitions.add(`${stage.workflowId}:${stage.workflowDigest}`)
        }
        if (page.length < 100) break
        beforeSequenceId = page.at(-1).sequenceId
      }
      assertRetiredWorkflowsDrained({ records: prior, activeDefinitions, pendingStages,
        currentDefinitions: [...workflows, ...legacyStepWorkflows, ...(legacyFileWorkflow ? [legacyFileWorkflow] : [])] })
      const engineeringWorkflows = await engineering.restore(store, artifacts)
      const historicalWorkflows = []
      for (const record of prior.filter(record => record.config?.kind !== 'engineering'
        && record.config?.kind !== 'external'
        && (activeDefinitions.has(`${record.workflowId}:${record.digest}`) || requiredDefinitions.has(`${record.workflowId}:${record.digest}`)))) {
        const candidates = [stepWorkflow, fileWorkflow, legacyFileWorkflow,
          ...legacyStepWorkflows].filter(Boolean)
          .filter(item => item.id === record.workflowId && item.version === record.definitionVersion)
        if (!candidates.length) throw executionError('WORKFLOW_VERSION_UNAVAILABLE')
        const previous = candidates.find(item => {
          const definition = defineExecutionWorkflow(item)
          return [definition.digest, ...definition.legacyDigests].includes(record.digest)
        })
        if (!previous) throw executionError('WORKFLOW_DEFINITION_DRIFT')
        if (![definitions.get(previous.id)?.digest, ...(definitions.get(previous.id)?.legacyDigests ?? [])].includes(defineExecutionWorkflow(previous).digest)) historicalWorkflows.push(previous)
      }
      for (const record of prior.filter(item => item.config?.kind === 'external'
        && (activeDefinitions.has(`${item.workflowId}:${item.digest}`) || requiredDefinitions.has(`${item.workflowId}:${item.digest}`)))) {
        const route = selectedExternal.byId.get(record.workflowId), saved = record.config
        const adapter = (record.workflowId === 'task-data-change' && record.definitionVersion === '3' && route?.adapter?.legacyAdapter ? [route.adapter.legacyAdapter] : [route?.adapter, route?.adapter?.nativeAdapter, route?.adapter?.legacyAdapter]).find(item => item && saved.adapterId === item.id
          && saved.adapterVersion === item.version && saved.rulesDigest === item.rulesDigest)
        if (!adapter || saved.registryVersion !== '1') throw executionError('EXTERNAL_WORKFLOW_DEFINITION_DRIFT')
        let previous = record.workflowId === 'task-data-change-approval-resume'
          ? createDataChangeApprovalResumeWorkflow({ ...saved.modelConfig, adapter })
          : record.workflowId === 'task-data-change'
          ? (record.definitionVersion === '3' ? createLegacyDataChangeTaskWorkflow : record.definitionVersion === '4' ? createDataChangeTaskWorkflowV4 : record.definitionVersion === '5' ? createDataChangeTaskWorkflowV5 : record.definitionVersion === '6' ? createDataChangeTaskWorkflowV6 : createDataChangeTaskWorkflow)({ ...saved.modelConfig, adapter })
          : record.workflowId === 'task-uat-pr-merge'
            ? (record.definitionVersion === '1' ? createLegacyUatPrMergeTaskWorkflow : record.definitionVersion === '2' ? createUatPrMergeTaskWorkflowV2 : createUatPrMergeTaskWorkflow)({ adapter })
          : record.workflowId === 'task-main-pr-merge' ? createMainPrMergeTaskWorkflow({ adapter })
          : (record.definitionVersion === '1' ? createLegacyReleaseTaskWorkflow : createReleaseTaskWorkflow)({ kind: record.workflowId.slice(5), adapter })
        if (saved.ownerContractVersion === '1') previous = { ...previous, ownerContract: legacyExternalWorkflowOwnerContract }
        else if (saved.ownerContractVersion === '2') previous = { ...previous, ownerContract: externalWorkflowOwnerContract }
        else if (saved.ownerContractVersion === '3' && ['task-data-change', 'task-data-change-approval-resume'].includes(record.workflowId)) previous = { ...previous, ownerContract: nativeDataChangeOwnerContract }
        else if (saved.ownerContractVersion === '4' && ['task-data-change', 'task-data-change-approval-resume'].includes(record.workflowId)) previous = { ...previous, ownerContract: createNativeDataChangeCompletionPolicy(adapter) }
        else if (saved.ownerContractVersion === '5' && ['task-data-change', 'task-data-change-approval-resume'].includes(record.workflowId)) previous = { ...previous, ownerContract: createScopedNativeDataChangeCompletionPolicy(adapter) }
        else if (saved.ownerContractVersion !== undefined) throw executionError('EXTERNAL_WORKFLOW_DEFINITION_DRIFT')
        if (previous.version !== record.definitionVersion || ![defineExecutionWorkflow(previous).digest, ...defineExecutionWorkflow(previous).legacyDigests].includes(record.digest))
          throw executionError('EXTERNAL_WORKFLOW_DEFINITION_DRIFT')
        if (record.digest !== selectedExternal.records.get(record.workflowId).digest) historicalWorkflows.push(previous)
      }
      for (const workflow of workflows) {
        const definition = definitions.get(workflow.id)
        const existing = prior.find(record => record.digest === definition.digest)
        if (existing) continue
        await store.command({ id: `workflow:${definition.digest}`, kind: 'workflow.register', args: {
          workflowId: workflow.id, definitionVersion: workflow.version,
          config: selected, digest: definition.digest,
        } })
      }
      for (const record of selectedExternal.records.values()) await store.command({ id: `workflow:${record.digest}`, kind: 'workflow.register', args: record })
      return { workflows: [...workflows, ...engineeringWorkflows, ...selectedExternal.workflows], historicalWorkflows }
    },
  })
  let closed = false, resolveMaterials
  const { store, controller, artifacts } = execution
  let taskOwner
  external?.bindStore?.(store)
  external?.bindExecution?.({ store, controller, artifacts })
  generalStore.current = store
  generalArtifacts.current = artifacts
  if (suppliedExecution && typeof controller.registerWorkflow === 'function') {
    for (const workflow of await engineering.restore(store, artifacts)) controller.registerWorkflow(workflow)
    if (stepWorkflow) controller.registerWorkflow(stepWorkflow)
    if (fileWorkflow) controller.registerWorkflow(fileWorkflow)
    for (const workflow of selectedExternal.workflows) controller.registerWorkflow(workflow)
  }
  const notifier = createWorkflowNotifications({ store, controller, artifacts, adapter: notifications,
    groupResponsibility: groupId => legacy.getGroup?.(groupId)?.responsibility ?? '' })
  const messageAgent = createMessageAgentController({ ctx, store, artifacts, getWorkspaceDir: () => sessionWorkspace(legacy.getAgentConfig().workspaceDir, 'answer'), tools: queryTools(artifacts), modelConfig,
    ownerActorId, ...(messageAgentSessions ? { sessionRunner: messageAgentSessions } : {}),
    onCommandSettled: runId => messages.commandSettled(runId),
    selectTools: input => queryCapabilities.filter(capability => !capability.available || capability.available(input.scope)).map(capability => capability.id),
    async prepareInput(action, info) {
      const args = messageAnswerArguments.parse(action.arguments)
      const current = await store.query({ kind: 'message.run', runId: info.run.runId })
      const ownCommand = current.commands.find(command => command.commandId === info.commandId)
      const dependencies = (ownCommand?.dependsOn ?? []).map(commandId => {
        const command = current.commands.find(item => item.commandId === commandId)
        if (command?.status !== 'applied') throw executionError('MESSAGE_DEPENDENCY_PENDING')
        return { id: `command-result:${commandId}`, text: JSON.stringify(command.result) }
      })
      const topic = action.binding?.topicId ? await fullTopic(action.binding.topicId) : null
      const topicSourceKeys = topic ? await store.query({ kind: 'message.topic.sources', topicId: topic.topicId }) : []
      const attachmentSources = []
      for (const frozen of info.run.snapshot?.history ?? []) {
        if (frozen.actorId !== info.run.actorId || !frozen.attachments?.length) continue
        const current = await store.query({ kind: 'task.source', sourceKey: frozen.sourceKey })
        if (!current || current.status === 'superseded' || current.conversationId !== info.run.conversationId
          || current.actorId !== frozen.actorId || current.sourceVersion !== frozen.sourceVersion || current.body !== frozen.text) continue
        const attachments = frozen.attachments.filter(attachment => attachment.source?.type && attachment.source?.resourceId
          && current.context?.sourceMessageId === attachment.sourceMessageId
          && current.context.attachments?.some(item => item.source?.type === attachment.source.type
            && item.source.resourceId === attachment.source.resourceId && item.sourceMessageId === attachment.sourceMessageId))
        if (attachments.length) attachmentSources.push({ source: current, attachments })
      }
      const sourceKeys = [...new Set([info.run.sourceKey, ...topicSourceKeys, ...attachmentSources.map(item => item.source.sourceKey)])]
      const sources = await Promise.all(sourceKeys.map(sourceKey => store.query({ kind: 'task.source', sourceKey })))
      const accessible = sources.filter(item => item && item.conversationId === info.run.conversationId && item.status !== 'superseded')
      const materialRefs = [...new Set(action.requiredExecutionMaterials ?? [])]
      const resolved = materialRefs.length ? await resolveMaterials({ run: info.run, unit: info.unit,
        needs: materialRefs.map(resourceRef => ({ resourceRef })) }) : { ready: true, data: { resources: [] } }
      if (!resolved.ready) throw executionError('WORKFLOW_REQUIRED_MATERIAL_NOT_READY')
      const materials = [...resolved.data.resources.map(item => ({ id: item.resourceRef, text: item.text })), ...dependencies]
      const scope = queryScope({ actorId: info.run.actorId, conversationId: info.run.conversationId,
        sourceKeys: accessible.map(item => item.sourceKey), sourceVersions: Object.fromEntries(accessible.map(item => [item.sourceKey, item.sourceVersion])) })
      return { request: args.objective, source: { text: info.run.body, sourceKey: info.run.sourceKey, actorId: info.run.actorId },
        constraints: action.constraints ?? [], materials, sourceRefs: [...scope.sourceKeys, ...materials.map(item => item.id)], scope,
        context: { topic, history: info.run.snapshot?.history ?? [],
          readableMessageResources: attachmentSources.flatMap(({ source, attachments }) => attachments.map(attachment => ({
            sourceKey: source.sourceKey, sourceVersion: source.sourceVersion, type: attachment.source.type,
            resourceId: attachment.source.resourceId, name: attachment.name ?? '' }))), ...queryCatalog(scope) } }
    },
    async verifyEvidence({ refs, entry, binding, input }) {
      const scope = await resolveQueryScope({ binding, input })
      await verifyAgentEvidence({ artifacts, refs, binding, scope,
        allowedBindings: (entry.bindingHistory ?? []).map(item => ({ kind: 'message-unit', runId: entry.runId, unitId: entry.unitId,
          sessionId: entry.sessionId, ...item })) })
      return true
    },
  })
  async function authorizedNotificationOperation(notification, authorizationRef, type, identity, reason) {
    if (authorizationRef?.startsWith('host-web:')) {
      if (identity?.channel !== 'web' || !config.webActorId || identity.actorId !== config.webActorId
        || authorizationRef !== `host-web:${encodeURIComponent(identity.actorId)}` || !(reason === 'explicit_user' || type === 'restore' && reason === 'correction')
        || !notification || !groups.has(notification.payload?.conversationId)) throw executionError('WORKFLOW_NOTIFICATION_AUTHORIZATION_REQUIRED')
      return
    }
    if (!notification || !groups.has(notification.payload?.conversationId) || !config.webActorId) throw executionError('WORKFLOW_NOTIFICATION_FORBIDDEN')
    const source = await store.query({ kind: 'task.source', sourceKey: requireText(authorizationRef, 'WORKFLOW_NOTIFICATION_AUTHORIZATION_REQUIRED') })
    const action = type === 'recall' ? '撤回通知' : '补发通知'
    const authorizedTargets = [notification.id, notification.evidence?.messageId].filter(Boolean)
    if (!source || source.actorId !== ownerActorId || source.conversationId !== notification.payload.conversationId
      || source.status === 'superseded'
      || !source.body.split(/\r?\n/u).some(line => authorizedTargets.some(id => line.trim() === `${action} ${id}`)))
      throw executionError('WORKFLOW_NOTIFICATION_AUTHORIZATION_REQUIRED')
    return source
  }
  async function prepareWorkflowNotificationOperation(input, identity) {
    input = { ...input, authorizationRef: input.authorizationRef ?? `host-web:${encodeURIComponent(identity?.actorId ?? '')}` }
    const notice = await store.query({ kind: 'message.notification', notificationId: input.notificationId })
    await authorizedNotificationOperation(notice, input.authorizationRef, input.type, identity, input.reason)
    return (await store.command({ id: `notification-operation:${input.operationId}:prepare`, kind: 'message.notification.operation.prepare', args: input })).result.operation
  }
  async function executeWorkflowNotificationOperation(input, identity) {
    input = { ...input, authorizationRef: input.authorizationRef ?? `host-web:${encodeURIComponent(identity?.actorId ?? '')}` }
    const operation = await store.query({ kind: 'message.notificationOperation', operationId: input.operationId })
    if (!operation) throw executionError('MESSAGE_NOTIFICATION_OPERATION_NOT_FOUND')
    const notice = await store.query({ kind: 'message.notification', notificationId: operation.snapshot.notificationId })
    await authorizedNotificationOperation(notice, input.authorizationRef, operation.snapshot.type, identity, operation.snapshot.reason)
    if (input.authorizationRef !== operation.snapshot.authorizationRef) throw executionError('WORKFLOW_NOTIFICATION_AUTHORIZATION_REQUIRED')
    if (input.expectedFactDigest !== operation.snapshot.expectedFactDigest) throw executionError('MESSAGE_NOTIFICATION_OPERATION_STALE')
    const adapter = { ...notifications,
      async readbackRecall(args) {
        const observation = await notifications.readbackRecall(args)
        if (!observation || observation.recallStatus !== 'SUCCESS' || observation.messageId !== args.messageId) return undefined
        const evidence = await artifacts.put(observation)
        return { ...observation, evidenceRef: evidence.ref }
      },
      async readback(args) {
        const observation = await notifications.readback(args)
        if (!observation?.messageId) return undefined
        const evidence = await artifacts.put(observation)
        return { ...observation, evidenceRef: evidence.ref }
      },
    }
    return executeNotificationOperation({ store, adapter, ...input })
  }
  async function reconcileWorkflowNotificationOperation(input, identity) {
    input = { ...input, authorizationRef: input.authorizationRef ?? `host-web:${encodeURIComponent(identity?.actorId ?? '')}` }
    const operation = await store.query({ kind: 'message.notificationOperation', operationId: input.operationId })
    if (!operation || !['acknowledged', 'unknown', 'in_flight'].includes(operation.status)) throw executionError('MESSAGE_NOTIFICATION_OPERATION_RECONCILE_REQUIRED')
    const notice = await store.query({ kind: 'message.notification', notificationId: operation.snapshot.notificationId })
    await authorizedNotificationOperation(notice, input.authorizationRef, operation.snapshot.type, identity, operation.snapshot.reason)
    if (input.authorizationRef !== operation.snapshot.authorizationRef) throw executionError('WORKFLOW_NOTIFICATION_AUTHORIZATION_REQUIRED')
    const snapshot = operation.snapshot
    const observed = snapshot.type === 'recall'
      ? await notifications.readbackRecall({ conversationId: snapshot.conversationId, messageId: snapshot.messageId, operationId: operation.id, ack: operation.ack })
      : await notifications.readback({ id: operation.id, payload: { conversationId: snapshot.conversationId, sourceMessageId: snapshot.sourceMessageId, text: snapshot.body }, ack: operation.ack })
    if (!observed?.messageId || snapshot.type === 'recall' && (observed.messageId !== snapshot.messageId || observed.recallStatus !== 'SUCCESS'))
      return operation
    if (!await notifications.canDisclose(notice)) throw executionError('WORKFLOW_NOTIFICATION_FORBIDDEN')
    const evidence = await artifacts.put(observed)
    return (await store.command({ id: `notification-operation:${operation.id}:reconcile`, kind: 'message.notification.operation.reconcile', args: {
      operationId: operation.id, messageId: observed.messageId, evidenceRef: evidence.ref,
      ...(snapshot.type === 'recall' ? { recallStatus: observed.recallStatus } : {}),
    } })).result.operation
  }
  const legacyGroup = id => legacy.getGroup?.(id)
  const agentNames = () => legacy.getAgentConfig?.().agentNames ?? []
  const investigationConfirmation = request => request.reason === 'COMPLETED_INVESTIGATION_REPORTED_AGAIN'
    || (request.nodeId === 'I' && request.kind === 'needs_clarification'
      && /此前对应任务仅授权排查分析/u.test(String(request.reason)))
  const admissionActionDigest = action => executionDigest({ intent: action.intent, arguments: action.arguments,
    constraints: action.constraints ?? [], requiredExecutionMaterials: action.requiredExecutionMaterials ?? [] })
  const taskAdmission = async (run, binding, action) => {
    const result = (allowed, reasonCode, sourceRefs = []) => ({ allowed, reasonCode, sourceRefs })
    if (run.channel === 'web') return result(run.actorId === config.webActorId && run.externalMessaging === false, 'WEB_IDENTITY')
    if (isDirectedToOtherParticipants(run.body, agentNames())) return result(false, 'ADDRESSED_TO_OTHERS')
    if (run.actorId === ownerActorId) return result(true, 'OWNER', [{ sourceKey: run.sourceKey, sourceVersion: run.sourceVersion }])
    const state = await store.query({ kind: 'message.run', runId: run.runId })
    const grants = state.requests.filter(request => request.kind === 'needs_authorization' && request.status === 'resolved'
      && request.revision === state.run.revision && request.resolvedByActorId === ownerActorId
      && request.authorization?.sourceKey === run.sourceKey && request.authorization.sourceVersion === run.sourceVersion
      && request.authorization.actorId === run.actorId && request.authorization.conversationId === run.conversationId
      && Array.isArray(request.authorization.actions) && executionDigest(request.authorization.actions) === request.authorization.actionDigest
      && (!binding?.topicId || request.authorization.topicId === binding.topicId)
      && (!action || request.authorization.actions.some(candidate => admissionActionDigest(candidate) === admissionActionDigest(action))))
    for (const grant of grants) {
      const topic = await fullTopic(grant.authorization.topicId)
      const dispatched = action?.commandId ? (await store.query({ kind: 'message.run', runId: run.runId })).commands.find(command => command.id === action.commandId) : null
      const boundCommand = dispatched?.args.authorizationRequestId === grant.id && dispatched.topicId === grant.authorization.topicId
        && dispatched.topicInputRevision === topic?.inputRevision
      if (topic?.conversationId === run.conversationId && (topic.inputRevision === grant.authorization.topicInputRevision || boundCommand))
        return { ...result(grant.answer === 'approved', grant.answer === 'approved' ? 'OWNER_APPROVED' : 'OWNER_REJECTED',
          [{ sourceKey: grant.authorization.sourceKey, sourceVersion: grant.authorization.sourceVersion, requestId: grant.id }]),
          authorizationRequestId: grant.id }
    }
    if (!/任务准入/u.test(legacyGroup(run.conversationId)?.responsibility ?? '')) return result(false, 'GROUP_ADMISSION_NOT_CONFIGURED')
    if (isDirectedTaskRequest(run.body, agentNames())) return result(true, 'DIRECTED_REQUEST', [{ sourceKey: run.sourceKey, sourceVersion: run.sourceVersion }])
    const referenceKeys = new Map([...(run.context?.quoteRefs ?? []).map(ref => [ref.sourceKey, ref.sourceVersion]),
      ...(binding?.explicitReferenceMatches ?? []).map(key => [key, undefined])])
    // 只有已经关联的事项来源可续接；同群相邻消息不进入授权证据集合。
    if (binding?.topicId) {
      const topic = await fullTopic(binding.topicId)
      if (topic?.conversationId === run.conversationId) for (const fact of topic.facts ?? [])
        for (const ref of fact.sourceRefs ?? []) referenceKeys.set(ref.sourceKey, ref.sourceVersion)
    }
    for (const [key, version] of referenceKeys) {
      const source = await store.query({ kind: 'task.source', sourceKey: key })
      if (source && source.actorId === run.actorId && source.conversationId === run.conversationId
        && source.status !== 'superseded' && (version === undefined || source.sourceVersion === version)
        && isDirectedTaskRequest(source.body, agentNames())) return result(true, 'RELATED_DIRECTED_REQUEST', [{ sourceKey: key, sourceVersion: source.sourceVersion }])
    }
    const confirmed = state.requests.some(request => investigationConfirmation(request)
      && request.status === 'resolved' && /^(?:是|需要|请|好|可以|同意|继续|修复)/u.test(String(request.answer).trim()))
    return result(confirmed, confirmed ? 'INVESTIGATION_CONFIRMED' : 'DIRECTED_REQUEST_NOT_ESTABLISHED')
  }
  const mayCreate = async (run, _workflowId, binding, action) => (await taskAdmission(run, binding, action)).allowed

  async function taskAccess(taskId, actorId, conversationId) {
    const origin = await store.query({ kind: 'task.origin', taskId })
    if (!origin || origin.run.conversationId !== conversationId || ![origin.run.actorId, ownerActorId].includes(actorId)) throw executionError('WORKFLOW_TASK_FORBIDDEN')
    return origin
  }
  async function verifyUatSourceRefs(action, run, binding, relatedSourceRuns = []) {
    const refs = action.arguments.uatSourceRefs
    if (refs === undefined) return []
    const invalid = () => { throw executionError('TASK_UAT_SOURCE_INVALID', '环境选择证据须为同话题当前完整原文，末条是当前有权确认者；不能截断、跨话题或覆盖当前明确环境。') }
    if (action.intent !== 'revise' || !binding.taskId || !binding.topicId || !uatBranchFor(action.arguments.uatEnvironment)
      || refs.length < 2 || new Set(refs.map(ref => ref.sourceKey)).size !== refs.length) invalid()
    const origin = await taskAccess(binding.taskId, run.actorId, run.conversationId)
    if (origin.command?.topicId && origin.command.topicId !== binding.topicId) invalid()
    const last = refs.at(-1)
    if (last.sourceKey !== run.sourceKey || last.sourceVersion !== run.sourceVersion || last.sourceQuote !== run.body) invalid()
    const explicit = [...new Set(run.body.toLowerCase().match(/\buat[1-9]\b/g) ?? [])]
    if (explicit.length && (explicit.length !== 1 || explicit[0] !== action.arguments.uatEnvironment)) invalid()
    const sources = []
    for (const ref of refs) {
      const source = await store.query({ kind: 'task.source', sourceKey: ref.sourceKey })
      if (!source || source.status === 'superseded' || source.conversationId !== run.conversationId
        || source.sourceVersion !== ref.sourceVersion || source.body !== ref.sourceQuote) invalid()
      if (source.sourceKey !== run.sourceKey) {
        const topics = await store.query({ kind: 'message.topic.source', sourceKey: source.sourceKey })
        if (!topics.some(topic => topic.topicId === binding.topicId)
          && !relatedSourceRuns.some(other => other.sourceKey === source.sourceKey && other.sourceVersion === source.sourceVersion)) invalid()
      }
      sources.push({ sourceKey: source.sourceKey, sourceVersion: source.sourceVersion, actorId: source.actorId, text: source.body })
    }
    return sources
  }
  const readableTaskOrigin = origin => !!origin && (origin.channel === 'web'
    ? origin.run.actorId === config.webActorId && origin.run.reportChannel === 'web' && origin.run.externalMessaging === false
    : groups.has(origin.run.conversationId))
  const approvals = createWorkflowApprovalService({ store, controller, authorizeTask: async ({ taskId, actorId, conversationId, channel, requestId, quoteMessageId }) => {
    const origin = await store.query({ kind: 'task.origin', taskId })
    if (!readableTaskOrigin(origin)) return false
    if (channel === 'web') return !!config.webActorId && actorId === config.webActorId
    if (quoteMessageId) {
      const notice = await store.query({ kind: 'approval.notice', requestId })
      return notice?.delivery?.conversationId === conversationId && notice.delivery.messageId === quoteMessageId
        && notice.approverActorId === actorId
    }
    return conversationId === origin.run.conversationId
  } })
  async function isApprovalRequest(requestId) {
    try { await approvals.get(requestId); return true }
    catch (error) { if (error.code === 'approval_not_found') return false; throw error }
  }
  async function decideApproval(input, identity) {
    if (identity?.channel === 'web' && (!config.webActorId || identity.actorId !== config.webActorId)) throw executionError('WORKFLOW_WEB_ACTOR_FORBIDDEN')
    const item = await approvals.get(input.requestId)
    const prepared = item.effect.definition?.payload
    if (prepared?.workflowKind === 'production-release' && prepared.operation === 'approval-gate'
      || prepared?.workflowKind === 'data-change' && prepared.stage === 'approval-gate') {
      if (identity?.channel !== 'web' && !identity?.quoteMessageId) throw executionError('WORKFLOW_APPROVAL_PRIVATE_REPLY_REQUIRED')
    }
    if (identity?.channel === 'im' && identity.quoteMessageId) {
      const notice = await store.query({ kind: 'approval.notice', requestId: input.requestId })
      if (!notice?.delivery || item.approval.decision === 'pending' && notice.status !== 'waiting-reply'
        || notice.effectId !== item.effect.effectId
        || notice.delivery.conversationId !== identity.conversationId || notice.delivery.messageId !== identity.quoteMessageId
        || notice.approverActorId !== identity.actorId) throw executionError('WORKFLOW_APPROVAL_FORBIDDEN')
    }
    const result = await approvals.decide(input, identity)
    const { applied: _applied, ...decision } = result
    const effect = item.effect
    if (effect?.runId) {
      const state = await controller.state(effect.runId)
      if (await store.query({ kind: 'task.owner', taskId: state.run.taskId }))
        await taskOwner.event({ taskId: state.run.taskId,
          eventKey: `approval:${executionDigest(decision)}`,
          eventType: 'approval.resolved', payload: { requestId: input.requestId, decision } })
    }
    return result
  }
  async function prepareApprovalNotice({ requestId, recipientUserId, text }) {
    const item = await approvals.get(requestId)
    const origin = await store.query({ kind: 'task.origin', taskId: item.run.taskId })
    if (!readableTaskOrigin(origin) || !config.approvalRecipientUserId || recipientUserId !== config.approvalRecipientUserId
      || !item.approval.approverIds.includes(ownerActorId)) throw executionError('WORKFLOW_APPROVAL_FORBIDDEN')
    const request = await getApprovalRequest(requestId)
    if (!request || text !== request.text) throw executionError('WORKFLOW_APPROVAL_NOTICE_TEXT_INVALID')
    const args = { requestId, effectId: item.effect.effectId, recipientUserId, approverActorId: ownerActorId, text }
    const receipt = await store.command({ id: `approval-notice-prepare:${executionDigest(args)}`, kind: 'approval.notice.prepare', args })
    return { ...receipt.result, dispatchEligible: receipt.dispatchEligible, notice: await store.query({ kind: 'approval.notice', requestId }) }
  }
  async function approvalNoticeCommand(operation, args) {
    const item = await approvals.get(args.requestId)
    const prior = operation === 'send' ? await store.query({ kind: 'approval.notice', requestId: args.requestId }) : null
    const plan = operation === 'send' ? await controller.taskPlan(item.run.taskId) : null
    const commandIdentity = operation === 'send'
      ? [args, prior?.unsentProof ?? null, plan?.task.controlRevision ?? null, item.run.revision] : args
    const receipt = await store.command({ id: `approval-notice-${operation}:${executionDigest(commandIdentity)}`, kind: `approval.notice.${operation}`, args })
    return { ...receipt.result, dispatchEligible: receipt.dispatchEligible, notice: await store.query({ kind: 'approval.notice', requestId: args.requestId }) }
  }
  async function reissueApprovalNotice(input, identity) {
    if (identity?.channel !== 'web' || !config.webActorId || identity.actorId !== config.webActorId) throw executionError('WORKFLOW_WEB_ACTOR_FORBIDDEN')
    if (Object.keys(input).some(key => !['requestId','noticeDigest','proof'].includes(key))) throw executionError('WORKFLOW_APPROVAL_NOTICE_RECOVERY_INVALID')
    const maintenance = await store.query({ kind: 'runtime.maintenance' })
    if (!maintenance.active || !maintenance.drained) throw executionError('WORKFLOW_APPROVAL_NOTICE_MAINTENANCE_REQUIRED')
    const request = await getApprovalRequest(input.requestId)
    if (!request || request.decision !== 'pending') throw executionError('WORKFLOW_APPROVAL_FORBIDDEN')
    return approvalNoticeCommand('unsent', input)
  }
  async function getApprovalRequest(requestId) {
    return (await listApprovalRequests()).find(item => item.requestId === requestId) ?? null
  }
  async function listApprovalRequests() {
    const approvals = await store.query({ kind: 'approval.list', limit: 200 })
    const rows = await Promise.all(approvals.map(async approval => {
      const effect = await store.query({ kind: 'effect.get', effectId: approval.effectId })
      const prepared = effect.definition?.payload
      const productionRelease = prepared?.workflowKind === 'production-release' && prepared.operation === 'approval-gate'
      const dataChange = prepared?.workflowKind === 'data-change' && prepared.stage === 'approval-gate'
      const uatBuild = prepared?.workflowKind === 'uat-deployment' && prepared.operation === 'build'
        || prepared?.workflowKind === 'uat-rebuild' && prepared.operation === 'rebuild'
      if (!productionRelease && !dataChange && !uatBuild) return null
      const state = await controller.state(effect.runId)
      const origin = await store.query({ kind: 'task.origin', taskId: state.run.taskId })
      if (!readableTaskOrigin(origin)) return null
      const plan = await controller.taskPlan(state.run.taskId)
      const goal = await artifacts.read(plan.task.requirementRef)
      const target = uatBuild ? (await artifacts.read(state.run.requirementRef)).target : null
      const uatAction = uatBuild ? `${prepared.operation === 'rebuild' ? '重新构建' : '构建提测'} UAT 目标 ${target.runbookId}（${target.repository} / ${target.service}），提交 ${prepared.expected.commitSha}` : null
      const notification = await store.query({ kind: 'approval.notice', requestId: approval.requestId })
      const objective = goal.objective ?? origin.command.args.arguments?.objective ?? (uatBuild ? 'UAT 提测' : productionRelease ? '生产发布' : '数据变更')
      const deletion = dataChange && simpleDroppedColumnDefinition(prepared.intent.applySql) !== null
      const details = dataChange ? [
        `**目标数据库：** ${prepared.target.database}`,
        `**Bytebase 工单：** ${prepared.intent.issueId}`,
        ...(deletion ? [`**删除影响：** ${columnDeletionImpact}`] : []),
      ] : uatBuild ? [
        `**操作：** ${prepared.operation === 'rebuild' ? '重新构建' : '构建提测'}`,
        `**环境：** ${target.environment}`,
        `**仓库 / 服务：** ${target.repository} / ${target.service}`,
        `**提交：** ${prepared.expected.commitSha}`,
      ] : [
        `**发布目标：** ${prepared.resourceKey}`,
        `**提交：** ${prepared.expected.commitSha}`,
        `**标签：** ${prepared.expected.tag}`,
      ]
      return { kind: 'workflow-approval', requestId: approval.requestId, taskId: state.run.taskId, groupId: origin.run.conversationId,
        approverIds: approval.approverIds, notification,
        objective,
        text: [`**待审批：${dataChange ? '数据库变更' : uatBuild ? 'UAT 提测' : '生产发布'}**`,
          `**事项：** ${objective}`, ...details,
          '**回复方式：** 请引用本消息回复“批准”，或“拒绝：原因”。',
          `审批编号：${approval.requestId.slice(-12)}`].join('\n\n'),
        requestedAction: uatBuild ? `审批 ${uatAction}` : productionRelease
          ? `审批生产发布 ${prepared.resourceKey}，提交 ${prepared.expected.commitSha}，标签 ${prepared.expected.tag}`
          : `审批数据变更工单 ${prepared.intent.issueId}，目标 ${prepared.target.database}，SQL 摘要 ${prepared.intent.sheetSha256}`,
        waitingReason: uatBuild ? '等待批准本次 UAT 构建提测' : productionRelease ? '等待真人批准后创建生产 Tag' : '等待插件人工审批通过后执行 Bytebase 工单',
        risk: uatBuild ? 'UAT 流水线可能更新对应环境服务并发送配置的提测通知' : productionRelease ? '生产发布会更新运行服务' : deletion ? columnDeletionImpact : '生产数据库将执行工单中的 SQL',
        evidence: uatBuild ? [prepared.resourceKey, target.environment, target.runbookId, target.repository, target.service, prepared.expected.commitSha] : productionRelease
          ? [prepared.resourceKey, prepared.expected.commitSha, prepared.expected.tag]
          : [prepared.resourceKey, prepared.intent.issueId, prepared.target.database, prepared.intent.applySql ?? prepared.intent.sheetSha256,
            prepared.intent.sheetSha256, prepared.intent.packageDigest], attemptedActions: [],
        createdAt: approval.createdAt, status: approval.decision === 'pending'
          ? notification?.delivery?.messageId ? 'waiting-reply' : notification?.status === 'unknown' ? 'sending-unknown' : 'pending-send'
          : 'answered',
        decision: approval.decision, decidedAt: approval.updatedAt, decisionSource: approval.decisionSource, reply: approval.comment ?? '',
        taskState: state.run.status }
    }))
    return rows.filter(Boolean)
  }
  async function currentTask(taskId, selector) {
    const runs = await store.query({ kind: 'run.list', taskId, limit: 200 })
    const selected = selector && selector !== 'current' ? runs.find(run => run.runId === selector) : runs[0]
    if (!selected) throw executionError('WORKFLOW_TASK_NOT_FOUND')
    return controller.state(selected.runId)
  }
  async function readAcceptedTaskCompletion(taskId, plan) {
    const owner = await store.query({ kind: 'task.owner', taskId })
    if (owner?.decision?.action !== 'complete' || owner.applicationStatus !== 'applied') return null
    const saved = await store.query({ kind: 'task.owner.delivery-manifest', taskId })
    if (!saved || saved.requirementRevision !== plan?.task.requirementRevision || saved.planRevision !== plan.task.planRevision) return null
    const manifest = await artifacts.read(saved.ref)
    const items = await store.query({ kind: 'task.owner.acceptance', taskId })
    if (manifest.kind !== 'task-delivery-manifest' || manifest.taskId !== taskId
      || manifest.requirementRevision !== plan.task.requirementRevision || manifest.planRevision !== plan.task.planRevision
      || manifest.complete !== true || manifest.businessValidation?.status !== 'accepted'
      || items.some(item => !manifest.businessValidation.items?.some(verified => verified.itemId === item.itemId && verified.criterion === item.criterion))) return null
    return { owner, manifest, ref: saved.ref }
  }
  async function taskFacts(origin, selector) {
    const taskId = origin.command.args.taskId
    if (await store.query({ kind: 'task.deleted', taskId })) throw executionError('WORKFLOW_TASK_NOT_FOUND')
    const factVersion = await store.query({ kind: 'message.task.version', taskId })
    const plan = await controller.taskPlan(taskId)
    const runs = await store.query({ kind: 'run.list', taskId, limit: 200 })
    const state = runs.length ? await currentTask(taskId, selector) : null
    const last = state?.nodes.filter(node => node.outputRef).at(-1)
    const outputStage = plan?.stages.findLast(stage => stage.outputRef)
    const outputRef = outputStage?.outputRef ?? last?.outputRef ?? null
    const output = outputRef ? await artifacts.read(outputRef) : null
    const completion = selector && selector !== 'current' ? null : await readAcceptedTaskCompletion(taskId, plan)
    const owner = selector && selector !== 'current' ? null : await store.query({ kind: 'task.owner', taskId })
    const waiting = ['wait', 'block'].includes(owner?.decision?.action) && owner.applicationStatus === 'applied'
      && owner.requirementRevision === plan?.task.requirementRevision && owner.eventWatermark === owner.processedWatermark
      && (!plan?.task.planRevision || plan.task.planRequirementRevision === plan.task.requirementRevision)
    const result = completion ? { outputRef: completion.ref, stageId: null, summary: completion.owner.decision.summary,
      evidenceIds: completion.owner.decision.evidenceRefs, limitations: [] } : waiting ? { outputRef: null, stageId: null,
      summary: owner.decision.summary, evidenceIds: owner.decision.evidenceRefs, limitations: [owner.decision.condition.missing],
      condition: owner.decision.condition } : output && typeof output === 'object' ? {
      outputRef, stageId: outputStage?.stageId ?? null,
      summary: typeof output.summary === 'string' ? output.summary : null,
      evidenceIds: Array.isArray(output.evidenceIds) ? output.evidenceIds : [],
      limitations: Array.isArray(output.limitations) ? output.limitations : [],
    } : outputRef ? { outputRef } : null
    const blockedStage = plan?.stages.find(stage => stage.status === 'blocked')
    const objectiveAssessment = completion ? { status: 'satisfied', evidenceRefs: [completion.ref, ...completion.owner.decision.evidenceRefs],
      reason: '本需求版本的任务最终验收已通过' } : waiting ? { status: 'insufficient_evidence',
      evidenceRefs: owner.decision.evidenceRefs, reason: owner.decision.condition.missing } : plan?.task.planRequirementRevision !== plan?.task.requirementRevision
      ? { status: 'unassessed', evidenceRefs: [], reason: '新增任务要求尚未由当前计划覆盖' }
      : state?.run.status === 'succeeded' && state.run.workflowId === 'task-general'
      && output?.outcome === 'completed' && result?.evidenceIds?.length
      ? { status: 'satisfied', evidenceRefs: [outputRef, ...result.evidenceIds], reason: '通用任务的 Host 完成核验已通过' }
      : blockedStage
        ? { status: 'insufficient_evidence', evidenceRefs: [blockedStage.outputRef].filter(Boolean), reason: blockedStage.unavailableReason ?? '后续阶段受阻' }
        : { status: 'unassessed', evidenceRefs: [outputRef].filter(Boolean), reason: '执行状态和结果已记录；尚无逐项业务目标核验' }
    const notifications = []
    let afterSequenceId = 0
    for (;;) {
      const page = await store.query({ kind: 'message.notifications', runId: origin.run.runId,
        states: ['prepared', 'sending', 'acknowledged', 'unknown', 'delivered', 'superseded'], afterSequenceId, limit: 200 })
      for (const notice of page) {
        const replacements = await store.query({ kind: 'message.notificationReplacements', notificationId: notice.id })
        notifications.push({ notificationId: notice.id, eventKey: notice.eventKey ?? null, phase: notice.payload.phase,
          status: notice.status, messageId: notice.evidence?.messageId ?? null, recallStatus: notice.recallStatus ?? null,
          replacements: replacements.map(item => ({ messageId: item.messageId, status: item.status })) })
      }
      if (page.length < 200) break
      afterSequenceId = page.at(-1).sequenceId
    }
    const requirement = plan?.task.requirementRef ? await artifacts.read(plan.task.requirementRef) : null
    return { taskId, factVersion, objective: requirement?.request ?? origin.command.args.arguments.objective,
      sourceKey: origin.run.sourceKey, sourceVersion: origin.run.sourceVersion,
      topicId: origin.command.args.binding?.topicId ?? null,
      workflowId: state?.run.workflowId ?? origin.command.args.arguments.workflowId,
      status: completion ? 'succeeded' : waiting ? owner.decision.action === 'block' ? 'blocked' : 'waiting' : plan?.task.status ?? state?.run.status ?? origin.command.status,
      nodes: state?.nodes.map(node => ({ nodeId: node.nodeId, status: node.status, waitReason: node.waitReason })) ?? [],
      run: state ? { runId: state.run.runId, status: state.run.status, revision: state.run.revision } : null,
      stages: plan?.stages.map(stage => ({ stageId: stage.stageId, workflowId: stage.workflowId,
        status: stage.status, runId: stage.runId ?? null, outputRef: stage.outputRef ?? null })) ?? [],
      result, objectiveAssessment, notifications,
    }
  }
  async function topicTaskFacts(topic, run) {
    const origins = []
    let beforeSequenceId
    do {
      const page = await store.query({ kind: 'message.task-candidates', conversationId: run.conversationId, limit: 200, ...(beforeSequenceId ? { beforeSequenceId } : {}) })
      origins.push(...page)
      beforeSequenceId = page.length === 200 ? page.at(-1).sequenceId : null
      if (origins.length >= 10000 && beforeSequenceId) throw executionError('MESSAGE_CANDIDATE_CATALOG_CAPACITY')
    } while (beforeSequenceId)
    const sourceKeys = new Set(topic.sources.map(ref => ref.sourceKey))
    const matched = origins.filter(origin => ['accepted', 'applied'].includes(origin.command.status)
      && (origin.command.args.binding?.topicId === topic.topicId
        || !origin.command.args.binding?.topicId && sourceKeys.has(origin.run.sourceKey)))
    const unique = [...new Map(matched.map(origin => [origin.command.args.taskId, origin])).values()]
    const tasks = []
    for (const origin of unique) {
      try { await taskAccess(origin.command.args.taskId, run.actorId, run.conversationId) }
      catch (error) { if (error.code === 'WORKFLOW_TASK_FORBIDDEN') continue; throw error }
      tasks.push(await taskFacts(origin))
    }
    return { tasks, total: unique.length, hasMore: false }
  }
  const stageRunId = (taskId, planRevision, stageId, attempt = 1) =>
    `run-${executionDigest({ taskId, planRevision, stageId, attempt })}`
  async function createPlannedTask({ action, info }) {
    const taskId = requireText(action.taskId, 'WORKFLOW_TASK_ID_REQUIRED')
    const stageAuthorizations = action.arguments.stageAuthorizations ?? []
    if (catalogById.get(action.arguments.workflowId)?.mode === 'external'
      && !stageAuthorizations.some(item => item.workflowId === action.arguments.workflowId)
      || stageAuthorizations.some(item => catalogById.get(item.workflowId)?.mode === 'external'
        && (typeof item.objective !== 'string' || !item.objective.trim() || !['none', 'confirmation'].includes(item.gate)
          || !info.run.body.includes(item.sourceQuote) || !item.sourceQuote.includes(item.objective))))
      throw executionError('TASK_STAGE_AUTHORIZATION_SOURCE_INVALID', '当前外部阶段授权合同不完整或不属于原文；旧持久动作也必须经完整授权修复，不能新建缺字段Task。')
    const topic = action.binding?.topicId ? await fullTopic(action.binding.topicId) : null
    const sourceKeys = [...new Set([info.run.sourceKey,
      ...(topic?.facts.flatMap(fact => fact.sourceRefs.map(ref => ref.sourceKey)) ?? [])])]
    const sources = await Promise.all(sourceKeys.map(key => store.query({ kind: 'task.source', sourceKey: key })))
    if (sources.some(source => !source || source.conversationId !== info.run.conversationId
      || source.status === 'superseded'
      || (topic?.facts.flatMap(fact => fact.sourceRefs) ?? []).some(ref => ref.sourceKey === source.sourceKey && ref.sourceVersion !== source.sourceVersion))) throw executionError('TASK_SOURCE_NOT_CURRENT')
    const references = [...new Set([...(action.requiredExecutionMaterials ?? []),
      ...referencedResourceIds([action.arguments, ...(topic?.facts.map(fact => fact.text) ?? [])],
        sources.flatMap(source => source.context?.attachments ?? []).filter(item => item.source?.type !== 'dingtalkDoc'))])]
    const resolved = references.length ? await resolveMaterials({ run: info.run, unit: info.unit,
      needs: references.map(resourceRef => ({ resourceRef })) }) : { ready: true, data: { resources: [] } }
    if (!resolved.ready) throw executionError('WORKFLOW_REQUIRED_MATERIAL_NOT_READY')
    const objective = requireText(action.arguments.objective, 'WORKFLOW_OBJECTIVE_REQUIRED')
    const fileDelivery = bindFileDelivery(action.arguments.fileDelivery, info.run.body)
    if (fileDelivery && !fileWorkflow) throw executionError('TASK_FILE_TRANSPORT_UNAVAILABLE')
    const requirement = { request: taskSourceRequest(info), objective, title: taskTitle(action.arguments.title ?? objective),
      stageAuthorizations: [...(action.arguments.stageAuthorizations ?? []), ...(action.arguments.workflowId && !action.arguments.stageAuthorizations?.some(item => item.workflowId === action.arguments.workflowId) ? [{ workflowId: action.arguments.workflowId, sourceQuote: info.run.body }] : [])].map(item => ({ ...item, sourceKey: info.run.sourceKey, sourceVersion: info.run.sourceVersion, ...(item.gate === 'confirmation' ? { requiredActorId: info.run.actorId } : {}) })),
      sourceInstructions: sources.map(source => ({ sourceKey: source.sourceKey, sourceVersion: source.sourceVersion, actorId: source.actorId, text: source.body, attachments: source.context?.attachments ?? [] })),
      ...(fileDelivery ? { fileDelivery } : {}),
      acceptanceCriteria: action.arguments.acceptanceCriteria ?? [sourceRequestCriterion],
      constraints: [...new Set(action.constraints ?? [...(info.unit.constraints ?? []), ...(info.unit.sharedConstraints ?? [])])],
      explicitStages: action.arguments.explicitStages ?? [],
      materials: resolved.data.resources.map(item => ({ id: item.resourceRef, text: item.text })),
      target: engineeringTarget(Object.fromEntries(['repositoryId', 'uatEnvironment', 'targetId', 'commitSha', 'releaseTag', 'changeRef', 'pullRequestNumber', 'headCommitSha']
        .filter(key => action.arguments[key] !== undefined).map(key => [key, action.arguments[key]])),
        [...sources.map(source => source.body), ...resolved.data.resources.map(resource => resource.text)]),
      scope: queryScope({ actorId: info.run.actorId, conversationId: info.run.conversationId, sourceKeys,
        sourceVersions: Object.fromEntries(sources.map(source => [source.sourceKey, source.sourceVersion])),
        readableFiles, ...(fileDelivery ? { artifactFiles: fileDelivery.files } : {}),
        writeMarkdown: /(?:生成|创建|写入|输出|保存).{0,16}(?:Markdown|md文件|文档|文件)/iu.test(info.run.body) }),
      authorization: { actorId: info.run.actorId, sourceKey: info.run.sourceKey,
        sourceVersion: info.run.sourceVersion, commandId: info.commandId,
        ownerConfirmed: info.ownerConfirmed === true } }
    const saved = await artifacts.put(requirement, { taskId })
    await store.command({ id: `task-accept:${info.commandId}`, kind: 'task.accept', args: {
      taskId, requirementRef: saved.ref, requirementRevision: 1,
      sessionId: `owner-${executionDigest(taskId).slice(0, 40)}`,
      criteria: requirement.acceptanceCriteria, sourceKey: info.run.sourceKey,
      eventKey: `task-created-${executionDigest(taskId).slice(0, 40)}`,
    } })
    const plan = await controller.taskPlan(taskId)
    // 消息接纳只落盘目标；现有恢复循环负责执行，长查询不占住群消息协调回合。
    return { taskId, runId: plan.stages[0]?.runId ?? null, planningError: null }
  }
  async function ensureLegacyTaskRequirement(taskId) {
    const plan = await controller.taskPlan(taskId)
    if (!plan || plan.task.requirementRef) return plan
    const origin = await store.query({ kind: 'task.origin', taskId })
    if (!origin?.command?.args?.arguments?.objective) throw executionError('TASK_REQUIREMENT_LEGACY_SOURCE_MISSING')
    const args = origin.command.args, sourceKey = origin.run.sourceKey
    const source = await store.query({ kind: 'task.source', sourceKey })
    if (!source || source.status === 'superseded'
      || source.sourceVersion !== origin.run.sourceVersion)
      throw executionError('TASK_REQUIREMENT_LEGACY_SOURCE_CHANGED')
    const first = plan.stages[0]?.requirementRef
      ? await artifacts.read(plan.stages[0].requirementRef) : null
    const objective = args.arguments.objective
    const requirement = { request: objective, objective, title: taskTitle(args.arguments.title ?? objective),
      acceptanceCriteria: args.arguments.acceptanceCriteria ?? [objective],
      constraints: args.constraints ?? first?.constraints ?? [],
      explicitStages: args.arguments.explicitStages ?? [],
      materials: first?.materials ?? [],
      target: Object.fromEntries(['repositoryId', 'uatEnvironment', 'targetId', 'commitSha', 'releaseTag',
        'changeRef', 'pullRequestNumber', 'headCommitSha']
        .filter(key => args.arguments[key] !== undefined).map(key => [key, args.arguments[key]])),
      scope: { conversationId: origin.run.conversationId, sourceKeys: [sourceKey],
        sourceVersions: { [sourceKey]: origin.run.sourceVersion },
        readableFiles, writeMarkdown: false },
      authorization: { actorId: origin.run.actorId, sourceKey,
        sourceVersion: origin.run.sourceVersion, commandId: origin.commandId } }
    const saved = await artifacts.put(requirement, { taskId })
    await store.command({ id: `task-legacy-bind:${taskId}`, kind: 'task.requirement.bind-legacy', args: {
      taskId, expectedRequirementRevision: plan.task.requirementRevision, requirementRef: saved.ref,
      sessionId: `owner-${executionDigest(taskId).slice(0, 40)}`,
      criteria: requirement.acceptanceCriteria, sourceKey,
      eventKey: `task-legacy-recovered:${taskId}` } })
    return controller.taskPlan(taskId)
  }
  async function prepareFileDeliveryInput(plan, requirement) {
    if (!fileWorkflow || !requirement.fileDelivery) throw executionError('TASK_FILE_DELIVERY_NOT_AUTHORIZED')
    const outputs = []
    for (const stage of plan.stages.filter(stage => stage.status === 'succeeded' && stage.outputRef)) {
      const output = await artifacts.read(stage.outputRef)
      outputs.push(output)
    }
    const files = selectTaskDeliveryFiles(outputs, { taskId: plan.task.taskId, requirementRevision: plan.task.requirementRevision,
      fileDelivery: requirement.fileDelivery })
    await managedFiles.validateManifest(files, { taskId: plan.task.taskId, requirementRevision: plan.task.requirementRevision })
    return { files, groupId: requirement.scope.conversationId, profile: config.profile, requirementRevision: plan.task.requirementRevision }
  }
  async function verifyRequiredFileDelivery(plan, requirement) {
    const delivered = plan.stages.filter(stage => stage.workflowId === 'task-group-file-delivery' && stage.status === 'succeeded' && stage.outputRef)
    if (delivered.length !== 1) return false
    const output = await artifacts.read(delivered[0].outputRef)
    return verifyFileDeliveryOutput(output, { taskId: plan.task.taskId, requirementRevision: plan.task.requirementRevision,
      groupId: requirement.scope.conversationId, profile: config.profile, fileDelivery: requirement.fileDelivery })
  }
  async function taskMessageResources(requirement, origin) {
    const run = origin.run, selected = new Map()
    const frozenSources = [{ sourceKey: run.sourceKey, sourceVersion: run.sourceVersion, actorId: run.actorId, text: run.body, attachments: run.context?.attachments }, ...(run.snapshot?.history ?? []), ...(requirement.sourceInstructions ?? [])]
    // 老消息也从已冻结的正文派生引用；不补写历史附件，不扩大到话题中未进入本Task的来源。
    for (const frozen of requirement.sourceInstructions ?? []) {
      if (!requirement.scope.sourceKeys.includes(frozen.sourceKey)
        || requirement.scope.sourceVersions[frozen.sourceKey] !== frozen.sourceVersion) continue
      const refs = normalizeResourceRefs([], frozen.text).filter(ref => ref.type === 'dingtalkDoc')
      if (!refs.length) continue
      const current = await store.query({ kind: 'task.source', sourceKey: frozen.sourceKey })
      if (!current || current.status === 'superseded' || current.conversationId !== run.conversationId
        || current.actorId !== frozen.actorId || current.sourceVersion !== frozen.sourceVersion || current.body !== frozen.text
        || typeof current.context?.sourceMessageId !== 'string') throw executionError('TASK_MATERIAL_SOURCE_STALE')
      for (const ref of refs) selected.set(executionDigest([current.sourceKey, ref.type, ref.resourceId]), {
        sourceKey: current.sourceKey, sourceVersion: current.sourceVersion, type: ref.type, resourceId: ref.resourceId, name: ref.name ?? '' })
    }
    for (const material of requirement.materials ?? []) {
      for (const frozen of frozenSources) {
        const candidates = (frozen.attachments ?? []).filter(attachment => material.id === frozen.sourceKey
          || material.id === attachment.resourceRef)
        if (!candidates.length) continue
        const current = await store.query({ kind: 'task.source', sourceKey: frozen.sourceKey })
        if (!current || current.status === 'superseded' || current.conversationId !== run.conversationId
          || current.actorId !== frozen.actorId || current.sourceVersion !== frozen.sourceVersion || current.body !== frozen.text)
          throw executionError('TASK_MATERIAL_SOURCE_STALE')
        const attachments = material.id === frozen.sourceKey ? current.context?.attachments ?? []
          : (current.context?.attachments ?? []).filter(item => item.resourceRef === material.id)
        if (!attachments.length || candidates.some(attachment => !attachments.some(item => item.source?.type === attachment.source?.type
          && item.source?.resourceId === attachment.source?.resourceId && item.sourceMessageId === attachment.sourceMessageId
          && current.context?.sourceMessageId === item.sourceMessageId))) throw executionError('TASK_MATERIAL_IDENTITY_CHANGED')
        const cacheRef = `source-attachments:${executionDigest([current.sourceKey, current.sourceVersion, attachments])}`
        const proof = await store.query({ kind: 'message.material', runId: run.runId, resourceRef: cacheRef })
        if (!proof || proof.text !== material.text) throw executionError('TASK_MATERIAL_PROOF_MISSING')
        for (const attachment of attachments) {
          const ref = attachment.source
          if (!ref?.resourceId || !['fileId','mediaId','dingtalkDoc'].includes(ref.type)) throw executionError('TASK_MATERIAL_IDENTITY_CHANGED')
          selected.set(executionDigest([current.sourceKey, ref.type, ref.resourceId]), { sourceKey: current.sourceKey,
            sourceVersion: current.sourceVersion, type: ref.type, resourceId: ref.resourceId, name: attachment.name ?? '' })
        }
      }
    }
    return [...selected.values()]
  }
  async function readTaskMaterialAccess({ taskId, plan, requirement }) {
    const origin = await store.query({ kind: 'task.origin', taskId })
    const readableMessageResources = origin ? await taskMessageResources(requirement, origin) : []
    return { readableMessageResources, verification: 'current-source-identity-and-material-ledger',
      instruction: '资源已由Host核验当前来源及材料账，本任务会话可按当前queryContext.readableMessageResources读取；读取错误在同一会话纠正，不要求用户重发已提供附件。' }
  }
  const stageContracts = createTaskStageContracts({ controller, artifacts,
    readOwnerContract: id => id === 'task-engineering' ? engineeringWorkflowOwnerContract
      : visibleDefinitions.has(id) ? controller.workflowDefinition(id).ownerContract : null,
    contracts: [
    createEngineeringStageContract({ engineering, controller, mayCreate, engineeringSourceTaskId,
      readTaskEvidence: args => taskOwner.readTaskEvidence(args) }),
    createGeneralCapabilityStageContract(),
    createFileDeliveryStageContract({ prepareFiles: prepareFileDeliveryInput }),
    ...createExternalStageContracts({ workflowIds: [...selectedExternal.byId.keys()], external,
      readTaskEvidence: args => taskOwner.readTaskEvidence(args),
      readEngineeringProof: async (taskId, stage) => readEngineeringDeliveryProof({
        state: await controller.state(stage.runId), artifacts, store, taskId }),
      readArtifact: ref => artifacts.read(ref) }),
  ] })
  async function advanceBusinessTask(taskId, continuation) {
    let plan = await ensureLegacyTaskRequirement(taskId)
    plan = await controller.advanceTaskPlan(taskId, { ownerTurnId: continuation?.ownerTurnId })
    plan = await continueFailedUatStage({ taskId, plan, store, controller, external })
    const stageIndex = plan.stages.findIndex(stage => !['succeeded', 'invalidated'].includes(stage.status))
    const stage = plan.stages[stageIndex]
    if (!stage || stage.status !== 'ready' || stage.unavailableReason || stage.requirementRef) return plan
    const requirement = plan.task.requirementRef ? await artifacts.read(plan.task.requirementRef) : null
    if (!requirement?.request) throw executionError('TASK_REQUIREMENT_MISSING')
    const origin = continuation?.command ? continuation : await store.query({ kind: 'task.origin', latest: true, taskId })
      ?? await store.query({ kind: 'task.origin', taskId })
    if (!origin) throw executionError('TASK_REQUIREMENT_MISSING')
    const prepared = await stageContracts.prepare({ taskId, stage, stageIndex, plan, requirement, origin, continuation })
    await controller.bindTaskStageInput({ commandId: `stage-input:${taskId}:${plan.task.planRevision}:${stage.stageId}`,
      taskId, ownerTurnId: continuation?.ownerTurnId, planRevision: plan.task.planRevision, stageId: stage.stageId,
      predecessorOutputRef: plan.stages[stageIndex - 1]?.outputRef ?? null,
      input: prepared.input, ...(prepared.workflowId ? { workflowId: prepared.workflowId } : {}) })
    return controller.advanceTaskPlan(taskId, { ownerTurnId: continuation?.ownerTurnId })
  }
  async function prepareInitialStage({ taskId, stage, decision, plan }) {
    const requirement = await artifacts.read(plan.task.requirementRef)
    const origin = await store.query({ kind: 'task.origin', taskId })
    if (!origin || !requirement?.request) throw executionError('TASK_REQUIREMENT_MISSING')
    return stageContracts.prepare({ taskId, stage: { ...stage, stageId: 'stage-1' }, stageIndex: 0,
      executionPlanRevision: plan.task.planRevision + 1, decision, plan, requirement, origin })
  }
  const withAcceptanceIdentity = policy => ({ ...policy,
    rulesDigest: executionDigest({ domain: policy.rulesDigest ?? null, acceptanceVerifier: completionIdentity,
      binding: verifyTaskAcceptance.toString() }) })
  const completionPolicies = new Map([stepWorkflow?.ownerContract, createEngineeringCompletionPolicy(),
    withAcceptanceIdentity(externalWorkflowOwnerContract), fileWorkflow && withAcceptanceIdentity(fileWorkflow.ownerContract)]
    .filter(Boolean).map(policy => [policy.id, policy]))
  async function prepareCurrentDataChangeInput({ taskId, stageId, decision }) {
    const plan = await controller.taskPlan(taskId)
    const stage = plan?.stages.find(item => item.stageId === stageId)
    const requirement = plan?.task.requirementRef ? await artifacts.read(plan.task.requirementRef) : null
    const origin = await store.query({ kind: 'task.origin', taskId })
    if (!stage || stage.workflowId !== 'task-data-change' || !origin || !requirement?.request) throw executionError('TASK_REQUIREMENT_MISSING')
    const prepared = await stageContracts.prepare({ taskId, stage, plan,
      stageIndex: plan.stages.findIndex(item => item.stageId === stageId), requirement, origin })
    if (!decision) return prepared.input
    const state = await controller.state(stage.runId)
    const originalInput = await artifacts.read(state.run.requirementRef)
    const observed = await ownerContracts.inspectCurrentExecution(taskId, plan)
    const input = { ...prepared.input,
      sources: [...prepared.input.sources, ...(observed?.repairable && observed.validationSource ? [observed.validationSource] : [])],
      constraints: [...prepared.input.constraints, ...dataChangeProposalRepairConstraints(originalInput, decision)] }
    assertDataChangeProposalRepairInput({ originalInput, input, decision })
    return input
  }
  const ownerContracts = createTaskWorkflowContracts({ store, artifacts, controller,
    readTaskEvidence: args => taskOwner.readTaskEvidence(args), prepareRepairContext: engineering.prepareRepairContext,
    prepareDataChangeRepairInput: async context => {
      const input = await prepareCurrentDataChangeInput({ taskId: context.taskId, stageId: context.stage.stageId, decision: context.decision })
      const evidence = await taskOwner.readTaskEvidence({ taskId: context.taskId, requirementRevision: context.plan.task.requirementRevision })
      const saved = await artifacts.put({ kind: 'data-change-proposal-repair-context', taskId: context.taskId, runId: context.stage.runId,
        generation: context.state.run.generation, requirementRevision: context.plan.task.requirementRevision,
        queryEvidenceRefs: evidence.map(item => item.artifactRef), failureEvidence: context.failureEvidence,
        diagnosis: context.decision.summary, inputDigest: executionDigest(input) }, { taskId: context.taskId })
      return { input, contextRef: saved.ref }
    },
    completionPolicy: (contract, context) => {
      if (contract.id === 'external-result' && ['3', '4', '5'].includes(contract.version)
        && ['task-data-change', 'task-data-change-approval-resume'].includes(context?.state?.run?.workflowId))
        return withAcceptanceIdentity(createScopedNativeDataChangeCompletionPolicy(selectedExternal.byId.get(context.state.run.workflowId)?.adapter))
      return completionPolicies.get(contract.id) ?? contract
    },
    verifyAcceptance: context => verifyTaskAcceptance({ ...context, check: (input, options) => {
      ownerAcceptanceInputs.add(input)
      return completionCheck(input, options)
    } }),
    validateFiles: (files, scope) => managedFiles.validateManifest(files, scope), verifyFileDelivery: verifyRequiredFileDelivery })
  const { inspectCurrentExecution, repairCurrentStage, readStageArtifacts } = ownerContracts
  taskOwner = createTaskOwnerController({ ctx, store, artifacts, controller, modelConfig,
    tools: queryTools(artifacts), prepareQueryInput: resolveTaskQueryInput,
    getWorkspaceDir: ({ binding }) => taskSessionWorkspace('owner', binding),
    ...(taskOwnerSessions ? { sessionRunner: taskOwnerSessions } : {}),
    capabilityCatalog: stepCapabilities.filter(item => item.effectClass === 'file.write').map(item => ({ id: item.id, description: item.description,
      effectClass: item.effectClass })),
    workflowCatalog: taskWorkflowCatalog.filter(item => !['task-general', 'task-analysis'].includes(item.id))
      .map(item => ({ id: item.id, purpose: item.purpose, mode: item.mode,
        ...(stageContracts.descriptors.find(contract => contract.id === item.id)
          ? { contract: stageContracts.descriptors.find(contract => contract.id === item.id) } : {}),
        available: item.mode === 'delivery' ? Boolean(fileWorkflow) : item.mode !== 'external' || selectedExternal.byId.has(item.id),
        ...(externalWorkflows.find(entry => entry.id === item.id)?.targetIds
          ? { targetIds: externalWorkflows.find(entry => entry.id === item.id).targetIds } : {}) })),
    prepareInitialStage, inspectCurrentExecution, repairCurrentStage, readStageArtifacts,
    validateDataChangeRepairContext: args => prepareCurrentDataChangeInput(args),
    readMaterialAccess: readTaskMaterialAccess,
    readCurrentSources: async ({ taskId }) => (await store.query({ kind: 'message.task.inputs', taskId }))
      .map(source => ({ sourceKey: source.sourceKey, sourceVersion: source.sourceVersion, actorId: source.actorId,
        text: source.body, runId: source.runId })),
    readDeliveryManifest: ownerContracts.readDeliveryManifest,
    advanceTask: advanceBusinessTask,
    authorizeCompletion: async ({ taskId, decision, signal }) => {
      const plan = await controller.taskPlan(taskId)
      if (!plan || plan.stages.length && (plan.task.status !== 'succeeded'
        || plan.task.planRequirementRevision !== plan.task.requirementRevision)) return false
      const initial = await artifacts.read(plan.task.requirementRef)
      if (initial.fileDelivery && !await verifyRequiredFileDelivery(plan, initial)) return false
      const source = await store.query({ kind: 'task.origin', taskId })
      if (source?.channel === 'web' && (plan.stages.length !== source.run.request.stages.length
        || plan.stages.some((stage, index) => (stage.workflowId.startsWith('task-engineering-') ? 'task-engineering' : stage.workflowId) !== source.run.request.stages[index]))
        && !await verifiedUatRebuildCompletion({ taskId, plan, origin: source, artifacts, external, controller })) return false
      return ownerContracts.authorizeCompletion({ taskId, decision, plan, requirement: initial, signal })
    },
    authorizeStages: async ({ taskId, stages }) => {
      const plan = await controller.taskPlan(taskId)
      if (!plan || !stages.length || plan.task.controlState !== 'active') return false
      const requirement = await artifacts.read(plan.task.requirementRef)
      const origin = await store.query({ kind: 'task.origin', taskId })
      if (!origin || !requirement?.authorization
        || !requirement.authorization.ownerConfirmed && !await mayCreate(origin.run, null, origin.command?.args?.binding,
          origin.command ? { intent: origin.command.kind, ...origin.command.args.arguments && { arguments: origin.command.args.arguments },
            constraints: origin.command.args.constraints, requiredExecutionMaterials: origin.command.args.requiredExecutionMaterials } : undefined)) return false
      if (origin.channel === 'web' && (requirement.authorization.channel !== 'web'
        || requirement.reportChannel !== 'web' || requirement.externalMessaging !== false
        || stages.length !== origin.run.request.stages.length
        || stages.some((stage, index) => stage.workflowId !== origin.run.request.stages[index]))) return false
      const userText = [requirement.request, ...(requirement.explicitStages ?? []), ...(requirement.sourceInstructions ?? []).map(source => source.text)].join('\n')
      for (const stage of stages) {
        if (stage.workflowId === 'task-general-capability') {
          const step = stage.capabilityStep
          const capability = stepCapabilities.find(item => item.id === step?.capabilityId)
          if (!step || !capability || capability.effectClass !== 'file.write' || stage.gate !== 'none' || !step.expectedEvidence?.trim()) return false
          const scope = { ...requirement.scope, predecessorOutputRef: plan.stages.at(-1)?.outputRef ?? null,
            ...(['write-task-file', 'import-task-file'].includes(step.capabilityId) ? { requirementRevision: plan.task.requirementRevision } : {}) }
          if (!await capability.authorize({ input: step.input, scope })) return false
          const proposed = executionDigest({ capabilityId: step.capabilityId, input: step.input, scope: requirement.scope })
          for (const prior of plan.stages) if (prior.workflowId === 'task-general-capability' && prior.requirementRef) {
            const used = await artifacts.read(prior.requirementRef)
            if (executionDigest({ capabilityId: used.capabilityId, input: used.input, scope: requirement.scope }) === proposed) return false
          }
          continue
        }
        const item = catalogById.get(stage.workflowId)
        if (stage.sourceCondition) {
          const condition = stage.sourceCondition
          const source = (requirement.sourceInstructions ?? []).find(item => item.sourceKey === condition.sourceKey && item.sourceVersion === condition.sourceVersion)
          if (!source || !source.text.includes(condition.sourceQuote)) throw executionError('TASK_OWNER_STAGE_NOT_AUTHORIZED', 'sourceCondition.sourceQuote/sourceKey/sourceVersion 未绑定当前原文来源；请复制 goal.stageAuthorizations 中本阶段的来源。')
          if (!condition.sourceQuote.includes(condition.objective)) throw executionError('TASK_OWNER_STAGE_NOT_AUTHORIZED', 'sourceCondition.objective 必须逐字复制 goal.stageAuthorizations 的 objective，且是 sourceQuote 的连续原文片段；实现方案和 SQL 写入 summary 或执行参数。')
          if (condition.requiredActorId && condition.requiredActorId !== source.actorId
            || stage.gate === 'confirmation' && !condition.requiredActorId) throw executionError('TASK_OWNER_STAGE_NOT_AUTHORIZED', 'gate confirmation 必须绑定原来源 requiredActorId；不能替真人确认或删除原文验证门槛。')
          const current = await store.query({ kind: 'task.source', sourceKey: condition.sourceKey })
          if (!current || current.sourceVersion !== condition.sourceVersion || current.status === 'superseded') return false
        }
        if (item?.mode === 'external' && origin.channel !== 'web' && requirement.sourceInstructions) {
          const authorizations = (requirement.stageAuthorizations ?? []).filter(item => item.workflowId === stage.workflowId)
          const latestSource = authorizations.at(-1)?.sourceKey
          const authorized = authorizations.filter(item => item.sourceKey === latestSource).find(item =>
            item.sourceKey === stage.sourceCondition?.sourceKey && item.sourceVersion === stage.sourceCondition?.sourceVersion
            && item.sourceQuote === stage.sourceCondition?.sourceQuote
            && typeof item.objective === 'string' && item.objective.trim() && item.objective === stage.sourceCondition?.objective
            && ['none','confirmation'].includes(item.gate) && item.gate === stage.gate)
          if (!authorizations.some(item => typeof item.objective === 'string' && item.objective.trim() && ['none', 'confirmation'].includes(item.gate)))
            throw executionError('TASK_OWNER_STAGE_NOT_AUTHORIZED', 'goal.stageAuthorizations 缺 objective/gate，属于授权投影合同不完整；不能猜测或视为生产批准，需沿受管原文授权修复入口恢复当前 Task。')
          if (!authorized) throw executionError('TASK_OWNER_STAGE_NOT_AUTHORIZED', 'sourceCondition 与 goal.stageAuthorizations 的 workflowId/sourceKey/sourceVersion/sourceQuote/objective/gate 不一致；请逐字复制匹配授权，禁止自行增删验证门槛。')
          if (!(requirement.sourceInstructions ?? []).some(source => source.sourceKey === authorized.sourceKey
            && source.sourceVersion === authorized.sourceVersion && source.actorId === requirement.authorization.actorId
            && source.text.includes(authorized.sourceQuote))
            || authorized.gate === 'confirmation' && (stage.gate !== 'confirmation'
              || stage.sourceCondition.requiredActorId !== authorized.requiredActorId)) return false
        }
        if (stage.workflowId === 'task-group-file-delivery' && (!fileWorkflow || !requirement.fileDelivery
          || plan.stages.some(previous => previous.workflowId === stage.workflowId && previous.status !== 'invalidated'))) return false
        if (!item || item.id === 'task-general' || item.mode === 'external' && !selectedExternal.byId.has(item.id)) return false
        if (item.mode === 'engineering' && (!requirement.target.repositoryId || !uatBranchFor(requirement.target.uatEnvironment)))
          throw executionError('TASK_OWNER_ENGINEERING_INPUT_REQUIRED', `${!requirement.target.repositoryId ? '目标仓库' : '目标 UAT 环境'}尚未明确；先读当前材料及关联来源，确实缺少时提交 wait/business-input，只询问缺失参数，不重复确认开发意图。`)
        if (item.mode === 'external' && !(requirement.stageTargets?.[item.id] ?? requirement.target.targetId)) return false
        if (item.id === 'task-uat-pr-merge' && !/合并|部署|提测|UAT/iu.test(userText) && origin.channel !== 'web') return false
        if (item.id === 'task-main-pr-merge' && !/上线|合并.*main|main.*合并/iu.test(userText)) return false
        if (item.id === 'task-production-release' && !/生产发布|上线/iu.test(userText)) return false
        if (item.id === 'task-data-change' && external?.dataChangeAdapter?.pluginApproval === true
          && !(await taskOwner.readTaskEvidence({ taskId, requirementRevision: plan.task.requirementRevision })).length)
          throw executionError('TASK_OWNER_STAGE_NOT_AUTHORIZED', '当前需求版本缺少本任务查询证据；请先使用查询工具核对当前生产目标或来源材料，再依据当前查询结果提交数据变更阶段。旧需求证据不能代替当前版本。')
        if (item.id === 'task-data-change' && external?.dataChangeAdapter?.pluginApproval === true)
          await stageContracts.prepare({ taskId, stage: { ...stage, stageId: 'candidate-data-change' }, stageIndex: plan.stages.length, plan, requirement, origin })
        if (item.id === 'task-data-change' && origin.channel !== 'web' && !requirement.sourceInstructions
          && requirement.target?.workflowId !== item.id && origin.command?.args?.arguments?.workflowId !== item.id) return false
      }
      return true
    } })
  async function executeWebEvent(event) {
    const finishKind = event.channel === 'web' ? 'task.web-input.finish' : 'message.web-task.finish'
    if(event.status==='pending') {
      try {
        const commandId=`web-task:${event.id}`
        if(event.request.action==='cancel') {
          const plan = await controller.taskPlan(event.request.taskId)
          if (plan) await controller.controlTask({ commandId, taskId: event.request.taskId,
            intent: 'cancel', expectedControlRevision: event.expectedControlRevision ?? plan.task.controlRevision })
          else await controller.stop({commandId,runId:event.executionRunId,reason:event.request.reason})
          await taskOwner.cancel(event.request.taskId)
        } else if (event.request.action === 'confirm-stage') {
          await controller.confirmTaskStage({ commandId, taskId: event.request.taskId,
            stageId: event.request.stageId, planRevision: event.request.planRevision,
            expectedRequirementRevision: event.request.requirementRevision,
            expectedControlRevision: event.request.controlRevision, outputRef: event.request.outputRef })
        } else {
          if (!event.input?.request?.trim() || !Array.isArray(event.input.acceptanceCriteria)
            || !event.input.scope?.sourceKeys?.length || !event.input.authorization)
            throw executionError('TASK_WEB_REQUIREMENT_INVALID')
          const saved = await artifacts.put(event.input, { taskId: event.request.taskId })
          await store.command({ id: commandId, kind: 'task.requirement.update', args: {
            taskId: event.request.taskId, expectedRequirementRevision: event.request.inputVersion - 1,
            requirementRef: saved.ref, eventKey: `web:${event.id}` } })
        }
        if (['cancel', 'confirm-stage'].includes(event.request.action) && await store.query({ kind: 'task.owner', taskId: event.request.taskId }))
          await taskOwner.event({ taskId: event.request.taskId, eventKey: `web:${event.id}`,
            eventType: event.request.action === 'cancel' ? 'control.changed' : 'approval.resolved',
            payload: { action: event.request.action, requestId: event.request.requestId,
              actorId: event.actorId, input: event.input,
              ...(event.request.action === 'confirm-stage' ? { confirmation: event.request } : {}) } })
        event=(await store.command({id:`web-finish:${event.id}`,kind:finishKind,args:{eventId:event.id,result:{status:'accepted',taskId:event.request.taskId,requestId:event.request.requestId}}})).result.event
      } catch(error) {
        if(!['REVISION_CONFLICT','TASK_REQUIREMENT_STALE','RUN_TERMINAL','RUN_STOPPING','TASK_CONTROL_STALE','TASK_CONTROL_CONFLICT','TASK_PLAN_STALE','TASK_CONFIRMATION_NOT_WAITING','TASK_CONFIRMATION_OUTPUT_STALE'].includes(error.code))throw error
        event=(await store.command({id:`web-reject:${event.id}`,kind:finishKind,args:{eventId:event.id,error:error.code}})).result.event
      }
    }
    if(event.error)throw executionError(event.error)
    return event.result
  }
  async function engineeringSourceTaskId(taskId, repositoryId) {
    const records = await store.query({ kind: 'workflow.list' })
    const family = await store.query({ kind: 'task.family', taskId })
    if (!family) throw executionError('ENGINEERING_BRANCH_SOURCE_INVALID')
    // 已取消的最新一次可能尚未创建开发目录，沿明确祖先寻找已登记开发起点。
    let sourceTaskId = taskId
    while (sourceTaskId) {
      if (records.some(record => record.config?.kind === 'engineering' && record.config.taskId === sourceTaskId
        && record.config.repoId === repositoryId && record.config.ownerActorId === ownerActorId)) return sourceTaskId
      sourceTaskId = (await store.query({ kind: 'task.origin', taskId: sourceTaskId }))?.rerunOfTaskId
    }
    throw executionError('ENGINEERING_BRANCH_SOURCE_INVALID')
  }
  async function rerunWebTask(request, identity, origin) {
    const fields = ['action', 'taskId', 'requestId', 'expectedRunId', 'objective', 'acceptanceCriteria', 'constraints', 'repositoryId', 'uatEnvironment', 'stages', 'mergeTargetId', 'deployTargetId']
    if (Object.keys(request).some(key => !fields.includes(key))) throw executionError('TASK_RERUN_REQUEST_INVALID')
    for (const key of ['requestId', 'objective', 'repositoryId', 'mergeTargetId', 'deployTargetId']) requireText(request[key], 'TASK_RERUN_REQUEST_INVALID')
    if (request.expectedRunId !== null) requireText(request.expectedRunId, 'TASK_RERUN_REQUEST_INVALID')
    if (request.objective.length > 12000 || !uatBranchFor(request.uatEnvironment)
      || !acceptanceCriteriaSchema.safeParse(request.acceptanceCriteria).success
      || request.constraints !== undefined && (!Array.isArray(request.constraints)
        || request.constraints.some(value => typeof value !== 'string' || !value.trim() || value.length > 2000))
      || !Array.isArray(request.stages) || executionDigest(request.stages) !== executionDigest(['task-engineering', 'task-uat-pr-merge', 'task-uat-deployment'])) throw executionError('TASK_RERUN_REQUEST_INVALID')
    const identityDigest = executionDigest([identity.actorId, request.taskId, request.requestId])
    const sourceKey = `web-rerun:${identityDigest}`, taskId = `task-web-${identityDigest}`
    const existing = await store.query({ kind: 'task.source', sourceKey })
    if (existing) {
      if (existing.channel !== 'web' || existing.actorId !== identity.actorId
        || executionDigest(existing.request) !== executionDigest(request)) throw executionError('MESSAGE_WEB_EVENT_CONFLICT')
    } else {
      const repository = config.repositories?.find(item => item.id === request.repositoryId)
      if (!repository || !engineering.availableWorkflows().some(item => item.repositoryId === request.repositoryId)) throw executionError('ENGINEERING_REPOSITORY_NOT_ADMITTED')
      const repositoryName = repository.githubRepository
        ?? /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/.exec(repository.remote)?.[1]
        ?? /^(?:git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/.exec(repository.remote)?.[1]
      for (const [workflowId, targetId] of [['task-uat-pr-merge', request.mergeTargetId], ['task-uat-deployment', request.deployTargetId]]) {
        const target = external?.availableTargets?.find(item => item.workflowId === workflowId && item.targetId === targetId)
        if (!selectedExternal.byId.has(workflowId) || !target || target.repository !== repositoryName
          || target.branch !== uatBranchFor(request.uatEnvironment)) throw executionError('TASK_RERUN_TARGET_NOT_ADMITTED')
      }
      await engineeringSourceTaskId(request.taskId, request.repositoryId)
      const requirement = { request: request.objective, objective: request.objective,
        acceptanceCriteria: request.acceptanceCriteria, constraints: request.constraints ?? [],
        explicitStages: request.stages, materials: [],
        target: { repositoryId: request.repositoryId, uatEnvironment: request.uatEnvironment },
        stageTargets: { 'task-uat-pr-merge': request.mergeTargetId, 'task-uat-deployment': request.deployTargetId },
        scope: { conversationId: `web:${identity.actorId}`, sourceKeys: [sourceKey], sourceVersions: { [sourceKey]: 1 }, readableFiles, writeMarkdown: false },
        authorization: { channel: 'web', actorId: identity.actorId, sourceKey, sourceVersion: 1, requestId: request.requestId, commandId: sourceKey },
        rerunOfTaskId: request.taskId, reportChannel: 'web', externalMessaging: false }
      const family = await store.query({ kind: 'task.family', taskId: request.taskId })
      if (!family) throw executionError('TASK_FAMILY_INVALID')
      const saved = await artifacts.put(requirement, { taskId, logicalTaskId: family.rootTaskId })
      await store.command({ id: sourceKey, kind: 'task.web-rerun.accept', args: { taskId, rerunOfTaskId: request.taskId,
        actorId: identity.actorId, request, requirementRef: saved.ref, criteria: requirement.acceptanceCriteria, sourceKey } })
    }
    let planningError = null
    try { await taskOwner.drive(taskId); planningError = (await taskOwner.applyPending())[0]?.code ?? null }
    catch (error) { planningError = error.code ?? error.message }
    const plan = await controller.taskPlan(taskId)
    return { status: 'accepted', taskId, rerunOfTaskId: request.taskId, requestId: request.requestId,
      runId: plan.stages[0]?.runId ?? null, reportChannel: 'web', planningError }
  }
  function reviseWebRequirement(previous, request, identity, eventId) {
    const revision = request.requirement
    if (!revision) return null
    if (request.action !== 'context' || !acceptanceCriteriaSchema.safeParse(revision.acceptanceCriteria).success
      || !revision.objective?.trim() || !request.context.includes(revision.objective)
      || !Array.isArray(revision.stageAuthorizations) || revision.stageAuthorizations.length === 0
      || !revision.stageTargets || Object.keys(revision).some(key => !['objective','acceptanceCriteria','stageTargets','stageAuthorizations'].includes(key)))
      throw executionError('TASK_WEB_REQUIREMENT_INVALID')
    const sourceKey = `web-context:${eventId}`, sourceVersion = 1
    for (const [workflowId, targetId] of Object.entries(revision.stageTargets)) {
      if (!selectedExternal.byId.has(workflowId) || !external?.availableTargets?.some(item =>
        item.workflowId === workflowId && item.targetId === targetId)) throw executionError('EXTERNAL_TARGET_NOT_ALLOWED')
    }
    const stageAuthorizations = revision.stageAuthorizations.map(item => {
      if (!selectedExternal.byId.has(item.workflowId) || !revision.stageTargets[item.workflowId]
        || !['none', 'confirmation'].includes(item.gate) || !item.sourceQuote?.trim()
        || !item.objective?.trim() || !request.context.includes(item.sourceQuote) || !item.sourceQuote.includes(item.objective))
        throw executionError('TASK_STAGE_AUTHORIZATION_SOURCE_INVALID')
      return { ...item, sourceKey, sourceVersion,
        ...(item.gate === 'confirmation' ? { requiredActorId: identity.actorId } : {}) }
    })
    return { ...previous, request: revision.objective, objective: revision.objective,
      acceptanceCriteria: revision.acceptanceCriteria, constraints: [request.context],
      explicitStages: [], stageTargets: revision.stageTargets, stageAuthorizations,
      sourceInstructions: [...(previous.sourceInstructions ?? []), { sourceKey, sourceVersion,
        actorId: identity.actorId, text: request.context, attachments: [] }],
      scope: { ...previous.scope, sourceKeys: [...new Set([...previous.scope.sourceKeys, sourceKey])],
        sourceVersions: { ...previous.scope.sourceVersions, [sourceKey]: sourceVersion } },
      authorization: { channel: 'web', actorId: identity.actorId, requestId: request.requestId, sourceKey, sourceVersion } }
  }
  async function submitWebTask(request, identity) {
    if(identity?.channel!=='web'||!config.webActorId||identity.actorId!==config.webActorId)throw executionError('WORKFLOW_WEB_ACTOR_FORBIDDEN')
    const origin=await store.query({kind:'task.origin',taskId:request.taskId})
    if(!origin)throw executionError('WORKFLOW_TASK_NOT_FOUND')
    await taskAccess(request.taskId,identity.actorId,origin.run.conversationId)
    if (request.action === 'archive') {
      const family = await readableTaskFamily(request.taskId)
      if (!family || family.latestTaskId !== request.taskId) throw executionError('TASK_EXECUTION_STALE')
      const task = (await tasks({ taskId: request.taskId }))[0]
      if (!task || task.state !== 'completed') throw executionError('TASK_ARCHIVE_NOT_COMPLETED')
      const receipt = await store.command({ id: `task-archive:${executionDigest([identity.actorId, request.taskId, family.taskIds])}`,
        kind: 'task.archive', args: { taskId: request.taskId, actorId: identity.actorId } })
      return { ...task, archivedAt: receipt.result.archivedAt }
    }
    if (request.action === 'rerun') return rerunWebTask(request, identity, origin)
    if (origin.channel === 'web') {
      if (!['context', 'cancel', 'confirm-stage'].includes(request.action)) throw executionError('WORKFLOW_WEB_ACTION_UNSUPPORTED')
      const eventId = `web-input:${executionDigest([identity.actorId, request.taskId, requireText(request.requestId, 'WORKFLOW_WEB_EVENT_REQUIRED')])}`
      const prior = await store.query({ kind: 'task.web-input', eventId })
      if (prior) {
        if (prior.actorId !== identity.actorId || executionDigest(prior.request) !== executionDigest(request)) throw executionError('MESSAGE_WEB_EVENT_CONFLICT')
        return executeWebEvent(prior)
      }
      const plan = await controller.taskPlan(request.taskId), previous = await artifacts.read(plan.task.requirementRef)
      const input = request.action === 'context' ? reviseWebRequirement(previous, request, identity, eventId) ?? { ...previous,
        request: `${previous.request}\n\n补充要求：\n${requireText(request.context, 'WORKFLOW_CONTEXT_REQUIRED')}`,
        objective: `${previous.request}\n\n补充要求：\n${request.context}`,
        constraints: [...new Set([...previous.constraints, request.context])],
        authorization: { ...previous.authorization, actorId: identity.actorId, requestId: request.requestId } } : null
      const event = (await store.command({ id: `web-prepare:${eventId}`, kind: 'task.web-input.prepare',
        args: { eventId, actorId: identity.actorId, request, input } })).result.event
      return executeWebEvent(event)
    }
    if(request.action==='reissue-repository')return engineering.reissueTask(request,controller,artifacts)
    if(!['cancel','context'].includes(request.action))throw executionError('WORKFLOW_WEB_ACTION_UNSUPPORTED')
    const eventId=executionDigest([request.taskId,requireText(request.requestId,'WORKFLOW_WEB_EVENT_REQUIRED')])
    const prior=await store.query({kind:'message.web-task',eventId})
    if(prior){if(executionDigest(prior.request)!==executionDigest(request)||prior.actorId!==identity.actorId)throw executionError('MESSAGE_WEB_EVENT_CONFLICT');return executeWebEvent(prior)}
    if ((await store.query({ kind: 'task.family', taskId: request.taskId }))?.latestTaskId !== request.taskId)
      throw executionError('TASK_EXECUTION_STALE')
    const runs=await store.query({kind:'run.list',taskId:request.taskId,limit:1})
    const state=runs.length?await currentTask(request.taskId):null
    const plan=await controller.taskPlan(request.taskId)
    if (!plan?.task.requirementRef) throw executionError('TASK_REQUIREMENT_MISSING')
    const previous=await artifacts.read(plan.task.requirementRef)
    const input=request.action==='context'?reviseWebRequirement(previous,request,identity,eventId)??{...previous,
      request:`${previous.request}\n\n补充要求：\n${requireText(request.context,'WORKFLOW_CONTEXT_REQUIRED')}`,
      constraints:[...new Set([...(previous.constraints ?? []), request.context])],
      authorization:{ ...previous.authorization, actorId: identity.actorId, channel: 'web', requestId: request.requestId }} : null
    if (input) input.objective = input.request
    const event=(await store.command({id:`web-prepare:${eventId}:${executionDigest(input)}`,kind:'message.web-task.prepare',args:{eventId,request,actorId:identity.actorId,executionRunId:state?.run.runId??null,input}})).result.event
    return executeWebEvent(event)
  }
  async function ownerConfirmedPriorTask(action, info) {
    if (!action.binding?.priorTaskId) return false
    const requests = (await messages.state(info.run.runId)).requests
    for (const request of requests.filter(item => item.status === 'resolved' && item.unitId === info.unit.unitId && item.eventId)) {
      const answer = await store.query({ kind: 'task.source', sourceKey: request.eventId })
      if (answer?.actorId === ownerActorId) return true
    }
    return false
  }
  async function createTask(action, info) {
    const admission = await taskAdmission(info.run, info.binding, { ...action, commandId: info.commandId })
    const ownerConfirmed = admission.reasonCode === 'OWNER_APPROVED' || await ownerConfirmedPriorTask(action, info)
    if (!admission.allowed && !ownerConfirmed) throw executionError('WORKFLOW_ACTION_FORBIDDEN')
    info = { ...info, ownerConfirmed }
    if (info.run.context.editOf) {
      const original = await messages.state(info.run.context.editOf.sourceRunId)
      const previous = original.commands.filter(item => item.args?.taskId && ['create', 'research', 'answer', 'reopen'].includes(item.kind))
      const confirmedNew = (await messages.state(info.run.runId)).requests.some(request => request.unitId === info.unit.unitId && request.reason === 'SOURCE_EDIT_NEW_MATTER' && request.status === 'resolved' && request.answer === '新增独立任务')
      if (previous.length && !confirmedNew) throw executionError('WORKFLOW_EDIT_REQUIRES_EXISTING_TASK')
    }
    if (action.sourceInputRunId) {
      const latest = (await messages.state(action.sourceInputRunId)).run
      if (latest.sourceKey !== info.run.sourceKey || latest.actorId !== info.run.actorId) throw executionError('WORKFLOW_EDIT_SOURCE_MISMATCH')
      info = { ...info, run: latest }
    }
    const result = await createPlannedTask({ action, info })
    return { taskId: result.taskId, runId: result.runId, status: 'accepted',
      reply: '正在核对执行条件，处理尚未开始。' }
  }
  async function taskAction(action, info) {
    if (info.binding.disposition === 'conversation' && ['status', 'result'].includes(action.intent)) {
      const origins = await store.query({ kind: 'message.task-candidates', conversationId: info.run.conversationId, limit: 200 })
      const allRuns = await store.query({ kind: 'run.list', limit: 200 })
      return queryConversationTaskProgress({ queryText: action.arguments.objective ?? info.unit.goalText, conversationId: info.run.conversationId,
        actorId: info.run.actorId, ownerActorId, occurredAt: info.run.context?.occurredAt ?? info.run.createdAt,
        workflowOrigins: origins, workflowRuns: allRuns, legacyTasks: legacy.listTasks?.() ?? [] })
    }
    const taskId = info.binding.taskId ?? action.taskId
    const origin = await taskAccess(taskId, info.run.actorId, info.run.conversationId)
    const currentPlan = await ensureLegacyTaskRequirement(taskId)
    const recordIntent = () => taskOwner.event({ taskId, eventKey: `intent:${info.commandId}`,
      eventType: 'intent.received', payload: { action: action.intent, sourceRunId: info.run.runId,
        actorId: info.run.actorId, arguments: action.arguments, constraints: action.constraints } })
    const extendAcceptance = async () => {
      const criteria = action.arguments.acceptanceCriteria ?? [sourceRequestCriterion]
      for (const [index, criterion] of criteria.entries()) await store.command({
        id: `acceptance:${info.commandId}:${index}`, kind: 'task.owner.acceptance.extend',
        args: { taskId, itemId: `acceptance-${executionDigest([info.commandId, index]).slice(0, 32)}`,
          criterion, sourceKey: info.run.sourceKey,
          eventKey: `acceptance-event-${executionDigest([info.commandId, index]).slice(0, 32)}` },
      })
    }
    if (currentPlan && action.intent === 'resume' && currentPlan.task.controlState === 'active'
      && !['succeeded', 'cancelled'].includes(currentPlan.task.status)) {
      await recordIntent()
      return { taskId, runId: currentPlan.stages.findLast(stage => stage.runId)?.runId ?? null,
        status: 'accepted', reply: '补充信息已交由原任务继续核查。' }
    }
    if (currentPlan && ['pause', 'cancel', 'resume'].includes(action.intent)) {
      const controlled = await controller.controlTask({ commandId: `task-control:${info.commandId}`, taskId,
        intent: action.intent, expectedControlRevision: currentPlan.task.controlRevision })
      if (['pause', 'cancel'].includes(action.intent)) await taskOwner.cancel(taskId)
      await taskOwner.event({ taskId, eventKey: `control:${info.commandId}`, eventType: 'control.changed',
        payload: { intent: action.intent, sourceRunId: info.run.runId,
          controlRevision: controlled.plan.task.controlRevision } })
      return { taskId, runId: controlled.plan.stages.findLast(stage => stage.runId)?.runId ?? null,
        status: controlled.plan.task.status, reply: `目前${groupStatusText(controlled.plan.task.status)}。` }
    }
    if (action.intent === 'report') {
      if (!currentPlan || !await readAcceptedTaskCompletion(taskId, currentPlan)) throw executionError('TASK_REPORT_NOT_READY')
      await taskOwner.event({ taskId, eventKey: `report-language:${info.commandId}`,
        eventType: 'report.preference.changed', payload: { language: action.arguments.language,
          sourceRunId: info.run.runId, actorId: info.run.actorId } })
      await taskOwner.drive(taskId)
      const failures = await taskOwner.applyPending()
      if (failures.length) throw executionError(failures[0].code)
      return { taskId, status: 'accepted', reply: '已按当前任务的已核验结果重新生成报告。' }
    }
    if (['reopen', 'revise'].includes(action.intent)) {
      if (!currentPlan) throw executionError('TASK_PLAN_NOT_FOUND')
      let plan = currentPlan
      const wasCancelled = plan.task.controlState === 'cancelled'
      // 确认已有阶段不追加验收；其余修订在改需求/解除取消前整批检查，不能半批落账。
      if (!(action.intent === 'reopen' && !wasCancelled && plan.stages.some(stage => stage.status === 'waiting_confirmation'))) {
        const criteria = action.arguments.acceptanceCriteria === undefined ? [sourceRequestCriterion] : action.arguments.acceptanceCriteria
        if (!acceptanceCriteriaSchema.safeParse(criteria).success) throw executionError('TASK_OWNER_CRITERIA_INVALID')
        const active = await store.query({ kind: 'task.owner.acceptance', taskId })
        const added = criteria.filter((criterion, index) => !active.some(item => item.itemId === `acceptance-${executionDigest([info.commandId, index]).slice(0, 32)}`))
        if (added.length && !acceptanceCriteriaSchema.safeParse([...active.map(item => item.criterion), ...added]).success)
          throw executionError('TASK_OWNER_CRITERIA_INVALID')
      }
      if (action.intent === 'reopen' && wasCancelled) {
        const authorization = await artifacts.put({ taskId, sourceKey: info.run.sourceKey,
          actorId: info.run.actorId, conversationId: info.run.conversationId,
          intent: action.intent, commandId: info.commandId }, { taskId })
        await controller.controlTask({ commandId: `task-reopen:${info.commandId}`, taskId, intent: 'reopen',
          expectedControlRevision: plan.task.controlRevision,
          requirementRevision: plan.task.requirementRevision, authorizationRef: authorization.ref })
        plan = await controller.taskPlan(taskId)
      }
      const current = plan.stages.find(stage => stage.status === 'waiting_confirmation')
      if (current && action.intent === 'reopen' && !wasCancelled) {
        const predecessor = plan.stages[current.position - 1]
        if (!predecessor?.outputRef) throw executionError('TASK_CONFIRMATION_OUTPUT_MISSING')
        await controller.confirmTaskStage({ commandId: `confirm:${info.commandId}`, inputCommandId: info.commandId, taskId,
          stageId: current.stageId, planRevision: plan.task.planRevision, outputRef: predecessor.outputRef,
          expectedRequirementRevision: plan.task.requirementRevision,
          ...(current.sourceCondition ? { confirmation: { conditionDigest: executionDigest(current.sourceCondition),
            actorId: info.run.actorId, sourceKey: info.run.sourceKey, sourceVersion: info.run.sourceVersion } } : {}) })
        await recordIntent()
        await taskOwner.drive(taskId)
        const failures = await taskOwner.applyPending()
        if (failures.length) throw executionError(failures[0].code)
        return { taskId, status: 'accepted', reply: '验证已确认，等待后续处理。' }
      }
      const previous = await artifacts.read(plan.task.requirementRef)
      const objective = requireText(action.arguments.objective, 'WORKFLOW_OBJECTIVE_REQUIRED')
      const source = await store.query({ kind: 'task.source', sourceKey: info.run.sourceKey })
      if (!source || source.status === 'superseded') throw executionError('TASK_SOURCE_NOT_CURRENT')
      const uatSources = await verifyUatSourceRefs(action, info.run, info.binding)
      const target = engineeringTarget(Object.fromEntries(['repositoryId', 'uatEnvironment', 'targetId', 'commitSha', 'releaseTag', 'changeRef', 'pullRequestNumber', 'headCommitSha']
        .filter(key => action.arguments[key] !== undefined).map(key => [key, action.arguments[key]])), [source.body], previous.target)
      if (uatSources.length) target.uatEnvironment = action.arguments.uatEnvironment
      const fileDelivery = action.arguments.fileDelivery ? bindFileDelivery(action.arguments.fileDelivery, info.run.body) : previous.fileDelivery
      if (fileDelivery && !fileWorkflow) throw executionError('TASK_FILE_TRANSPORT_UNAVAILABLE')
      const next = { ...previous, request: taskSourceRequest(info), objective, title: taskTitle(action.arguments.title ?? objective),
        stageAuthorizations: [...(previous.stageAuthorizations ?? []), ...(action.arguments.stageAuthorizations ?? []).map(item => ({ ...item, sourceKey: info.run.sourceKey, sourceVersion: info.run.sourceVersion, ...(item.gate === 'confirmation' ? { requiredActorId: info.run.actorId } : {}) }))],
        sourceInstructions: [...new Map([...(previous.sourceInstructions ?? []), ...uatSources, { sourceKey: source.sourceKey, sourceVersion: source.sourceVersion, actorId: source.actorId, text: source.body }].map(item => [item.sourceKey, item])).values()], ...(fileDelivery ? { fileDelivery } : {}),
        acceptanceCriteria: action.arguments.acceptanceCriteria ?? previous.acceptanceCriteria,
        constraints: [...new Set([...(previous.constraints ?? []), ...(action.constraints ?? [])])],
        explicitStages: [...new Set([...(previous.explicitStages ?? []), ...(action.arguments.explicitStages ?? [])])],
        target,
        scope: { ...previous.scope, sourceKeys: [...new Set([...previous.scope.sourceKeys, ...uatSources.map(item => item.sourceKey), info.run.sourceKey])],
          ...(fileDelivery ? { artifactFiles: fileDelivery.files } : {}),
          sourceVersions: { ...previous.scope.sourceVersions, ...Object.fromEntries(uatSources.map(item => [item.sourceKey, item.sourceVersion])), [info.run.sourceKey]: source.sourceVersion },
          writeMarkdown: previous.scope.writeMarkdown || /(?:生成|创建|写入|输出|保存).{0,16}(?:Markdown|md文件|文档|文件)/iu.test(info.run.body) },
        authorization: { actorId: info.run.actorId, sourceKey: info.run.sourceKey,
          sourceVersion: info.run.sourceVersion, commandId: info.commandId,
          ownerConfirmed: previous.authorization?.ownerConfirmed === true } }
      const saved = await artifacts.put(next, { taskId })
      await store.command({ id: `task-requirement:${info.commandId}`, kind: 'task.requirement.update', args: {
        taskId, expectedRequirementRevision: plan.task.requirementRevision, requirementRef: saved.ref,
        eventKey: `intent:${info.commandId}`,
      } })
      await extendAcceptance()
      let planningError = null
      try {
        await taskOwner.drive(taskId)
        const failures = await taskOwner.applyPending()
        planningError = failures[0]?.code ?? null
      } catch (cause) { planningError = cause.code ?? cause.message }
      return { taskId, status: 'accepted', reply: '任务要求已更新，正在核对后续处理。' }
    }
    const existingRuns = await store.query({ kind: 'run.list', taskId, limit: 200 })
    if (!existingRuns.length) {
      if (['status', 'result'].includes(action.intent)) return singleTaskProgressResult({ taskId,
        status: currentPlan?.task.status ?? origin.command.status, beforeStart: true,
        reply: `任务尚未开始执行；当前状态：${groupStatusText(currentPlan?.task.status ?? origin.command.status)}` })
      if (!['cancel', 'pause', 'resume', 'revise'].includes(action.intent)) throw executionError('WORKFLOW_ACTION_NOT_ADMITTED')
      const receipt = await store.command({ id: `prestart:${info.commandId}`, kind: 'message.task.control', args: {
        taskId, action: action.intent, actorId: info.run.actorId, sourceRunId: info.run.runId,
        ...(action.intent === 'revise' ? { arguments: { ...origin.command.args.arguments, ...action.arguments }, constraints: [...new Set([...(origin.command.args.constraints ?? []), ...(action.constraints ?? [])])] } : {}),
      } })
      return { taskId, status: receipt.result.command.status, beforeStart: true, reply: `任务执行前已记录${groupActionText(action.intent)}要求，尚未开始处理。` }
    }
    const state = await currentTask(taskId, action.arguments.runId ?? info.binding.runId)
    const args = { commandId: `dispatch:${info.commandId}`, runId: state.run.runId }
    if (action.intent === 'status' || action.intent === 'result') {
      const last = state.nodes.filter(node => node.outputRef).at(-1)
      const output = last ? await artifacts.read(last.outputRef) : null
      const owner = currentPlan ? await store.query({ kind: 'task.owner', taskId }) : null
      const taskComplete = owner?.decision?.action === 'complete' && owner.applicationStatus === 'applied'
        && currentPlan?.task.planRequirementRevision === currentPlan?.task.requirementRevision
        && owner.eventWatermark === owner.processedWatermark
      const status = currentPlan ? taskComplete ? 'succeeded' : currentPlan.task.status : state.run.status
      return singleTaskProgressResult({ taskId, runId: state.run.runId, status, observedAt: new Date().toISOString(), output,
        reply: action.intent === 'result' && workflowResultText(output)
          ? `${taskComplete ? '任务结果' : '当前流程结果'}：${workflowResultText(output)}`
          : `目前${groupStatusText(status)}。` })
    }
    if (action.intent === 'cancel') await controller.stop({ ...args, reason: info.unit.goalText })
    else if (action.intent === 'pause') await controller.pause({ ...args, reason: info.unit.goalText })
    else if (action.intent === 'resume') await controller.resume(args)
    else if (action.intent === 'revise') {
      const previous = await artifacts.read(state.run.requirementRef)
      await controller.changeInput({ ...args, inputId: info.commandId, sourceKey: info.run.sourceKey,
        input: { ...previous, request: requireText(action.arguments.objective, 'WORKFLOW_OBJECTIVE_REQUIRED'),
          title: taskTitle(action.arguments.title ?? action.arguments.objective),
          ...(Object.hasOwn(previous, 'acceptanceCriteria') ? { acceptanceCriteria: action.arguments.acceptanceCriteria ?? previous.acceptanceCriteria } : {}),
          constraints: [...new Set([...(previous.constraints ?? []), ...(action.constraints ?? [...(info.unit.constraints ?? []), ...(info.unit.sharedConstraints ?? [])])])] } })
      if (currentPlan) await recordIntent()
    } else throw executionError('WORKFLOW_ACTION_NOT_ADMITTED')
    const observed = await controller.state(state.run.runId)
    return { taskId, runId: state.run.runId, status: observed.run.status, reply: `目前${groupStatusText(observed.run.status)}。` }
  }
  async function cancellableAnswers(run) {
    const answers = []
    for (const key of new Set((run.context?.quoteRefs ?? []).map(ref => ref.sourceKey).filter(Boolean))) {
      const source = await store.query({ kind: 'message.source', sourceKey: key })
      if (!source || source.runId === run.runId || source.status === 'superseded'
        || source.conversationId !== run.conversationId || source.actorId !== run.actorId) continue
      const data = await store.query({ kind: 'message.run', runId: source.runId })
      for (const entry of data.executions ?? []) {
        const target = data.commands.find(item => item.id === entry.commandId)
        if (!['running', 'waiting_user', 'ready', 'interrupted', 'cancelling'].includes(entry.status)
          || !target || target.kind !== 'answer' || !['running', 'waiting', 'pending'].includes(target.status)) continue
        answers.push({ commandId: entry.commandId, runId: source.runId, unitId: entry.unitId,
          sourceVersion: source.sourceVersion, inputVersion: entry.inputVersion, inputDigest: entry.inputDigest,
          objective: target.args?.arguments?.objective ?? source.body, status: entry.status, sourceKey: source.sourceKey })
      }
    }
    return answers
  }
  async function selectedAnswerCancellation(action, run, unitId, suppliedRequests) {
    const targets = await cancellableAnswers(run)
    const target = targets.find(item => item.commandId === action.arguments.commandId)
    if (!target) return null
    const requests = suppliedRequests ?? (await store.query({ kind: 'message.run', runId: run.runId })).requests
    const request = requests.findLast(item => item.unitId === unitId && item.revision === run.revision
      && item.reason === 'MESSAGE_AGENT_CANCEL_TARGET_REQUIRED')
    if (!request) return targets.length === 1 ? target : null
    if (request.status !== 'resolved' || !request.answer?.trim() || !request.eventId) return null
    const reference = request.needs?.find(item => item.reason === 'message-answer-cancel-snapshot')?.resourceRef
    if (!reference) return null
    const snapshot = await artifacts.read(reference)
    if (snapshot.runId !== run.runId || snapshot.revision !== run.revision || snapshot.sourceVersion !== run.sourceVersion
      || snapshot.actorId !== run.actorId || snapshot.conversationId !== run.conversationId || snapshot.unitId !== (request.authorizationUnitId ?? request.unitId)) return null
    return snapshot.targets.some(item => item.commandId === target.commandId && item.runId === target.runId
      && item.sourceVersion === target.sourceVersion && item.inputVersion === target.inputVersion
      && item.inputDigest === target.inputDigest) ? target : null
  }
  const handlers = Object.fromEntries(['cancel', 'pause', 'resume', 'revise', 'report', 'reopen', 'status', 'result'].map(kind => [kind, taskAction]))
  handlers.cancel_answer = async (action, info) => {
    const target = await selectedAnswerCancellation(action, info.run, info.unit.authorizationUnitId ?? info.unit.id ?? info.unit.unitId)
    if (!target) throw executionError('MESSAGE_AGENT_CANCEL_TARGET_REQUIRED')
    await messageAgent.cancel(target.commandId, `source:${info.run.sourceKey}`)
    return { status: 'cancelled', reply: '已停止你引用的问答查询。' }
  }
  for (const intent of ['status', 'result']) handlers[intent] = async (action, info) => {
    if (info.binding.engine !== 'legacy') return taskAction(action, info)
    const task = legacy.getTask?.(info.binding.taskId)
    if (!task || task.groupId !== info.run.conversationId) throw executionError('WORKFLOW_TASK_FORBIDDEN')
    return singleTaskProgressResult({ taskId: task.taskId, engine: 'legacy', status: task.state, outcome: task.outcome, observedAt: new Date().toISOString(),
      reply: info.run.actorId === ownerActorId && intent === 'result' ? (typeof task.result === 'string' ? task.result : task.result?.summary ?? task.completion ?? '旧任务没有保存可读取的结果正文。') : `之前的事项目前${groupStatusText(task.state)}${task.outcome ? `（${groupStatusText(task.outcome)}）` : ''}；UAT2：${task.result?.delivery?.uat2Status ? groupStatusText(task.result.delivery.uat2Status) : '尚未核验部署结果'}。` })
  }
  handlers.create = createTask
  handlers.research = createTask
  handlers.answer = (action, info) => messageAgent.start(action, info)
  handlers.fact = async (action, info) => {
    const topic = await store.query({ kind: 'message.topic', topicId: action.binding.topicId })
    const taskId = info.binding.taskId ?? action.taskId
    if (taskId) {
      const origin = await store.query({ kind: 'task.origin', taskId })
      if (origin?.run.conversationId === info.run.conversationId
        && await store.query({ kind: 'task.owner', taskId }))
        await taskOwner.event({ taskId, eventKey: `topic-fact:${info.commandId}`,
          eventType: action.arguments.kind === 'constraint' ? 'intent.received' : 'topic.fact',
          payload: { sourceKey: info.run.sourceKey, actorId: info.run.actorId,
            kind: action.arguments.kind, text: action.arguments.text } })
    }
    return { status: 'recorded', sourceKey: info.run.sourceKey, topic }
  }
  handlers.no_action = async () => ({ status: 'ignored' })
  handlers.clarification = async (action, info) => resumeRequest({
    runId: action.arguments.runId, requestId: action.arguments.requestId,
    eventId: info.run.sourceKey, answer: info.run.body,
  }, { channel: 'im', actorId: info.run.actorId, conversationId: info.run.conversationId })
  handlers.approval = async (action, info) => {
    const requestId = requireText(action.arguments.requestId, 'WORKFLOW_APPROVAL_REQUEST_REQUIRED')
    if (!info.run.body.includes(requestId) && !info.run.context.quoteRefs?.some(ref => ref.text?.includes(requestId))) throw executionError('WORKFLOW_APPROVAL_SOURCE_REQUIRED')
    return decideApproval({ requestId, decision: action.arguments.decision, eventId: info.run.sourceKey },
      { channel: 'im', actorId: info.run.actorId, conversationId: info.run.conversationId })
  }
  async function passiveTopic(run) {
    const quotes = run.context?.quoteRefs ?? []
    if (!quotes.length || quotes.length > 4) return null
    const matches = new Map()
    for (const quote of quotes) {
      if (!quote.messageId || !quote.sourceKey) continue
      const sourceKeys = [quote.sourceKey]
      const notification = await store.query({ kind: 'message.outboundByMessage', conversationId: run.conversationId, messageId: quote.messageId })
      if (notification?.status === 'delivered' && notification.evidence?.messageId === quote.messageId && notification.payload?.sourceMessageId)
        sourceKeys.push(sourceKey(config.profile ?? '', run.conversationId, notification.payload.sourceMessageId))
      for (const item of legacyGroup(run.conversationId)?.outbox ?? [])
        if (item.status === 'sent' && item.deliveredMessageId === quote.messageId && item.sourceMessageId)
          sourceKeys.push(sourceKey(config.profile ?? '', run.conversationId, item.sourceMessageId))
      for (const evidenceSourceKey of new Set(sourceKeys)) {
        const evidence = await store.query({ kind: 'task.source', sourceKey: evidenceSourceKey })
        if (!evidence || evidence.conversationId !== run.conversationId || evidence.sourceKey === run.sourceKey) continue
        const topics = await store.query({ kind: 'message.topic.source', sourceKey: evidenceSourceKey })
        for (const topic of topics.filter(item => item.conversationId === run.conversationId))
          matches.set(topic.topicId, { topicId: topic.topicId, evidenceSourceKey, quoteMessageId: quote.messageId })
      }
    }
    return matches.size === 1 ? matches.values().next().value : null
  }
  async function fullTopic(topicId) {
    let topic = await store.query({ kind: 'message.topic', topicId })
    if (!topic) return null
    const facts = topic.hasMoreFacts ? [] : topic.facts
    let cursor = 0
    let version = null
    while (topic.hasMoreFacts && cursor !== null) {
      const page = await store.query({ kind: 'message.topic.facts', topicId, status: 'active', cursor, limit: 100 })
      if (version !== null && version !== page.contextRevision) throw executionError('MESSAGE_TOPIC_CONTEXT_STALE')
      version = page.contextRevision
      facts.push(...page.facts)
      cursor = page.nextCursor
    }
    if (version !== null) {
      topic = await store.query({ kind: 'message.topic', topicId })
      if (topic.contextRevision !== version) throw executionError('MESSAGE_TOPIC_CONTEXT_STALE')
    }
    // 仅合并同一发送人逐字相同的事实。不同表述、不同发送人的授权和全部历史原记录仍保留。
    const currentFacts = new Map()
    for (const fact of facts) {
      const key = executionDigest([fact.actorId, fact.kind, fact.text])
      const existing = currentFacts.get(key)
      if (existing) existing.equivalentFactCount = (existing.equivalentFactCount ?? 1) + 1
      else currentFacts.set(key, { ...fact })
    }
    return { ...topic, facts: [...currentFacts.values()], historyFactCount: facts.length, hasMoreFacts: false }
  }
  const messageContext = {
      agentNames,
      groups: () => [...groups],
      passiveTopic,
      async authorizePriorityControl({ run, unit, binding }) {
        const taskId = binding?.taskId ?? binding?.target?.taskId
        if (!taskId || binding?.disposition !== 'existing') return null
        const origin = await store.query({ kind: 'task.origin', taskId })
        if (!origin || origin.run.conversationId !== run.conversationId || origin.run.actorId !== run.actorId) return null
        const text = unit.goalText?.trim().replace(/^@\S+\s*/u, '') ?? ''
        const actions = [
          [/^(?:暂停|先停|先暂停)(?:这个|该|当前)?任务[。！!]?$/u, 'pause'],
          [/^(?:取消|停止)(?:这个|该|当前)?任务[。！!]?$/u, 'cancel'],
          [/^(?:恢复|继续)(?:这个|该|当前)?任务[。！!]?$/u, 'resume'],
        ].filter(([pattern]) => pattern.test(text))
        return actions.length === 1 ? { taskId, action: actions[0][1] } : null
      },
      async validateAction(action, info) {
        const reject = reason => ({ allowed: false, reason })
        if (action.intent === 'cancel_answer') {
          return await selectedAnswerCancellation(action, info.run, info.unit.authorizationUnitId ?? info.unit.id ?? info.unit.unitId)
            ? { allowed: true } : reject('请引用本人要停止的原问题，并明确唯一事项；不能取消他人或不明确的问答')
        }
        if (action.intent === 'answer' && !messageAnswerArguments.safeParse(action.arguments).success) return reject('请说明需要回答的具体问题')
        if (info.binding.engine === 'legacy') {
          const task = legacy.getTask?.(info.binding.taskId)
          if (!task || task.groupId !== info.run.conversationId) return reject('无权读取该旧任务')
          return ['status', 'result', 'no_action', 'fact', 'answer'].includes(action.intent) ? { allowed: true } : reject('旧任务只读，请明确发起新工作流任务')
        }
        if (!handlers[action.intent] && action.intent !== 'no_action') return reject(`尚未提供 ${action.intent} 处理流程`)
        if (['create', 'research', 'reopen'].includes(action.intent) && !await mayCreate(info.run, action.arguments.workflowId, info.binding, { ...action, commandId: info.commandId })
          && !await ownerConfirmedPriorTask(action, info)) return reject('当前消息发送人没有创建业务任务的权限')
        if (['create', 'research', 'reopen'].includes(action.intent)
          && !action.arguments.objective?.trim()) return reject('任务目标未明确')
        if (['pause', 'cancel', 'resume', 'revise', 'status', 'result'].includes(action.intent) && info.binding.disposition !== 'conversation') {
          const taskId = info.binding.taskId ?? action.taskId
          if (!taskId) return reject('请求未关联到唯一任务')
          const origin = await store.query({ kind: 'task.origin', taskId })
          if (!origin || origin.run.conversationId !== info.run.conversationId || ![origin.run.actorId, ownerActorId].includes(info.run.actorId)) return reject('当前发送人无权访问该群中的目标任务')
          if (action.arguments.runId && action.arguments.runId !== 'current') {
            const runs = await store.query({ kind: 'run.list', taskId, limit: 200 })
            if (!runs.some(run => run.runId === action.arguments.runId)) return reject('指定执行版本不属于目标任务')
          }
        }
        return { allowed: true }
      },
      async splitBackground({ history }) {
        return { messages: history, omissions: [] }
      },
      async history(run) {
        const recent = await store.query({ kind: 'message.list', conversationId: run.conversationId, limit: 200 })
        const outboundIds = new Set(await store.query({ kind: 'message.outboundIds', conversationId: run.conversationId }))
        const cutoff = messageTimestamp(run.context?.occurredAt ?? run.createdAt)
        const current = []
        for (const item of recent) {
          if (item.runId === run.runId || !(messageTimestamp(item.context?.occurredAt ?? item.createdAt) < cutoff) || item.reason === 'message_reprocessed') continue
          if (outboundIds.has(item.context?.sourceMessageId)) continue
          current.push(item)
          if (current.length === 30) break
        }
        current.reverse()
        const old = (legacyGroup(run.conversationId)?.messages ?? []).filter(item => (!item.isBackfill || item.routingStatus === 'routed') && (!item.occurredAt || messageTimestamp(item.occurredAt) < cutoff) && typeof item.text === 'string' && item.text.trim()).slice(-30)
          .map(item => ({ sourceKey: sourceKey(config.profile ?? '', run.conversationId, item.messageId), sourceVersion: item.messageVersion ?? 1, text: item.text, ...(item.senderOpenDingTalkId ? { actorId: item.senderOpenDingTalkId } : {}) }))
        return [...old, ...current.map(item => ({ sourceKey: item.sourceKey, sourceVersion: item.sourceVersion, text: item.body, actorId: item.actorId, attachments: item.context?.attachments ?? [] }))].slice(-30)
      },
      async localQuote(ref, run) {
        const key = typeof ref === 'string' ? ref : ref.sourceKey
        const found = await store.query({ kind: 'task.source', sourceKey: key })
        if (found && found.conversationId === run.conversationId) return { sourceKey: key, sourceVersion: found.sourceVersion, text: found.body, attachments: found.context?.attachments ?? [] }
        if (typeof ref === 'object' && ref.text) return ref
        return null
      },
      async candidates({ run, unit, explicitSourceKeys = [] }) {
        const values = await store.query({ kind: 'run.list', limit: 200 })
        const result = []
        const origins = []
        let beforeSequenceId
        do {
          const page = await store.query({ kind: 'message.task-candidates', conversationId: run.conversationId, limit: 200, ...(beforeSequenceId ? { beforeSequenceId } : {}) })
          origins.push(...page)
          beforeSequenceId = page.length === 200 ? page.at(-1).sequenceId : null
          if (origins.length >= 10000 && beforeSequenceId) throw executionError('MESSAGE_CANDIDATE_CATALOG_CAPACITY')
        } while (beforeSequenceId)
        const quoted = new Set([...(run.context.quoteRefs ?? []).map(ref => ref.sourceKey), ...(run.context.editOf ? [run.sourceKey] : []), ...explicitSourceKeys])
        for (const origin of origins) {
          if (origin.run.runId === run.runId || (['superseded', 'failed'].includes(origin.command.status) && !(run.context.editOf && origin.run.sourceKey === run.sourceKey))) continue
          const item = values.find(value => value.taskId === origin.command.args.taskId)
          const explicit = quoted.has(origin.run.sourceKey)
          result.push({ candidateId: item?.runId ?? origin.command.commandId, taskId: origin.command.args.taskId, ...(origin.command.args.binding?.topicId ? { topicId: origin.command.args.binding.topicId } : {}), ...(item ? { runId: item.runId } : {}),
            title: origin.command.args.arguments.objective, goal: origin.command.args.arguments.objective, state: item?.status ?? 'accepted',
            historyRef: `workflow-task-history:${origin.command.args.taskId}`,
            relevantTime: item?.updatedAt ?? origin.run.createdAt, versions: { requirement: item?.revision ?? 0 },
            sourceRefs: [origin.run.sourceKey], explicitReferenceMatches: explicit ? [origin.run.sourceKey] : [],
            distinguishingFacts: [...(item ? [] : ['任务命令已接纳，执行实例尚未创建']), ...(run.context.editOf && origin.run.sourceKey === run.sourceKey ? ['被本条编辑直接修订的原任务；不得再次创建相同Task'] : [])] })
        }
        const topics = []
        let beforeTopicRowId
        do {
          const page = await store.query({ kind: 'message.topics', conversationId: run.conversationId, limit: 200, ...(beforeTopicRowId ? { beforeTopicRowId } : {}) })
          topics.push(...page)
          beforeTopicRowId = page.length === 200 ? page.at(-1).sequenceId : null
          if (topics.length >= 10000 && beforeTopicRowId) throw executionError('MESSAGE_CANDIDATE_CATALOG_CAPACITY')
        } while (beforeTopicRowId)
        const explicitTopics = new Map()
        for (const key of quoted) for (const topic of await store.query({ kind: 'message.topic.source', sourceKey: key })) {
          if (topic.conversationId === run.conversationId) explicitTopics.set(topic.topicId, [...(explicitTopics.get(topic.topicId) ?? []), key])
        }
        for (const topic of topics) {
          if (topic.facts.every(fact=>fact.sourceRunId===run.runId)) continue
          const taskCards = result.filter(card => card.topicId === topic.topicId)
          if (taskCards.length) {
            for (const card of taskCards) { card.topicTitle = topic.title; card.summary = topic.summary ?? '' }
            continue
          }
          result.push({ candidateId: topic.topicId, topicId: topic.topicId, title: topic.title, summary: topic.summary ?? '', goal: topic.title, state: 'topic', relevantTime: topic.updatedAt,
            versions: { topic: topic.revision }, sourceRefs: topic.facts.flatMap(fact => fact.sourceRefs.map(ref => ref.sourceKey)),
            explicitReferenceMatches: explicitTopics.get(topic.topicId) ?? [], distinguishingFacts: ['话题事实，尚未关联执行Task'] })
        }
        const legacyTasks = legacy.listTasks?.() ?? []
        const group = legacyGroup(run.conversationId)
        const legacyTopics = legacy.listTopics?.(run.conversationId) ?? []
        const cutoff = messageTimestamp(run.context?.occurredAt ?? run.createdAt)
        for (const task of legacyTasks) {
          if (task.groupId !== run.conversationId) continue
          if (task.createdAt && messageTimestamp(task.createdAt) >= cutoff) continue
          const sourceIds = [...(task.sourceMessageIds ?? []), ...(group?.outbox ?? []).filter(item => item.taskIds?.includes(task.taskId)).flatMap(item => [item.deliveredMessageId, item.replyToMessageId, ...(item.matterSourceMessageIds ?? [])]),
            ...legacyTopics.filter(topic => task.topicRefs?.some(ref => ref.topicId === topic.topicId)).flatMap(topic => topic.entries?.map(entry => entry.messageId) ?? [])].filter(Boolean)
          const references = [...new Set(sourceIds)].map(id => sourceKey(config.profile ?? '', run.conversationId, id))
          result.push({ candidateId: `legacy:${task.taskId}`, engine: 'legacy', taskId: task.taskId, title: task.title ?? task.objective ?? task.taskId, goal: task.objective ?? task.title ?? task.taskId, state: task.state,
            historyRef: `task-history:${task.taskId}`,
            relevantTime: task.updatedAt ?? task.completedAt ?? task.createdAt ?? null, versions: { inputVersion: task.inputVersion ?? 1, runSequence: task.runSequence ?? 1 }, sourceRefs: references,
            explicitReferenceMatches: references.filter(key => quoted.has(key)), distinguishingFacts: [`旧引擎任务状态：${task.state}；结果：${task.outcome ?? '未记录'}；UAT2：${task.result?.delivery?.uat2Status ?? '未见部署回执'}；仅支持只读查询`] })
        }
        const previous = run.snapshot?.history?.at(-1)
        const recentReference = /^(?:这|这个|刚才|上面|前面|不是让你)/u.test(run.body.trim())
          && previous?.actorId === run.actorId ? previous.sourceKey : null
        rankMessageCandidates(result, unit.goalText, recentReference)
        const cards = result.map((card, index) => {
          if (index > 1 || card.engine !== 'legacy') return card
          const task = legacy.getTask?.(card.taskId)
          const lastChange = task?.objectiveHistory?.at(-1)?.objective
          return { ...card, distinguishingFacts: [...card.distinguishingFacts,
            `最近目标：${String(lastChange ?? task?.objective ?? task?.title ?? '').slice(0, 160)}`,
            `结果：${String(task?.outcome ?? task?.result ?? '未记录').slice(0, 120)}`] }
        })
        for (const card of cards.slice(0, 8)) {
          if (!card.taskId || card.engine === 'legacy') continue
          let origin
          try { origin = await taskAccess(card.taskId, run.actorId, run.conversationId) }
          catch (error) { if (error.code === 'WORKFLOW_TASK_FORBIDDEN') continue; throw error }
          const facts = await taskFacts(origin)
          if (facts.result?.outputRef) card.resultRef = facts.result.outputRef
          card.distinguishingFacts.push(`执行状态：${facts.status}；业务目标：${facts.objectiveAssessment.status}`)
          if (facts.result?.summary) card.distinguishingFacts.push(`已执行结果：${facts.result.summary.slice(0, 240)}`)
          if (facts.result?.limitations?.length) card.distinguishingFacts.push(`结果限制：${facts.result.limitations.slice(0, 4).join('；')}`)
        }
        // 目录只投影可回读的历史引用；全文按需读取，不为每条来源复制整份候选材料账。
        const bounded = cards.map(card => card.historyRef
          ? candidateCards([{ ...card, detailRef: card.historyRef }])[0]
          : card)
        return { cards: bounded, total: result.length, explicitOverflow: false, catalogRevision: executionDigest(bounded.map(card => [card.candidateId, card.versions])) }
      },
      async facts({ run, binding, unit, conversationFacts = false }) {
        if (conversationFacts) {
          const intent = unit?.intent
          if (intent?.kind !== 'intent' || !intent.actions?.length || intent.replyPolicy !== 'none'
            || intent.actions.some(action => action.intent !== 'fact' || action.arguments?.scope !== 'conversation')
            || binding.taskId) throw executionError('WORKFLOW_TASK_FORBIDDEN')
          const topic = binding.topicId ? await fullTopic(binding.topicId) : null
          if (!topic || topic.conversationId !== run.conversationId) throw executionError('WORKFLOW_TOPIC_FORBIDDEN')
          return { topic: { ...topic, facts: topic.facts.map(fact => ({ ...fact,
            sourceRefs: fact.sourceRefs.map(({ text: _text, ...ref }) => ref) })),
            sources: [...new Map(topic.facts.flatMap(fact => fact.sourceRefs)
              .map(ref => [`${ref.sourceKey}:${ref.sourceVersion}`, ref])).values()] } }
        }
        const clarificationRequests = []
        for (const pending of await store.query({ kind: 'message.pending' })) {
          if (pending.runId === run.runId || pending.conversationId !== run.conversationId || pending.status === 'superseded') continue
          const state = await messages.state(pending.runId)
          for (const request of state.requests) {
            if (!['needs_clarification', 'needs_authorization'].includes(request.kind) || request.status !== 'pending'
              || request.revision !== state.run.revision
              || !(request.permittedActors ?? []).includes(run.actorId) && run.actorId !== ownerActorId) continue
            clarificationRequests.push({ runId: pending.runId, requestId: request.id, sourceKey: pending.sourceKey,
              sourceVersion: pending.sourceVersion, actorId: pending.actorId, sourceText: pending.body,
              question: request.question, reason: request.reason, kind: request.kind, unitId: request.unitId })
          }
        }
        const cancellable = { cancellableAnswers: await cancellableAnswers(run), clarificationRequests }
        if (binding.engine === 'legacy') {
          const task = legacy.getTask?.(binding.taskId)
          if (!task || task.groupId !== run.conversationId) throw executionError('WORKFLOW_TASK_FORBIDDEN')
          return { ...cancellable, legacyTask: { taskId: task.taskId, title: task.title, objective: task.objective ?? task.title, state: task.state, outcome: task.outcome ?? 'legacy-unknown', updatedAt: task.updatedAt ?? task.createdAt ?? null, uat2Status: task.result?.delivery?.uat2Status ?? null }, readOnly: true }
        }
        const storedTopic = binding.topicId ? await fullTopic(binding.topicId) : null
        if (binding.topicId && (!storedTopic || storedTopic.conversationId !== run.conversationId)) throw executionError('WORKFLOW_TOPIC_FORBIDDEN')
        const topic = storedTopic ? { ...storedTopic, facts: storedTopic.facts.map(fact => ({ ...fact, sourceRefs: fact.sourceRefs.map(({ text: _text, ...ref }) => ref) })), sources: [...new Map(storedTopic.facts.flatMap(fact => fact.sourceRefs).map(ref => [`${ref.sourceKey}:${ref.sourceVersion}`, ref])).values()] } : null
        if (!binding.taskId) {
          const admission = await taskAdmission(run, binding)
          return { ...cancellable, ...(topic ? { topic, ...(await topicTaskFacts(topic, run)) } : {}),
            availableWorkflows: [...readOnlyCatalog, ...generalCatalog, ...engineering.availableWorkflows(), ...externalWorkflows],
            unavailableWorkflows, actorMayCreate: admission.allowed, taskAdmission: admission }
        }
        await taskAccess(binding.taskId, run.actorId, run.conversationId)
        const origin = await store.query({ kind: 'task.origin', taskId: binding.taskId })
        const detail = await taskFacts(origin, binding.runId)
        return { ...cancellable, ...(topic ? { topic } : {}), task: detail,
          ...(topic ? { topicTasks: await topicTaskFacts(topic, run) } : {}) }
      },
      async validateActions({ run, unit, binding, intent, requests, facts, relatedSourceRuns }) {
        for (const action of intent.actions) await verifyUatSourceRefs(action, run, binding, relatedSourceRuns)
        const acceptedAdmission = { kind: 'accepted' }
        const inheritedConstraints = (facts?.topic?.facts ?? []).filter(fact => fact.kind === 'constraint'
          && !(intent.factRevisions ?? []).some(revision => revision.factId === fact.id)).map(fact => fact.text)
        const creations = intent.actions.filter(action => ['create', 'research', 'reopen'].includes(action.intent))
          .map(action => ({ intent: action.intent, arguments: action.arguments, constraints: [...new Set([...inheritedConstraints, ...intent.constraints])],
            requiredExecutionMaterials: intent.requiredExecutionMaterials }))
        for (const action of creations) {
          const admission = await taskAdmission(run, binding, action)
          if (admission.allowed) { if (admission.authorizationRequestId) acceptedAdmission.authorizationRequestId = admission.authorizationRequestId; continue }
          if (['OWNER_REJECTED', 'ADDRESSED_TO_OTHERS'].includes(admission.reasonCode)) return { kind: 'rejected', reason: 'TASK_ADMISSION_REJECTED', reasonCode: admission.reasonCode }
          const ownerSource = (await store.query({ kind: 'message.list', conversationId: run.conversationId, limit: 200 }))
            .find(source => source.actorId === ownerActorId && source.context?.senderName)
          const ownerName = ownerSource?.context.senderName
            ?? legacyGroup(run.conversationId)?.messages?.find(message => message.senderOpenDingTalkId === ownerActorId && message.senderName)?.senderName ?? ownerActorId
          return { kind: 'needs_authorization', reason: 'TASK_ADMISSION_APPROVAL_REQUIRED', responsibility: 'owner',
            question: `已明确交办内容：${creations.map(item => item.arguments.objective).join('；')}。当前交办来源尚未满足任务准入，请任务所有者 ${ownerName} 引用本通知回复“同意”或“拒绝”。该确认仅允许承接此事项，生产操作仍需独立审批。`,
            permittedActors: [ownerActorId], needs: [], authorization: { sourceKey: run.sourceKey, sourceVersion: run.sourceVersion,
              actorId: run.actorId, conversationId: run.conversationId, topicId: binding.topicId,
              actionDigest: executionDigest(creations), actions: creations } }
        }
        for (const action of intent.actions) {
          const authorizations = action.arguments.stageAuthorizations ?? []
          if (catalogById.get(action.arguments.workflowId)?.mode === 'external'
            && !authorizations.some(item => item.workflowId === action.arguments.workflowId)
            || authorizations.some(item => catalogById.get(item.workflowId)?.mode === 'external'
              && (typeof item.objective !== 'string' || !item.objective.trim() || !['none', 'confirmation'].includes(item.gate))))
            throw executionError('TASK_STAGE_AUTHORIZATION_SOURCE_INVALID', '外部阶段授权必须包含当前原文 sourceQuote、逐字 objective 和明确 gate；不能只指定 workflowId。')
          if (authorizations.some(item => !run.body.includes(item.sourceQuote) || item.objective && !item.sourceQuote.includes(item.objective)))
            throw executionError('TASK_STAGE_AUTHORIZATION_SOURCE_INVALID', 'stageAuthorizations.sourceQuote 必须逐字引用当前 runId 原文，stageAuthorizations.objective 必须是该 sourceQuote 的连续原文片段；完整业务目标写入 arguments.objective，不得改写授权证据或借用其他作者消息。请修正候选后重新提交。')
        }
        for (const action of intent.actions.filter(item => item.intent === 'cancel_answer')) {
          const targets = await cancellableAnswers(run)
          if (!await selectedAnswerCancellation(action, run, unit.id ?? unit.unitId, requests)) {
            const snapshot = await artifacts.put({ runId: run.runId, revision: run.revision, sourceVersion: run.sourceVersion,
              actorId: run.actorId, conversationId: run.conversationId, unitId: unit.id ?? unit.unitId, targets })
            return {
            kind: 'needs_clarification', reason: 'MESSAGE_AGENT_CANCEL_TARGET_REQUIRED',
            question: targets.length > 1 ? `请明确要停止哪个查询：${targets.map(item => item.objective).join('；')}。`
              : '请引用你本人要停止的原问题，并明确具体事项。',
            needs: [{ resourceRef: snapshot.ref, reason: 'message-answer-cancel-snapshot' }],
            }
          }
        }
        for (const action of intent.actions.filter(item => item.intent === 'clarification')) {
          const target = action.arguments.runId === run.runId ? await messages.state(run.runId)
            : await messages.state(action.arguments.runId).catch(() => null)
          const request = target?.requests.find(item => item.id === action.arguments.requestId)
          if (!request || !['needs_clarification', 'needs_authorization'].includes(request.kind) || request.status !== 'pending'
            || target.run.conversationId !== run.conversationId || request.revision !== target.run.revision
            || !(request.permittedActors ?? []).includes(run.actorId) && run.actorId !== ownerActorId) return {
            kind: 'needs_clarification', reason: 'CLARIFICATION_TARGET_INVALID',
            question: '这条消息没有可确认的待答澄清，请明确所指的排查事项。', needs: [],
          }
        }
        if (!run.context.editOf) return acceptedAdmission
        const original = await messages.state(run.context.editOf.sourceRunId)
        const previous = original.commands.filter(item => item.args?.taskId && ['create', 'research', 'answer', 'reopen'].includes(item.kind))
        if (!previous.length) return acceptedAdmission
        const confirmedNew = requests.some(request => request.unitId === unit.unitId && request.reason === 'SOURCE_EDIT_NEW_MATTER' && request.status === 'resolved' && request.answer === '新增独立任务')
        if (intent.actions.some(action => ['create', 'research', 'reopen'].includes(action.intent)) && !confirmedNew) return { kind: 'needs_clarification', reason: 'SOURCE_EDIT_NEW_MATTER', question: '原消息已有任务。本次是修改原任务，还是新增独立事项？若确需新增，请回复“新增独立任务”；否则说明要修改或取消哪个原任务。', needs: [] }
        if (confirmedNew && intent.actions.some(action => ['create', 'research', 'reopen'].includes(action.intent)) && binding.taskId) return { kind: 'needs_clarification', reason: 'SOURCE_EDIT_NEW_MATTER_BINDING', question: '新增事项仍关联原任务，请明确新事项的独立目标。', needs: [] }
        if (intent.actions.some(action => ['revise', 'cancel', 'pause', 'resume'].includes(action.intent)) && !previous.some(item => item.args.taskId === binding.taskId)) return { kind: 'needs_clarification', reason: 'SOURCE_EDIT_TARGET_UNRESOLVED', question: '请指定本次编辑要修订、暂停或取消的原任务。', needs: [] }
        if (intent.actions.every(action => action.intent === 'no_action')) return { kind: 'needs_clarification', reason: 'SOURCE_EDIT_CONTROL_UNRESOLVED', question: '原消息已有任务。此次编辑是取消原任务，还是仅修改说明并继续原任务？', needs: [] }
        return acceptedAdmission
      },
      async bindTopic({ run, unit, binding, facts }) {
        const topicId = binding.disposition === 'conversation'
          ? binding.topicId ?? `topic-${executionDigest([run.runId, unit.unitId, 'agent-task-query']).slice(0, 32)}`
          : binding.topicId ?? `topic-${executionDigest([run.runId, unit.unitId]).slice(0, 32)}`
        const topic = await store.query({ kind: 'message.topic', topicId })
        if (topic && topic.conversationId !== run.conversationId) throw executionError('WORKFLOW_TOPIC_FORBIDDEN')
        const sourceRefs = [{ sourceKey: run.sourceKey, sourceVersion: run.sourceVersion, text: run.body }]
        return { topicId, conversationId: run.conversationId, sourceRunId: run.runId, unitId: unit.unitId,
          title: binding.disposition === 'conversation' ? unit.goalText : topic?.title ?? facts?.topic?.title ?? unit.goalText,
          ...(topic ? { expectedRevision: topic.revision } : {}),
          facts: [{ kind: 'fact', text: unit.spans.map(span => run.body.slice(span.start, span.end)).join('\n'), sourceRefs }] }
      },
      async topicFor({ run, unit, binding, intent, facts }) {
        if (intent.actions.every(action => ['approval', 'clarification'].includes(action.intent))) return null
        if (facts.topic && ![facts.topic.actorId, ownerActorId].includes(run.actorId)) throw executionError('WORKFLOW_TOPIC_FORBIDDEN')
        const sourceTopics=!binding.topicId ? (await store.query({kind:'message.topic.source',sourceKey:run.sourceKey})).filter(topic=>topic.conversationId===run.conversationId) : []
        const sourceTopic=sourceTopics.length===1?sourceTopics[0]:null
        const sourceRefs = [{ sourceKey: run.sourceKey, sourceVersion: run.sourceVersion, text: run.body }]
        const constraints = [...new Set([...(unit.constraints ?? []), ...(unit.sharedConstraints ?? []), ...intent.constraints])]
        for (const action of intent.actions) if (action.intent === 'fact' && action.arguments.kind === 'constraint' && typeof action.arguments.text === 'string') constraints.push(action.arguments.text)
        const topicId=unit.topicId ?? binding.topicId ?? sourceTopic?.topicId ?? `topic-${executionDigest([run.runId, unit.unitId]).slice(0, 32)}`
        return { topicId, conversationId: run.conversationId, sourceRunId: run.runId, unitId: unit.unitId,
          title: facts.topic?.title ?? sourceTopic?.title ?? unit.goalText, ...(facts.topic && facts.topic.topicId === topicId ? { expectedRevision: facts.topic.revision } : sourceTopic?.topicId===topicId ? {expectedRevision:sourceTopic.revision} : {}),
          facts: [{ kind: 'fact', text: unit.spans.map(span => run.body.slice(span.start, span.end)).join('\n'), sourceRefs }, ...constraints.map(text => ({ kind: 'constraint', text, sourceRefs }))] }
      },
      material: resolveMaterials = async function ({ run, unit, needs }) {
        const topic = unit?.topicId ? await fullTopic(unit.topicId) : null
        if (topic && topic.conversationId !== run.conversationId) return { ready: false, reason: 'MATERIAL_SOURCE_NOT_CURRENT' }
        const linkedRefs = topic?.facts.flatMap(fact => fact.sourceRefs) ?? []
        const sourceKeys = [...new Set([run.sourceKey, ...(run.snapshot?.historyManifest ?? []).map(item => item.sourceKey),
          ...(run.context.quoteRefs ?? []).map(item => item.sourceKey), ...linkedRefs.map(ref => ref.sourceKey)])]
        const items = []
        const remember = async (resourceRef, text) => {
          const material = { text }
          await store.command({ id: `material:${run.runId}:${executionDigest([resourceRef, material])}`, kind: 'message.material.record', args: { runId: run.runId, resourceRef, material } })
          items.push({ resourceRef, ...(await store.query({ kind: 'message.material', runId: run.runId, resourceRef })) })
        }
        for (let need of needs) {
          const alias = /^h([1-9]\d*)$/u.exec(need.resourceRef)
          const materialRef = alias ? run.snapshot?.historyManifest?.[Number(alias[1]) - 1]?.sourceKey : need.resourceRef
          if (!materialRef) return { ready: false, responsibility: 'system', reason: 'MATERIAL_SOURCE_UNRESOLVED' }
          let materialSource = await store.query({ kind: 'task.source', sourceKey: materialRef })
          let selectedAttachments = materialSource?.context?.attachments
          if (!materialSource) {
            for (const key of sourceKeys) {
              const source = await store.query({ kind: 'task.source', sourceKey: key })
              const attachment = source?.context?.attachments?.find(item => item.resourceRef === materialRef)
              if (attachment && linkedRefs.some(ref => ref.sourceKey === key && ref.sourceVersion !== source.sourceVersion)) return { ready: false, reason: 'MATERIAL_SOURCE_NOT_CURRENT' }
              if (attachment) { materialSource = source; selectedAttachments = [attachment]; break }
            }
          }
          if (materialSource?.context?.attachments?.length) {
            if (materialSource.conversationId !== run.conversationId || materialSource.status === 'superseded') return { ready: false, responsibility: 'system', reason: 'MATERIAL_SOURCE_NOT_CURRENT' }
            // 单独缓存真实附件投影，旧版仅存文件消息正文的缓存不能冒充附件已读取。
            const cacheRef = `source-attachments:${executionDigest([materialSource.sourceKey, materialSource.sourceVersion, selectedAttachments])}`
            let material = await store.query({ kind: 'message.material', runId: run.runId, resourceRef: cacheRef })
            if (!material) {
              if (!messageResourceRead) return { ready: false, responsibility: 'system', reason: 'MATERIAL_READER_UNAVAILABLE' }
              try {
                const contents = []
                for (const attachment of selectedAttachments) {
                  const ref = attachment.source
                  if (!ref?.resourceId || !['fileId', 'mediaId', 'dingtalkDoc'].includes(ref.type)) throw executionError('MATERIAL_RESOURCE_IDENTITY_REQUIRED')
                  const output = await messageResourceRead.execute({ input: { sourceKey: materialSource.sourceKey, type: ref.type, resourceId: ref.resourceId },
                    scope: { conversationId: run.conversationId, sourceKeys: [materialSource.sourceKey], sourceVersions: { [materialSource.sourceKey]: materialSource.sourceVersion } } })
                  contents.push(output.markdown)
                }
                material = { text: `${materialSource.body}\n\n${contents.join('\n\n')}` }
                await store.command({ id: `material:${run.runId}:${executionDigest([cacheRef, material])}`, kind: 'message.material.record', args: { runId: run.runId, resourceRef: cacheRef, material } })
              } catch (error) { return { ready: false, responsibility: 'system', reason: `MATERIAL_READ_FAILED:${error.code ?? error.message}`,
                error: { code: error.code, status: error.status, retryAfterMs: error.retryAfterMs } } }
            }
            items.push({ resourceRef: materialRef, ...material }); continue
          }
          if (alias) need = { ...need, resourceRef: materialRef }
          const cached = await store.query({ kind: 'message.material', runId: run.runId, resourceRef: need.resourceRef })
          if (cached) { items.push({ resourceRef: need.resourceRef, ...cached }); continue }
          if (need.resourceRef.startsWith('task-history:')) {
            const taskId = need.resourceRef.slice('task-history:'.length)
            const task = legacy.getTask?.(taskId)
            if (task?.groupId !== run.conversationId) return { ready: false }
            const history = (task.objectiveHistory ?? []).map(item => ({ at: item.revisedAt, objective: String(item.objective ?? '') }))
            await remember(need.resourceRef, JSON.stringify({ taskId, title: task.title, currentObjective: String(task.objective ?? ''), state: task.state, outcome: task.outcome, uat2Status: task.result?.delivery?.uat2Status ?? null, ...(run.actorId === ownerActorId ? { result: task.result ?? null } : {}), history }))
            continue
          }
          if (need.resourceRef.startsWith('workflow-task-history:')) {
            const taskId = need.resourceRef.slice('workflow-task-history:'.length)
            let origin
            try { origin = await taskAccess(taskId, run.actorId, run.conversationId) }
            catch (error) {
              if (error.code !== 'WORKFLOW_TASK_FORBIDDEN') throw error
              items.push({ resourceRef: need.resourceRef, unavailable: 'not_authorized' })
              continue
            }
            await remember(need.resourceRef, JSON.stringify(await taskFacts(origin)))
            continue
          }
          const quote = run.context.quoteRefs.find(item => item.sourceKey === need.resourceRef)
          if (quote?.text) { await remember(need.resourceRef, quote.text); continue }
          const local = await store.query({ kind: 'task.source', sourceKey: need.resourceRef })
          if (local && local.conversationId === run.conversationId) { await remember(need.resourceRef, local.body); continue }
          const historical = (legacyGroup(run.conversationId)?.messages ?? []).find(item => sourceKey(config.profile ?? '', run.conversationId, item.messageId) === need.resourceRef)
          if (historical?.text) { await remember(need.resourceRef, historical.text); continue }
          if (quote?.messageId && readMessage) {
            const value = await readMessage(run.conversationId, quote.messageId)
            if (typeof value?.text === 'string' && value.complete !== false && value.hasMore !== true
              && value.coverage?.complete !== false && value.projection?.complete !== false
              && !value.failures?.length && !value.mediaUnavailable?.length) { await remember(need.resourceRef, value.text); continue }
          }
          let resource = (run.context.attachments ?? []).find(item => item.resourceRef === need.resourceRef)
          let resourceMessageId = run.context.sourceMessageId
          if (!resource) {
            const sourceKeys = [...new Set([...(run.snapshot?.historyManifest ?? []).map(item => item.sourceKey), ...(run.context.quoteRefs ?? []).map(item => item.sourceKey)])]
            for (const key of sourceKeys) {
              const source = await store.query({ kind: 'task.source', sourceKey: key })
              if (!source || source.conversationId !== run.conversationId) continue
              resource = (source.context?.attachments ?? []).find(item => item.resourceRef === need.resourceRef)
              if (resource) { resourceMessageId = source.context.sourceMessageId; break }
            }
          }
          if (resource && readResource) {
            const value = await readResource(run.conversationId, resourceMessageId, resource.source)
            if (typeof value?.text === 'string' && value.complete !== false && value.hasMore !== true
              && value.coverage?.complete !== false && value.projection?.complete !== false
              && !value.failures?.length && !value.mediaUnavailable?.length) { await remember(need.resourceRef, value.text); continue }
          }
          return { ready: false }
        }
        return { ready: items.length > 0, data: { resources: items } }
      },
      async onCommandApplied(action, info, result) {
        if (!result?.taskId) return
        await taskOwner.dispatch()
        const plan = await controller.taskPlan(result.taskId)
        const stage = plan?.stages.find(item => item.status === 'running')
        if (!stage?.runId) return
        const state = await controller.state(stage.runId)
        if (state.run?.status === 'queued') await controller.advanceTaskPlan(result.taskId)
      },
      async onBarrierResolved(barrier) {
        const source = barrier.targetSourceKey ? await store.query({ kind: 'task.source', sourceKey: barrier.targetSourceKey }) : null
        if (source) void messages.process(source.runId).catch(() => {})
        if (source?.context?.editOf?.sourceRunId) void messages.process(source.context.editOf.sourceRunId).catch(() => {})
        if (barrier.targetTaskId) {
          const runs = await store.query({ kind: 'run.list', taskId: barrier.targetTaskId, limit: 1 })
          if (!runs.length) return
          const state = await currentTask(barrier.targetTaskId)
          if (!terminal(state.run.status) && !state.run.pauseRequested) await controller.recover({ commandId: `unfence:${barrier.id}`, runId: state.run.runId })
        }
      },
  }
  const coordinator = createMessageCoordinator({ ctx, store, context: messageContext, modelConfig,
    getWorkspaceDir: () => legacy.getAgentConfig().workspaceDir,
    getGroupName: groupId => legacyGroup(groupId)?.name, sessionRunner: coordinatorSessions })
  const messages = createMessageWorkflow({ store, coordinator, policy: config.policy, handlers, context: messageContext })

  async function investigationRequest(runId) {
    const state = await store.query({ kind: 'run', runId })
    if (state.run.workflowId !== 'task-investigation' || state.run.status !== 'waiting') return null
    const node = state.nodes.find(item => item.status === 'waiting' && item.drained && item.waitReason?.reference === 'AGENT_WORK_NEEDS_INPUT')
    if (!node?.outputRef) return null
    const output = await artifacts.read(node.outputRef)
    if (output.outcome !== 'needs_input' || !output.question?.trim()) return null
    const history = await store.query({ kind: 'node.input-history', nodeRunId: node.nodeRunId })
    const requestId = `investigation-${executionDigest([node.nodeRunId, history.inputVersion, node.inputDigest, node.outputRef])}`
    const origin = await store.query({ kind: 'task.origin', taskId: state.run.taskId })
    return { id: requestId, requestId, kind: 'needs_clarification', status: 'pending', taskId: state.run.taskId,
      runId, nodeRunId: node.nodeRunId, inputVersion: history.inputVersion, inputDigest: node.inputDigest,
      outputRef: node.outputRef, question: output.question,
      canAnswer: !!config.webActorId && [origin?.run.actorId, ownerActorId].includes(config.webActorId) }
  }
  async function resumeInvestigation(input, identity, state) {
    const origin = await store.query({ kind: 'task.origin', taskId: state.run.taskId })
    if (!origin || ![origin.run.actorId, ownerActorId].includes(identity.actorId)
      || identity.channel === 'im' && (origin.channel === 'web' || identity.conversationId !== origin.run.conversationId)
      || identity.channel === 'web' && identity.actorId !== config.webActorId) throw executionError('WORKFLOW_ACTION_FORBIDDEN')
    const eventId = requireText(input.eventId, 'WORKFLOW_EVENT_REQUIRED'), requestId = requireText(input.requestId, 'WORKFLOW_CLARIFICATION_NOT_FOUND')
    const answer = { eventId, requestId, actorId: identity.actorId, conversationId: origin.run.conversationId,
      answer: requireText(input.answer, 'WORKFLOW_ANSWER_REQUIRED') }
    const commandId = `investigation-answer:${executionDigest([state.run.runId, requestId, eventId])}`
    const replay = await store.query({ kind: 'receipt', commandId })
    const request = await investigationRequest(state.run.runId)
    if (!replay && request?.requestId !== requestId) throw executionError('WORKFLOW_CLARIFICATION_STALE')
    await controller.continueNode({ commandId, runId: state.run.runId,
      nodeRunId: request?.nodeRunId ?? replay.result.nodeRunId,
      expectedInputVersion: request?.inputVersion, expectedInputDigest: request?.inputDigest,
      expectedOutputRef: replay?.result.expectedOutputRef ?? request.outputRef, answer })
    return { accepted: true, runId: state.run.runId, requestId, status: 'resolved', answer: answer.answer }
  }
  async function ensureInvestigationMessageRequest(runId) {
    const request = await investigationRequest(runId)
    if (!request) return
    const origin = await store.query({ kind: 'task.origin', taskId: request.taskId })
    if (!origin || origin.channel === 'web') return
    const data = await messages.state(origin.run.runId)
    await store.command({ id: `investigation-question:${request.requestId}`, kind: 'message.wait', args: {
      runId: data.run.runId, unitId: origin.command.unitId, nodeId: 'investigation', expectedRevision: data.run.revision,
      reason: 'AGENT_WORK_NEEDS_INPUT', request: { requestId: request.requestId, kind: 'needs_clarification',
        question: request.question, permittedActors: [origin.run.actorId, ownerActorId], executionRunId: runId } } })
  }
  async function recoverClarification(input, identity) {
    if (identity?.channel !== 'web' || !config.webActorId || identity.actorId !== config.webActorId) throw executionError('WORKFLOW_WEB_ACTOR_FORBIDDEN')
    const { recoveryKey, dryRun, expectedDigest, ...request } = input
    requireText(recoveryKey, 'WORKFLOW_RECOVERY_KEY_REQUIRED')
    requireText(request.reason, 'WORKFLOW_RECOVERY_REASON_REQUIRED')
    if (typeof dryRun !== 'boolean') throw executionError('WORKFLOW_RECOVERY_CHECK_REQUIRED')
    const target = await messages.state(request.targetRunId), answer = await messages.state(request.answerRunId)
    if (!groups.has(target.run.conversationId) || target.run.conversationId !== answer.run.conversationId) throw executionError('WORKFLOW_GROUP_NOT_ADMITTED')
    const args = { ...request, actorId: identity.actorId }
    const commandId = `clarification-recover:${recoveryKey}`
    const inputDigest = dryRun ? null : executionDigest({ ...args, expectedDigest: expectedDigest ?? null })
    if (!dryRun) {
      if (!/^[a-f0-9]{64}$/u.test(expectedDigest ?? '')) throw executionError('MESSAGE_CLARIFICATION_RECOVERY_DIGEST_REQUIRED')
      const previous = await store.query({ kind: 'receipt', commandId })
      if (previous) {
        const evidence = await artifacts.read(previous.result.command.clarificationRecovery.at(-1).evidenceRef)
        if (evidence.inputDigest !== inputDigest) throw executionError('MESSAGE_CLARIFICATION_RECOVERY_CONFLICT')
        return previous.result
      }
    }
    const check = await store.query({ kind: 'message.clarification.recover.check', ...args })
    if (dryRun) return check
    if (check.expectedDigest !== expectedDigest) throw executionError('MESSAGE_CLARIFICATION_RECOVERY_STALE')
    const evidence = await artifacts.put({ kind: 'clarification-source-recovery', inputDigest, operator: identity.actorId, reason: request.reason, ...check })
    return (await store.command({ id: commandId, kind: 'message.clarification.recover', args: { ...args, expectedDigest, evidenceRef: evidence.ref } })).result
  }
  async function resumeRequest(input, identity) {
    if (!['web', 'im'].includes(identity?.channel) || !identity.actorId) throw executionError('WORKFLOW_AUTHENTICATED_ACTOR_REQUIRED')
    if (identity.channel === 'web' && (!config.webActorId || identity.actorId !== config.webActorId)) throw executionError('WORKFLOW_ACTION_FORBIDDEN')
    let executionState
    try { executionState = await store.query({ kind: 'run', runId: input.runId }) }
    catch (error) { if (error.code !== 'RUN_NOT_FOUND') throw error }
    if (executionState?.run?.workflowId === 'task-investigation') return resumeInvestigation(input, identity, executionState)
    const data = await messages.state(requireText(input.runId, 'WORKFLOW_RUN_REQUIRED'))
    if (!groups.has(data.run.conversationId)) throw executionError('WORKFLOW_GROUP_NOT_ADMITTED')
    if (identity.channel === 'im' && identity.conversationId !== data.run.conversationId) throw executionError('WORKFLOW_ACTION_FORBIDDEN')
    const request = data.requests.find(item => item.id === input.requestId)
    if (!request || !['needs_clarification', 'needs_authorization'].includes(request.kind)) throw executionError('WORKFLOW_CLARIFICATION_NOT_FOUND')
    const ownerAnswer = identity.actorId === ownerActorId
    if (request.reason === 'MESSAGE_AGENT_CANCEL_TARGET_REQUIRED' && identity.actorId !== data.run.actorId) throw executionError('WORKFLOW_ACTION_FORBIDDEN')
    if (!request.permittedActors?.includes(identity.actorId) && (request.kind === 'needs_authorization' || !ownerAnswer)) throw executionError('WORKFLOW_ACTION_FORBIDDEN')
    let answer = requireText(input.answer, 'WORKFLOW_ANSWER_REQUIRED')
    if (request.kind === 'needs_authorization') {
      const bound = request.authorization
      const latest = await store.query({ kind: 'message.source', sourceKey: data.run.sourceKey })
      if (!bound || latest?.runId !== data.run.runId || latest.sourceVersion !== bound.sourceVersion
        || bound.sourceKey !== data.run.sourceKey || bound.actorId !== data.run.actorId
        || bound.conversationId !== data.run.conversationId || request.revision !== data.run.revision
        || executionDigest(bound.actions) !== bound.actionDigest) throw executionError('WORKFLOW_AUTHORIZATION_STALE')
      const normalized = authorizationAnswer(answer)
      if (!normalized) throw executionError('WORKFLOW_AUTHORIZATION_DECISION_REQUIRED', '请引用授权通知明确回复“同意”或“拒绝”。')
      answer = normalized
    }
    if (request.nodeId === 'investigation' && request.executionRunId) {
      const state = await store.query({ kind: 'run', runId: request.executionRunId })
      const result = await resumeInvestigation({ ...input, runId: request.executionRunId }, identity, state)
      await messages.resume({ runId: data.run.runId, requestId: request.id, eventId: input.eventId,
        actorId: identity.actorId, answer, ownerAnswer })
      return result
    }
    if (request.nodeId === 'message-agent' && request.commandId) {
      const result = await messageAgent.resume({ request, data, identity,
        eventId: requireText(input.eventId, 'WORKFLOW_EVENT_REQUIRED'), answer })
      await messages.process(data.run.runId)
      return { accepted: true, runId: data.run.runId, requestId: request.id, status: result.request.status, answer: result.request.answer }
    }
    const result = await messages.resume({ runId: data.run.runId, requestId: request.id,
      eventId: requireText(input.eventId, 'WORKFLOW_EVENT_REQUIRED'), actorId: identity.actorId, answer, ownerAnswer })
    return { accepted: true, runId: data.run.runId, requestId: request.id, status: result.request.status, answer: result.request.answer }
  }
  async function deleteCancelledTask(request, identity) {
    if (identity?.channel !== 'web' || identity.actorId !== config.webActorId) throw executionError('WORKFLOW_ACTION_FORBIDDEN')
    const args = { taskId: request.taskId, actorId: identity.actorId, expectedControlRevision: request.expectedControlRevision }
    const origin = await store.query({ kind: 'task.origin', taskId: request.taskId })
    if (!origin) throw executionError('WORKFLOW_TASK_NOT_FOUND')
    await taskAccess(request.taskId,identity.actorId,origin.run.conversationId)
    if (request.checkOnly) return store.query({ kind: 'task.delete.check', ...args })
    const prior = await store.query({ kind: 'task.deleted', taskId: request.taskId })
    if (prior) return prior
    return (await store.command({ id: `task-delete:${executionDigest(args)}`, kind: 'task.delete', args })).result
  }
  async function retryInvestigation(input, identity) {
    if (identity?.channel !== 'web' || !config.webActorId || identity.actorId !== config.webActorId) throw executionError('WORKFLOW_ACTION_FORBIDDEN')
    const taskId = requireText(input.taskId, 'WORKFLOW_TASK_REQUIRED')
    const origin = await store.query({ kind: 'task.origin', taskId })
    if (!origin) throw executionError('WORKFLOW_TASK_NOT_FOUND')
    await taskAccess(taskId, identity.actorId, origin.run.conversationId)
    const retryKey = requireText(input.retryKey, 'WORKFLOW_RETRY_KEY_REQUIRED'), reason = requireText(input.reason, 'WORKFLOW_RETRY_REASON_REQUIRED')
    const commandId = `investigation-retry:${executionDigest([taskId, retryKey])}`
    const audit = await artifacts.put({ ...input, reason, actorId: identity.actorId, kind: 'investigation-system-recovery' }, { taskId })
    const prior = await store.query({ kind: 'receipt', commandId })
    if (prior) {
      if (prior.result.readonlyRecoveryReasonRef !== audit.ref) throw executionError('INVESTIGATION_RETRY_CONFLICT')
      return { accepted: true, taskId, runId: input.runId }
    }
    const plan = await controller.taskPlan(taskId), state = await controller.state(input.runId)
    const stage = plan?.stages.find(item => item.runId === input.runId && ['running','blocked'].includes(item.status))
    const first = state.nodes[0]
    if (!stage || plan.task.planRequirementRevision !== plan.task.requirementRevision || state.run.taskId !== taskId || state.run.workflowId !== 'task-investigation'
      || !['waiting','failed'].includes(state.run.status) || !first || !['failed','waiting'].includes(first.status)
      || state.nodes.some(node => !node.drained || node.status === 'succeeded') || state.pendingInputCount
      || stage.outputRef || (await store.query({ kind: 'effect.list', runId: input.runId })).length) throw executionError('INVESTIGATION_RETRY_FORBIDDEN')
    const requirement = await artifacts.read(plan.task.requirementRef)
    const prepared = await stageContracts.prepare({ taskId, stage, stageIndex: plan.stages.indexOf(stage), plan, requirement, origin })
    await controller.changeInput({ commandId, runId: input.runId, inputId: commandId, sourceKey: commandId,
      input: prepared.input, expectedRevision: input.runRevision,
      readonlyRecovery: { taskId, stageId: stage.stageId, nodeRunId: input.nodeRunId, generation: input.generation,
        inputDigest: input.inputDigest, requirementRevision: input.requirementRevision, controlRevision: input.controlRevision,
        planRevision: input.planRevision, reasonRef: audit.ref } })
    return { accepted: true, taskId, runId: input.runId }
  }
  async function handoffDataChangeApproval(input, identity) {
    if (identity?.channel !== 'web' || !config.webActorId || identity.actorId !== config.webActorId) throw executionError('WORKFLOW_ACTION_FORBIDDEN')
    const taskId = requireText(input.taskId, 'WORKFLOW_TASK_REQUIRED'), runId = requireText(input.runId, 'WORKFLOW_RUN_REQUIRED')
    const recoveryKey = requireText(input.recoveryKey, 'WORKFLOW_RECOVERY_KEY_REQUIRED')
    requireText(input.reason, 'WORKFLOW_RECOVERY_REASON_REQUIRED')
    if (typeof input.dryRun !== 'boolean') throw executionError('APPROVAL_HANDOFF_ARGUMENT_INVALID')
    const origin = await store.query({ kind: 'task.origin', taskId })
    if (!origin) throw executionError('WORKFLOW_TASK_NOT_FOUND')
    await taskAccess(taskId, identity.actorId, origin.run.conversationId)
    const eventKey = `approval-handoff:${executionDigest([taskId, recoveryKey])}`, requestDigest = executionDigest({ ...input, dryRun: false })
    const stopReason = JSON.stringify({ kind: 'approval-channel-handoff', requestDigest, reason: input.reason })
    const receipt = await store.query({ kind: 'receipt', commandId: `owner-event:${eventKey}` })
    if (receipt) {
      let cursor = 0, previous
      do {
        const events = await store.query({ kind: 'task.owner.events', taskId, afterSequenceId: cursor, limit: 200 })
        previous = events.find(event => event.eventKey === eventKey)
        if (previous || !events.length) break
        cursor = events.at(-1).eventSeq
      } while (true)
      if (!previous?.payloadRef || (await artifacts.read(previous.payloadRef)).requestDigest !== requestDigest) throw executionError('APPROVAL_HANDOFF_CONFLICT')
      await controller.advanceTaskPlan(taskId)
      return { accepted: true, replayed: true, taskId, runId, eventSeq: receipt.result.eventSeq }
    }
    const inspect = async () => {
      if ((await store.query({ kind: 'runtime.maintenance' })).active) throw executionError('APPROVAL_HANDOFF_MAINTENANCE')
      const plan = await controller.taskPlan(taskId), owner = await store.query({ kind: 'task.owner', taskId }), state = await controller.state(runId)
      const stopped = await store.query({ kind: 'receipt', commandId: `${eventKey}:stop` })
      const resumingStop = stopped?.result.run?.taskId === taskId && stopped.result.run.runId === runId
        && stopped.result.run.recoveryReason === stopReason && state.run?.stopRequested
        && ['cancelling', 'cancelled'].includes(state.run.status)
      if (!plan || !owner || plan.task.controlState !== 'active'
        || plan.task.requirementRevision !== input.expectedRequirementRevision || plan.task.controlRevision !== input.expectedControlRevision
        || plan.task.planRevision !== input.expectedPlanRevision || owner.revision !== input.expectedOwnerRevision
        || owner.leaseEpoch !== input.expectedLeaseEpoch || state.run?.taskId !== taskId
        || state.run.generation !== input.generation || !resumingStop && state.run.revision !== input.expectedRunRevision) throw executionError('APPROVAL_HANDOFF_STALE')
      const index = plan.stages.findIndex(stage => stage.runId === runId)
      if (index < 0 || plan.stages[index].workflowId !== 'task-data-change'
        || plan.stages.slice(0, index).some(stage => stage.status !== 'succeeded')
        || plan.stages.slice(index + 1).some(stage => stage.status !== 'invalidated')
        || !(state.run.status === 'waiting' || resumingStop) || state.pendingInputCount || state.nodes.some(node => !node.drained)
        || owner.status === 'running') throw executionError('APPROVAL_HANDOFF_UNSAFE')
      const requirement = await artifacts.read(plan.task.requirementRef), sourceKey = requirement.authorization?.sourceKey
      if (owner.applicationStatus === 'pending') {
        const change = owner.decision?.planChange
        if (owner.decision?.action !== 'advance' || change?.kind !== 'replaceSuffix' || change.affectedFrom !== index
          || change.stages?.length !== 1 || change.stages[0].workflowId !== 'task-data-change-approval-resume'
          || change.stages[0].sourceCondition?.sourceKey !== sourceKey) throw executionError('APPROVAL_HANDOFF_UNSAFE')
      }
      const source = sourceKey && await store.query({ kind: 'task.source', sourceKey })
      const eventId = sourceKey?.startsWith('web-context:') ? sourceKey.slice('web-context:'.length) : null
      const event = eventId && await store.query({ kind: origin.channel === 'web' ? 'task.web-input' : 'message.web-task', eventId })
      const authorization = requirement.stageAuthorizations?.find(item => item.workflowId === 'task-data-change-approval-resume'
        && item.sourceKey === sourceKey && item.sourceVersion === 1 && item.gate === 'none')
      const authorized = requirement.authorization?.channel === 'web' && requirement.authorization.actorId === identity.actorId
        && event?.status === 'accepted' && event.request.taskId === taskId && event.request.action === 'context'
        && source?.actorId === identity.actorId && source.sourceVersion === 1
        && source.status !== 'superseded' && /插件[\s\S]*审批/u.test(source.body)
        && authorization && source.body.includes(authorization.sourceQuote) && authorization.sourceQuote.includes(authorization.objective)
        && requirement.stageTargets?.['task-data-change-approval-resume']
      return { plan, state, sourceKey, authorized: Boolean(authorized) }
    }
    const current = await inspect()
    if (!external?.verifyDataChangeApprovalHandoff || !execution.delivery?.closeReadonlyApproval) throw executionError('APPROVAL_HANDOFF_NOT_AVAILABLE')
    const proof = await external.verifyDataChangeApprovalHandoff({ taskId, runId })
    if (proof.taskId !== taskId || proof.originalRunId !== runId || proof.originalGeneration !== input.generation) throw executionError('APPROVAL_HANDOFF_STALE')
    if (input.dryRun) return { checked: true, authorized: current.authorized, taskId, runId, effectId: proof.effectId,
      requirementRevision: current.plan.task.requirementRevision, resumeWorkflowId: 'task-data-change-approval-resume' }
    if (!current.authorized) throw executionError('APPROVAL_HANDOFF_AUTHORIZATION_REQUIRED')
    await execution.delivery.closeReadonlyApproval(proof.effectId, { beforeObserve: async () => {
      if (!(await inspect()).authorized) throw executionError('APPROVAL_HANDOFF_AUTHORIZATION_REQUIRED')
    } })
    await controller.stop({ commandId: `${eventKey}:stop`, runId, reason: stopReason })
    if ((await controller.whenIdle(runId)).run.status !== 'cancelled') throw executionError('APPROVAL_HANDOFF_STOP_UNSETTLED')
    const latest = await controller.taskPlan(taskId)
    if (latest.task.requirementRef !== current.plan.task.requirementRef || latest.task.controlRevision !== input.expectedControlRevision
      || latest.task.controlState !== 'active') throw executionError('APPROVAL_HANDOFF_STALE')
    const result = await taskOwner.event({ taskId, eventKey, eventType: 'approval.channel.changed', payload: { ...proof,
      resumeWorkflowId: 'task-data-change-approval-resume', nextAction: '保留成功前段，仅将旧数据变更阶段替换为已有工单接续，进入插件真人审批；不得重新建单。',
      requirementRef: latest.task.requirementRef, requirementRevision: latest.task.requirementRevision,
      sourceKey: current.sourceKey, requestDigest, recoveryKey, reason: input.reason, actorId: identity.actorId } })
    await controller.advanceTaskPlan(taskId)
    return { accepted: true, taskId, runId, eventSeq: result.result.eventSeq, resumeWorkflowId: 'task-data-change-approval-resume' }
  }
  async function repairStageAuthorizations(input, identity) {
    if (identity?.channel !== 'web' || !config.webActorId || identity.actorId !== config.webActorId) throw executionError('WORKFLOW_ACTION_FORBIDDEN')
    const taskId = requireText(input.taskId, 'WORKFLOW_TASK_REQUIRED')
    const origin = await store.query({ kind: 'task.origin', taskId })
    if (!origin) throw executionError('WORKFLOW_TASK_NOT_FOUND')
    await taskAccess(taskId, identity.actorId, origin.run.conversationId)
    const repairKey = requireText(input.repairKey, 'WORKFLOW_REPAIR_KEY_REQUIRED'), reason = requireText(input.reason, 'WORKFLOW_REPAIR_REASON_REQUIRED')
    const commandId = `authorization-repair:${executionDigest([taskId, repairKey])}`
    const requestDigest = executionDigest(input), receipt = await store.query({ kind: 'receipt', commandId })
    if (receipt) {
      if (receipt.result.requestDigest !== requestDigest) throw executionError('TASK_AUTHORIZATION_REPAIR_CONFLICT')
      return { accepted: true, ...receipt.result }
    }
    const plan = await controller.taskPlan(taskId)
    if (!plan || plan.task.requirementRevision !== input.expectedRequirementRevision || plan.task.requirementRef !== input.expectedRequirementRef) throw executionError('TASK_REQUIREMENT_STALE')
    const previous = await artifacts.read(plan.task.requirementRef), sources = []
    for (const frozen of previous.sourceInstructions ?? []) {
      const current = await store.query({ kind: 'task.source', sourceKey: frozen.sourceKey })
      if (!current || current.status === 'superseded' || current.sourceVersion !== frozen.sourceVersion || current.actorId !== frozen.actorId
        || current.actorId !== previous.authorization.actorId || current.conversationId !== origin.run.conversationId || current.body !== frozen.text) throw executionError('TASK_AUTHORIZATION_SOURCE_STALE')
      sources.push({ sourceKey: frozen.sourceKey, sourceVersion: frozen.sourceVersion, actorId: frozen.actorId, bodyDigest: executionDigest(frozen.text) })
    }
    if (!sources.length || !Array.isArray(input.stageAuthorizations) || !input.stageAuthorizations.length) throw executionError('TASK_STAGE_AUTHORIZATION_SOURCE_INVALID')
    const stageAuthorizations = input.stageAuthorizations.map(item => {
      const source = (previous.sourceInstructions ?? []).find(source => source.sourceKey === item.sourceKey && source.sourceVersion === item.sourceVersion)
      if (!source || !previous.stageAuthorizations?.some(prior => prior.workflowId === item.workflowId)
        || typeof item.sourceQuote !== 'string' || !item.sourceQuote.trim() || !source.text.includes(item.sourceQuote)
        || typeof item.objective !== 'string' || !item.objective.trim() || !item.sourceQuote.includes(item.objective)
        || !['none','confirmation'].includes(item.gate)) throw executionError('TASK_STAGE_AUTHORIZATION_SOURCE_INVALID')
      return { workflowId: item.workflowId, sourceKey: source.sourceKey, sourceVersion: source.sourceVersion,
        sourceQuote: item.sourceQuote, objective: item.objective, gate: item.gate,
        ...(item.gate === 'confirmation' ? { requiredActorId: source.actorId } : {}) }
    })
    const saved = await artifacts.put({ ...previous, stageAuthorizations }, { taskId })
    const audit = await artifacts.put({ kind: 'authorization.projection.repaired', taskId, repairKey, reason,
      actorId: identity.actorId, oldRef: plan.task.requirementRef, newRef: saved.ref, sources, requestDigest }, { taskId })
    const result = await store.command({ id: commandId, kind: 'task.authorization.repair', args: { taskId,
      expectedRequirementRevision: input.expectedRequirementRevision, expectedRequirementRef: input.expectedRequirementRef,
      requirementRef: saved.ref, eventKey: commandId, payloadRef: audit.ref, sources, requestDigest } })
    return { accepted: true, ...result.result }
  }
  async function reassessReadonly(input, identity) {
    if (identity?.channel !== 'web' || !config.webActorId || identity.actorId !== config.webActorId) throw executionError('WORKFLOW_ACTION_FORBIDDEN')
    const taskId = requireText(input.taskId, 'WORKFLOW_TASK_REQUIRED')
    const origin = await store.query({ kind: 'task.origin', taskId })
    if (!origin) throw executionError('WORKFLOW_TASK_NOT_FOUND')
    await taskAccess(taskId, identity.actorId, origin.run.conversationId)
    const recoveryKey = requireText(input.recoveryKey, 'WORKFLOW_RECOVERY_KEY_REQUIRED'), reason = requireText(input.reason, 'WORKFLOW_RECOVERY_REASON_REQUIRED')
    const commandId = `readonly-reassess:${executionDigest([taskId, recoveryKey])}`, requestDigest = executionDigest(input)
    const prior = await store.query({ kind: 'receipt', commandId })
    if (prior) {
      if (prior.result.requestDigest !== requestDigest) throw executionError('TASK_OWNER_REASSESS_CONFLICT')
      return { accepted: true, ...prior.result }
    }
    const plan = await controller.taskPlan(taskId), owner = await store.query({ kind: 'task.owner', taskId })
    if (!plan || !owner || owner.revision !== input.expectedOwnerRevision || owner.leaseEpoch !== input.expectedLeaseEpoch
      || plan.task.requirementRevision !== input.expectedRequirementRevision || plan.task.controlRevision !== input.expectedControlRevision) throw executionError('TASK_OWNER_REASSESS_STALE')
    const requirement = await artifacts.read(plan.task.requirementRef), sources = []
    for (const frozen of requirement.sourceInstructions ?? []) {
      const current = await store.query({ kind: 'task.source', sourceKey: frozen.sourceKey })
      if (!current || current.status === 'superseded' || current.sourceVersion !== frozen.sourceVersion || current.actorId !== frozen.actorId
        || current.conversationId !== origin.run.conversationId || current.body !== frozen.text) throw executionError('TASK_AUTHORIZATION_SOURCE_STALE')
      sources.push({ sourceKey: frozen.sourceKey, sourceVersion: frozen.sourceVersion, actorId: frozen.actorId, bodyDigest: executionDigest(frozen.text) })
    }
    const materialAccess = await readTaskMaterialAccess({ taskId, plan, requirement })
    const payload = await artifacts.put({ kind: 'readonly-system-recovery', taskId, recoveryKey, reason, actorId: identity.actorId,
      requirementRef: plan.task.requirementRef, requestDigest, sources, materialAccess,
      previousDecision: { action: owner.decision?.action ?? null, condition: owner.decision?.condition ?? null,
        applicationStatus: owner.applicationStatus, lastFailure: owner.lastFailure ?? null } }, { taskId })
    const receipt = await store.command({ id: commandId, kind: 'task.owner.reassess', args: { taskId, eventKey: commandId, payloadRef: payload.ref,
      expectedOwnerRevision: input.expectedOwnerRevision, expectedLeaseEpoch: input.expectedLeaseEpoch,
      expectedRequirementRevision: input.expectedRequirementRevision, expectedControlRevision: input.expectedControlRevision, sources, requestDigest } })
    return { accepted: true, ...receipt.result }
  }
  async function retryOwner(input, identity) {
    if (identity?.channel !== 'web' || !config.webActorId || identity.actorId !== config.webActorId) throw executionError('WORKFLOW_ACTION_FORBIDDEN')
    const taskId = requireText(input.taskId, 'WORKFLOW_TASK_REQUIRED')
    const origin = await store.query({ kind: 'task.origin', taskId })
    if (!origin) throw executionError('WORKFLOW_TASK_NOT_FOUND')
    await taskAccess(taskId, identity.actorId, origin.run.conversationId)
    const retryKey = requireText(input.retryKey, 'WORKFLOW_RETRY_KEY_REQUIRED')
    const reason = requireText(input.reason, 'WORKFLOW_RETRY_REASON_REQUIRED')
    const payload = { kind: 'owner-system-recovery', taskId, retryKey, reason, actorId: identity.actorId,
      expectedOwnerRevision: input.expectedOwnerRevision, expectedLeaseEpoch: input.expectedLeaseEpoch,
      expectedRequirementRevision: input.expectedRequirementRevision, expectedControlRevision: input.expectedControlRevision,
      expectedLastFailure: input.expectedLastFailure }
    const saved = await artifacts.put(payload, { taskId })
    const eventKey = `owner-retry:${executionDigest([taskId, retryKey])}`
    const receipt = await store.command({ id: eventKey, kind: 'task.owner.retry', args: { taskId, eventKey, payloadRef: saved.ref,
      expectedOwnerRevision: input.expectedOwnerRevision, expectedLeaseEpoch: input.expectedLeaseEpoch,
      expectedRequirementRevision: input.expectedRequirementRevision, expectedControlRevision: input.expectedControlRevision,
      expectedLastFailure: input.expectedLastFailure } })
    return { accepted: true, ...receipt.result }
  }
  async function retryReadonlyAnswer(input, identity) {
    if (identity?.channel !== 'web' || !config.webActorId || identity.actorId !== config.webActorId) throw executionError('WORKFLOW_ACTION_FORBIDDEN')
    const data = await messages.state(requireText(input.runId, 'WORKFLOW_RUN_REQUIRED'))
    if (!groups.has(data.run.conversationId)) throw executionError('WORKFLOW_GROUP_NOT_ADMITTED')
    if (data.run.sourceVersion !== input.sourceVersion) throw executionError('MESSAGE_STALE')
    const command = data.commands.find(item => item.commandId === input.commandId)
    if (!command || command.kind !== 'answer') throw executionError('MESSAGE_READONLY_RETRY_FORBIDDEN')
    const retryKey = requireText(input.retryKey, 'WORKFLOW_RETRY_KEY_REQUIRED')
    const reason = requireText(input.reason, 'WORKFLOW_RETRY_REASON_REQUIRED')
    const priorRetry = command.readonlyRetryHistory?.find(item => item.retryKey === retryKey)
    if (priorRetry) {
      const current = await store.query({ kind: 'task.source', sourceKey: data.run.sourceKey })
      if (current.sourceVersion !== data.run.sourceVersion) throw executionError('MESSAGE_STALE')
      if (priorRetry.reason !== reason) throw executionError('MESSAGE_READONLY_RETRY_CONFLICT')
      return { runId: data.run.runId, commandId: command.commandId, inputVersion: data.executions.find(item => item.commandId === command.commandId)?.inputVersion, accepted: true, cached: true }
    }
    const action = { intent: command.kind, ...command.args }
    const info = { run: data.run, unit: data.units.find(unit => (unit.id ?? unit.unitId) === command.unitId), binding: action.binding, commandId: command.commandId }
    const args = await messageAgent.prepareRetry(action, info, { retryKey, reason })
    const receipt = await store.command({ id: `answer-retry:${executionDigest([command.commandId, retryKey])}`, kind: 'message.command.retry.readonly', args })
    await messages.process(data.run.runId)
    return { runId: data.run.runId, commandId: command.commandId, inputVersion: receipt.result.execution.inputVersion, accepted: true }
  }
  async function retryMaterialRequest(input, identity) {
    if (identity?.channel !== 'web' || !config.webActorId || identity.actorId !== config.webActorId)
      throw executionError('WORKFLOW_ACTION_FORBIDDEN')
    const data = await messages.state(requireText(input.runId, 'WORKFLOW_RUN_REQUIRED'))
    if (!groups.has(data.run.conversationId)) throw executionError('WORKFLOW_GROUP_NOT_ADMITTED')
    const request = data.requests.find(item => item.id === input.requestId)
    if (!request || request.kind !== 'needs_context' || request.status !== 'pending' || !request.lastError
      || request.dependencyRevision === input.dependencyRevision)
      throw executionError('MESSAGE_REQUEST_STALE')
    await store.command({ id: `material-retry:${executionDigest([input.runId, input.requestId, input.dependencyRevision])}`,
      kind: 'message.request.retry.reset', args: { runId: data.run.runId, requestId: request.id,
        sourceVersion: input.sourceVersion, reason: requireText(input.reason, 'WORKFLOW_RETRY_REASON_REQUIRED'),
        dependencyRevision: requireText(input.dependencyRevision, 'WORKFLOW_DEPENDENCY_REVISION_REQUIRED') } })
    await messages.recover()
    const current = await messages.state(data.run.runId)
    return { runId: current.run.runId, sourceVersion: current.run.sourceVersion,
      request: current.requests.find(item => item.id === request.id) }
  }
  const messageCompactPolicy = conversationId => `${legacyGroup(conversationId)?.responsibility ?? ''}\n任务准入由Host核验当前交办和关联来源；模型只提交明确意图，不根据身份猜测无权或索要负责人重复确认。taskAdmission为当前绑定的事实，目标改变后由Host重新核验；执行阶段继续独立校验授权。具体可用流程由协调输入的availableWorkflows确定。`
  async function reprocessMessage(runId, identity) {
    if(identity?.channel!=='web'||!config.webActorId||identity.actorId!==config.webActorId) throw executionError('WORKFLOW_ACTION_FORBIDDEN')
    const prior=await messages.state(requireText(runId,'WORKFLOW_RUN_REQUIRED'))
    if(!groups.has(prior.run.conversationId)) throw executionError('WORKFLOW_GROUP_NOT_ADMITTED')
    const result=await messages.reprocess(runId, messageCompactPolicy(prior.run.conversationId))
    return {previousRunId:runId,runId:result.run.runId,status:result.run.status,
      units:result.units.map(unit=>({unitId:unit.id,status:unit.status})),
      requests:result.requests.filter(request=>request.status==='pending').map(request=>({requestId:request.id,kind:request.kind,question:request.question}))}
  }
  async function quotedClarification(message) {
    const messageId = message.quotedMessage?.messageId
    if (!messageId) return null
    const item = await store.query({ kind: 'message.requestByReply', conversationId: message.groupId, messageId })
    if (!item) return null
    if (item.request.kind === 'needs_authorization' && !authorizationAnswer(message.text)) return null
    if (!item.request.permittedActors?.includes(message.senderOpenDingTalkId)
      && message.senderOpenDingTalkId !== ownerActorId) return null
    const eventId=sourceKey(config.profile ?? '', message.groupId, message.messageId)
    const duplicate=await store.query({kind:'message.source',sourceKey:eventId})
    if(duplicate&&duplicate.status!=='superseded')await store.command({id:`clarification-fold:${duplicate.runId}:${item.request.id}`,kind:'message.clarification.fold',args:{runId:duplicate.runId,targetRunId:item.run.runId,requestId:item.request.id,eventId,replyToMessageId:messageId}})
    return resumeRequest({ runId: item.run.runId, requestId: item.request.id, eventId, answer: message.text }, { channel: 'im', actorId: message.senderOpenDingTalkId, conversationId: message.groupId })
  }
  async function ingest(message) {
    if (closed) throw executionError('WORKFLOW_SERVICE_CLOSED')
    if (!groups.has(message.groupId)) throw executionError('WORKFLOW_GROUP_NOT_ADMITTED')
    const actorId = requireText(message.senderOpenDingTalkId, 'WORKFLOW_AUTHENTICATED_ACTOR_REQUIRED')
    // 按同群已登记的外发消息ID识别回声，发送账号不等于业务任务所有者。
    if (await store.query({ kind: 'message.outboundByMessage', conversationId: message.groupId, messageId: message.messageId }))
      return { accepted: true, duplicate: true, processing: 'outbound-echo' }
    const clarification = await quotedClarification(message)
    if (clarification) return clarification
    // 切换前已可靠处理的消息属于旧引擎；渠道重叠补拉不能重新获得执行权。
    const historical = legacyGroup(message.groupId)?.messages?.find(item => item.messageId === message.messageId)
    if (historical) return { accepted: true, duplicate: true, processing: 'legacy-receipt' }
    const key = sourceKey(config.profile ?? '', message.groupId, message.messageId)
    const existing = await store.query({ kind: 'task.source', sourceKey: key })
    const sourceVersion = message.messageVersion ?? 1
    if (existing && sourceVersion < existing.sourceVersion)
      return { accepted: true, duplicate: true, runId: existing.aliasOf ?? existing.runId, processing: existing.status }
    if (existing && existing.sourceVersion === sourceVersion) {
      // 事件文件卡片附带 DWS 下载提示；回补不带。只接受资源身份严格相同的这一项展示差异。
      const sameFile = sameDwsFileProjection({ sourceKind: 'dingtalk', text: existing.body }, message)
        || sameDwsFileProjection({ sourceKind: 'dingtalk', text: message.text }, { text: existing.body, resourceRefs: message.resourceRefs })
      if (existing.actorId !== actorId || existing.body !== message.text && !sameFile) throw executionError('WORKFLOW_EDIT_VERSION_REQUIRED')
      const missingFiles = normalizeResourceRefs(message.resourceRefs, message.text).filter(resource => resource.type === 'fileId'
        && !(existing.context?.attachments ?? []).some(item => item.resourceRef === resource.resourceId))
      if (missingFiles.length && readMessage) {
        const observed = await readMessage(message.groupId, message.messageId)
        const observedActor = observed?.senderOpenDingTalkId ?? observed?.sender_open_dingtalk_id ?? observed?.senderId
        if (observed?.messageId !== message.messageId || observed?.conversationId !== message.groupId || observedActor !== actorId)
          throw executionError('WORKFLOW_ATTACHMENT_READBACK_IDENTITY_MISMATCH')
        const files = normalizeResourceRefs(observed.resourceRefs, observed.text).filter(item => item.type === 'fileId')
        if (missingFiles.some(file => !files.some(item => item.resourceId === file.resourceId))) throw executionError('WORKFLOW_ATTACHMENT_READBACK_RESOURCE_MISMATCH')
        await store.command({ id: `source-enrich:${executionDigest([key, sourceVersion, files])}`, kind: 'message.source.enrich', args: {
          runId: existing.runId, sourceKey: key, sourceVersion, actorId,
          attachments: files.map(resource => ({ resourceRef: resource.resourceId, fileId: resource.resourceId, ...(resource.name ? { name: resource.name } : {}),
            sourceMessageId: message.messageId, sourceVersion, state: 'pending', source: resource })),
          independentReadback: { provider: 'dws', messageId: observed.messageId, conversationId: observed.conversationId,
            actorId: observedActor, body: observed.text, resourceRefs: files, fileIds: files.map(file => file.resourceId) },
        } })
      }
      return { accepted: true, duplicate: true, runId: existing.aliasOf ?? existing.runId, processing: existing.status }
    }
    if (existing && sourceVersion > existing.sourceVersion && existing.body === message.text && existing.actorId === actorId) {
      const receipt = await store.command({ id: `source-alias:${executionDigest([key, sourceVersion])}`, kind: 'message.source.alias', args: {
        runId: `alias-${executionDigest([key, sourceVersion])}`, sourceKey: key, sourceVersion, conversationId: message.groupId, actorId, body: message.text,
      } })
      return { accepted: true, duplicate: true, runId: receipt.result.run.runId, processing: receipt.result.run.status }
    }
    const quote = message.quotedMessage
    const quoteKey = quote?.messageId ? sourceKey(config.profile ?? '', message.groupId, quote.messageId) : null
    const barriers = quoteKey && actorId === ownerActorId ? [{ barrierId: `fence-${executionDigest([key, sourceVersion, quoteKey])}`, targetSourceKey: quoteKey }] : []
    const result = await messages.receive({ sourceKey: key, sourceVersion, conversationId: message.groupId, actorId,
      body: requireText(message.text, 'WORKFLOW_MESSAGE_BODY_REQUIRED'), barriers,
      context: { sourceMessageId: message.messageId,
        ...(message.senderName ? { senderName: message.senderName } : {}),
        ...(message.occurredAt ? { occurredAt: normalizeMessageTime(message.occurredAt), rawOccurredAt: message.rawOccurredAt ?? message.occurredAt } : {}),
        directedToAgent: isNamedAgentDirection(message.text, agentNames()),
        agentNames: agentNames(),
        ...(existing ? { editOf: { sourceRunId: existing.aliasOf ?? existing.runId, sourceVersion: existing.sourceVersion, sourceKey: key } } : {}),
        quoteRefs: quoteKey ? [{ sourceKey: quoteKey, messageId: quote.messageId, ...(quote.content ? { text: quote.content } : {}) }] : [],
        attachments: normalizeResourceRefs(message.resourceRefs, message.text).map(resource => ({ resourceRef: resource.resourceId, ...(resource.type === 'fileId' ? { fileId: resource.resourceId } : {}), ...(resource.name ? { name: resource.name } : {}), sourceMessageId: message.messageId, sourceVersion, state: 'pending', source: resource })),
        compactPolicy: messageCompactPolicy(message.groupId),
      } })
    return { accepted: true, duplicate: false, runId: result.runId, processing: 'pending' }
  }
  async function taskNodeReadoutRef(node) {
    const recorded = readableNodeOutputRef(node)
    if (recorded || node.nodeId !== 'run-local-acceptance') return recorded
    const effects = await store.query({ kind: 'effect.list', runId: node.runId })
    const effect = effects.find(item => item.nodeRunId === node.nodeRunId && item.generation === node.generation
      && item.definition?.payload?.workflowKind === 'local-acceptance' && item.result?.result?.localAcceptance)
    return effect?.result?.evidenceRef ?? null
  }
  async function currentPlanNodes(taskId, plan, states = new Map()) {
    const result = []
    const requirementCurrent = plan.task.planRequirementRevision === plan.task.requirementRevision
    for (const stage of plan.stages) {
      const stageTitle = taskWorkflowCatalog.find(item => item.id === stage.workflowId)?.label
        ?? (stage.workflowId.startsWith('task-engineering') ? '开发与验证' : stage.stageId)
      const context = { stageId: stage.stageId, stageTitle }
      if (stage.runId) {
        if (!states.has(stage.runId)) states.set(stage.runId, controller.state(stage.runId))
        const state = await states.get(stage.runId)
        if (state.run?.taskId !== taskId) throw executionError('TASK_PLAN_RUN_INVALID')
        for (const node of state.nodes) {
          const current = requirementCurrent && stage.status !== 'invalidated' && state.pendingInputCount === 0
          result.push({ ...node, ...context, stepKey: `${taskId}:${stage.stageId}:${state.run.workflowId}:${node.nodeId}`,
            ...(current ? {} : { status: 'blocked', waitReason: { kind: 'input', reference: '需求已更新，等待重新确认执行方案' } }),
            outputRef: current ? await taskNodeReadoutRef(node) : null })
        }
        continue
      }
      const definition = stage.workflowDigest ? controller.workflowDefinition(stage.workflowId, stage.workflowDigest) : null
      const planned = definition?.nodes ?? [{ id: 'definition-pending' }]
      for (const node of planned) result.push({ ...context,
        stepKey: `${taskId}:${stage.stageId}:${stage.workflowId}:${node.id}`,
        nodeId: node.id, nodeRunId: null, runId: null, outputRef: null, sessionId: null,
        title: definition ? undefined : `${stageTitle}（步骤待确定）`, definitionPending: !definition,
        status: plan.task.controlState === 'cancelled' ? 'cancelled' : 'pending',
        ...(stage.unavailableReason ? { waitReason: { kind: 'capability', reference: stage.unavailableReason } } : {}) })
    }
    return result
  }
  async function tasks({ taskId: selectedTaskId, readableOnly = false, completePlan = false, origins = new Map() } = {}) {
    const archives = new Map((await store.query({ kind: 'task.archives' })).map(item => [item.taskId, item.archivedAt]))
    const catalog = await store.query({ kind: 'task.catalog', ...(selectedTaskId ? { taskId: selectedTaskId } : {}) })
    const topicBindings = new Map()
    const project = async ({ taskId, runs: taskRuns }) => {
      if (!origins.has(taskId)) origins.set(taskId, store.query({ kind: 'task.origin', taskId }))
      const origin = await origins.get(taskId)
      if (readableOnly && !readableTaskOrigin(origin)) return null
      const groupId = origin?.run.conversationId
      if (origin?.command.unitId && !topicBindings.has(groupId))
        topicBindings.set(groupId, store.query({ kind: 'message.topic.bindings', conversationId: groupId }))
      const topic = origin?.command.unitId
        ? (await topicBindings.get(groupId)).find(item => item.unitId === origin.command.unitId && item.sourceKey === origin.run.sourceKey)?.topic : null
      const topicRefs = topic && topic.conversationId === origin.run.conversationId
        ? [{ groupId: topic.conversationId, topicId: topic.topicId, revision: topic.revision, title: topic.title }] : []
      const plan = await controller.taskPlan(taskId)
      const currentStage = plan?.stages.find(stage => !['succeeded', 'invalidated'].includes(stage.status)) ?? plan?.stages.at(-1)
      const run = taskRuns.find(item => item.runId === currentStage?.runId) ?? taskRuns[0]
      const owner = await store.query({ kind: 'task.owner', taskId })
      const ownerComplete = owner?.decision?.action === 'complete' && owner.applicationStatus === 'applied'
        && owner.requirementRevision === plan?.task.requirementRevision
        && (!plan?.task.planRevision || plan.task.planRequirementRevision === plan.task.requirementRevision)
        && owner.eventWatermark === owner.processedWatermark
      const ownerWaiting = ['wait', 'block'].includes(owner?.decision?.action) && owner.applicationStatus === 'applied'
        && (!plan?.task.planRevision || plan.task.planRequirementRevision === plan.task.requirementRevision)
        && owner.requirementRevision === plan?.task.requirementRevision && owner.eventWatermark === owner.processedWatermark
      let waitingCondition = ownerWaiting ? owner.decision.condition ?? null : null
      const state = run ? await controller.state(run.runId) : null
      const approvalNode = state?.nodes.find(node => node.status === 'waiting'
        && ['PLUGIN_APPROVAL_PENDING', 'BYTEBASE_APPROVAL_PENDING', 'BYTEBASE_HUMAN_APPROVAL_NOT_CONFIGURED'].includes(node.waitReason?.reference))
      if (approvalNode) {
        const approvalOutput = approvalNode.outputRef ? await artifacts.read(approvalNode.outputRef) : null
        const approvalEffect = (await store.query({ kind: 'effect.list', runId: run.runId }))
          .find(effect => effect.nodeRunId === approvalNode.nodeRunId && effect.definition.payload?.stage === 'approval-gate')
        const issueId = approvalOutput?.view?.issue?.id ?? approvalOutput?.view?.issue?.issueId ?? approvalOutput?.view?.issue?.name ?? '当前工单'
        const observedDecision = approvalEffect?.result?.result?.result?.approval?.decision
        const unconfigured = observedDecision ? observedDecision === 'unconfigured'
          : approvalNode.waitReason.reference === 'BYTEBASE_HUMAN_APPROVAL_NOT_CONFIGURED'
        waitingCondition = { kind: unconfigured ? 'capability' : 'approval',
          missing: unconfigured ? `Bytebase 工单 ${issueId} 未启用真人审批（SKIPPED）` : `Bytebase 工单 ${issueId} 的真人审批结果`,
          responsibleParty: approvalNode.waitReason.reference === 'PLUGIN_APPROVAL_PENDING' ? '插件审批人' : unconfigured ? 'Bytebase 管理员' : 'Bytebase 审批人',
          resumeWhen: unconfigured ? 'Bytebase 管理员启用原生人工审批规则，并重新送审本次精确 SQL；SKIPPED 工单不能直接执行' : '批准后执行；驳回后按意见修改并重新送审',
          evidenceRefs: approvalNode.outputRef ? [approvalNode.outputRef] : [] }
      }
      const states = new Map(run ? [[run.runId, state]] : [])
      const firstRun = plan?.stages[0]?.runId
        ? taskRuns.find(item => item.runId === plan.stages[0].runId) ?? await store.query({ kind: 'run', runId: plan.stages[0].runId }).then(item => item.run)
        : taskRuns.at(-1)
      const requirementRef = plan?.task.requirementRef ?? firstRun?.requirementRef ?? plan?.stages[0]?.requirementRef
      const requirement = requirementRef ? await artifacts.read(requirementRef) : null
      const requirementCurrent = !plan || plan.task.planRequirementRevision === plan.task.requirementRevision
      const currentRun = !plan || currentStage?.runId === state?.run.runId
      const outputRef = requirementCurrent && !state?.pendingInputCount
        ? currentStage?.outputRef ?? (currentRun ? state?.nodes.filter(node => node.outputRef).at(-1)?.outputRef : null) : null
      const output = outputRef ? await artifacts.read(outputRef) : null
      const planState = plan?.task.status
      // 无 Owner 的计划以持久终态为准；有 Owner 时仍须通过当前版本验收。
      const taskCancelled = plan?.task.controlState === 'cancelled'
      const taskStopping = ['cancelling', 'pausing', 'paused'].includes(plan?.task.controlState)
      const taskComplete = !taskStopping && !taskCancelled && (ownerComplete || !owner && planState === 'succeeded')
      const taskState = taskCancelled || taskComplete ? 'completed' : taskStopping ? 'waiting' : ownerWaiting || owner?.status === 'blocked' || planState === 'blocked' || planState === 'waiting_confirmation'
        || planState === 'succeeded' ? 'waiting' : owner?.status === 'running' ? 'running' : !run ? 'queued'
        : terminal(run.status) && !plan ? 'completed' : state.controllerError ? 'waiting'
          : run.status === 'running' ? 'running' : run.status === 'queued' ? 'queued' : 'waiting'
      return { taskId, archivedAt: archives.get(taskId), engine: 'workflow-v2', workflowId: run?.workflowId ?? currentStage?.workflowId,
        workflowVersion: run?.definitionVersion, groupId: origin?.run.conversationId,
        title: taskTitle(requirement?.title ?? requirement?.request ?? origin?.command.args.arguments?.objective ?? taskId),
        objective: requirement?.request ?? origin?.command.args.arguments?.objective ?? taskId,
        inputVersion: (plan?.task.requirementRevision ?? run?.revision ?? 0) + 1, runSequence: taskRuns.length,
        stageConfirmation: taskState === 'waiting' && origin?.channel === 'web' ? await store.query({ kind: 'task.stageConfirmation', taskId }) : null,
        investigationRequest: taskState === 'waiting' && run?.workflowId === 'task-investigation' ? await investigationRequest(run.runId) : null,
        state: taskState,
        outcome: taskCancelled ? 'cancelled' : taskComplete ? 'succeeded' : plan ? undefined : run && terminal(run.status) ? run.status : undefined,
        createdAt: plan?.task.createdAt ?? run?.createdAt, updatedAt: plan?.task.updatedAt ?? run?.updatedAt,
        executionTiming: await store.query({ kind: 'task.executionTiming', taskId }),
        result: ownerComplete ? owner.decision.summary : workflowResultText(output),
        waitingReason: taskState !== 'waiting' ? undefined : taskStopping ? ({ cancelling: '正在取消任务，等待执行结束', pausing: '正在暂停任务，等待执行结束', paused: '任务已暂停' })[plan.task.controlState]
          : owner?.lastFailure ? '处理程序异常，需要维护人员修复后重新评估。'
          : taskDecisionConditionText(waitingCondition)
          ?? (ownerWaiting ? owner.decision.summary : null)
          ?? currentStage?.unavailableReason ?? (currentStage?.status === 'waiting_confirmation' ? '等待阶段确认' : null)
          ?? state?.controllerError ?? run?.recoveryReason ?? state?.nodes.find(node => node.status === 'waiting')?.waitReason?.reference,
        waitingCondition,
        taskRunId: run?.runId ?? null,
        ...(origin?.channel === 'web' ? { sourceChannel: 'web', reportChannel: 'web', rerunOfTaskId: origin.rerunOfTaskId } : {}),
        stageTasks: state?.nodes.map(node => node.nodeId) ?? [], topicRefs, checkpoints: [],
        executionNodes: completePlan && plan ? await currentPlanNodes(taskId, plan, states)
          : await Promise.all((state?.nodes ?? []).map(async node => ({ ...node,
            ...(completePlan ? { stepKey: `${taskId}:${state.run.workflowId}:${node.nodeId}` } : {}),
            ...(completePlan && state.pendingInputCount ? { status: 'blocked',
              waitReason: { kind: 'input', reference: '输入已更新，等待重新执行' } } : {}),
            outputRef: completePlan && state.pendingInputCount ? null : await taskNodeReadoutRef(node) }))), childSessionId: owner?.sessionId ?? state?.nodes.findLast(node => node.sessionId)?.sessionId,
        taskOwner: owner ? { sessionId: owner.sessionId, status: owner.status, decision: owner.decision?.action ?? null,
          revision: owner.revision, leaseEpoch: owner.leaseEpoch, requirementRevision: owner.requirementRevision, controlRevision: owner.controlRevision,
          failureCount: owner.failureCount, lastFailure: owner.lastFailure,
          eventWatermark: owner.eventWatermark, processedWatermark: owner.processedWatermark } : null,
        ...(plan ? { plan: { version: plan.task.planRevision, requirementRevision: plan.task.requirementRevision,
          requirementCurrent, currentStageId: currentStage?.stageId ?? null,
          ...(completePlan ? { stepsResolved: plan.stages.length > 0 && plan.stages.every(stage => stage.runId || stage.workflowDigest) } : {}),
          stages: plan.stages.map(stage => ({ stageId: stage.stageId,
            title: taskWorkflowCatalog.find(item => item.id === stage.workflowId)?.label ?? stage.stageId,
            status: stage.status, workflowId: stage.workflowId, runId: stage.runId, outputRef: stage.outputRef })) } } : {}),
      }
    }
    const projected = []
    // 原生 RPC 队列有上限；完整目录按小批次投影，不能用截断隐藏旧任务。
    for (let offset = 0; offset < catalog.length; offset += 8)
      projected.push(...await Promise.all(catalog.slice(offset, offset + 8).map(project)))
    return projected.filter(Boolean)
  }
  async function readableTaskFamily(taskId, origins = new Map()) {
    const origin = id => {
      if (!origins.has(id)) origins.set(id, store.query({ kind: 'task.origin', taskId: id }))
      return origins.get(id)
    }
    if (!readableTaskOrigin(await origin(taskId))) return null
    const family = await store.query({ kind: 'task.family', taskId })
    if (!family) return null
    const taskIds = []
    for (const id of family.taskIds)
      if (readableTaskOrigin(await origin(id))) taskIds.push(id)
    return { rootTaskId: taskIds[0], latestTaskId: taskIds.at(-1), taskIds }
  }
  async function boardTasks() {
    const [physical, families] = await Promise.all([tasks({ readableOnly: true }), store.query({ kind: 'task.families' })])
    return groupTaskExecutions(physical, families)
  }
  async function taskDetail(taskId) {
    for (let attempt = 0; attempt < 3; attempt++) {
      // 只在本次一致性检查内复用读取；重试和最终授权复核仍查询当前持久状态。
      const origins = new Map()
      const family = await readableTaskFamily(taskId, origins)
      if (!family) return null
      const currentTaskId = family.latestTaskId
      const before = await store.query({ kind: 'task.viewRevision', taskId: currentTaskId })
      const task = (await tasks({ taskId: currentTaskId, readableOnly: true, completePlan: true, origins }))[0]
      if (!task) return null
      const deliveryManifest = task.taskOwner
        ? await store.query({ kind: 'task.owner.delivery-manifest', taskId: currentTaskId }) : null
      const after = await store.query({ kind: 'task.viewRevision', taskId: currentTaskId })
      const currentFamily = await readableTaskFamily(taskId)
      if (before !== after || executionDigest(family) !== executionDigest(currentFamily)) continue
      return { ...task, requestedTaskId: taskId, logicalTaskId: family.rootTaskId, latestTaskId: currentTaskId,
        deliveryManifest,
        detailRevision: after, executionNumber: family.taskIds.length, executionCount: family.taskIds.length }
    }
    throw executionError('TASK_DETAIL_STALE')
  }
  async function taskExecutions(taskId, { offset = 0, limit = 20 } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw executionError('TASK_EXECUTION_CURSOR_INVALID')
    const family = await readableTaskFamily(taskId)
    if (!family) return null
    const selected = [...family.taskIds].reverse().slice(offset, offset + limit)
    const executions = []
    for (const id of selected) {
      const task = (await tasks({ taskId: id }))[0]
      const [{ runs }] = await store.query({ kind: 'task.catalog', taskId: id })
      executions.push({ taskId: id, executionNumber: family.taskIds.indexOf(id) + 1,
        state: task.state, outcome: task.outcome, title: task.title, objective: task.objective,
        createdAt: task.createdAt, updatedAt: task.updatedAt, result: task.result, archivedAt: task.archivedAt,
        stageOutcomes: [...runs].reverse().map(run => ({ runId: run.runId,
          title: task.plan?.stages.find(stage => stage.runId === run.runId)?.title
            ?? taskWorkflowCatalog.find(item => item.id === run.workflowId)?.label ?? '工程执行',
          status: run.status })) })
    }
    return { rootTaskId: family.rootTaskId, latestTaskId: family.latestTaskId, total: family.taskIds.length,
      executions, nextOffset: offset + limit < family.taskIds.length ? offset + limit : null }
  }
  let messageRecoveryFlight, taskRecoveryFlight, taskRecoveryCursor
  async function reconcileFoldedAnswers() {
    const failures = []
    for (const answer of await store.query({ kind: 'message.clarifications.unlinked', limit: 100 })) {
      try {
        await store.command({ id: `clarification-link:${answer.runId}:${answer.requestId}`,
          kind: 'message.clarification.reconcile', args: answer })
      } catch (error) {
        failures.push({ scope: 'clarification-link', runId: answer.runId, code: error.code ?? error.message })
      }
    }
    return failures
  }
  async function recoverTasks() {
    if ((await store.query({ kind: 'runtime.maintenance' })).active) return []
    const failures = []
    for (const event of await store.query({ kind: 'task.web-inputs.pending' })) try { await executeWebEvent(event) }
    catch (error) { failures.push({ scope: 'web-task', eventId: event.id, code: error.code ?? error.message }) }
    for(const event of await store.query({kind:'message.web-tasks.pending'}))try{await executeWebEvent(event)}catch(error){failures.push({scope:'web-task',eventId:event.id,code:error.code??error.message})}
    let ownerCursor
    do {
      const owners = await store.query({ kind: 'task.owners.list', limit: 100,
        ...(ownerCursor ? { beforeSequenceId: ownerCursor } : {}) })
      for (const item of owners) try {
        const plan = await ensureLegacyTaskRequirement(item.taskId)
        const advanced = plan?.stages.some(stage => stage.status === 'running') ? await controller.advanceTaskPlan(item.taskId) : plan
        await continueFailedUatStage({ taskId: item.taskId, plan: advanced, store, controller, external })
        await taskOwner.observe(item.taskId)
      }
      catch (error) { failures.push({ scope: 'task-plan', taskId: item.taskId, code: error.code ?? error.message }) }
      ownerCursor = owners.length === 100 ? owners.at(-1).sequenceId : undefined
    } while (ownerCursor)
    let planCursor
    do {
      const plans = await controller.pendingTaskPlans({ limit: 100,
        ...(planCursor ? { beforeSequenceId: planCursor } : {}) })
      for (const plan of plans) if (!await store.query({ kind: 'task.owner', taskId: plan.taskId })) {
        try { await advanceBusinessTask(plan.taskId) }
        catch (error) { failures.push({ scope: 'legacy-task-plan', taskId: plan.taskId, code: error.code ?? error.message }) }
      }
      planCursor = plans.length === 100 ? plans.at(-1).sequenceId : undefined
    } while (planCursor)
    const page = await store.query({ kind: 'run.list', limit: 200, activeOnly: true, ...(taskRecoveryCursor ? { beforeSequenceId: taskRecoveryCursor } : {}) })
    taskRecoveryCursor = page.length === 200 ? page.at(-1).sequenceId : undefined
    for (const run of page) {
      if (terminal(run.status) || run.pauseRequested || run.stopRequested || run.status === 'running') continue
      try {
        if (run.status === 'waiting') {
          const state = await store.query({ kind: 'run', runId: run.runId })
          const waiting = state.nodes?.filter(node => node.status === 'waiting') ?? [], node = waiting[0]
          if (waiting.length !== 1) continue
          if (node.waitReason?.kind === 'recovery' && ['execution_no_submission','execution_tool_failed'].includes(node.waitReason.reference)
            && ctx?.sessionPersistence && state.nodes.every(item => item.drained) && node.sessionBound && !node.outputRef) {
            const definition = controller.workflowDefinition(run.workflowId, run.workflowDigest)
            const frozen = definition.nodes.find(item => item.id === node.nodeId)
            const effects = await store.query({ kind: 'effect.list', runId: run.runId })
            if (frozen?.executor !== 'agent' || frozen.allowedEffects.some(effect => !['pure','read'].includes(effect))
              || effects.some(effect => effect.nodeRunId === node.nodeRunId || !['succeeded','failed'].includes(effect.state))) continue
            const input = await artifacts.read(node.inputRef)
            if (executionDigest(input) !== node.inputDigest || input.workflowDigest !== definition.digest || input.nodeId !== node.nodeId) continue
            const proof = await inspectLegacyTurnFailure(ctx, { taskId: run.taskId, runId: run.runId, nodeRunId: node.nodeRunId,
              generation: state.run.generation, inputDigest: node.inputDigest, sessionId: node.sessionId, leaseEpoch: node.leaseEpoch, sessionBound: true }, node.waitReason.reference)
            if (!proof) continue
            const evidence = await artifacts.put({ kind: 'legacy-turn-failure-classification', ...proof }, { taskId: run.taskId })
            // 已发布的幂等键保留，避免把同一历史回合重分类记作另一项操作。
            await store.command({ id: `provider-reclassify:${node.nodeRunId}:${node.leaseEpoch}`, kind: 'node.failure.reclassify', args: {
              runId: run.runId, runRevision: state.run.revision, nodeRunId: node.nodeRunId, generation: state.run.generation,
              leaseEpoch: node.leaseEpoch, inputDigest: node.inputDigest, sessionId: node.sessionId, evidenceRef: evidence.ref,
              previousCode: node.waitReason.reference, code: proof.failure.code } })
            continue
          }
          if (node.waitReason?.reference === 'AGENT_WORK_NEEDS_INPUT') { await ensureInvestigationMessageRequest(run.runId); continue }
          if (run.workflowId === 'task-data-change' && node.nodeId === 'readback-issue'
            && node.waitReason?.kind === 'recovery') {
            const definition = controller.workflowDefinition(run.workflowId, run.workflowDigest)
            const readback = definition.nodes.find(item => item.id === node.nodeId)
            const eligible = async current => !(await store.query({ kind: 'runtime.maintenance' })).active
              && current.run.status === 'waiting' && current.run.generation === state.run.generation
              && current.run.revision === state.run.revision && !current.run.pauseRequested && !current.run.stopRequested
              && !current.pendingInputCount && current.nodes.every(item => item.drained)
              && current.nodes.filter(item => item.status === 'waiting').length === 1
              && current.nodes.some(item => item.nodeRunId === node.nodeRunId && item.status === 'waiting'
                && item.leaseEpoch === node.leaseEpoch && item.inputDigest === node.inputDigest
                && item.waitReason?.reference === node.waitReason?.reference)
              && !(await store.query({ kind: 'effect.list', runId: run.runId })).some(effect => !['succeeded', 'failed'].includes(effect.state))
              && (await store.query({ kind: 'task.plan', taskId: run.taskId }))?.task.controlState === 'active'
            if (!['4', '5'].includes(definition.version) || readback.executor !== 'code'
              || readback.allowedEffects.length !== 1 || readback.allowedEffects[0] !== 'read' || !await eligible(state)) continue
            const input = await artifacts.read(node.inputRef)
            if (executionDigest(input) !== node.inputDigest || input.workflowDigest !== definition.digest || input.nodeId !== node.nodeId) continue
            // 先用冻结的只读节点重新证明既有工单身份；成功后只恢复该节点，不重发建单。
            await readback.execute({ input: structuredClone(input.data), signal: new AbortController().signal })
            if (!await eligible(await store.query({ kind: 'run', runId: run.runId }))) continue
          } else if (node.waitReason?.reference === 'PLUGIN_APPROVAL_PENDING') {
            const effects = await store.query({ kind: 'effect.list', runId: run.runId })
            const gates = effects.filter(effect => effect.nodeRunId === node.nodeRunId
              && effect.generation === state.run.generation && effect.inputDigest === node.inputDigest
              && effect.definition.payload?.stage === 'approval-gate'
              && effect.definition.payload.intent?.approvalSource === 'assistant')
            if (gates.length !== 1 || !gates[0].requestId) continue
            const approval = await store.query({ kind: 'approval.get', requestId: gates[0].requestId })
            if (approval.effectId !== gates[0].effectId || approval.revoked
              || !['approved', 'rejected'].includes(approval.decision)
              || !['web', 'dingtalk'].includes(approval.decisionSource) || !approval.decidedBy) continue
          } else if (['DELIVERY_RECONCILIATION_REQUIRED', 'BYTEBASE_APPROVAL_PENDING', 'BYTEBASE_HUMAN_APPROVAL_NOT_CONFIGURED'].includes(node.waitReason?.reference)) {
            const eligible = async current => {
              const plan = await store.query({ kind: 'task.plan', taskId: run.taskId })
              return !(await store.query({ kind: 'runtime.maintenance' })).active
                && current.run.status === 'waiting' && !current.run.pauseRequested && !current.run.stopRequested
                && !current.pendingInputCount && (!plan || plan.task.controlState === 'active')
                && current.run.generation === state.run.generation
                && current.run.revision === state.run.revision
                && current.nodes.every(item => item.drained)
                && current.nodes.filter(item => item.status === 'waiting').length === 1
                && current.nodes.some(item => item.nodeRunId === node.nodeRunId && item.status === 'waiting'
                  && item.inputDigest === node.inputDigest && item.leaseEpoch === node.leaseEpoch
                  && item.waitReason?.reference === node.waitReason?.reference)
            }
            if (!execution.delivery?.reconcile || !await eligible(state)) continue
            const effects = await store.query({ kind: 'effect.list', runId: run.runId })
            const owned = effect => effect.kind === 'operation' && effect.nodeRunId === node.nodeRunId
              && effect.generation === state.run.generation && effect.inputDigest === node.inputDigest
            const unsentCandidate = effect => owned(effect) && effect.state === 'failed'
              && effect.definition.action === 'pr' && effect.definition.adapterId === 'github-pr'
              && effect.result?.result?.phase === 'preflight' && effect.result.result.mutationAttempted === false
              && ['PR_CONNECTION_FAILED', 'PR_PREFLIGHT_NOT_SENT'].includes(effect.result.result.reason)
            if (!effects.some(owned) || effects.some(effect => effect.state !== 'succeeded'
              && !(owned(effect) && (effect.state === 'unknown' || isTerminalUatBuildFailure(effect) || unsentCandidate(effect))))) continue
            // 只读适配器对账已有操作；绝不经 execute 重发未知写入。
            for (const effect of effects.filter(effect => effect.state === 'unknown')) {
              if (!await eligible(await store.query({ kind: 'run', runId: run.runId }))) break
              await execution.delivery.reconcile(effect.effectId)
            }
            const currentEffects = await store.query({ kind: 'effect.list', runId: run.runId }), provenUnsent = new Set()
            for (const effect of currentEffects.filter(unsentCandidate)) {
              if (!await eligible(await store.query({ kind: 'run', runId: run.runId }))) break
              if ((await execution.delivery.reconcile(effect.effectId)).unsentRecovery) provenUnsent.add(effect.effectId)
            }
            if (!await eligible(await store.query({ kind: 'run', runId: run.runId }))
              || currentEffects.some(effect => effect.state !== 'succeeded' && !(owned(effect)
                && (isTerminalUatBuildFailure(effect) || provenUnsent.has(effect.effectId))))) continue
          } else {
            if (!transientRecoveryReasons.includes(node.waitReason?.reference)) continue
            const effects = await store.query({kind:'effect.list',runId:run.runId})
            if (effects.some(effect => !['succeeded','failed'].includes(effect.state))) continue
            try {
              await store.command({id:`recovery-admit:${node.nodeRunId}:${node.leaseEpoch}:${node.waitReason.reference}`,kind:'run.recovery.admit',args:{
                runId:run.runId,runRevision:state.run.revision,nodeRunId:node.nodeRunId,generation:state.run.generation,
                leaseEpoch:node.leaseEpoch,inputDigest:node.inputDigest,errorCode:node.waitReason.reference}})
            } catch(error) {
              if (['RECOVERY_RETRY_LIMIT','RECOVERY_RETRY_DEFERRED','RECOVERY_RETRY_NOT_ADMITTED'].includes(error.code)) continue
              throw error
            }
          }
        }
        await controller.recover({ commandId: `recover:${run.runId}:${run.revision}:${run.claimCount}`, runId: run.runId })
      }
      catch (error) { if (error.code !== 'EXECUTOR_STILL_ACTIVE') failures.push({ scope: 'task', runId: run.runId, code: error.code ?? error.message }) }
    }
    failures.push(...await taskOwner.applyPending())
    await taskOwner.dispatch()
    return failures
  }
  async function recoverBusinessResumeCommands() {
    const failures = []
    for (const run of await store.query({ kind: 'message.pending' })) {
      const data = await messages.state(run.runId)
      for (const command of data.commands.filter(item => item.kind === 'resume' && item.status === 'unknown' && item.error === 'TASK_CONTROL_CONFLICT')) {
        const taskId = command.args.taskId ?? command.args.binding?.taskId
        try {
          await taskAccess(taskId, run.actorId, run.conversationId)
          const plan = await controller.taskPlan(taskId), owner = await store.query({ kind: 'task.owner', taskId })
          if (!plan || !owner || plan.task.controlState !== 'active' || ['succeeded', 'cancelled'].includes(plan.task.status)
            || await store.query({ kind: 'receipt', commandId: `task-control:${command.commandId}` })) continue
          const proof = await artifacts.put({ kind: 'business-resume-recovery', taskId, commandId: command.commandId,
            action: 'resume', sourceRunId: run.runId, sourceKey: run.sourceKey, sourceVersion: run.sourceVersion,
            actorId: run.actorId, arguments: command.args.arguments, controlReceiptAbsent: true,
            controlRevision: plan.task.controlRevision, requirementRevision: plan.task.requirementRevision }, { taskId })
          await store.command({ id: `recover-business-resume:${command.commandId}`, kind: 'message.command.recover-business-resume', args: {
            commandId: command.commandId, expectedCommandDigest: executionDigest(command), sourceVersion: run.sourceVersion,
            ownerActorId, controlRevision: plan.task.controlRevision, requirementRevision: plan.task.requirementRevision,
            ownerRevision: owner.revision, evidenceRef: proof.ref } })
        } catch (error) {
          if (!['MESSAGE_RESUME_RECOVERY_STALE', 'MESSAGE_STALE', 'WORKFLOW_TASK_FORBIDDEN'].includes(error.code)) failures.push({ scope: 'business-resume', commandId: command.commandId, code: error.code ?? error.message })
        }
      }
    }
    return failures
  }
  async function recoverAll() {
    await messageAgent.reconcile()
    if ((await store.query({ kind: 'runtime.maintenance' })).active) return { failures: [] }
    // 三条恢复通路独立：消息等模型或投递等连接器时，不占住其它通路下一轮恢复。
    const results = await Promise.allSettled([
      messageRecoveryFlight ??= messages.recover().finally(() => { messageRecoveryFlight = undefined }),
      recoverExecutionTasks(),
      notifier.flush(),
      reconcileFoldedAnswers(),
      recoverBusinessResumeCommands(),
    ])
    const failures = results.flatMap((result, index) => result.status === 'rejected'
      ? [{ scope: ['messages', 'tasks', 'notifications', 'clarification-link', 'business-resume'][index], code: result.reason.code ?? result.reason.message }]
      : index === 1 || index === 3 || index === 4 ? result.value : [])
    return { failures }
  }
  function recoverExecutionTasks() {
    return taskRecoveryFlight ??= recoverTasks().finally(() => { taskRecoveryFlight = undefined })
  }
  function workflowCatalogState() {
    const repositories = engineering.availableWorkflows().map(item => item.repositoryId)
    return taskWorkflowCatalog.filter(item => item.id !== 'task-general').map(item => {
      const workflow = visibleDefinitions.get(item.id)
      const available = !!workflow || item.mode === 'engineering' && repositories.length > 0
      return { id: item.id, label: item.label, purpose: item.purpose, mode: item.mode,
        status: available ? 'available' : 'unavailable', version: workflow?.version ?? null,
        nodes: workflow?.nodes.map(node => ({ id: node.id, executor: node.executor, effects: node.allowedEffects })) ?? [],
        ...(item.mode === 'engineering' ? { repositories, reason: available ? '具体节点随任务和仓库配置冻结，在任务详情查看' : '未配置受信工程仓库' }
          : !available ? { reason: '受信平台目标、客户端或验证未齐，当前不能发起' } : {}),
      }
    })
  }
  const messageStages = [{ id: 'receive', label: '接收消息' }, { id: 'context', label: '准备上下文' },
    { id: 'coordinator', label: '群会话协调' }, { id: 'material', label: '按需读取材料' }, { id: 'dispatch', label: '派发任务' }]
  async function mailboxes() {
    const messages = [], outbox = [], coordinators = {}
    for (const groupId of groups) {
      const binding = await store.query({ kind: 'message.coordinator', conversationId: groupId })
      if (binding.coordinator?.sessionId) coordinators[groupId] = { sessionId: binding.coordinator.sessionId, status: binding.coordinator.status }
      const outboundIds = new Set(await store.query({ kind: 'message.outboundIds', conversationId: groupId }))
      const topicBindings = await store.query({ kind: 'message.topic.bindings', conversationId: groupId })
      const topicRefsBySource = new Map()
      for (const item of topicBindings) topicRefsBySource.set(item.sourceKey, [...(topicRefsBySource.get(item.sourceKey) ?? []), { topicId: item.topic.topicId, revision: item.topic.revision, title: item.topic.title, unitId: item.unitId }])
      const senderNames = new Map((legacyGroup(groupId)?.messages ?? []).filter(item => item.senderOpenDingTalkId && item.senderName).map(item => [item.senderOpenDingTalkId, item.senderName]))
      let beforeSequenceId
      for (;;) {
        const page = await store.query({ kind: 'message.mailbox', conversationId: groupId, limit: 200, ...(beforeSequenceId ? { beforeSequenceId } : {}) })
        for (const state of page) {
          const run = state.run
          if (run.status === 'superseded' || outboundIds.has(run.context?.sourceMessageId) || run.reason === 'message_reprocessed') continue
          const topicRefs = topicRefsBySource.get(run.sourceKey) ?? []
          const pendingRequests = state.requests.filter(item => item.status === 'pending')
          const pendingRequest = pendingRequests.find(item => item.blocked) ?? pendingRequests[0]
          const waitingStatus = pendingRequest?.blocked ? 'waiting_system' : pendingRequest?.kind === 'needs_authorization' ? 'waiting_authorization'
            : pendingRequest?.kind === 'needs_clarification' ? 'waiting_clarification' : pendingRequest?.kind === 'needs_context' ? 'waiting_context' : null
          const waiting = pendingRequests.map(request => ({ requestId: request.id, unitId: request.unitId, kind: request.kind,
            responsibility: request.responsibility ?? (request.kind === 'needs_authorization' ? 'owner' : request.kind === 'needs_clarification' ? 'requester' : 'host'),
            reason: request.question ?? request.reason, blocked: request.blocked === true, attempts: request.attempts ?? 0, retryAt: request.retryAt ?? null,
            recoveryCondition: request.kind === 'needs_authorization' ? '指定授权人批准当前版本的交办后继续'
              : request.kind === 'needs_clarification' ? (request.missingField ? `补齐${request.missingField}后继续${request.blockedAction ?? '处理'}` : '收到该问题的有效补充后继续')
                : request.blocked ? '修复材料读取问题并恢复原请求后继续' : '取得并核验所需材料后继续' }))
          for (const unit of state.units.filter(item => item.blockedReason)) waiting.push({ kind: 'system', responsibility: 'system', blocked: true,
            unitId: unit.unitId ?? unit.id, goalText: unit.goalText, reason: unit.blockedReason,
            recoveryCondition: '修复该事项的处理故障后，按当前来源版本恢复；已证明独立的其他事项可继续' })
          if (run.status === 'needs_attention' && run.attentionScope !== 'unit') waiting.push({ kind: 'system', responsibility: 'system', blocked: true,
            reason: run.reason, recoveryCondition: '排查并修复处理故障后，按当前来源版本恢复' })
          const blockingSources = new Map()
          if (run.intentStatus === 'waiting_routing_barrier') for (const topic of topicRefs) {
            for (const source of await store.query({ kind: 'message.routing.pending', conversationId: groupId, topicId: topic.topicId })) {
              blockingSources.set(source.runId, { runId: source.runId, sourceKey: source.sourceKey, sourceVersion: source.sourceVersion,
                messageId: source.context?.sourceMessageId, text: source.body, reason: source.reason ?? '关联范围尚未核验', topicId: topic.topicId })
            }
          }
          if (blockingSources.size) waiting.push({ kind: 'scope', responsibility: 'host', blocked: true,
            reason: '核对相关输入对当前事项的影响', recoveryCondition: '相关输入已纳入当前要求，或已证明不影响当前事项' })
          const failedAnswer = state.commands.find(command => command.kind === 'answer' && command.status === 'applied' && command.result?.status === 'blocked')
          if (failedAnswer) waiting.push({ kind: 'system', responsibility: 'system', blocked: true,
            reason: failedAnswer.result.reply, recoveryCondition: '系统修复后对原只读答复安全重试，无需重复提交材料' })
          const workflowStatus = waitingStatus ?? (failedAnswer ? 'execution_blocked' : null) ?? (['routing_blocked', 'intent_blocked'].includes(run.routingStatus) || run.intentStatus === 'intent_blocked' ? 'routing_blocked'
            : run.routingStatus === 'routing_pending' ? 'routing' : run.intentStatus ?? (run.status === 'needs_attention' ? 'routing_blocked' : run.status === 'settled' ? 'processed' : 'routing'))
          messages.push({ groupId, messageId: run.context?.sourceMessageId, runId: run.runId, sourceVersion: run.sourceVersion, text: run.body, senderOpenDingTalkId: run.actorId,
            senderName: run.context?.senderName ?? senderNames.get(run.actorId), occurredAt: run.context?.occurredAt ?? run.createdAt, sequence: run.sequenceId,
            topicRefs, workflowStatus, waiting, blockingSources: [...blockingSources.values()],
            ...(pendingRequest?.question || pendingRequest?.reason || failedAnswer || run.reason ? { workflowStatusDetail: pendingRequest?.question ?? pendingRequest?.reason ?? failedAnswer?.result.reply ?? run.reason } : {}),
            routingStatus: run.status === 'needs_attention' ? 'failed' : run.reason === 'message_quiet' && isPassiveTaskProgress(run.body) && !topicRefs.length ? 'pending' : ['settled', 'superseded'].includes(run.status) ? 'routed' : 'pending' })
        }
        if (page.length < 200) break
        beforeSequenceId = page.at(-1).sequenceId
      }
    }
    const states = ['prepared', 'sending', 'acknowledged', 'unknown', 'delivered', 'superseded']
    let afterSequenceId = 0
    for (;;) {
      const page = await store.query({ kind: 'message.notifications', states, afterSequenceId, limit: 200 })
      const replacements = await store.query({ kind: 'message.notificationReplacements', notificationIds: page.map(notice => notice.id) })
      for (const notice of page) {
        const groupId = notice.payload?.conversationId
        if (!groups.has(groupId)) continue
        outbox.push({ groupId, runId: notice.runId, phase: notice.payload.phase, notificationStatus: notice.status,
          outboundId: notice.id, text: notice.payload.text, sourceMessageId: notice.payload.sourceMessageId,
          deliveredMessageId: notice.evidence?.messageId, status: notice.status === 'delivered' ? 'sent' : notice.status === 'superseded' ? 'superseded' : 'pending',
          ...(notice.recallStatus ? { recallStatus: notice.recallStatus } : {}),
          createdAt: notice.createdAt, deliveredAt: notice.deliveredAt, deliveryAttemptedAt: notice.startedAt,
          deliveryAttemptCount: notice.leaseEpoch, ...(notice.status === 'unknown' ? { deliveryPendingReason: 'send_unknown' } : {}),
          ...(notice.status === 'acknowledged' ? { deliveryPendingReason: 'message_not_observed' } : {}) })
        for (const replacement of replacements.filter(item => item.restoresNotificationId === notice.id))
          outbox.push({ groupId, outboundId: `replacement:${replacement.id}`, text: replacement.body,
            sourceMessageId: replacement.sourceMessageId, deliveredMessageId: replacement.messageId,
            replacesNotificationId: notice.id, status: 'sent', createdAt: replacement.recordedAt, deliveredAt: replacement.recordedAt })
      }
      if (page.length < 200) break
      afterSequenceId = page.at(-1).sequenceId
    }
    for (const message of messages) message.notifications = outbox.filter(notice => notice.runId === message.runId)
      .map(notice => ({ notificationId: notice.outboundId, phase: notice.phase, status: notice.notificationStatus,
        acknowledged: ['acknowledged', 'delivered'].includes(notice.notificationStatus), delivered: notice.notificationStatus === 'delivered' }))
    return { messages, outbox, coordinators }
  }
  async function topics(groupId) {
    const selected=groupId ? [groupId] : [...groups]
    return (await Promise.all(selected.filter(id=>groups.has(id)).map(id=>store.query({kind:'message.topics',conversationId:id,limit:200})))).flat()
  }
  async function topicContext({groupId,topicId,offset=0,limit=50}) {
    if(!groups.has(groupId)) return null
    let topic=await store.query({kind:'message.topic',topicId})
    if(!topic||topic.conversationId!==groupId) return null
    if(topic.mergedIntoTopicId) {
      topic=await store.query({kind:'message.topic',topicId:topic.mergedIntoTopicId})
      if(!topic||topic.conversationId!==groupId||topic.mergedIntoTopicId) return null
      topicId=topic.topicId
    }
    const refs=[...new Set([...topic.facts.flatMap(fact=>fact.sourceRefs.map(ref=>ref.sourceKey)),...await store.query({kind:'message.topic.sources',topicId})])]
    const messages=(await Promise.all(refs.map(key=>store.query({kind:'message.source',sourceKey:key})))).filter(Boolean)
      .map(run=>({messageId:run.context?.sourceMessageId,text:run.body,senderName:run.context?.senderName,occurredAt:run.context?.occurredAt??run.createdAt,sourceKind:'workflow-v2'}))
      .sort((a,b)=>String(a.occurredAt).localeCompare(String(b.occurredAt)))
    return {topic,messages:messages.slice(offset,offset+limit),total:messages.length,offset,limit}
  }
  async function messageTraceRecords(runId) {
    const data = await messages.state(runId)
    if (!data?.run || !groups.has(data.run.conversationId)) return null
    const coordination = data.run.coordinatorConsumed ? (await store.query({ kind: 'message.coordinator', conversationId: data.run.conversationId })).coordinator : null
    const shared = []
    let beforeSequenceId
    do {
      const page = await store.query({ kind: 'message.intent.runs', runId, limit: 100, ...(beforeSequenceId ? { beforeSequenceId } : {}) })
      shared.push(...page)
      beforeSequenceId = page.length === 100 ? page.at(-1).sequenceId : null
    } while (beforeSequenceId)
    const byId = new Map(data.nodes.map(node => [node.nodeRunId, { ...node, carrierRunId: runId }]))
    for (const node of shared) if (!byId.has(node.nodeRunId)) byId.set(node.nodeRunId, node)
    const nodeKinds = { S: 'split', R: 'route', I: 'intent', IB: 'intent' }
    const items = [...byId.values()].map(node => ({ id: node.nodeRunId, kind: nodeKinds[node.nodeId] ?? 'node', nodeId: node.nodeId,
      unitId: node.unitId, status: node.status, createdAt: node.createdAt, startedAt: node.startedAt, attempt: node.leaseEpoch, completedAt: node.completedAt ?? node.finishedAt,
      topicId: node.input?.topicId ?? node.input?.sharedTopic?.topicId, intentRunId: node.input?.intentRunId,
      carrierRunId: node.carrierRunId, sourceRunIds: node.input?.units?.map(unit => unit.runId),
      evidenceRefs: node.output?.output?.evidence ?? node.input?.sharedTopic?.sources?.map(ref => `${ref.sourceKey}@${ref.sourceVersion}`) ?? [],
      gaps: [...(node.input?.omissions ?? []).map(item => item.reason ?? '历史输入已裁剪'), ...(node.input?.omittedCandidateCount ? [`未展示候选：${node.input.omittedCandidateCount}`] : [])],
      deterministic: node.input?.deterministic === true,
      input: node.input, output: node.output?.output ?? node.output, reason: node.error ?? null, usage: node.usage ?? node.output?.usage ?? null }))
      .concat(data.commands.map(command => ({ id: command.commandId ?? command.id, kind: 'command', status: command.status,
        unitId: command.unitId, topicId: command.topicId, createdAt: command.createdAt, startedAt: command.startedAt, attempt: command.leaseEpoch, completedAt: command.completedAt,
        input: { kind: command.kind, args: command.args, dependsOn: command.dependsOn }, output: command.result,
        reason: command.error ?? command.reason ?? null })))
      .concat(coordination ? [{ id: data.run.coordinatorConsumed.turnId, kind: 'coordinator', nodeId: 'coordinator',
        sessionId: coordination.sessionId, status: 'committed', attempt: data.run.coordinatorConsumed.leaseEpoch,
        createdAt: data.run.createdAt, completedAt: data.run.coordinatorConsumed.at, carrierRunId: runId, sourceRunIds: [runId],
        input: { source: { sourceKey: data.run.sourceKey, sourceVersion: data.run.sourceVersion, text: data.run.body }, context: data.run.snapshot },
        output: { units: data.units.filter(unit => unit.status !== 'superseded').map(unit => ({ unitId: unit.id, goalText: unit.goalText, binding: unit.routingBinding, status: unit.status })) },
        reason: data.run.reason ?? null }] : [])
      .concat((data.executions ?? []).map(execution => ({ id: `agent:${execution.commandId}`, kind: 'agent', unitId: execution.unitId,
        status: execution.result?.status === 'blocked' ? 'blocked' : execution.status,
        createdAt: execution.createdAt, startedAt: execution.startedAt, completedAt: execution.completedAt ?? execution.drainedAt,
        attempt: execution.leaseEpoch, sessionId: execution.sessionBound ? execution.sessionId : null,
        outputRef: execution.resultRef ?? null, evidenceCount: execution.result?.evidenceRefs?.length ?? 0,
        clarification: (() => {
          const request = data.requests.find(item => item.id === execution.requestId && item.status === 'pending')
          return request ? { runId, requestId: request.id, question: request.question,
            canAnswer: !!config.webActorId && (config.webActorId === ownerActorId || request.permittedActors?.includes(config.webActorId)) } : null
        })(),
        input: { question: data.requests.find(request => request.id === execution.requestId && request.status === 'pending')?.question },
        output: { reply: execution.result?.reply }, reason: execution.error ?? null })))
      .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')) || String(a.id).localeCompare(String(b.id)))
    return { data, items }
  }
  async function messageTrace(runId, { offset = 0, limit = 50 } = {}) {
    const trace = await messageTraceRecords(runId)
    if (!trace) return null
    const { data, items } = trace
    const pageItems = items.slice(offset, offset + limit)
    const sourceCache = new Map([[runId, data.run]])
    for (const item of pageItems.filter(item => ['intent', 'coordinator'].includes(item.kind))) {
      const topic = item.topicId ? await store.query({ kind: 'message.topic', topicId: item.topicId }) : null
      item.topicTitle = topic?.conversationId === data.run.conversationId ? topic.title : null
      item.sourceMessages = []
      for (const sourceId of [...new Set(item.sourceRunIds ?? [runId])]) {
        if (!sourceCache.has(sourceId)) sourceCache.set(sourceId, (await messages.state(sourceId))?.run)
        const source = sourceCache.get(sourceId)
        if (!source || source.conversationId !== data.run.conversationId) continue
        item.sourceMessages.push({ runId: sourceId, text: source.body, senderName: source.context?.senderName ?? null,
          occurredAt: source.context?.occurredAt ?? source.createdAt, current: sourceId === runId })
      }
    }
    return { runId, message: { text: data.run.body, receivedAt: data.run.createdAt }, status: data.run.status, reason: data.run.reason ?? null, revision: data.run.revision ?? data.run.matterSetRevision ?? 0,
      items: pageItems.map(({ input, output, usage, evidenceRefs, deterministic, ...item }) => ({ ...item, summary: describeMessageTraceItem({ ...item, input, output }) })), nextCursor: offset + limit < items.length ? offset + limit : null, total: items.length }
  }
  async function workflowTopicContext(topicId, { offset = 0, limit = 50, intentCursor = 0, expectedRevision = null } = {}) {
    const topic = await store.query({ kind: 'message.topic', topicId })
    if (!topic || !groups.has(topic.conversationId)) return null
    if (expectedRevision !== null && topic.contextRevision !== expectedRevision) throw executionError('MESSAGE_TOPIC_CONTEXT_STALE')
    const page = await store.query({ kind: 'message.topic.facts', topicId, status: 'active', cursor: offset, limit })
    if (page.contextRevision !== topic.contextRevision) throw executionError('MESSAGE_TOPIC_CONTEXT_STALE')
    const sourceKeys = await store.query({ kind: 'message.topic.sources', topicId })
    const intentRuns = await store.query({ kind: 'message.topic.intents', topicId, limit: 50, ...(intentCursor ? { beforeSequenceId: intentCursor } : {}) })
    return { topicId, revision: page.contextRevision, current: { topicTitle: topic.title, activeFactCount: page.total,
      sourceCount: sourceKeys.length, hasMoreFacts: page.nextCursor !== null }, facts: page.facts,
      intentRuns, intentNextCursor: intentRuns.length === 50 ? intentRuns.at(-1).sequenceId : null, nextCursor: page.nextCursor, total: page.total }
  }
  async function messageEvidence(runId, resourceRef, { offset = 0, limit = 2000, hash = null } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 2 || limit > 8000) throw executionError('MESSAGE_EVIDENCE_CURSOR_INVALID')
    const data = await messages.state(runId)
    if (!data?.run || !groups.has(data.run.conversationId)) return null
    let material = await store.query({ kind: 'message.material', runId, resourceRef })
    let evidenceRefs
    if (!material) {
      // 只按本消息已接纳的产出引用读取工件；默认 trace 不读取任何工件正文。
      const ownOutput = (data.executions ?? []).find(execution => execution.resultRef === resourceRef)
      const ownEvidence = (data.executions ?? []).find(execution => execution.result?.evidenceRefs?.includes(resourceRef))
      if (ownOutput || ownEvidence && /^sha256-[a-f0-9]{64}\.json$/.test(resourceRef)) {
        const output = await artifacts.read(resourceRef)
        if (ownOutput) {
          evidenceRefs = ownOutput.result?.evidenceRefs ?? []
          const body = output.summary ?? output.reply ?? '本次执行未生成答复正文。'
          material = { text: [body, ...(output.limitations?.length ? ['\n已知限制', ...output.limitations] : [])].join('\n') }
        } else if (output.kind === 'agent-query-evidence' && output.execution?.runId === runId) {
          // 保留来源和业务查询结果，隐藏会话租约、权限摘要等内部身份。
          material = { text: [`读取时间：${output.observedAt ?? '未记录'}`, '来源：', ...(output.verification?.sourceRefs ?? []),
            '\n读取结果：', typeof output.result === 'string' ? output.result : JSON.stringify(output.result, null, 2)].join('\n') }
        }
      }
    }
    if (!material) {
      const trace = await messageTraceRecords(runId)
      const sources = [data.run.snapshot?.source, ...(data.run.snapshot?.quotes ?? []), ...(data.run.snapshot?.history ?? []),
        ...trace.items.flatMap(item => item.input?.sharedTopic?.sources ?? [])].filter(Boolean)
      material = sources.find(ref => ref.sourceKey === resourceRef && typeof ref.text === 'string')
    }
    if (typeof material?.text !== 'string') return null
    const currentHash = executionDigest(material.text)
    if (hash && hash !== currentHash) throw executionError('MESSAGE_EVIDENCE_VERSION_CHANGED')
    if (offset > material.text.length || offset > 0 && (!hash || /[\uDC00-\uDFFF]/u.test(material.text[offset] ?? ''))) throw executionError('MESSAGE_EVIDENCE_CURSOR_INVALID')
    let end = Math.min(material.text.length, offset + limit)
    if (end < material.text.length && /[\uD800-\uDBFF]/u.test(material.text[end - 1])) end--
    return { runId, resourceRef, ...(evidenceRefs ? { evidenceRefs } : {}), hash: currentHash, sourceVersion: material.sourceVersion ?? null, totalLength: material.text.length,
      totalBytes: Buffer.byteLength(material.text), start: offset, end, text: material.text.slice(offset, end),
      complete: offset === 0 && end === material.text.length, nextCursor: end < material.text.length ? end : null }
  }
  async function taskNodeOutput(taskId, runId, nodeRunId, { offset = 0, limit = 1200, outputRef, detailRevision, document = false } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 2 || limit > 8000)
      throw executionError('TASK_OUTPUT_CURSOR_INVALID')
    const family = await readableTaskFamily(taskId)
    if (!family || family.latestTaskId !== taskId) return null
    const before = await store.query({ kind: 'task.viewRevision', taskId })
    if (detailRevision !== undefined && detailRevision !== before) throw executionError('TASK_OUTPUT_CHANGED')
    const plan = await controller.taskPlan(taskId)
    const stage = plan?.stages.find(item => item.runId === runId)
    if (plan && (!stage || stage.status === 'invalidated'
      || plan.task.planRequirementRevision !== plan.task.requirementRevision)) return null
    const state = await store.query({ kind: 'run', runId })
    if (!state.run || state.run.taskId !== taskId || state.pendingInputCount) return null
    const node = state.nodes.find(item => item.nodeRunId === nodeRunId)
    const readableRef = node && await taskNodeReadoutRef(node)
    if (!readableRef) return null
    if (outputRef !== readableRef) throw executionError('TASK_OUTPUT_CHANGED')
    const output = await artifacts.read(outputRef)
    const context = {}
    if (node.nodeId === 'prepare-workspace' && !output?.workspace) {
      const effects = await store.query({ kind: 'effect.list', runId })
      const effect = effects.find(item => item.nodeRunId === nodeRunId && item.generation === node.generation && item.state === 'succeeded' && item.definition?.action === 'workspace')
      if (effect?.result?.result?.status === 'succeeded') context.workspace = { ...effect.result.result, sourceRepository: effect.definition.payload.sourceRepository }
    }
    if (node.nodeId === 'prepare-generation' && !output?.startingPoint) {
      const records = await store.query({ kind: 'workflow.list' })
      const record = records.find(item => item.workflowId === state.run.workflowId && item.digest === state.run.workflowDigest && item.config?.taskId === taskId)
      if (record) context.startingPoint = { repository: record.config.repoId, workBranch: record.config.head }
    }
    const result = describeTaskNodeOutput(node, output, context), { text, overview } = result
    // 工件读取期间发生修订也不能把旧正文交给当前页面。
    if (before !== await store.query({ kind: 'task.viewRevision', taskId })) throw executionError('TASK_OUTPUT_CHANGED')
    if (document) return result.document ?? null
    if (['inspect-and-propose', 'propose-changes', 'validate-proposal'].includes(node.nodeId)) {
      const pathText = `方案工件路径\n${artifacts.locate ? artifacts.locate(node.outputRef) : join(artifacts.root, node.outputRef)}`
      return { text: pathText, overview: '', nextCursor: null, totalLength: pathText.length }
    }
    if (offset > text.length || offset > 0 && /[\uDC00-\uDFFF]/u.test(text[offset] ?? '')) throw executionError('TASK_OUTPUT_CURSOR_INVALID')
    let end = Math.min(text.length, offset + limit)
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1])) end--
    return { text: text.slice(offset, end), nextCursor: end < text.length ? end : null, totalLength: text.length, overview,
      ...(result.document ? { documentName: result.document.name } : {}) }
  }
  async function taskRuns(taskId, { offset = 0, limit = 20 } = {}) {
    const origin = await store.query({ kind: 'task.origin', taskId })
    if (!readableTaskOrigin(origin)) return null
    const owner = await store.query({ kind: 'task.owner', taskId })
    const runs = await store.query({ kind: 'run.list', taskId, limit: limit + 1, ...(offset ? { beforeSequenceId: offset } : {}) })
    const selected = runs.slice(0, limit)
    return { taskId, taskOwner: owner ? { sessionId: owner.sessionId, sessionBound: owner.sessionBound, status: owner.status, decision: owner.decision?.action ?? null } : null, runs: await Promise.all(selected.map(async run => {
      const state = await controller.state(run.runId)
      return { runId: run.runId, status: run.status, startedAt: run.createdAt,
        nodes: state.nodes.map(node => ({ nodeId: node.nodeId, label: node.title ?? node.nodeId,
          status: node.status, sessionBound: node.sessionBound === true, sessionId: node.sessionBound === true ? node.sessionId ?? null : null })) }
    })), nextCursor: runs.length > limit ? selected.at(-1).sequenceId : null, total: null }
  }
  return {
    ingest, resumeRequest, recoverClarification, handoffDataChangeApproval, reassessReadonly, repairStageAuthorizations, retryInvestigation, retryOwner, retryReadonlyAnswer, retryMaterialRequest, reprocessMessage, decideApproval, isApprovalRequest, listApprovalRequests, getApprovalRequest, prepareApprovalNotice, approvalNoticeCommand, reissueApprovalNotice,
    getApprovalNotice: requestId => store.query({ kind: 'approval.notice', requestId }), submitWebTask, mailboxes, topics, topicContext,
    maintenance: () => store.query({ kind: 'runtime.maintenance' }),
    async reconcileTopic(request, identity, check = false) {
      if (identity?.channel !== 'web' || !config.webActorId || identity.actorId !== config.webActorId) throw executionError('WORKFLOW_WEB_ACTOR_FORBIDDEN')
      const { requestId, ...input } = request
      const args = { ...input, actorId: identity.actorId }
      const source = await store.query({ kind: 'message.topic', topicId: args.sourceTopicId })
      const target = await store.query({ kind: 'message.topic', topicId: args.targetTopicId })
      if (!source || !target || !groups.has(source.conversationId) || source.conversationId !== target.conversationId) throw executionError('WORKFLOW_TOPIC_FORBIDDEN')
      if (check) return store.query({ kind: 'message.topic.reconcile.check', ...args })
      if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 200) throw executionError('MESSAGE_TOPIC_RECONCILE_INVALID')
      return (await store.command({ id: `topic-reconcile:${requestId}`, kind: 'message.topic.reconcile', args })).result
    },
    completedObservations: taskId => store.query({ kind: 'task.owner.completed-observations', taskId }),
    async reconcileCompletedObservations(request, identity) {
      if (identity?.channel !== 'web' || !config.webActorId || identity.actorId !== config.webActorId) throw executionError('WORKFLOW_WEB_ACTOR_FORBIDDEN')
      const { requestId, ...args } = request
      if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 200) throw executionError('OWNER_COMPLETED_OBSERVATIONS_INVALID')
      const receipt = await store.command({ id: `owner-completed-observations:${requestId}`, kind: 'task.owner.reconcile-completed-observations', args: { ...args, actorId: identity.actorId } })
      return { receipt, owner: await store.query({ kind: 'task.owner', taskId: args.taskId }) }
    },
    async changeMaintenance(request, identity, operation = 'change') {
      if (!['change','seal','resume'].includes(operation)) throw executionError('RUNTIME_MAINTENANCE_INVALID')
      if (identity?.channel !== 'web' || !config.webActorId || identity.actorId !== config.webActorId) throw executionError('WORKFLOW_WEB_ACTOR_FORBIDDEN')
      const { requestId, ...args } = request
      if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 200) throw executionError('RUNTIME_MAINTENANCE_INVALID')
      const receipt = await store.command({ id: `maintenance:${requestId}`, kind: `runtime.maintenance.${operation}`, args: { ...args, actorId: identity.actorId } })
      return { receipt, state: await store.query({ kind: 'runtime.maintenance' }) }
    },
    prepareWorkflowNotificationOperation, executeWorkflowNotificationOperation, reconcileWorkflowNotificationOperation,
    isTask: async taskId => !!await store.query({kind:'task.origin',taskId}), messages, execution, tasks, messageTrace, workflowTopicContext, messageEvidence, taskRuns, taskNodeOutput,
    boardTasks, taskDetail, taskExecutions,
    isGroup: id => groups.has(id), flushNotifications: () => notifier.flush(),
    catalog: () => ({ engine: 'workflow-v2', groupIds: [...groups], messageStages, builtInWorkflows: [taskProgressQueryDefinition], workflows: workflowCatalogState() }),
    async state(runId) { return runId ? messages.state(runId) : { engine: 'workflow-v2', groupIds: [...groups], store: store.info,
      messages: await store.query({ kind: 'message.list', limit: 100 }), tasks: await tasks() } },
    recover: recoverAll, recoverExecutionTasks, deleteCancelledTask,
    async close() {
      closed = true
      await closeExecutionResources([['messageAgent', () => messageAgent.close()], ['messages', () => messages.close()],
        ['taskOwner', () => taskOwner.close()], ['execution', () => !suppliedExecution && execution.close()]])
    },
  }
}
