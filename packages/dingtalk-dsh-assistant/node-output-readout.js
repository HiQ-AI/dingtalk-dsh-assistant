import {workflowResultText} from './workflow-notifications.js'
import {describeVerificationChecks} from './execution-check-job.js'
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
    if(!workspace)return {overview:'工作目录回执未记录',text:'未找到本次节点的成功目录回执。'}
    const actual=workspace.sourceMode==='remote-source-only'
    return {overview:workspace.status==='succeeded'?'已绑定 Task 独立 Git 工作目录':'工作目录回执未记录',text:`工作目录\n${workspace.directory}\n\n${actual?'实际开发分支':'登记的开发分支（旧回执未证明 checkout 分支）'}\n${workspace.developmentBranch??'未记录'}\n\n源分支\n${workspace.sourceBranch??'历史记录未区分'}\n\nPR / UAT 目标分支\n${workspace.targetBranch??'未记录'}\n\n实际 checkout 提交\n${workspace.sourceCommit??workspace.baseCommit??'未记录'}\n\n来源\n${workspace.remote??workspace.sourceRepository??'未记录'}\n\n隔离方式\nTask 独立 Git 仓库；工作区回执绑定实际目录与提交。`}
  }
  if (node.nodeId === 'prepare-generation') {
    const point = output?.startingPoint ?? context.startingPoint, requirement = output?.requirement ?? output
    const remoteSource=point?.sourceOrigin==='remote-ls-remote'
    return { overview: '已解析项目与分支意向；工作目录尚未创建',
      text: `项目\n${point?.repository ?? '历史记录未提供项目名称'}\n\n源分支\n${point?.sourceBranch ?? '历史记录未区分'}\n\n拟用开发分支\n${point?.plannedDevelopmentBranch ?? point?.workBranch ?? '未记录'}\n\nPR / UAT 目标分支\n${point?.targetBranch ?? '未记录'}\n\n${remoteSource?'远程源提交（ls-remote 查询）':'登记的修改起点（历史来源未区分）'}\n${remoteSource?point.remoteSourceCommit:requirement?.baseCommit ?? '未记录'}\n\n创建状态\n本节点仅解析配置和远程引用；实际目录、工作分支和 checkout 提交由后续工作区回执记录。` }
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
  if (node.nodeId === 'apply-changes' && output?.status === 'plan-revision-needed') {
    add('方案修订意见', output.summary)
    add('技术方案引用', output.planRef)
    overview = '技术方案待修订，尚未编辑'
  }
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
