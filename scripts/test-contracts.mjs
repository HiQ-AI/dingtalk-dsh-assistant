import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parse } from 'acorn'
import { digest, registrations, testFiles } from './test-catalog.mjs'

function reviewedDigest(value, label) {
  if (!value.review) return value.sha256
  const review = value.review
  if (review.fromSha256 !== value.sha256 || !/^[a-f0-9]{64}$/.test(review.sha256)
    || review.sha256 === value.sha256 || !/^[a-f0-9]{40}$/.test(review.basisCommit)
    || !review.reason?.trim() || !review.evidence?.length || review.evidence.some(item => typeof item !== 'string' || !item.trim()))
    throw Error(`mixed_review_invalid: ${label}`)
  return review.sha256
}

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
      const aliases = new Set()
      for (const node of parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body.filter(node => node.type === 'ImportDeclaration')) {
        if (node.source.value === 'node:test') continue
        if (!node.source.value.startsWith('.') || resolve(root, dirname(file), node.source.value) !== resolve(root, group.fixture.file)
          || node.specifiers.some(spec => spec.type !== 'ImportSpecifier' || spec.local.name !== spec.imported.name))
          throw Error(`mixed_destination_import_invalid: ${file}`)
        for (const spec of node.specifiers) aliases.add(spec.local.name)
      }
      if (group.registrationAliases?.some(alias => !aliases.has(alias))) throw Error(`mixed_destination_alias_invalid: ${file}`)
      for (const item of registrations(source, { strict: true, aliases: group.registrationAliases ?? [] })) actual.push({ ...item, file })
    }
    if (digest(await readFile(resolve(root, group.fixture.file), 'utf8')) !== reviewedDigest(group.fixture, group.fixture.file)) throw Error(`mixed_fixture_changed: ${group.fixture.file}`)
    if (actual.length !== group.cases.length) throw Error(`mixed_case_count_changed: ${group.original}`)
    for (const item of group.cases) {
      const key = `${group.original}:${item.originalId}`
      if (seen.has(key) || !item.reason || !item.evidence?.length || !['current', 'compatibility', 'historical'].includes(item.contract)) throw Error(`mixed_classification_invalid: ${key}`)
      seen.add(key)
      const matches = actual.filter(value => value.sha256 === reviewedDigest(item, key))
      if (matches.length !== 1 || matches[0].file !== item.file || matches[0].variants !== item.variants) throw Error(`mixed_case_missing_duplicate_or_changed: ${key}`)
      destinations.get(item.file).push(item)
    }
    const baselineIds = group.baselineIds ?? group.cases.map((_, i) => i + 1)
    if (baselineIds.length !== group.cases.length || new Set(baselineIds).size !== baselineIds.length
      || baselineIds.some((id, i) => !Number.isSafeInteger(id) || id < 1 || i > 0 && id <= baselineIds[i - 1])
      || group.baselineIds && !/^[a-f0-9]{40}$/.test(group.sourceCommit)
      || group.cases.some((item, i) => item.originalId !== baselineIds[i])) throw Error(`mixed_original_coverage_invalid: ${group.original}`)
    for (const file of group.destinations) {
      const cases = destinations.get(file)
      if (!cases.length || cases.some(item => (item.contract === 'historical') !== (cases[0].contract === 'historical'))) throw Error(`mixed_release_boundary: ${file}`)
    }
  }
  return destinations
}
