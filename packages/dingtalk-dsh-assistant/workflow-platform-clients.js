import { promisify } from 'node:util'
import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'

const execFile = promisify(execFileCallback)
const fail = code => { throw new Error(code) }
const sha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)
const evidence = (system, identity) => `${system}:${identity}`
const safePath = value => typeof value === 'string' && /^[A-Za-z0-9._/-]+$/.test(value)
const safeName = value => typeof value === 'string' && /^[A-Za-z0-9._-]+$/.test(value)
const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)

/** 只接受受信 Host 注入的凭据与固定端点；异常不透传服务端响应或认证头。 */
export function createPlatformClients({ githubToken, woodpeckerToken, kubeconfig,
  kubeServer, kubeSkipTlsVerify = false, bytebaseBaseUrl, bytebaseToken, registryBearerToken,
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
        mergeCommitSha: row.merge_commit_sha,
        evidenceRef: evidence('github-pr', `${repository}:${number}:${row.updated_at}`) }
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
  const bytebase = {
    async getDatabase({ project, target }) {
      if (!bytebaseBaseUrl?.startsWith('https://') || !bytebaseToken
        || !/^projects\/[A-Za-z0-9._-]+$/.test(project ?? '')
        || !/^instances\/[A-Za-z0-9._-]+$/.test(target?.instance ?? '')
        || !/^instances\/[A-Za-z0-9._-]+\/databases\/[A-Za-z0-9._-]+$/.test(target?.database ?? '')
        || !target.database.startsWith(`${target.instance}/databases/`)
        || !['production', 'uat'].includes(target?.environment)) fail('BYTEBASE_READ_NOT_CONFIGURED')
      const row = await request(`${bytebaseBaseUrl.replace(/\/$/, '')}/v1/${target.database}`, bytebaseToken)
      const environment = { 'environments/prod': 'production', 'environments/uat': 'uat' }[row.effectiveEnvironment]
      if (row.project !== project || row.name !== target.database
        || row.instanceResource?.name !== target.instance || environment !== target.environment)
        fail('BYTEBASE_DATABASE_IDENTITY_UNCONFIRMED')
      return { project: row.project, instance: row.instanceResource.name, database: row.name,
        environment, evidenceRef: evidence('bytebase-database',
          `${row.name}:${row.effectiveEnvironment}:${row.successfulSyncTime ?? ''}`) }
    },
  }
  return { github, woodpecker, kubernetes, registry,
    attestations: attestations?.read ? { read: attestations.read } : {}, bytebase }
}
