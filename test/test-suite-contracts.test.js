import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, dirname, posix } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { parse } from 'acorn'
import { digest, registrations, testFiles } from '../scripts/test-catalog.mjs'
import { checkedContracts } from '../scripts/test-contracts.mjs'
import { inventory, selectFiles, extendedLanes } from '../scripts/test-suites.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const contractPath = 'test/mixed-test-contracts.json'
const load = async () => JSON.parse(await readFile(join(root, contractPath), 'utf8'))
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i)

test('fixed baseline registrations, variants and helper bodies survive the physical split', async () => {
  const contracts = await load()
  assert.equal(contracts.sourceCommit, '7ca36c26ad1c52e8b1896fdc76a7e8aed1c9a697')
  const fixed = contracts.groups.filter(group => !group.baselineIds)
  assert.equal(fixed.length, 3)
  assert.equal(fixed.reduce((n, g) => n + g.originalRegistrations, 0), 202)
  assert.equal(fixed.reduce((n, g) => n + g.originalVariants, 0), 220)
  const keep = [[1,9], [19,20], [1,3,4,...range(19,26),33,34,35,36,40,61,62,91,92,...range(101,107),121,123,126,127,136,137,141]]
  for (const [index, group] of fixed.entries()) {
    const baseline = execFileSync('git', ['show', `${contracts.sourceCommit}:${group.original}`], { cwd: root, encoding: 'utf8' })
    assert.equal(digest(baseline), group.originalSha256)
    const original = registrations(baseline)
    assert.deepEqual(group.cases.map(c => [c.originalId, c.sha256, c.variants]), original.map(c => [c.id, c.sha256, c.variants]))
    assert.deepEqual(group.cases.filter(c => c.contract !== 'historical').map(c => c.originalId), keep[index])
    let helpers = baseline
    for (const node of [...original].reverse()) helpers = helpers.slice(0, node.start) + helpers.slice(node.end)
    // Reviewed changes retain the original baseline and classification. Compare
    // the pre-review helper with the split source, then check today's bytes via
    // the independently reviewed digest in checkedContracts below.
    let actual = group.fixture.review
      ? execFileSync('git', ['show', `${group.fixture.review.basisCommit}:${group.fixture.file}`], { cwd: root, encoding: 'utf8' })
      : await readFile(join(root, group.fixture.file), 'utf8')
    assert.equal(digest(actual), group.fixture.sha256)
    const ast = parse(actual, { ecmaVersion: 'latest', sourceType: 'module' })
    const exported = ast.body.at(-1)
    assert.equal(exported.type, 'ExportNamedDeclaration')
    actual = actual.slice(0, exported.start).replaceAll('../../packages/', '../packages/').replaceAll("from './task-plan.js'", "from './fixtures/task-plan.js'")
    const normalizeHelperWhitespace = text => text.replaceAll('\r\n', '\n').replace(/^[ \t]+$/gm, '').trim()
    assert.equal(normalizeHelperWhitespace(actual), normalizeHelperWhitespace(helpers), group.fixture.file)
  }
  assert.equal((await checkedContracts(root)).size, contracts.groups.reduce((n, group) => n + group.destinations.length, 0))
})

