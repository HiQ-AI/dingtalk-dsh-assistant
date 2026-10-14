// A promoted shell call still belongs to the original execution and process scope.
// Never launch a replacement command, or accept a job belonging to another session.
export async function collectNativeJob({ result, jobs, sessionId, toolName, command, startedAt, signal, record }) {
  const jobId = result?.value?.jobId
  if (!jobId) return null
  const fail = code => { throw Object.assign(new Error(code), { code }) }
  if (!jobs?.get || !jobs?.wait || !jobs?.readAt || !jobs?.kill) fail('DYNAMIC_JOB_REGISTRY_REQUIRED')
  let job = jobs.get(jobId, sessionId)
  if (job.owner !== sessionId || !['bash','pwsh'].includes(toolName) || job.kind !== toolName
    || job.label !== command || !Number.isFinite(startedAt) || job.startedAt < startedAt) fail('DYNAMIC_JOB_OWNER_MISMATCH')
  if (['running', 'stopping'].includes(job.status)) await record({ jobId, owner: sessionId, status: job.status, startedAt: job.startedAt })
  let offset = 0, chunks = [], lossy = false, bytes = 0
  const read = () => {
    const page = jobs.readAt(jobId, offset, sessionId)
    offset = page.next; lossy ||= page.lossy
    for (const chunk of page.chunks) {
      chunks.push(chunk); bytes += Buffer.byteLength(chunk.text)
      while (bytes > 256 * 1024 && chunks.length > 1) { bytes -= Buffer.byteLength(chunks.shift().text); lossy = true }
    }
  }
  try {
    while (['running', 'stopping'].includes(job.status)) {
      signal.throwIfAborted()
      read()
      job = await jobs.wait(jobId, 1000, sessionId, signal)
    }
  } catch (error) {
    // Abort only the owned job; wait for the producer's terminal drain before disposal.
    try {
      jobs.kill(jobId, sessionId, 'task execution cancelled')
      do { job = await jobs.wait(jobId, 1000, sessionId) } while (['running', 'stopping'].includes(job.status))
      read()
      await record({ jobId, owner: sessionId, status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt,
        detail: job.detail ?? null, chunks, lossy, cancelled: true })
    } catch (cause) {
      throw Object.assign(new Error('DYNAMIC_JOB_DRAIN_UNPROVEN'), { code: 'DYNAMIC_JOB_DRAIN_UNPROVEN', executionDrained: false, cause })
    }
    throw error
  }
  read()
  const receipt = { jobId, owner: sessionId, status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt,
    detail: job.detail ?? null, chunks, lossy, cancelled: false }
  await record(receipt)
  return receipt
}
