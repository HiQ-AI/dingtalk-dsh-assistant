import { Worker } from 'node:worker_threads'

export function checkTaskStoreIntegrity(dbPath) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./task-store-integrity-worker.js', import.meta.url), { workerData: { dbPath }, execArgv: [] })
    let result
    const failed = () => Object.assign(new Error('DYNAMIC_STORE_CORRUPT'), { code: 'DYNAMIC_STORE_CORRUPT' })
    worker.once('message', message => { result = message })
    worker.once('error', () => reject(failed()))
    // Wait for close too, so recovery never races a still-open validation reader.
    worker.once('exit', code => code === 0 && result?.ok === true ? resolve() : reject(failed()))
  })
}
