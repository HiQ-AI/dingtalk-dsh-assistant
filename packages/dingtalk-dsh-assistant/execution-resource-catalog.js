import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

const fail = (code, detail) => { throw Object.assign(new Error(detail ?? code), { code }) }
const validText = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 1024

/** 目录只从受信工作区的固定入口读取，不能由模型参数指向另一份映射。 */
export async function readExecutionResourceCatalog(workspaceDir) {
  const file = join(workspaceDir, '.dsh', 'shared-resources.json')
  let target
  try { target = await realpath(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  const path = relative(await realpath(workspaceDir), target)
  if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) fail('DYNAMIC_RESOURCE_CATALOG_PATH_INVALID')
  const bytes = await readFile(target)
  if (bytes.length > 1024 * 1024) fail('DYNAMIC_RESOURCE_CATALOG_INVALID', 'Resource catalog exceeds 1 MiB.')
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { fail('DYNAMIC_RESOURCE_CATALOG_INVALID', 'Resource catalog must be JSON.') }
  return createExecutionResourceCatalog(value).snapshot
}

/** 旧映射属于锁身份的一部分：追加可以，删除、改绑或改用途必须拒绝。 */
export function createExecutionResourceCatalog(configured, persisted = null) {
  const validate = value => {
    if (!value || value.version !== 1 || !Array.isArray(value.resources)
      || Object.keys(value).some(key => !['version', 'resources'].includes(key))) fail('DYNAMIC_RESOURCE_CATALOG_INVALID')
    const names = new Set()
    const resources = value.resources.map(item => {
      if (!item || !validText(item.key) || !validText(item.description) || !['publication', 'workspace'].includes(item.purpose)
        || !Array.isArray(item.aliases) || item.aliases.some(alias => !validText(alias))
        || Object.keys(item).some(key => !['key', 'aliases', 'purpose', 'description'].includes(key))) fail('DYNAMIC_RESOURCE_CATALOG_INVALID')
      for (const name of [item.key, ...item.aliases]) {
        if (names.has(name)) fail('DYNAMIC_RESOURCE_CATALOG_AMBIGUOUS', name)
        names.add(name)
      }
      return { key: item.key, aliases: [...item.aliases].sort(), purpose: item.purpose, description: item.description }
    }).sort((a, b) => a.key.localeCompare(b.key))
    return { version: 1, resources }
  }
  const previous = persisted == null ? null : validate(persisted)
  // 文件暂缺也不能撤销已登记的锁身份；保留上次成功加载的目录。
  const snapshot = configured == null ? previous : validate(configured)
  const byName = new Map()
  for (const item of snapshot?.resources ?? []) for (const name of [item.key, ...item.aliases]) byName.set(name, item)
  for (const item of previous?.resources ?? []) for (const name of [item.key, ...item.aliases]) {
    const current = byName.get(name)
    if (current?.key !== item.key || current?.purpose !== item.purpose) fail('DYNAMIC_RESOURCE_CATALOG_REBIND_FORBIDDEN', name)
  }
  const keys = (values = [], registered = false) => {
    if (!Array.isArray(values)) fail('DYNAMIC_ARGUMENT_INVALID', 'resourceKeys')
    return [...new Set(values.map(key => {
      if (typeof key !== 'string' || !key.trim()) fail('DYNAMIC_ARGUMENT_INVALID', 'resourceKey')
      const item = byName.get(key)
      if (registered && snapshot && !item) fail('DYNAMIC_RESOURCE_UNREGISTERED', key)
      return item?.key ?? key
    }))].sort()
  }
  const phase = (value = 'prepare', values = []) => {
    if (!['prepare', 'publish'].includes(value)) fail('DYNAMIC_RESOURCE_PHASE_INVALID')
    if (value === 'prepare' && values.some(key => byName.get(key)?.purpose === 'publication')) fail('DYNAMIC_RESOURCE_PHASE_MISMATCH', 'Publication resources require resourcePhase=publish.')
    return value
  }
  return { snapshot, keys, phase, publication: key => byName.get(key)?.purpose === 'publication',
    // 老执行的用途由既有键推导，仅用于继续看守旧锁，不改写历史委派记录。
    executionPhase: execution => execution.resourcePhase ?? (execution.resourceKeys?.some(key => byName.get(key)?.purpose === 'publication') ? 'publish' : 'prepare') }
}
