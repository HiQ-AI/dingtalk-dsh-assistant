import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

// Keep test doubles on the same read-handle boundary as the native backend.
export function sessionPersistenceFixture(inspect) {
  return {
    async open(id, access) {
      assert.equal(access, 'read')
      const { meta, inheritedEventCount = 0, events } = await inspect(id)
      return {
        header: meta,
        inheritedEventCount,
        async read() { return { events } },
        async close() {},
      }
    },
  }
}

export function requestSystemText(request) {
  return request.messages.filter(message => message.role === 'system')
    .flatMap(message => message.content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text).join('\n')
}

// Locate fixtures by the stored header rather than the backend's private path API.
export async function findSessionLog(root, id) {
  const matches = []
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    const path = join(entry.parentPath, entry.name)
    const header = JSON.parse((await readFile(path, 'utf8')).split('\n', 1)[0])
    if (header.id === id) matches.push(path)
  }
  assert.equal(matches.length, 1, `one persisted fixture log for ${id}`)
  return matches[0]
}
