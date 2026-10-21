import { readdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, relative, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
export const lanes = ['unit', 'native-0', 'native-1', 'compat-0', 'compat-1', 'compat-2']
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
  const published = new Set(['index.js'])
  for (const name of ['assistant', 'observer']) {
    const dir = `packages/dingtalk-dsh-${name}`
    const pkg = JSON.parse(await readFile(resolve(root, dir, 'package.json'), 'utf8'))
    for (const file of pkg.files ?? (await readdir(resolve(root, dir))).filter(x => x.endsWith('.js'))) published.add(`${dir}/${file}`)
  }
  const tests = (await readdir(resolve(root, 'test'))).filter(x => x.endsWith('.test.js')).sort()
  const counters = { native: 0, compat: 0 }
  const entries = []
  for (const name of tests) {
    const file = `test/${name}`, closure = [...await graph(file)].sort()
    const product = closure.filter(x => published.has(x))
    const archived = closure.filter(x => x.startsWith('packages/') && !published.has(x))
    const native = closure.includes('test/fixtures/task-session-native-host.js')
    const processFixture = closure.some(x => /child_process|execFile|spawn\(/.test(cache.get(x) ?? ''))
    const category = native ? 'native' : archived.length || processFixture ? 'compat' : 'unit'
    const lane = category === 'unit' ? 'unit' : `${category}-${counters[category]++ % (category === 'native' ? 2 : 3)}`
    entries.push({ file, lane, category, release: true, publishedImports: product, retainedCompatibilityImports: archived,
      reason: native ? '真实原生Host合成夹具；独立runner串行保留原超时' : category === 'compat' ? '进程/Git/历史兼容合同仍保留；未审定退出权威发行验证' : '静态/单元或当前发行合同；保留权威验证' })
  }
  return { schema: 1, policy: 'all-tests-retained; no unreviewed release exclusions', lanes, entries }
}
export async function checkedInventory() {
  const expected = await inventory(), saved = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (JSON.stringify(saved) !== JSON.stringify(expected)) throw Error('test_suite_map_stale: run node scripts/test-suites.mjs update and review every change')
  if (new Set(saved.entries.map(x => x.file)).size !== saved.entries.length || saved.entries.some(x => !x.release || !lanes.includes(x.lane))) throw Error('test_suite_coverage_invalid')
  return saved
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command = 'check', lane] = process.argv.slice(2)
  if (command === 'update') { const data = await inventory(); await writeFile(manifestPath, JSON.stringify(data, null, 2) + '\n'); console.log(`mapped ${data.entries.length} files; excluded 0`) }
  else {
    const data = await checkedInventory()
    if (command === 'run') {
      if (!lanes.includes(lane)) throw Error('unknown_test_lane')
      const files = data.entries.filter(x => x.lane === lane).map(x => x.file)
      if (!files.length) throw Error('empty_test_lane')
      const result = spawnSync(process.execPath, ['--test', `--test-concurrency=${lane === 'unit' ? 4 : 1}`, ...files], { cwd: root, stdio: 'inherit', env: process.env })
      if (result.error) throw result.error
      process.exitCode = result.status ?? 1
    } else if (command === 'check') console.log(`verified ${data.entries.length} files; every file exactly once; excluded 0`)
    else throw Error('unknown_test_suite_command')
  }
}
