import { parse } from 'acorn'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export const digest = text => createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex')
export async function testFiles(root, directory = 'test') {
  const result = []
  for (const item of await readdir(resolve(root, directory), { withFileTypes: true })) {
    if (item.name === 'node_modules') continue
    const path = `${directory}/${item.name}`
    if (item.isSymbolicLink()) throw Error(`test_inventory_symlink: ${path}`)
    if (item.isDirectory()) result.push(...await testFiles(root, path))
    else if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(item.name)) {
      if (!item.name.endsWith('.test.js')) throw Error(`unclassified_test_extension: ${path}`)
      result.push(path)
    }
  }
  return result.sort()
}

// Catalogue registration statements, including parameterized loops, without executing tests.
// The entire statement is hashed: changing a loop, option, assertion or timeout needs review.
export function registrations(source, { strict = false } = {}) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true })
  const names = new Set()
  for (const node of ast.body) if (node.type === 'ImportDeclaration' && node.source.value === 'node:test') {
    for (const spec of node.specifiers) if (spec.type === 'ImportDefaultSpecifier' || ['test', 'it', 'describe', 'suite'].includes(spec.imported?.name)) names.add(spec.local.name)
  }
  const contains = node => {
    if (!node || typeof node !== 'object') return false
    if (node.type === 'CallExpression') {
      let callee = node.callee
      while (callee?.type === 'MemberExpression') callee = callee.object
      if (callee?.type === 'Identifier' && names.has(callee.name)) return true
    }
    return Object.values(node).some(value => Array.isArray(value) ? value.some(contains) : contains(value))
  }
  const statements = ast.body.filter(node => !['ImportDeclaration', 'FunctionDeclaration'].includes(node.type) && contains(node))
  if (strict && ast.body.some(node => node.type !== 'ImportDeclaration' && !statements.includes(node))) throw Error('unreviewed_mixed_test_statement')
  return statements.map((node, index) => ({
    id: index + 1, line: node.loc.start.line, start: node.start, end: node.end,
    title: source.slice(node.start, source.indexOf('\n', node.start) < 0 ? node.end : source.indexOf('\n', node.start)).trim(),
    sha256: digest(source.slice(node.start, node.end)),
    variants: node.type === 'ForOfStatement' && node.right.type === 'ArrayExpression' ? node.right.elements.length : 1,
  }))
}
export async function catalogue(root, file) {
  const source = await readFile(resolve(root, file), 'utf8')
  return { sourceSha256: digest(source), registrations: registrations(source).map(({ start, end, ...item }) => item) }
}
