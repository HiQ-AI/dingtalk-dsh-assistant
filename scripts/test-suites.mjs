import { readdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, relative, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { testFiles } from './test-catalog.mjs'
import { checkedContracts } from './test-contracts.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
export const lanes = ['unit', 'native-0', 'native-1', 'compat-0', 'compat-1', 'compat-2']
export const extendedLanes = [...lanes, 'history']
const manifestPath = resolve(root, 'test/suite-map.json')
const cache = new Map()
async function graph(path, seen = new Set()) {
  if (seen.has(path)) return seen
  seen.add(path)
  let text
  try { text = cache.get(path) ?? await readFile(resolve(root, path), 'utf8'); cache.set(path, text) } catch { return seen }
  const matches = [...text.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]/g)]
  for (const [, spec] of matches) if (spec.startsWith('.')) {
    const next = relative(root, resolve(root, dirname(path), spec)).replaceAll('\\', '/')
    if (!next.startsWith('../')) await graph(next, seen)
  }
  return seen
}
export async function inventory() {
  cache.clear()
  const reviewed = await checkedContracts(root)
  const published = new Set(['index.js'])
  for (const name of ['assistant', 'observer']) {
    const dir = `packages/dingtalk-dsh-${name}`
    const pkg = JSON.parse(await readFile(resolve(root, dir, 'package.json'), 'utf8'))
    for (const file of pkg.files ?? (await readdir(resolve(root, dir))).filter(x => x.endsWith('.js'))) published.add(`${dir}/${file}`)
  }
  const tests = await testFiles(root)
  const roots = [...published].filter(x => x.endsWith('.js')).sort()
  const staticLocalClosure = [...new Set((await Promise.all(roots.map(x => graph(x)))).flatMap(x => [...x]))].filter(x => x.endsWith('.js')).sort()
  const counters = { native: 0, compat: 0 }
  const entries = []
  for (const file of tests) {
    const closure = [...await graph(file)].sort()
    const product = closure.filter(x => published.has(x))
    const archived = closure.filter(x => x.startsWith('packages/') && !published.has(x))
    const native = closure.includes('test/fixtures/task-session-native-host.js')
    const processFixture = closure.some(x => /child_process|execFile|spawn\(/.test(cache.get(x) ?? ''))
    const category = native ? 'native' : archived.length || processFixture ? 'compat' : 'unit'
    const cases = reviewed.get(file)
    const release = !cases || cases[0].contract !== 'historical'
    const lane = !release ? 'history' : category === 'unit' ? 'unit' : `${category}-${counters[category]++ % (category === 'native' ? 2 : 3)}`
    entries.push({ file, lane, category, release, publishedImports: product, retainedCompatibilityImports: archived,
      reason: cases ? `逐注册审定见test/mixed-test-contracts.json；${release ? '当前/兼容保证留发行门禁' : '纯历史协议保留手动串行入口'}` : '未逐用例审定退出；保守保留Release，分类仅隔离资源' })
  }
  return { schema: 2, policy: 'reviewed-case-preservation; unknown-release', lanes, extendedLanes,
    publishedBoundary: { roots, staticLocalClosure, limitation: 'literal relative imports only; publication membership alone never excludes a test' }, entries }
}
export async function checkedInventory() {
  const expected = await inventory(), saved = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (JSON.stringify(saved) !== JSON.stringify(expected)) throw Error('test_suite_map_stale: run node scripts/test-suites.mjs update and review every change')
  if (new Set(saved.entries.map(x => x.file)).size !== saved.entries.length || saved.entries.some(x => x.release ? !lanes.includes(x.lane) : x.lane !== 'history')) throw Error('test_suite_coverage_invalid')
  return saved
}
export function selectFiles(data, lane, selection = []) {
  if (!extendedLanes.includes(lane)) throw Error('unknown_test_lane')
  const eligible = data.entries.filter(x => x.lane === lane).map(x => x.file)
  if (selection.some(file => !eligible.includes(file)) || new Set(selection).size !== selection.length) throw Error('unknown_or_duplicate_test_selection')
  const files = selection.length ? selection : eligible
  if (!files.length) throw Error('empty_test_lane')
  return files
}
function runLane(data, lane, selection) {
  const files = selectFiles(data, lane, selection)
  const result = spawnSync(process.execPath, ['--test', `--test-concurrency=${lane === 'unit' ? 4 : 1}`, ...files], { cwd: root, stdio: 'inherit', env: process.env })
  if (result.error) throw result.error
  return result.status ?? 1
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command = 'check', lane, ...selection] = process.argv.slice(2)
  if (command === 'update') { const data = await inventory(); await writeFile(manifestPath, JSON.stringify(data, null, 2) + '\n'); console.log(`mapped ${data.entries.length} files; historical ${data.entries.filter(x => !x.release).length}; deleted 0`) }
  else {
    const data = await checkedInventory()
    if (command === 'run') {
      process.exitCode = runLane(data, lane, selection)
    } else if (command === 'all') {
      for (const current of extendedLanes) {
        process.exitCode = runLane(data, current)
        if (process.exitCode) break
      }
    } else if (command === 'check') console.log(`verified ${data.entries.length} files; every file exactly once; historical ${data.entries.filter(x => !x.release).length}; deleted 0`)
    else throw Error('unknown_test_suite_command')
  }
}