test('已审 Router 历史子集保持独立固定基线，其他注册仍留 Release', async () => {
  const contracts = await load()
  const groups = contracts.groups.filter(group => group.baselineIds)
  const expected = [
    { name: 'task-session-service', ids: [12], registrations: 42, variants: 53, aliases: ['test'], sha: 'ef8becce25836348006889b440af6b19e538a5f1df60783bca3e1858d51ec707' },
    { name: 'task-topic-routing', ids: [6, 7, 10, 11, 12], registrations: 36, variants: 45, aliases: ['testRunner'], sha: 'e57194aa5dc062f645d1caa2ebd8c337ada4614ab5dae3a297be61114e4f371b' },
  ]
  assert.equal(groups.length, expected.length)
  const normalizeImports = (source, file) => {
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
    for (const node of [...ast.body].reverse()) if (node.type === 'ImportDeclaration' && node.source.value.startsWith('.')) {
      const target = posix.normalize(posix.join(posix.dirname(file), node.source.value))
      source = source.slice(0, node.source.start) + JSON.stringify(target) + source.slice(node.source.end)
    }
    return source.replaceAll('\r\n', '\n').replace(/^[ \t]+$/gm, '').trim()
  }
  for (const [i, group] of groups.entries()) {
    const fixed = expected[i]
    assert.equal(group.sourceCommit, '14ad11aa7c7ba2f0c4082ecc65bfd81cfa5b2a2f')
    assert.equal(group.original, `test/${fixed.name}-native.test.js`)
    assert.deepEqual(group.baselineIds, fixed.ids)
    assert.deepEqual(group.registrationAliases, fixed.aliases)
    assert.deepEqual(group.destinations, [`test/${fixed.name}-history.test.js`])
    assert.equal(group.fixture.file, `test/fixtures/${fixed.name}-history.js`)
    const baseline = execFileSync('git', ['show', `${group.sourceCommit}:${group.original}`], { cwd: root, encoding: 'utf8' })
    assert.equal(digest(baseline), fixed.sha)
    assert.equal(group.originalSha256, fixed.sha)
    const original = registrations(baseline, { forwardingWrappers: true })
    assert.equal(original.length, fixed.registrations)
    assert.equal(original.reduce((n, item) => n + item.variants, 0), fixed.variants)
    const selected = original.filter(item => fixed.ids.includes(item.id))
    assert.deepEqual(group.cases.map(item => [item.originalId, item.sha256, item.variants]), selected.map(item => [item.id, item.sha256, item.variants]))
    assert.ok(group.cases.every(item => item.contract === 'historical'))
    let helpers = baseline
    for (const item of [...original].reverse()) helpers = helpers.slice(0, item.start) + helpers.slice(item.end)
    const fixture = await readFile(join(root, group.fixture.file), 'utf8')
    const exportNode = parse(fixture, { ecmaVersion: 'latest', sourceType: 'module' }).body.at(-1)
    assert.equal(exportNode.type, 'ExportNamedDeclaration')
    assert.equal(normalizeImports(fixture.slice(0, exportNode.start), group.fixture.file), normalizeImports(helpers, group.original))
  }
  const { entries } = await inventory()
  for (const item of expected) assert.equal(entries.find(entry => entry.file === `test/${item.name}-native.test.js`)?.release, true)
})

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'suite-contract-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const contracts = await load()
  for (const file of [contractPath, ...contracts.groups.flatMap(g => [...g.destinations, g.fixture.file])]) {
    await mkdir(dirname(join(directory, file)), { recursive: true })
    await writeFile(join(directory, file), await readFile(join(root, file)))
  }
  return { directory, contracts, save: () => writeFile(join(directory, contractPath), JSON.stringify(contracts)) }
}

test('omissions, duplicates, classification changes and fixture edits cannot silently exit Release', async t => {
  for (const mutation of ['omit', 'duplicate', 'unclassified', 'fixture', 'mixed-boundary']) await t.test(mutation, async t => {
    const f = await fixture(t), group = f.contracts.groups[0], file = group.destinations[1]
    if (mutation === 'fixture') await writeFile(join(f.directory, group.fixture.file), '// modified helper')
    else if (mutation === 'mixed-boundary') { group.cases[0].contract = 'historical'; await f.save() }
    else {
      let source = await readFile(join(f.directory, file), 'utf8')
      const cases = registrations(source)
      if (mutation === 'omit') source = source.slice(0, cases[0].start) + source.slice(cases[0].end)
      if (mutation === 'duplicate') source = source.slice(0, cases[1].start) + source.slice(cases[0].start, cases[0].end) + source.slice(cases[1].end)
      if (mutation === 'unclassified') source += "\nconst hidden = (() => { test('new unreviewed', () => {}) })()\n"
      await writeFile(join(f.directory, file), source)
      // Exercise the statement guard even if someone refreshes only the file-level checksum.
      group.destinationSha256[file] = digest(source); await f.save()
    }
    await assert.rejects(checkedContracts(f.directory), /mixed_/)
  })
})

test('import changes and new historical helper statements require review', async t => {
  const f = await fixture(t), file = f.contracts.groups[0].destinations[1]
  await writeFile(join(f.directory, file), "import './unreviewed-helper.js'\n" + await readFile(join(f.directory, file), 'utf8'))
  await assert.rejects(checkedContracts(f.directory), /mixed_destination_changed/)
  assert.throws(() => registrations("import test from 'node:test'; const unreviewed = 1", { strict: true }), /unreviewed_mixed/)
})

test('仅刷新目的文件摘要不能把未审 helper 或新注册带入历史组', async t => {
  for (const index of [0, 4]) await t.test(`group=${index}`, async t => {
    const f = await fixture(t), group = f.contracts.groups[index], file = group.destinations.at(-1)
    const originalImport = `from './fixtures/${posix.basename(group.fixture.file)}'`
    const source = (await readFile(join(f.directory, file), 'utf8')).replace(originalImport, "from './fixtures/unreviewed-history-bridge.js'")
    assert.ok(!source.includes(originalImport))
    await writeFile(join(f.directory, file), source)
    await writeFile(join(f.directory, 'test/fixtures/unreviewed-history-bridge.js'), `export * from './${posix.basename(group.fixture.file)}'; import test from 'node:test'; test('new-current-contract', () => {})`)
    group.destinationSha256[file] = digest(source)
    await f.save()
    await assert.rejects(checkedContracts(f.directory), /mixed_destination_import_invalid/)
  })
})

