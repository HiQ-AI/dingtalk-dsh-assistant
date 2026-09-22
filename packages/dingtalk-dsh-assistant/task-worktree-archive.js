import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, realpath, readFile, mkdir, copyFile, rm, access } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

const exec = promisify(execFile)
const categories = new Set(['spec', 'acceptance', 'ops', 'manual', 'reference', 'api', 'sql'])

async function git(cwd, ...args) {
  const { stdout } = await exec('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true })
  return stdout.trim()
}

function assertInside(parent, candidate) {
  const relative = path.relative(parent, candidate)
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('worktree_path_outside_managed_root')
}

async function assertPhysicalPath(location, workspaceDir) {
  if (!path.isAbsolute(location)) throw new Error('worktree_path_not_absolute')
  const root = path.resolve(workspaceDir, 'worktrees')
  const absolute = path.resolve(location)
  assertInside(root, absolute)
  let current = path.parse(absolute).root
  for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    const stat = await lstat(current)
    if (stat.isSymbolicLink()) throw new Error('worktree_path_linked_component')
  }
  const actualRoot = await realpath(root)
  const actual = await realpath(absolute)
  assertInside(actualRoot, actual)
  return actual
}

function parseWorktreeList(value) {
  return value.split(/\r?\n\r?\n/).map((block) => Object.fromEntries(block.split(/\r?\n/).map((line) => {
    const index = line.indexOf(' ')
    return index < 0 ? [line, true] : [line.slice(0, index), line.slice(index + 1)]
  }))).filter((entry) => entry.worktree)
}

export async function inspectTaskWorktree({ location, workspaceDir }) {
  const actual = await assertPhysicalPath(location, workspaceDir)
  const top = await realpath(await git(actual, 'rev-parse', '--show-toplevel'))
  if (top !== actual) throw new Error('worktree_path_not_root')
  const gitDir = await realpath(await git(actual, 'rev-parse', '--absolute-git-dir'))
  const commonDir = await realpath(await git(actual, 'rev-parse', '--git-common-dir'))
  if (gitDir === commonDir) throw new Error('worktree_main_checkout_forbidden')
  const list = parseWorktreeList(await git(actual, 'worktree', 'list', '--porcelain'))
  if (!list.some((item) => path.resolve(item.worktree) === actual && !item.bare)) throw new Error('worktree_not_registered_with_git')
  const repositoryRoot = path.dirname(commonDir)
  const head = await git(actual, 'rev-parse', 'HEAD')
  const branchRef = await git(actual, 'symbolic-ref', '-q', 'HEAD').catch(() => '')
  const branch = branchRef.startsWith('refs/heads/') ? branchRef.slice('refs/heads/'.length) : null
  const originUrl = await git(actual, 'remote', 'get-url', 'origin')
  return { path: actual, repositoryRoot, gitDir, head, branch, originUrl }
}

function sameIdentity(actual, entry) {
  for (const key of ['path', 'repositoryRoot', 'gitDir', 'head', 'branch', 'originUrl']) {
    if (actual[key] !== (entry[key] ?? null)) throw new Error(`worktree_identity_changed:${key}`)
  }
}

function safeComponent(value, label) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) || value === '.' || value === '..') throw new Error(`invalid_${label}`)
  return value
}

function documentSource(value) {
  if (typeof value !== 'string' || value.includes('\\') || path.posix.isAbsolute(value)) throw new Error('invalid_document_source')
  const parts = value.split('/')
  if (parts.length < 3 || parts[0] !== 'docs' || !categories.has(parts[1]) || parts.some((part) => !part || part === '.' || part === '..' || part.includes(':'))) throw new Error('invalid_document_source')
  return { category: parts[1], relative: parts.slice(2).join('/') }
}

export function validateTaskDocumentSources(sources) {
  if (new Set(sources).size !== sources.length) throw new Error('task_worktree_duplicate_document')
  for (const source of sources) documentSource(source)
}

async function assertRegularUnlinkedFile(root, source) {
  let current = root
  for (const part of source.split('/')) {
    current = path.join(current, part)
    const stat = await lstat(current)
    if (stat.isSymbolicLink()) throw new Error(`document_link_forbidden:${source}`)
  }
  if (!(await lstat(current)).isFile()) throw new Error(`document_not_file:${source}`)
  return current
}

async function sha256(file) { return createHash('sha256').update(await readFile(file)).digest('hex') }
async function exists(file) { return access(file).then(() => true, () => false) }
async function pathPresent(file) { return lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error }) }

async function assertNoExistingLink(target) {
  let current = path.parse(target).root
  for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    let stat
    try { stat = await lstat(current) } catch (error) {
      if (error.code === 'ENOENT') break
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error(`document_target_link_forbidden:${current}`)
  }
}

