import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'

// 本轮两项真实任务的受信场景配方；只生成不可变文件，不激活运行 profile。
const [templatePath, originalReviewRuntimePath, mergeRuntimePath] = process.argv.slice(2)
if (![templatePath, originalReviewRuntimePath, mergeRuntimePath].every(p => isAbsolute(p ?? ''))) throw new Error('ABSOLUTE_CONFIG_PATHS_REQUIRED')
const root = 'D:/dsh_home/workflows/runtime-v2/local-acceptance'
const hash = value => createHash('sha256').update(value).digest('hex')
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const immutable = async (path, value) => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }) }
  catch (error) { if (error.code !== 'EEXIST' || !bytes.equals(await readFile(path))) throw error }
}
const files = ['local-acceptance-project.mjs', 'local-acceptance-readonly.mjs', 'local-acceptance-review.mjs', 'local-acceptance-merge.mjs', 'LocalAcceptanceBackground.java', 'verify-dataset-unit-tests.mjs']
const contents = await Promise.all(files.map(file => readFile(new URL('../../../../scripts/' + file, import.meta.url))))
const toolHash = hash(Buffer.concat(contents)), toolDirectory = root + '/tools/' + toolHash
await mkdir(toolDirectory, { recursive: true })
for (let i = 0; i < files.length; i++) await immutable(toolDirectory + '/' + files[i], contents[i])
const bundle = await json(templatePath), review = await json(originalReviewRuntimePath), merge = await json(mergeRuntimePath)
const companion = bundle['dataset-web'].companionServices?.find(service => service.id === 'dataset')
if (!companion?.artifactPath || !/^[a-f0-9]{64}$/.test(companion.artifactSha256 ?? '')) throw new Error('COMPANION_IDENTITY_REQUIRED')
review.companionArtifact = { path: companion.artifactPath, sha256: companion.artifactSha256 }
const reviewText = JSON.stringify(review, null, 2), reviewRuntimePath = root + '/review-' + hash(reviewText).slice(0, 16) + '.json'
await immutable(reviewRuntimePath, reviewText)
if (review.uatEnvironment !== 'uat2' || merge.uatEnvironment !== 'uat3') throw new Error('TASK_UAT_MISMATCH')
const profile = await json(bundle.dataset.sharedDataProfilePath)
await mkdir(root + '/temp', { recursive: true })
profile.env = { ...profile.env, TEMP: root + '/temp', TMP: root + '/temp' }
const profileText = JSON.stringify(profile, null, 2), profilePath = root + '/profile-' + hash(profileText) + '.json'
await immutable(profilePath, profileText)
const command = (runtime, path, file, operation) => ({ executable: runtime.nodeExecutable,
  args: ['--openssl-legacy-provider', toolDirectory + '/' + file, operation, '--config', path] })
const backend = bundle.dataset, frontend = bundle['dataset-web']
backend.version = 'uat3-merge-' + toolHash.slice(0, 12)
backend.sharedDataProfilePath = profilePath
backend.prepareSteps = [command(merge, mergeRuntimePath, files[3], 'initialize'), command(merge, mergeRuntimePath, files[0], 'prepare-dataset')]
backend.generatedOutputDirectories = ['target']
backend.cleanup = command(merge, mergeRuntimePath, files[3], 'cleanup')
backend.verifyCleanup = command(merge, mergeRuntimePath, files[3], 'verify-cleanup')
const mergeActual = JSON.stringify({ sourceCount: 2, sourceValue: '0.5', sourceUnit: 'kg', declaredUnit: 't', weightSum: '1', resultValue: '1', resultUnit: 't', persisted: true })
backend.scenarios = [{ ...command(merge, mergeRuntimePath, files[3], 'api'), id: 'merge-normalization',
  description: 'parameters为空对象。创建本次命名空间两份专属0.5kg声明t数据，各权重0.5；真实preview和confirm后独立数据库读取结果1t，清理精确数据及Redis snapshot。expected必须逐字为' + mergeActual }]
const backgroundPaths = ['com/ecdigit/ecdata/task/ApprovalReminderTask.java', 'com/ecdigit/ecdata/task/DataQualityReportTask.java',
  'com/ecdigit/ecdata/task/DatasourceVersionCalculateTask.java', 'com/ecdigit/ecdata/task/VersionDiffReportTimeoutTask.java',
  'com/hiqdata/convertor/domain/task/reconcile/TaskReconciler.java', 'com/ecdigit/ecdata/config/RedisStreamConsumerConfig.java',
  'com/ecdigit/ecdata/controller/internal/ApprovalReminderDebugController.java']
backend.instructions = '仅本次明确UAT3任务；共享连接和SSO来自受信外置配置。必须使用merge-normalization验证preview/confirmation真实入口，不可用旧CommonService补丁或单位查询冒充。保留鉴权。以下src/main/java/路径需要@ConditionalOnProperty(name="app.background-jobs.enabled",havingValue="true",matchIfMissing=true)：' + backgroundPaths.join('、') + '；com/ecdigit/ecdata/service/BlacklistCacheService.java读取${app.background-jobs.enabled:true}并关闭后台刷新，仅启动只读加载。缺失时在冻结候选前按已授权本地验收模式修改。合并写入仅本次专属数据，审计日志保留。'
frontend.version = 'uat2-review-' + toolHash.slice(0, 12)
frontend.sharedDataProfilePath = profilePath
frontend.prepareSteps = [command(review, reviewRuntimePath, files[2], 'initialize'), command(review, reviewRuntimePath, files[0], 'prepare-web')]
frontend.generatedOutputDirectories = ['node_modules', 'dist']
const serve = command(review, reviewRuntimePath, files[0], 'serve-web')
frontend.service = { ...serve, args: [...serve.args, '--host', '127.0.0.1', '--port', '{port}'], readyPath: '/login' }
frontend.cleanup = command(review, reviewRuntimePath, files[2], 'cleanup')
frontend.verifyCleanup = command(review, reviewRuntimePath, files[2], 'verify-cleanup')
frontend.scenarios = [{ ...command(review, reviewRuntimePath, files[2], 'execute'), id: 'review-opinion-draft',
  description: 'parameters为空对象。真实审核人以页面添加自定义维度，填写意见、保存、离开后重新进入，读取真实输入框验证恢复；不提交、不上传、不分配。expected逐字为{"saved":true,"restored":true,"browserStorageCleared":true}。' }]
frontend.instructions = '仅本次明确UAT2任务，真实候选前端绑定固定本地伴随后端。必须review-opinion-draft专门场景，不得用登录/通用查询替代。保留最新UAT2面板草稿机制，不引入旧PR父组件重复保存按钮。共享业务写入为零，独立浏览器关闭并注销会话。'
const policy = { targets: [
  { targetId: 'dataset-uat3-deployment', requiredChecks: [], requiredScenarioIds: ['merge-normalization'] },
  { targetId: 'dataset-web-uat2-deployment', requiredChecks: [], requiredScenarioIds: ['review-opinion-draft'] },
] }
const bundleText = JSON.stringify(bundle, null, 2), bundlePath = root + '/tasks-' + hash(bundleText).slice(0, 16) + '.json'
const policyText = JSON.stringify(policy, null, 2), policyPath = root + '/merge-policy-' + hash(policyText).slice(0, 16) + '.json'
await immutable(bundlePath, bundleText); await immutable(policyPath, policyText)
console.log(JSON.stringify({ reviewRuntimePath, bundlePath, policyPath, toolDirectory, profilePath, toolFiles: files.map((name, i) => ({ name, sha256: hash(contents[i]) })) }))
