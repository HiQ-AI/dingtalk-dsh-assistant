const fail = code => { throw new Error(code) }
const commitSha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)
const packageSha = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

/** 只投影源码身份；认证变量和原始日志不得进入证明或异常。 */
export async function readUploadedSourceEvidence({ pipeline, readStepLogs }) {
  const variables = pipeline?.variables ?? {}
  const steps = (Array.isArray(pipeline?.workflows) ? pipeline.workflows : [])
    .flatMap(workflow => Array.isArray(workflow?.children) ? workflow.children : [])
  const prepares = steps.filter(step => step?.name === 'prepare-uploaded-source')
  const sourceValues = [variables.SOURCE_PACKAGE_ID, variables.SOURCE_PACKAGE_SHA256, variables.SOURCE_COMMIT_SHA]
  if (!sourceValues.some(value => value !== undefined && value !== '')
    && !prepares.some(step => step.state !== 'skipped')) return undefined

  const artifactId = variables.SOURCE_PACKAGE_ID
  const sha256 = variables.SOURCE_PACKAGE_SHA256
  if (pipeline.event !== 'manual' || !Number.isInteger(pipeline.number) || pipeline.number < 1
    || !commitSha(pipeline.commit) || variables.SOURCE_COMMIT_SHA !== pipeline.commit
    || typeof artifactId !== 'string' || !/^[0-9a-f]{32}$/.test(artifactId) || !packageSha(sha256))
    fail('WOODPECKER_SOURCE_PACKAGE_UNCONFIRMED')
  const prepare = prepares[0]
  const clones = steps.filter(step => step?.name === 'clone-source')
  if (prepares.length !== 1 || !Number.isInteger(prepare?.id) || prepare.id < 1
    || prepare.state !== 'success' || prepare.exit_code !== 0
    || clones.some(step => step.state !== 'skipped'
      || step.started !== undefined && step.started !== null && step.started !== 0
      || step.exit_code !== undefined && step.exit_code !== null && step.exit_code !== 0))
    fail('WOODPECKER_SOURCE_PREPARATION_UNCONFIRMED')

  let logs
  try { logs = await readStepLogs(prepare.id) } catch { fail('WOODPECKER_SOURCE_LOG_READ_FAILED') }
  if (!Array.isArray(logs)) fail('WOODPECKER_SOURCE_LOG_INVALID')
  const lines = []
  for (const row of logs) {
    if (row?.step_id !== prepare.id || row.data !== null && (typeof row.data !== 'string'
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.data)))
      fail('WOODPECKER_SOURCE_LOG_INVALID')
    if (row.data === null) continue
    const bytes = Buffer.from(row.data, 'base64')
    if (bytes.toString('base64') !== row.data) fail('WOODPECKER_SOURCE_LOG_INVALID')
    try { lines.push(...new TextDecoder('utf-8', { fatal: true }).decode(bytes).split(/\r?\n/).map(line => line.trim())) }
    catch { fail('WOODPECKER_SOURCE_LOG_INVALID') }
  }
  const proofs = lines.map(line => /^uploaded source prepared commit=([0-9a-f]{12}) sha256=([0-9a-f]{64})$/.exec(line)).filter(Boolean)
  if (proofs.length !== 1 || proofs[0][1] !== pipeline.commit.slice(0, 12) || proofs[0][2] !== sha256)
    fail('WOODPECKER_SOURCE_LOG_UNCONFIRMED')
  return { commitSha: pipeline.commit, sha256, artifactId,
    evidenceRef: `woodpecker-source:${pipeline.number}:${prepare.id}:${artifactId}:${sha256}` }
}