test('an explicit re-review retains original identities and rejects incomplete or mismatched evidence', async t => {
  for (const mutation of ['wrong-origin', 'empty-reason', 'empty-evidence', 'wrong-current-digest', 'changed-classification']) await t.test(mutation, async t => {
    const f = await fixture(t)
    const reviewed = f.contracts.groups.flatMap(group => group.cases).find(item => item.review)
    assert.ok(reviewed, 'release recovery must keep an explicit review of the changed input fixture')
    if (mutation === 'wrong-origin') reviewed.review.fromSha256 = '0'.repeat(64)
    if (mutation === 'empty-reason') reviewed.review.reason = ''
    if (mutation === 'empty-evidence') reviewed.review.evidence = []
    if (mutation === 'wrong-current-digest') reviewed.review.sha256 = '0'.repeat(64)
    if (mutation === 'changed-classification') reviewed.contract = 'historical'
    await f.save()
    await assert.rejects(checkedContracts(f.directory), /mixed_/)
  })
})

test('a classified destination cannot disappear from the runnable discovery set', async t => {
  const f = await fixture(t), group = f.contracts.groups[0], previous = group.destinations[1]
  const hidden = previous.replace('.test.js', '.js')
  await writeFile(join(f.directory, hidden), await readFile(join(f.directory, previous)))
  group.destinations[1] = hidden
  group.destinationSha256[hidden] = group.destinationSha256[previous]
  delete group.destinationSha256[previous]
  for (const item of group.cases) if (item.file === previous) item.file = hidden
  await f.save()
  await assert.rejects(checkedContracts(f.directory), /mixed_destination_not_discovered/)
})

test('registration catalog hashes full parameter loops, nested assertions, options and CRLF', () => {
  const source = "import check from 'node:test'; for (const value of ['a','b']) check(value, {timeout:123}, t => { t.test('nested', () => {}) })"
  const entries = registrations(source, { strict: true })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].variants, 2)
  assert.notEqual(entries[0].sha256, registrations(source.replace('123', '124'))[0].sha256)
  assert.equal(digest('line\r\n'), digest('line\n'))
})

test('直转发包装是 helper，参数循环与嵌套断言仍完整登记', () => {
  const source = "import run from 'node:test'; const test=(...args)=>run(...args); for(const value of ['a','b']) test(value, {timeout:12}, t=>{ t.test('nested',()=>{}) })"
  const entries = registrations(source, { forwardingWrappers: true })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].variants, 2)
  assert.ok(entries[0].title.startsWith('for('))
  assert.notEqual(entries[0].sha256, registrations(source.replace('timeout:12', 'timeout:13'), { forwardingWrappers: true })[0].sha256)
})

test('recursive discovery sees new nested tests and rejects unsupported test extensions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'suite-discovery-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(directory, 'test/nested/node_modules'), { recursive: true })
  await writeFile(join(directory, 'test/nested/new.test.js'), '')
  await writeFile(join(directory, 'test/nested/node_modules/dependency.test.js'), '')
  assert.deepEqual(await testFiles(directory), ['test/nested/new.test.js'])
  await writeFile(join(directory, 'test/nested/new.spec.mjs'), '')
  await assert.rejects(testFiles(directory), /unclassified_test_extension/)
})

test('unknown tests conservatively enter Release and historical selection never accepts globs or duplicates', async () => {
  const data = await inventory()
  assert.ok(data.entries.filter(x => !x.file.endsWith('-history.test.js')).every(x => x.release))
  assert.deepEqual(selectFiles(data, 'history'), data.entries.filter(x => !x.release).map(x => x.file))
  assert.throws(() => selectFiles(data, 'history', ['test/*.test.js']), /unknown_or_duplicate/)
  const file = selectFiles(data, 'history')[0]
  assert.deepEqual(selectFiles(data, 'history', [file]), [file])
  assert.throws(() => selectFiles(data, 'history', [file, file]), /unknown_or_duplicate/)
  assert.throws(() => selectFiles(data, 'unit', [file]), /unknown_or_duplicate/)
  assert.equal(extendedLanes.at(-1), 'history')
})