async function recoveredRemoval({ taskId, entry, workspaceDir, checkOnly, onProgress }) {
  safeComponent(taskId, 'task_id')
  if (!entry?.createdByTask || entry.status !== 'registered') throw new Error('worktree_not_owned_or_registered')
  const root = path.resolve(workspaceDir, 'worktrees')
  const candidate = path.resolve(entry.path)
  assertInside(root, candidate)
  if (await pathPresent(candidate)) return null
  const actualRoot = await realpath(root)
  assertInside(actualRoot, candidate)
  const listed = parseWorktreeList(await git(entry.repositoryRoot, 'worktree', 'list', '--porcelain'))
  if (listed.some(item => path.resolve(item.worktree) === candidate)) throw new Error('worktree_directory_missing_but_git_record_exists')
  for (const item of entry.documents ?? []) {
    const { category, relative } = documentSource(item.source)
    const expected = path.resolve(workspaceDir, 'docs', category, taskId, safeComponent(path.basename(entry.repositoryRoot), 'repository_key'), relative)
    if (!item.archivePath || path.resolve(item.archivePath) !== expected || !item.sha256) throw new Error(`worktree_removed_document_unverified:${item.source}`)
    await assertNoExistingLink(expected)
    if (!(await exists(expected)) || await sha256(expected) !== item.sha256) throw new Error(`worktree_removed_document_unverified:${item.source}`)
  }
  const cleaned = { ...entry, status: 'cleaned', cleanedAt: new Date().toISOString() }
  if (!checkOnly) await onProgress(cleaned)
  return cleaned
}

async function prepare({ taskId, entry, workspaceDir }) {
  if (!entry?.createdByTask || entry.status !== 'registered') throw new Error('worktree_not_owned_or_registered')
  safeComponent(taskId, 'task_id')
  const actual = await inspectTaskWorktree({ location: entry.path, workspaceDir })
  sameIdentity(actual, entry)
  const status = await git(actual.path, 'status', '--porcelain=v1', '--untracked-files=all')
  const untracked = new Set()
  for (const line of status.split(/\r?\n/).filter(Boolean)) {
    if (!line.startsWith('?? ')) throw new Error(`worktree_dirty_code:${line}`)
    untracked.add(line.slice(3).replaceAll('\\', '/'))
  }
  const remoteRef = actual.branch ? `refs/heads/${actual.branch}` : null
  if (!remoteRef) throw new Error('worktree_detached_push_unverifiable')
  const remote = await git(actual.path, 'ls-remote', 'origin', remoteRef)
  if (remote.split(/\s+/)[0] !== actual.head) throw new Error('worktree_unpushed_or_remote_changed')
  const repoKey = safeComponent(path.basename(actual.repositoryRoot), 'repository_key')
  const docs = []
  for (const item of entry.documents ?? []) {
    const { category, relative } = documentSource(item.source)
    const source = await assertRegularUnlinkedFile(actual.path, item.source)
    const archivePath = path.resolve(workspaceDir, 'docs', category, taskId, repoKey, relative)
    await assertNoExistingLink(archivePath)
    const digest = await sha256(source)
    if (item.archivePath && path.resolve(item.archivePath) !== archivePath) throw new Error(`document_archive_path_changed:${item.source}`)
    if (item.sha256 && item.sha256 !== digest) throw new Error(`document_source_changed:${item.source}`)
    if (await exists(archivePath) && await sha256(archivePath) !== digest) throw new Error(`document_target_conflict:${item.source}`)
    docs.push({ ...item, source: item.source, sourcePath: source, archivePath, sha256: digest, untracked: untracked.has(item.source) })
  }
  const declared = new Set(docs.map((item) => item.source))
  for (const file of untracked) if (!declared.has(file)) throw new Error(`worktree_unknown_untracked_file:${file}`)
  return { actual, docs }
}

export async function archiveTaskWorktree({ taskId, entry, workspaceDir, checkOnly = false, onProgress = async () => {} }) {
  const recovered = await recoveredRemoval({ taskId, entry, workspaceDir, checkOnly, onProgress })
  if (recovered) return recovered
  const { actual, docs } = await prepare({ taskId, entry, workspaceDir })
  if (checkOnly) return { ...entry, documents: docs.map(({ sourcePath, untracked, ...item }) => item) }
  let current = { ...entry, documents: [...(entry.documents ?? [])] }
  for (const doc of docs) {
    if (!(await exists(doc.archivePath))) {
      await mkdir(path.dirname(doc.archivePath), { recursive: true })
      await copyFile(doc.sourcePath, doc.archivePath, 1)
    }
    if (await sha256(doc.archivePath) !== doc.sha256) throw new Error(`document_copy_verification_failed:${doc.source}`)
    current = { ...current, documents: current.documents.map((item) => item.source === doc.source ? { ...item, archivePath: doc.archivePath, sha256: doc.sha256 } : item) }
    await onProgress(current)
  }
  await prepare({ taskId, entry: current, workspaceDir })
  for (const doc of docs) if (doc.untracked) await rm(doc.sourcePath)
  await git(actual.repositoryRoot, 'worktree', 'remove', actual.path)
  if (await pathPresent(actual.path)) throw new Error('worktree_directory_remains_after_git_remove')
  const listed = parseWorktreeList(await git(actual.repositoryRoot, 'worktree', 'list', '--porcelain'))
  if (listed.some((item) => path.resolve(item.worktree) === actual.path)) throw new Error('worktree_git_record_remains_after_remove')
  current = { ...current, status: 'cleaned', cleanedAt: new Date().toISOString() }
  await onProgress(current)
  return current
}
