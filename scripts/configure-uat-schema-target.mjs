import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import yaml from 'js-yaml'
import { validateUatSchemaTarget } from '../packages/dingtalk-dsh-assistant/workflow-uat-schema-migration.js'
const fail = code => { throw new Error(code) }
const hash = value => createHash('sha256').update(value).digest('hex')
const keys = (x, expected) => x && typeof x === 'object' && !Array.isArray(x) && isDeepStrictEqual(Object.keys(x).sort(), expected.sort())
export async function planUatSchemaTargetAppend(source, proposal) {
  if (!keys(proposal, ['expectedProfileSha256','uatSchemaMigrationTarget']) || hash(source)!==proposal.expectedProfileSha256) fail('UAT_SCHEMA_CONFIG_PROPOSAL_STALE')
  const target = validateUatSchemaTarget(proposal.uatSchemaMigrationTarget)
  const schema = yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value })])
  const parse = text => {
    const stack = [], maps = []
    let document
    try {
      document = yaml.load(text, { schema, listener(event, state) {
        if (event === 'open') stack.push(state.position)
        else {
          const start = stack.pop()
          if (state.kind === 'mapping') maps.push({ start, end: state.position, value: state.result })
        }
      } })
    } catch { fail('QUERY_CONFIG_PROFILE_YAML_INVALID') }
    const workflows = []
    const walk = value => {
      if (!value || typeof value !== 'object') return
      if (value.name === '@zzusp/dingtalk-dsh-assistant/resident' && value.config?.workflow) workflows.push(value.config.workflow)
      for (const child of Object.values(value)) walk(child)
    }
    walk(document)
    if (workflows.length !== 1) fail('QUERY_CONFIG_WORKFLOW_AMBIGUOUS')
    return { document, maps, workflow: workflows[0] }
  }
  const before = parse(source), insertions = []
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const replaceProperty = (parent, key, value) => {
    const matches = before.maps.filter(item => item.value === parent)
    if (matches.length !== 1) fail('QUERY_CONFIG_PROPERTY_LAYOUT_UNSUPPORTED')
    const map = matches[0], lineStart = source.lastIndexOf('\n', map.start - 1) + 1
    const prefix = source.slice(lineStart, map.start)
    const first = /^\r?\n( *)\S/m.exec(source.slice(map.start, map.end))
    const indent = /^ *- $/.test(prefix) ? prefix.length : first?.[1].length
    if (!Number.isInteger(indent)) fail('QUERY_CONFIG_PROPERTY_LAYOUT_UNSUPPORTED')
    const expression = new RegExp(`^ {${indent}}${key}:.*(?:\\r?\\n|$)`, 'gm')
    const locations = [...source.matchAll(expression)].filter(item => item.index >= map.start && item.index < map.end)
    if (locations.length > 1) fail('QUERY_CONFIG_PROPERTY_LAYOUT_UNSUPPORTED')
    let at, end
    if (locations.length) {
      at = locations[0].index; end = at + locations[0][0].length
      while (end < source.length) {
        const next = source.indexOf('\n', end), until = next < 0 ? source.length : next + 1
        const line = source.slice(end, until)
        if (line.trim() && /^ */.exec(line)[0].length <= indent) break
        end = until
      }
    } else {
      if (Object.hasOwn(parent, key)) fail('QUERY_CONFIG_PROPERTY_LAYOUT_UNSUPPORTED')
      at = /^ *- $/.test(prefix) ? source.indexOf('\n', map.start) + 1 : map.start + first.index + first[0].lastIndexOf('\n') + 1
      end = at
    }
    const fragment = yaml.dump({ [key]: value }, { noRefs: true, lineWidth: -1, sortKeys: false }).trimEnd()
      .split('\n').map(line => ' '.repeat(indent) + line).join(newline) + newline
    insertions.push({ at, end, fragment })
  }
  const platforms=before.workflow.platforms
  if (!platforms || !before.workflow.repositories?.some(repo => repo.githubRepository === target.repository || repo.remote?.replace(/\.git$/,'').endsWith('/'+target.repository))) fail('UAT_SCHEMA_CONFIG_REPOSITORY_UNKNOWN')
  const registered = platforms.uatSchemaMigration
  if (registered !== undefined && !isDeepStrictEqual(registered, { targets: [target] })) fail('UAT_SCHEMA_CONFIG_TARGET_CONFLICT')
  if (registered === undefined) replaceProperty(platforms, 'uatSchemaMigration', { targets: [target] })
  let updated=source
  for(const change of insertions.sort((a,b)=>b.at-a.at))updated=updated.slice(0,change.at)+change.fragment+updated.slice(change.end)
  const after=parse(updated)
  if (!isDeepStrictEqual(after.workflow.platforms.uatSchemaMigration,{targets:[target]})) fail('UAT_SCHEMA_CONFIG_TARGET_CONFLICT')
  delete before.workflow.platforms.uatSchemaMigration; delete after.workflow.platforms.uatSchemaMigration
  if (!isDeepStrictEqual(before.document,after.document)) fail('UAT_SCHEMA_CONFIG_UNRELATED_CHANGE')
  return { updated, changed: updated !== source }
}
