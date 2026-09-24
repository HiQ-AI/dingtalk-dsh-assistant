import { parseArgs } from 'node:util'
import { access, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { openExecutionStore } from '../packages/dingtalk-dsh-assistant/execution-store.js'
import { openExecutionArtifacts } from '../packages/dingtalk-dsh-assistant/execution-artifacts.js'

const { values } = parseArgs({ options: {
  db: { type: 'string' }, instance: { type: 'string' }, artifacts: { type: 'string' }, check: { type: 'boolean' }, execute: { type: 'boolean' },
} })
if (!values.db || !values.instance || !values.artifacts || values.check === values.execute) throw new Error('usage: --db <path> --instance <id> --artifacts <directory> (--check | --execute)')
const dbPath = resolve(values.db), artifactDirectory = resolve(values.artifacts)
try { await access(dbPath); throw new Error('execution_database_already_exists') } catch (error) { if (error.code !== 'ENOENT') throw error }
if (values.check) {
  console.log(JSON.stringify({ status: 'CHECK_PASS', dbPath, artifactDirectory, instanceId: values.instance, writes: 0 }))
} else {
  await mkdir(dirname(dbPath), { recursive: true })
  const store = await openExecutionStore({ dbPath, instanceId: values.instance, initialize: true })
  try {
    await openExecutionArtifacts({ directory: artifactDirectory, initialize: true })
    console.log(JSON.stringify({ status: 'INITIALIZED', dbPath, artifactDirectory, instanceId: values.instance }))
  } finally { await store.close() }
}
