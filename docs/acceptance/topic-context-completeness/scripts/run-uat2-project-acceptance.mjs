import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createLocalAcceptanceRunner } from '../../../../packages/dingtalk-dsh-assistant/execution-local-acceptance.js'
import { freezeCandidate } from '../../../../packages/dingtalk-dsh-assistant/execution-candidate.js'

const [project, bundlePath, outputDirectory] = process.argv.slice(2)
if (!['dataset', 'dataset-web'].includes(project) || !bundlePath || !outputDirectory) throw new Error('固定项目、配置与输出目录必填')
const bundle = JSON.parse(await readFile(bundlePath, 'utf8'))
const repository = `D:/project/worktrees/${project}-uat2-local-acceptance`
const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
const plan = { cases: [project === 'dataset'
  ? { criterionId: 'units-read', scenarioId: 'uat-readonly-api', steps: ['真实登录 UAT2', '本地候选查询单位分页', '确认响应成功且真实数据非空'], expected: '{"code":"200","nonempty":true}', parameters: { endpoint: 'units', body: { page: 1, size: 2 }, projections: [{ name: 'code', path: ['code'], op: 'value' }, { name: 'nonempty', path: ['data'], op: 'nonempty' }] } }
  : { criterionId: 'login-ui', scenarioId: 'uat-readonly-browser', steps: ['核对本地后端 origin 和 JAR SHA256', '独立浏览器打开真实登录页', '读取两个登录输入框'], expected: '2', parameters: { path: '/login', selector: 'input', read: 'count', authenticate: false } }
] }
if (project === 'dataset-web') plan.cases.push({ criterionId: 'units-ui', scenarioId: 'uat-readonly-browser', steps: ['真实 UAT2 登录', '通过本地前端查询本地后端单位数据', '确认首行单位单元格可见'], expected: 'true', parameters: { path: '/unit/base', selector: '.layout-route-view .table-main .el-table__body-wrapper tbody tr:first-child td:first-child .cell', read: 'visible', authenticate: true } })
await mkdir(outputDirectory, { recursive: true })
const candidate = await freezeCandidate({ repository, baseCommit, generation: 1, requirementDigest: createHash('sha256').update(JSON.stringify(plan)).digest('hex') })
const runner = createLocalAcceptanceRunner({ root: `D:/dsh_home/workflows/runtime-v2/local-acceptance/integration/${project}`, config: bundle[project] })
const prepared = await runner.prepare({ candidate, plan, taskId: `uat2-integration-${project}`, runId: `uat2-${Date.now()}`, generation: 1, uatEnvironment: 'uat2' })
await writeFile(`${outputDirectory}/${project}-prepared.json`, JSON.stringify(prepared, null, 2))
console.log(JSON.stringify({ project, phase: 'prepared', identity: prepared.identity, candidate: candidate.digest }))
const result = await runner.execute(prepared)
await writeFile(`${outputDirectory}/${project}-receipt.json`, JSON.stringify(result, null, 2))
console.log(JSON.stringify({ project, passed: result.passed, failureCode: result.failureCode, checks: result.checks, cleanup: result.cleanup, phases: result.phases }))
if (!result.passed) process.exitCode = 1
