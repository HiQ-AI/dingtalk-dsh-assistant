import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { digest, registrations, testFiles } from './test-catalog.mjs'

export async function checkedContracts(root) {
  const contracts = JSON.parse(await readFile(resolve(root, 'test/mixed-test-contracts.json'), 'utf8'))
  const discovered = new Set(await testFiles(root))
  const seen = new Set(), destinations = new Map()
  for (const group of contracts.groups) {
    if (group.cases.length !== group.originalRegistrations || group.cases.reduce((n, item) => n + item.variants, 0) !== group.originalVariants) throw Error(`mixed_baseline_count_changed: ${group.original}`)
    const actual = []
    for (const file of group.destinations) {
      if (!discovered.has(file)) throw Error(`mixed_destination_not_discovered: ${file}`)
      if (destinations.has(file)) throw Error(`duplicate_contract_destination: ${file}`)
      destinations.set(file, [])
      const source = await readFile(resolve(root, file), 'utf8')
      if (digest(source) !== group.destinationSha256[file]) throw Error(`mixed_destination_changed: ${file}`)
      for (const item of registrations(source, { strict: true })) actual.push({ ...item, file })
    }
    if (digest(await readFile(resolve(root, group.fixture.file), 'utf8')) !== group.fixture.sha256) throw Error(`mixed_fixture_changed: ${group.fixture.file}`)
    if (actual.length !== group.cases.length) throw Error(`mixed_case_count_changed: ${group.original}`)
    for (const item of group.cases) {
      const key = `${group.original}:${item.originalId}`
      if (seen.has(key) || !item.reason || !item.evidence?.length || !['current', 'compatibility', 'historical'].includes(item.contract)) throw Error(`mixed_classification_invalid: ${key}`)
      seen.add(key)
      const matches = actual.filter(value => value.sha256 === item.sha256)
      if (matches.length !== 1 || matches[0].file !== item.file || matches[0].variants !== item.variants) throw Error(`mixed_case_missing_duplicate_or_changed: ${key}`)
      destinations.get(item.file).push(item)
    }
    if (new Set(group.cases.map(item => item.originalId)).size !== group.cases.length || group.cases.some((item, i) => item.originalId !== i + 1)) throw Error(`mixed_original_coverage_invalid: ${group.original}`)
    for (const file of group.destinations) {
      const cases = destinations.get(file)
      if (!cases.length || cases.some(item => (item.contract === 'historical') !== (cases[0].contract === 'historical'))) throw Error(`mixed_release_boundary: ${file}`)
    }
  }
  return destinations
}
