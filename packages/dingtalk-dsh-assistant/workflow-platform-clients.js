import { promisify } from 'node:util'
import { execFile as execFileCallback } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { executionDigest } from './execution-artifacts.js'
import { narrowVerificationSql } from './workflow-postgres-uat-host.js'

const execFile = promisify(execFileCallback)
const fail = code => { throw new Error(code) }
const sha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)
const evidence = (system, identity) => `${system}:${identity}`
const safePath = value => typeof value === 'string' && /^[A-Za-z0-9._/-]+$/.test(value)
const safeName = value => typeof value === 'string' && /^[A-Za-z0-9._-]+$/.test(value)
const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)

/** 只接受受信 Host 注入的凭据与固定端点；异常不透传服务端响应或认证头。 */
export function createPlatformClients({ githubToken, woodpeckerToken, kubeconfig,
  kubeServer, kubeSkipTlsVerify = false, bytebaseBaseUrl, bytebaseToken, bytebaseCredentials, registryBearerToken,
  githubTagWritesEnabled = false, registryDockerCliEnabled = false,
  fetchImpl = fetch, execFileImpl = execFile, attestations } = {}) {
  async function request(url, token, options = {}) {
    if (!url.startsWith('https://')) fail('PLATFORM_HTTPS_REQUIRED')
    let response
    try {
      response = await fetchImpl(url, { ...options, headers: {
        Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      }, signal: AbortSignal.timeout(30000) })
    } catch { fail('PLATFORM_REQUEST_FAILED') }
    if (!response.ok) fail(`PLATFORM_HTTP_${response.status}`)
    if (response.status === 204) return {}
    try { return await response.json() } catch { fail('PLATFORM_RESPONSE_INVALID') }
  }
  let bytebaseCookie
  async function bytebaseRequest(path, options = {}) {
    if (!bytebaseBaseUrl?.startsWith('https://') || !/^\/v1\/[A-Za-z0-9._/%?=&:-]+$/.test(path))
      fail('BYTEBASE_READ_NOT_CONFIGURED')
    if (!bytebaseToken && !bytebaseCookie) {
      if (typeof bytebaseCredentials?.username !== 'string'
        || typeof bytebaseCredentials?.password !== 'string') fail('BYTEBASE_READ_NOT_CONFIGURED')
      let response
      try { response = await fetchImpl(`${bytebaseBaseUrl.replace(/\/$/, '')}/v1/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: bytebaseCredentials.username,
          password: bytebaseCredentials.password, web: true }), signal: AbortSignal.timeout(30000),
      }) } catch { fail('BYTEBASE_AUTH_FAILED') }
      if (!response.ok) fail('BYTEBASE_AUTH_FAILED')
      const cookies = response.headers?.getSetCookie?.() ?? []
      const access = cookies.map(item => /^access-token=([^;]+)/.exec(item)?.[1]).find(Boolean)
      if (!access) fail('BYTEBASE_AUTH_FAILED')
      bytebaseCookie = `access-token=${access}`
    }
    return request(`${bytebaseBaseUrl.replace(/\/$/, '')}${path}`, bytebaseToken,
      { ...options, headers: { ...(bytebaseCookie ? { Cookie: bytebaseCookie } : {}), ...options.headers } })
  }
  const githubUrl = (repository, suffix) => {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) fail('GITHUB_REPOSITORY_INVALID')
    return `https://api.github.com/repos/${repository}/${suffix}`
  }
  const github = {
    async readBranch({ repository, branch }) {
      if (!safePath(branch)) fail('GITHUB_BRANCH_INVALID')
      const row = await request(githubUrl(repository, `branches/${branch.split('/').map(encodeURIComponent).join('/')}`), githubToken)
      if (!sha(row?.commit?.sha)) fail('GITHUB_BRANCH_UNCONFIRMED')
      return { commitSha: row.commit.sha, evidenceRef: evidence('github-branch', `${repository}:${branch}:${row.commit.sha}`) }
    },
    async readPullRequest({ repository, number }) {
      if (!Number.isInteger(number) || number < 1) fail('GITHUB_PR_INVALID')
      const row = await request(githubUrl(repository, `pulls/${number}`), githubToken)
      return { number, merged: !!row.merged_at, baseBranch: row.base?.ref,
        headCommitSha: row.head?.sha, mergeCommitSha: row.merge_commit_sha,
        evidenceRef: evidence('github-pr', `${repository}:${number}:${row.updated_at}`) }
    },
    async readCommit({ repository, commitSha }) {
      if (!sha(commitSha)) fail('GITHUB_COMMIT_INVALID')
      const row = await request(githubUrl(repository, `git/commits/${commitSha}`), githubToken)
      if (row?.sha !== commitSha || !sha(row.tree?.sha)) fail('GITHUB_COMMIT_UNCONFIRMED')
      return { commitSha, treeSha: row.tree.sha,
        evidenceRef: evidence('github-commit', `${repository}:${commitSha}:${row.tree.sha}`) }
    },
    async resolveApprovedPullRequest({ repository, baseBranch, mergeCommitSha }) {
      if (!safePath(baseBranch) || !sha(mergeCommitSha)) fail('GITHUB_PR_IDENTITY_INVALID')
      // API 的普通列表没有 commit SHA 过滤；分页扫全 merged PR，不能由空首页推断唯一性。
      const matches = []
      for (let page = 1; page <= 100; page++) {
        const rows = await request(githubUrl(repository,
          `pulls?state=closed&base=${encodeURIComponent(baseBranch)}&per_page=100&page=${page}`), githubToken)
        if (!Array.isArray(rows)) fail('GITHUB_PR_LIST_INVALID')
        for (const row of rows) if (row.merged_at && row.merge_commit_sha === mergeCommitSha) matches.push(row)
        if (rows.length < 100) {
          if (matches.length !== 1) fail('GITHUB_PR_NOT_UNIQUE')
          const row = matches[0]
          return { number: row.number, merged: true, unique: true, baseBranch,
            mergeCommitSha, evidenceRef: evidence('github-pr', `${repository}:${row.number}:${row.updated_at}`) }
        }
      }
      fail('GITHUB_PR_LIST_INCOMPLETE')
    },
    async readTag({ repository, tag }) {
      if (!safeName(tag)) fail('GITHUB_TAG_INVALID')
      const url = githubUrl(repository, `git/ref/tags/${encodeURIComponent(tag)}`)
      let response
      try { response = await fetchImpl(url, { headers: { Accept: 'application/vnd.github+json',
        ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}) }, signal: AbortSignal.timeout(30000) }) }
      catch { fail('GITHUB_TAG_READ_FAILED') }
      if (response.status === 404) {
        // 私有仓库的权限不足也可能被隐藏为 404，独立确认仓库可读。
        const repo = await request(`https://api.github.com/repos/${repository}`, githubToken)
        if (repo.full_name !== repository) fail('GITHUB_REPOSITORY_UNCONFIRMED')
        return { exists: false, evidenceRef: evidence('github-tag-absent', `${repository}:${tag}`) }
      }
      if (!response.ok) fail(`GITHUB_TAG_HTTP_${response.status}`)
      let row
      try { row = await response.json() } catch { fail('GITHUB_TAG_RESPONSE_INVALID') }
      if (row?.object?.type !== 'commit' || !sha(row.object.sha)) fail('GITHUB_TAG_UNCONFIRMED')
      return { exists: true, commitSha: row.object.sha,
        evidenceRef: evidence('github-tag', `${repository}:${tag}:${row.object.sha}`) }
    },
  }
  if (githubTagWritesEnabled) github.createTag = async ({ target, commitSha, tag }) => {
    if (!safeName(tag) || !sha(commitSha) || target?.releaseTag !== tag || !safePath(target?.branch)) fail('GITHUB_TAG_WRITE_INVALID')
    const head = await github.readBranch({ repository: target.repository, branch: target.branch })
    if (head.commitSha !== commitSha) fail('GITHUB_TAG_BRANCH_MOVED')
    const prior = await github.readTag({ repository: target.repository, tag })
    if (prior.exists) fail('GITHUB_TAG_ALREADY_EXISTS')
    await request(githubUrl(target.repository, 'git/refs'), githubToken, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: `refs/tags/${tag}`, sha: commitSha }) })
    const after = await github.readTag({ repository: target.repository, tag })
    if (after.commitSha !== commitSha) fail('GITHUB_TAG_READBACK_MISMATCH')
    return after
  }
  const woodpeckerUrl = (baseUrl, suffix) => {
    if (baseUrl !== 'https://woodpecker.hiqdat.dev') fail('WOODPECKER_ENDPOINT_NOT_ALLOWED')
    return `${baseUrl}/api/${suffix}`
  }
  const woodpecker = {
    async listPipelines({ baseUrl, repositoryId }) {
      if (!Number.isInteger(repositoryId) || repositoryId < 1) fail('WOODPECKER_REPOSITORY_INVALID')
      const pipelines = [], numbers = new Set()
      for (let page = 1; page <= 100; page++) {
        const rows = await request(woodpeckerUrl(baseUrl,
          `repos/${repositoryId}/pipelines?page=${page}&perPage=100`), woodpeckerToken)
        if (!Array.isArray(rows)) fail('WOODPECKER_LIST_INVALID')
        for (const row of rows) {
          if (!Number.isInteger(row.number) || numbers.has(row.number) || !sha(row.commit)
            || typeof row.branch !== 'string' || !row.branch || typeof row.status !== 'string') fail('WOODPECKER_LIST_INVALID')
          numbers.add(row.number)
          pipelines.push({ number: row.number, commitSha: row.commit, branch: row.branch,
            ref: row.ref ?? `refs/heads/${row.branch}`, status: row.status })
        }
        if (rows.length === 0) return { complete: true, hasMore: false, pipelines,
          evidenceRef: evidence('woodpecker-list', `${repositoryId}:${pipelines.length}:${Math.max(0, ...numbers)}`) }
      }
      fail('WOODPECKER_LIST_INCOMPLETE')
    },
    async readBuildEvidence({ baseUrl, repositoryId, pipelineNumber }) {
      if (!Number.isInteger(repositoryId) || repositoryId < 1
        || !Number.isInteger(pipelineNumber) || pipelineNumber < 1) fail('WOODPECKER_PIPELINE_INVALID')
      const pipeline = await request(woodpeckerUrl(baseUrl,
        `repos/${repositoryId}/pipelines/${pipelineNumber}`), woodpeckerToken)
      if (pipeline.number !== pipelineNumber || !sha(pipeline.commit) || pipeline.status !== 'success'
        || !Array.isArray(pipeline.workflows)) fail('WOODPECKER_BUILD_UNCONFIRMED')
      const steps = pipeline.workflows.flatMap(workflow => Array.isArray(workflow.children) ? workflow.children : [])
        .filter(step => step.name === 'buildkit-build-and-push')
      if (steps.length !== 1 || !Number.isInteger(steps[0].id)
        || steps[0].state !== 'success' || steps[0].exit_code !== 0)
        fail('WOODPECKER_BUILD_STEP_UNCONFIRMED')
      const logs = await request(woodpeckerUrl(baseUrl,
        `repos/${repositoryId}/logs/${pipelineNumber}/${steps[0].id}`), woodpeckerToken)
      if (!Array.isArray(logs) || logs.some(row => row.step_id !== steps[0].id
        || row.data !== null && (typeof row.data !== 'string'
          || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.data))))
        fail('WOODPECKER_BUILD_LOG_INVALID')
      const lines = logs.filter(row => row.data !== null)
        .map(row => Buffer.from(row.data, 'base64').toString('utf8').trim())
      const exported = lines.map(line => /^#\d+ exporting manifest (sha256:[0-9a-f]{64}) done$/.exec(line))
        .filter(Boolean).map(match => match[1])
      const pushed = lines.map(line => /^#\d+ pushing manifest for (registry\.cn-sh1\.ctyun\.cn\/[A-Za-z0-9._/-]+:[A-Za-z0-9._-]+)@(sha256:[0-9a-f]{64}) \d+(?:\.\d+)?s done$/.exec(line))
        .filter(Boolean)
      if (exported.length !== 1 || pushed.length !== 1 || exported[0] !== pushed[0][2])
        fail('WOODPECKER_BUILD_DIGEST_UNCONFIRMED')
      return { pipelineNumber, commitSha: pipeline.commit, image: pushed[0][1], imageDigest: pushed[0][2],
        evidenceRef: evidence('woodpecker-build', `${repositoryId}:${pipelineNumber}:${steps[0].id}:${pushed[0][2]}`) }
    },
    async triggerBuild({ target, commitSha }) {
      const { baseUrl, repositoryId, cronName } = target?.woodpecker ?? {}
      if (!sha(commitSha) || !safeName(cronName) || !Number.isInteger(repositoryId)) fail('WOODPECKER_TRIGGER_INVALID')
      const head = await github.readBranch({ repository: target.repository, branch: target.branch })
      if (head.commitSha !== commitSha) fail('WOODPECKER_BRANCH_MOVED')
      const scan = await woodpecker.listPipelines({ baseUrl, repositoryId })
      if (scan.pipelines.some(row => row.commitSha === commitSha && row.branch === target.branch
        && ['created', 'pending', 'running', 'blocked', 'success'].includes(row.status))) fail('WOODPECKER_EQUIVALENT_BUILD_EXISTS')
      const crons = await request(woodpeckerUrl(baseUrl, `repos/${repositoryId}/cron`), woodpeckerToken)
      if (!Array.isArray(crons)) fail('WOODPECKER_CRON_INVALID')
      const found = crons.filter(row => row.name === cronName && row.branch === target.branch)
      if (found.length !== 1 || !Number.isInteger(found[0].id)) fail('WOODPECKER_CRON_UNCONFIRMED')
      await request(woodpeckerUrl(baseUrl, `repos/${repositoryId}/cron/${found[0].id}`), woodpeckerToken,
        { method: 'POST' })
      return { evidenceRef: evidence('woodpecker-cron-dispatch', `${repositoryId}:${found[0].id}:${commitSha}`) }
    },
  }
  const kubernetes = {
    async readPods({ namespace, deployment, deploymentUid }) {
      if (!safeName(namespace) || !safeName(deployment) || !safeName(deploymentUid) || !kubeconfig) fail('KUBE_TARGET_INVALID')
      const readList = async type => {
        try {
          const result = await execFileImpl('kubectl', ['--kubeconfig', kubeconfig,
            ...(kubeServer ? ['--server', kubeServer] : []),
            ...(kubeSkipTlsVerify ? ['--insecure-skip-tls-verify'] : []), '--request-timeout=15s', '-n', namespace,
            'get', type, '-o', 'json'], { maxBuffer: 4 * 1024 * 1024 })
          return JSON.parse(result.stdout)
        } catch { fail('KUBE_POD_READ_FAILED') }
      }
      const replicaSets = await readList('replicasets')
      const podList = await readList('pods')
      if (!Array.isArray(replicaSets?.items) || !Array.isArray(podList?.items)) fail('KUBE_POD_LIST_INVALID')
      const owned = new Set(replicaSets.items.filter(row => row.metadata?.ownerReferences?.some(ref =>
        ref.kind === 'Deployment' && ref.uid === deploymentUid && ref.name === deployment))
        .map(row => row.metadata?.uid).filter(Boolean))
      if (!owned.size) fail('KUBE_REPLICASET_NOT_FOUND')
      const pods = podList.items.filter(row => row.metadata?.ownerReferences?.some(ref =>
        ref.kind === 'ReplicaSet' && owned.has(ref.uid)))
      if (!pods.length) fail('KUBE_PODS_NOT_FOUND')
      return { complete: true, deploymentUid, pods: pods.map(row => {
        const container = row.status?.containerStatuses?.find(item => item.name === row.spec?.containers?.[0]?.name)
        const imageDigest = container?.imageID?.match(/sha256:[a-f0-9]{64}$/)?.[0]
        return { deploymentUid, imageDigest,
          ready: row.status?.phase === 'Running' && container?.ready === true
            && row.metadata?.deletionTimestamp == null,
        }
      }), evidenceRef: evidence('kube-pods', `${namespace}:${deployment}:${deploymentUid}:${pods.map(row => row.metadata?.resourceVersion).join(',')}`) }
    },
    async readDeployment({ namespace, deployment }) {
      if (!safeName(namespace) || !safeName(deployment) || !kubeconfig) fail('KUBE_TARGET_INVALID')
      let row
      try {
        const result = await execFileImpl('kubectl', ['--kubeconfig', kubeconfig,
          ...(kubeServer ? ['--server', kubeServer] : []),
          ...(kubeSkipTlsVerify ? ['--insecure-skip-tls-verify'] : []), '--request-timeout=15s', '-n', namespace,
          'get', 'deployment', deployment, '-o', 'json'], { maxBuffer: 1024 * 1024 })
        row = JSON.parse(result.stdout)
      } catch { fail('KUBE_DEPLOYMENT_READ_FAILED') }
      const status = row?.status
      return { uid: row?.metadata?.uid, desiredReplicas: row?.spec?.replicas,
        readyReplicas: status?.readyReplicas ?? 0,
        generation: row?.metadata?.generation, observedGeneration: status?.observedGeneration,
        ready: status?.readyReplicas === row?.spec?.replicas && status?.availableReplicas === row?.spec?.replicas,
        evidenceRef: evidence('kube-deployment', `${namespace}:${deployment}:${row?.metadata?.resourceVersion}`) }
    },
    async readEntry({ url }) {
      if (typeof url !== 'string' || !url.startsWith('https://')) fail('ENTRY_URL_INVALID')
      let response
      try { response = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(15000) }) }
      catch { fail('ENTRY_READ_FAILED') }
      return { accessible: response.ok, evidenceRef: evidence('entry', `${url}:${response.status}`) }
    },
  }
  const registry = {}
  if (registryBearerToken || registryDockerCliEnabled) registry.readManifest = async ({ image, digest: expected }) => {
    if (!/^registry\.cn-sh1\.ctyun\.cn\/[A-Za-z0-9._/-]+$/.test(image)
      || !digest(expected)) fail('REGISTRY_TARGET_INVALID')
    const name = image.slice('registry.cn-sh1.ctyun.cn/'.length)
    let bytes, body, response
    if (registryDockerCliEnabled) {
      try {
        const result = await execFileImpl('docker', ['buildx', 'imagetools', 'inspect', '--raw', `${image}@${expected}`],
          { timeout: 30000, maxBuffer: 4 * 1024 * 1024, encoding: 'buffer' })
        bytes = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout, 'utf8')
      } catch { fail('REGISTRY_READ_FAILED') }
    } else {
      try { response = await fetchImpl(`https://registry.cn-sh1.ctyun.cn/v2/${name}/manifests/${expected}`,
        { headers: { Authorization: `Bearer ${registryBearerToken}`,
          Accept: ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json',
            'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'].join(', ') },
          signal: AbortSignal.timeout(30000) }) }
      catch { fail('REGISTRY_READ_FAILED') }
      if (!response.ok) fail(`REGISTRY_HTTP_${response.status}`)
      try { bytes = Buffer.from(await response.arrayBuffer()) } catch { fail('REGISTRY_MANIFEST_INVALID') }
    }
    try { body = JSON.parse(bytes.toString('utf8')) }
    catch { fail('REGISTRY_MANIFEST_INVALID') }
    const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    if (actual !== expected || response && response.headers?.get?.('docker-content-digest') !== expected) fail('REGISTRY_DIGEST_MISMATCH')
    const platformDigests = Array.isArray(body.manifests)
      ? body.manifests.filter(item => item.platform?.os !== 'unknown' && item.platform?.architecture !== 'unknown')
        .map(item => item.digest) : [expected]
    if (!platformDigests.length || platformDigests.some(value => !digest(value))) fail('REGISTRY_PLATFORM_DIGEST_INVALID')
    return { digest: actual, platformDigests,
      evidenceRef: evidence('registry-manifest', `${name}:${actual}`) }
  }
  const bytebaseProject = 'projects/flbn'
  const bytebaseInstance = 'instances/flbnpguaf'
  const bytebaseDatabases = new Set(['hiq_editor', 'hiq_background_db', 'hiq_admin'])
  const bytebaseTarget = (project, target) => {
    if (project !== bytebaseProject || target?.instance !== bytebaseInstance
      || target?.environment !== 'production'
      || !bytebaseDatabases.has(target.database?.slice(`${bytebaseInstance}/databases/`.length))
      || !target.database.startsWith(`${bytebaseInstance}/databases/`)) fail('BYTEBASE_TARGET_NOT_ALLOWED')
  }
  const bytebaseResource = (project, name, type) => {
    if (project !== bytebaseProject || typeof name !== 'string'
      || !new RegExp(`^projects/flbn/${type}/[A-Za-z0-9_-]+$`).test(name)) fail('BYTEBASE_RESOURCE_NOT_ALLOWED')
    return name
  }
  const bytebaseList = async (project, type) => {
    if (project !== bytebaseProject || !['issues', 'plans'].includes(type)) fail('BYTEBASE_LIST_NOT_ALLOWED')
    const result = [], seen = new Set()
    let pageToken = ''
    for (let page = 0; page < 100; page++) {
      const suffix = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''
      const body = await bytebaseRequest(`/v1/${project}/${type}?pageSize=1000${suffix}`)
      if (!Array.isArray(body?.[type])) fail('BYTEBASE_LIST_UNCONFIRMED')
      result.push(...body[type])
      if (!body.nextPageToken) return result
      if (typeof body.nextPageToken !== 'string' || seen.has(body.nextPageToken)) fail('BYTEBASE_LIST_INCOMPLETE')
      seen.add(body.nextPageToken)
      pageToken = body.nextPageToken
    }
    fail('BYTEBASE_LIST_INCOMPLETE')
  }
  const bytebaseTitle = operationKey => {
    if (typeof operationKey !== 'string' || !/^[a-f0-9]{64}$/.test(operationKey))
      fail('BYTEBASE_OPERATION_KEY_INVALID')
    return `Assistant data change ${operationKey}`
  }
  const bytebaseIssueAttempts = new Set()
  const bytebaseRolloutAttempts = new Set()
  const bytebaseTaskAttempts = new Set()
  const bytebaseReadTaskRuns = async (taskId, project) => {
    bytebaseResource(project, taskId.split('/rollout/')[0], 'plans')
    if (!/^projects\/flbn\/plans\/[A-Za-z0-9_-]+\/rollout\/stages\/[A-Za-z0-9_-]+\/tasks\/[A-Za-z0-9_-]+$/.test(taskId))
      fail('BYTEBASE_TASK_NOT_ALLOWED')
    const rows = [], seen = new Set()
    let pageToken = ''
    for (let page = 0; page < 100; page++) {
      const suffix = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''
      const body = await bytebaseRequest(`/v1/${taskId}/taskRuns?pageSize=1000${suffix}`)
      if (!Array.isArray(body?.taskRuns)) fail('BYTEBASE_TASK_RUN_LIST_UNCONFIRMED')
      rows.push(...body.taskRuns)
      if (!body.nextPageToken) return rows
      if (typeof body.nextPageToken !== 'string' || seen.has(body.nextPageToken)) fail('BYTEBASE_TASK_RUN_LIST_INCOMPLETE')
      seen.add(body.nextPageToken)
      pageToken = body.nextPageToken
    }
    fail('BYTEBASE_TASK_RUN_LIST_INCOMPLETE')
  }
  const bytebase = {
    async getDatabase({ project, target }) {
      if (!bytebaseBaseUrl?.startsWith('https://') || !bytebaseToken && !bytebaseCredentials
        || !/^projects\/[A-Za-z0-9._-]+$/.test(project ?? '')
        || !/^instances\/[A-Za-z0-9._-]+$/.test(target?.instance ?? '')
        || !/^instances\/[A-Za-z0-9._-]+\/databases\/[A-Za-z0-9._-]+$/.test(target?.database ?? '')
        || !target.database.startsWith(`${target.instance}/databases/`)
        || !['production', 'uat'].includes(target?.environment)) fail('BYTEBASE_READ_NOT_CONFIGURED')
      const row = await bytebaseRequest(`/v1/${target.database}`)
      const environment = { 'environments/prod': 'production', 'environments/uat': 'uat' }[row.effectiveEnvironment]
      if (row.project !== project || row.name !== target.database
        || row.instanceResource?.name !== target.instance || environment !== target.environment)
        fail('BYTEBASE_DATABASE_IDENTITY_UNCONFIRMED')
      return { project: row.project, instance: row.instanceResource.name, database: row.name,
        environment, evidenceRef: evidence('bytebase-database',
          `${row.name}:${row.effectiveEnvironment}:${row.successfulSyncTime ?? ''}`) }
    },
    async getIssueBundle({ project, issueId }) {
      bytebaseResource(project, issueId, 'issues')
      const issueRow = await bytebaseRequest(`/v1/${issueId}`)
      if (issueRow?.name !== issueId || issueRow.type !== 'DATABASE_CHANGE'
        || typeof issueRow.description !== 'string') fail('BYTEBASE_ISSUE_UNCONFIRMED')
      let identity
      try { identity = JSON.parse(issueRow.description) } catch { fail('BYTEBASE_ISSUE_UNCONFIRMED') }
      if (issueRow.title !== bytebaseTitle(identity?.operationKey)
        || !/^[a-f0-9]{64}$/.test(identity?.packageDigest ?? '')) fail('BYTEBASE_ISSUE_UNCONFIRMED')
      const planId = bytebaseResource(project, issueRow.plan, 'plans')
      const planRow = await bytebaseRequest(`/v1/${planId}`)
      const spec = planRow?.specs?.length === 1 ? planRow.specs[0] : null
      const sheetId = bytebaseResource(project, spec?.changeDatabaseConfig?.sheet, 'sheets')
      const targets = spec?.changeDatabaseConfig?.targets
      if (planRow.name !== planId || planRow.issue !== issueId || planRow.title !== issueRow.title
        || targets?.length !== 1) fail('BYTEBASE_PLAN_UNCONFIRMED')
      const target = { instance: bytebaseInstance, database: targets[0], environment: 'production' }
      bytebaseTarget(project, target)
      if (identity.target?.database !== target.database || identity.target?.instance !== target.instance
        || identity.target?.environment !== target.environment) fail('BYTEBASE_ISSUE_UNCONFIRMED')
      const sheetRow = await bytebaseRequest(`/v1/${sheetId}?raw=true`)
      if (sheetRow?.name !== sheetId || typeof sheetRow.content !== 'string'
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(sheetRow.content))
        fail('BYTEBASE_SHEET_UNCONFIRMED')
      const sql = Buffer.from(sheetRow.content, 'base64').toString('utf8')
      const sqlSha256 = createHash('sha256').update(sql).digest('hex')
      if (sqlSha256 !== identity.applySqlSha256) fail('BYTEBASE_SHEET_UNCONFIRMED')
      let task = null
      if (planRow.hasRollout === true) {
        const rollout = await bytebaseRequest(`/v1/${planId}/rollout`)
        const stages = rollout?.stages
        const tasks = Array.isArray(stages) ? stages.flatMap(stage => stage.tasks ?? []) : []
        if (rollout.name !== `${planId}/rollout` || stages?.length !== 1
          || stages[0].environment !== 'environments/prod' || tasks.length !== 1
          || tasks[0].target !== target.database || tasks[0].specId !== spec.id
          || tasks[0].databaseUpdate?.sheet !== sheetId) fail('BYTEBASE_ROLLOUT_UNCONFIRMED')
        const taskId = tasks[0].name
        if (!/^projects\/flbn\/plans\/[A-Za-z0-9_-]+\/rollout\/stages\/[A-Za-z0-9_-]+\/tasks\/[A-Za-z0-9_-]+$/.test(taskId))
          fail('BYTEBASE_TASK_UNCONFIRMED')
        task = { id: taskId, planId, status: tasks[0].status }
      } else if (planRow.hasRollout !== false) fail('BYTEBASE_ROLLOUT_STATE_UNCONFIRMED')
      return { issue: { id: issueId, project, planId, ...(task ? { taskId: task.id } : {}),
        packageDigest: identity.packageDigest, operationKey: identity.operationKey },
      sheet: { id: sheetId, project, sha256: sqlSha256, target },
      plan: { id: planId, project, sheetId },
      task }
    },
    async findIssueByOperationKey({ project, operationKey }) {
      const title = bytebaseTitle(operationKey)
      const rows = (await bytebaseList(project, 'issues')).filter(row => row.title === title)
      if (rows.length > 1) fail('BYTEBASE_ISSUE_NOT_UNIQUE')
      if (!rows.length) return null
      return this.getIssueBundle({ project, issueId: rows[0].name })
    },
    async createIssueBundle({ project, target, operationKey, packageDigest,
      applySqlSha256, applySql }) {
      bytebaseTarget(project, target)
      const title = bytebaseTitle(operationKey)
      if (!/^[a-f0-9]{64}$/.test(packageDigest ?? '')
        || createHash('sha256').update(applySql ?? '').digest('hex') !== applySqlSha256)
        fail('BYTEBASE_ISSUE_INPUT_INVALID')
      const existing = await this.findIssueByOperationKey({ project, operationKey })
      if (existing) return existing
      if (bytebaseIssueAttempts.has(operationKey)) fail('BYTEBASE_CREATE_RESULT_UNKNOWN')
      bytebaseIssueAttempts.add(operationKey)
      // Sheet/Plan/Rollout/Issue 不是原子 API。任一步结果未知由外部效果账只读对账，绝不自动重发。
      const sheetRow = await bytebaseRequest(`/v1/${project}/sheets`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: Buffer.from(applySql).toString('base64') }) })
      const sheetId = bytebaseResource(project, sheetRow?.name, 'sheets')
      const planRow = await bytebaseRequest(`/v1/${project}/plans`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description: operationKey,
          specs: [{ id: randomUUID(), changeDatabaseConfig: { targets: [target.database], sheet: sheetId } }] }) })
      const planId = bytebaseResource(project, planRow?.name, 'plans')
      const issueRow = await bytebaseRequest(`/v1/${project}/issues`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description: JSON.stringify({ operationKey, packageDigest,
          applySqlSha256, target }), type: 'DATABASE_CHANGE', plan: planId }) })
      const issueId = bytebaseResource(project, issueRow?.name, 'issues')
      return this.getIssueBundle({ project, issueId })
    },
    async activateRollout({ project, issueId, operationKey }) {
      bytebaseTitle(operationKey)
      const bundle = await this.getIssueBundle({ project, issueId })
      if (bundle.issue.operationKey !== operationKey) fail('BYTEBASE_ROLLOUT_IDENTITY_CHANGED')
      if (bundle.task) return bundle
      if (bytebaseRolloutAttempts.has(operationKey)) fail('BYTEBASE_ROLLOUT_RESULT_UNKNOWN')
      bytebaseRolloutAttempts.add(operationKey)
      const planId = bundle.plan.id
      await bytebaseRequest(`/v1/${planId}/rollout`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent: planId, target: 'environments/prod' }) })
      const readback = await this.getIssueBundle({ project, issueId })
      if (!readback.task) fail('BYTEBASE_ROLLOUT_UNCONFIRMED')
      return readback
    },
    async getTaskExecution({ project, issueId, taskId }) {
      const bundle = await this.getIssueBundle({ project, issueId })
      if (bundle.task?.id !== taskId) fail('BYTEBASE_TASK_IDENTITY_CHANGED')
      const runs = await bytebaseReadTaskRuns(taskId, project)
      if (runs.length > 1) fail('BYTEBASE_TASK_RUN_NOT_UNIQUE')
      const row = runs[0]
      if (row && (typeof row.name !== 'string' || !row.name.startsWith(`${taskId}/taskRuns/`)
        || !['PENDING', 'RUNNING', 'DONE', 'FAILED', 'CANCELED'].includes(row.status)))
        fail('BYTEBASE_TASK_RUN_UNCONFIRMED')
      return { task: bundle.task, taskRun: row ? { id: row.name, taskId,
        status: row.status } : null }
    },
    async runTask({ project, issueId, taskId, operationKey }) {
      bytebaseTitle(operationKey)
      const bundle = await this.getIssueBundle({ project, issueId })
      if (bundle.issue.operationKey !== operationKey || bundle.task?.id !== taskId)
        fail('BYTEBASE_TASK_NOT_READY')
      const runs = await bytebaseReadTaskRuns(taskId, project)
      if (runs.length > 1) fail('BYTEBASE_TASK_RUN_NOT_UNIQUE')
      if (runs.length) {
        if (typeof runs[0].name !== 'string' || !runs[0].name.startsWith(`${taskId}/taskRuns/`)
          || !['PENDING', 'RUNNING', 'DONE'].includes(runs[0].status)) fail('BYTEBASE_TASK_ALREADY_RUN')
        return { taskId }
      }
      if (bundle.task.status !== 'NOT_STARTED') fail('BYTEBASE_TASK_NOT_READY')
      if (bytebaseTaskAttempts.has(operationKey)) fail('BYTEBASE_TASK_RESULT_UNKNOWN')
      bytebaseTaskAttempts.add(operationKey)
      const stage = taskId.slice(0, taskId.lastIndexOf('/tasks/'))
      await bytebaseRequest(`/v1/${stage}/tasks:batchRun`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent: stage, tasks: [taskId] }) })
      return { taskId }
    },
    async queryVerification({ project, target, sql, taskRunId, expectedChange }) {
      bytebaseTarget(project, target)
      const select = narrowVerificationSql(sql)
      let expected
      try { expected = JSON.parse(expectedChange) } catch { fail('BYTEBASE_VERIFICATION_NOT_ALLOWED') }
      if (!select || !Array.isArray(expected?.rows) || expected.rows.length < 1
        || expected.rows.length > 1000
        || expected.rows.some(row => !row || Object.keys(row).length !== 1
          || !Number.isSafeInteger(row[select.column]))
        || !/^projects\/flbn\/plans\/[A-Za-z0-9_-]+\/rollout\/stages\/[A-Za-z0-9_-]+\/tasks\/[A-Za-z0-9_-]+\/taskRuns\/[A-Za-z0-9_-]+$/.test(taskRunId ?? ''))
        fail('BYTEBASE_VERIFICATION_NOT_ALLOWED')
      const taskId = taskRunId.slice(0, taskRunId.lastIndexOf('/taskRuns/'))
      const planId = taskId.slice(0, taskId.indexOf('/rollout/'))
      const plan = await bytebaseRequest(`/v1/${planId}`)
      const issueId = bytebaseResource(project, plan?.issue, 'issues')
      const bundle = await this.getIssueBundle({ project, issueId })
      if (bundle.task?.id !== taskId || bundle.sheet.target.database !== target.database)
        fail('BYTEBASE_VERIFICATION_TASK_CHANGED')
      const taskExecution = await this.getTaskExecution({ project, issueId, taskId })
      if (taskExecution.task.status !== 'DONE' || taskExecution.taskRun?.id !== taskRunId
        || taskExecution.taskRun.status !== 'DONE') fail('BYTEBASE_TASK_RUN_UNCONFIRMED')
      const body = await bytebaseRequest(`/v1/${target.database}:query`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: target.database, statement: sql, limit: expected.rows.length + 1 }) })
      const result = body?.results?.[0]
      if (body?.results?.length !== 1 || result.error || result.columnNames?.length !== 1
        || result.columnNames[0] !== select.column || result.rows?.length !== expected.rows.length
        || result.rows.some(row => row.values?.length !== 1)) fail('BYTEBASE_VERIFICATION_UNCONFIRMED')
      const observedRows = result.rows.map(row => {
        const value = row.values[0]
        const observed = Number(value.int32Value ?? value.int64Value)
        if (!Number.isSafeInteger(observed)) fail('BYTEBASE_VERIFICATION_UNCONFIRMED')
        return { [select.column]: observed }
      })
      if (JSON.stringify(observedRows) !== JSON.stringify(expected.rows))
        fail('BYTEBASE_VERIFICATION_UNCONFIRMED')
      return { passed: true, target, packageDigest: bundle.issue.packageDigest,
        observedChange: JSON.stringify(observedRows),
        readbackId: evidence('bytebase-verification', `${taskRunId}:${executionDigest(result.rows)}`) }
    },
  }
  return { github, woodpecker, kubernetes, registry,
    attestations: attestations?.read ? { read: attestations.read } : {}, bytebase }
}
