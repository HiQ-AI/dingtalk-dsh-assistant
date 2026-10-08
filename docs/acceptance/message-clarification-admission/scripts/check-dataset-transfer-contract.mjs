import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

// 前置核验不是业务验收：缺少真实API合同时禁止生成PASS或猜测新URL。
export async function inspectDatasetTransferContract(repository) {
  const files = ['ProcessDraftController.java', 'ProcessCoreController.java']
  const evidence = []
  for (const name of files) {
    const path = `src/main/java/com/ecdigit/ecdata/controller/${name}`
    const source = await readFile(join(repository, path), 'utf8')
    evidence.push({ path, sha256: createHash('sha256').update(source).digest('hex'),
      mappings: [...source.matchAll(/@(Get|Post|Put|Delete)Mapping\(\s*"([^"\r\n]+)"/g)].map(match => ({ method: match[1].toUpperCase(), path: match[2] })) })
  }
  const draft = evidence[0].mappings
  const blockers = []
  if (!draft.some(route => /export/i.test(route.path))) blockers.push('FR02_DRAFT_UPR_EXPORT_API_MISSING')
  if (!draft.some(route => /upr/i.test(route.path) && /import/i.test(route.path))) blockers.push('FR04_DRAFT_UPR_REPLACE_API_MISSING')
  // 即使新增了端点，仍须落实专属fixture、全Sheet/覆盖/回滚/清旧结果实测；源码存在不能冒充业务通过。
  blockers.push('FR01_FR06_RUNTIME_TRANSFER_SUITE_NOT_VERIFIED')
  return { scenario: 'dataset-process-transfer', uatEnvironment: 'uat2', ready: false, passed: false,
    kind: 'business-api-contract-preflight', blockers, evidence }
}
async function main() {
  const [mode, flag, repository, ...extra] = process.argv.slice(2)
  if (mode !== '--check' || flag !== '--repository' || !repository || extra.length) throw new Error('DATASET_TRANSFER_ARGUMENT_INVALID')
  const result = await inspectDatasetTransferContract(resolve(repository))
  process.stdout.write(JSON.stringify(result) + '\n')
  if (!result.ready) process.exitCode = 2
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main().catch(error => { process.stderr.write(error.code ?? error.message); process.exitCode = 1 })
