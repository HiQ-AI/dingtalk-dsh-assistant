import { promisify } from 'node:util'
import { execFile as execFileCallback } from 'node:child_process'

const execFile = promisify(execFileCallback)
const fail = code => { throw new Error(code) }
const sha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)
const evidence = (system, identity) => `${system}:${identity}`
const safePath = value => typeof value === 'string' && /^[A-Za-z0-9._/-]+$/.test(value)
const safeName = value => typeof value === 'string' && /^[A-Za-z0-9._-]+$/.test(value)

/** 只接受受信 Host 注入的凭据与固定端点；异常不透传服务端响应或认证头。 */
export function createPlatformClients({ githubToken, woodpeckerToken, kubeconfig,
  kubeServer, bytebaseBaseUrl, bytebaseToken,
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
      const row = await request(githubUrl(repository, `git/ref/tags/${encodeURIComponent(tag)}`), githubToken)
      if (row?.object?.type !== 'commit' || !sha(row.object.sha)) fail('GITHUB_TAG_UNCONFIRMED')
      return { commitSha: row.object.sha, evidenceRef: evidence('github-tag', `${repository}:${tag}:${row.object.sha}`) }
    },
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
    async readDeployment({ namespace, deployment }) {
      if (!safeName(namespace) || !safeName(deployment) || !kubeconfig) fail('KUBE_TARGET_INVALID')
      let row
      try {
        const result = await execFileImpl('kubectl', ['--kubeconfig', kubeconfig,
          ...(kubeServer ? ['--server', kubeServer] : []), '--request-timeout=15s', '-n', namespace,
          'get', 'deployment', deployment, '-o', 'json'], { maxBuffer: 1024 * 1024 })
        row = JSON.parse(result.stdout)
      } catch { fail('KUBE_DEPLOYMENT_READ_FAILED') }
      const container = row?.spec?.template?.spec?.containers?.[0]
      const status = row?.status
      return { sourceSha: row?.metadata?.annotations?.['deployment.kubernetes.io/source-sha'],
        imageDigest: container?.image?.match(/@(?<digest>sha256:[a-f0-9]{64})$/)?.groups?.digest,
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
  // 没有可核验的 source SHA / 镜像清单绑定时不提供 readManifest 能力。
  const registry = {}
  const bytebase = {
    async getDatabase({ target }) {
      if (!bytebaseBaseUrl?.startsWith('https://') || !bytebaseToken || !safePath(target?.database)) fail('BYTEBASE_READ_NOT_CONFIGURED')
      const row = await request(`${bytebaseBaseUrl.replace(/\/$/, '')}/v1/${target.database}`, bytebaseToken)
      return { project: row.project, instance: target.instance, database: row.name,
        environment: target.environment, evidenceRef: evidence('bytebase-database', `${row.name}:${row.updateTime}`) }
    },
  }
  return { github, woodpecker, kubernetes, registry,
    attestations: attestations?.read ? { read: attestations.read } : {}, bytebase }
}
