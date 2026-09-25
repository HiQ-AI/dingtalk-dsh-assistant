import { stat, readFile } from 'node:fs/promises'
import { resolve, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { execFile as execFileCallback } from 'node:child_process'
import { createPlatformClients } from './workflow-platform-clients.js'
import { createUatPostgresHost } from './workflow-postgres-uat-host.js'
import { createProductionPostgresHost } from './workflow-postgres-production-host.js'

const execFile = promisify(execFileCallback)

export const name = 'dingtalk-task-workflow-platform-clients'

/** 凭据在 Host 进程内闭包持有；不得放入 profile YAML、工作流配置或执行账。 */
export async function createHostPlatformClients({ secretsDirectory, productionTagWritesEnabled = false,
  uatPostgres, productionPostgres,
  statImpl = stat, readFileImpl = readFile, execFileImpl = execFile,
  createClients = createPlatformClients, createUatPostgres = createUatPostgresHost,
  createProductionPostgres = createProductionPostgresHost,
  loadPostgres = () => import('pg') } = {}) {
  if (!isAbsolute(secretsDirectory ?? '')) throw new Error('platform_secrets_directory_absolute_required')
  const root = resolve(secretsDirectory)
  const kubeconfig = join(root, 'k3s', 'kubeconfig-uat.yml')
  const productionKubeconfig = join(root, 'k3s', 'kubeconfig-prod.yml')
  const kubeServer = 'https://192.168.8.8:6443'
  let woodpeckerToken, githubToken
  try {
    const kubeInfo = await statImpl(kubeconfig)
    const productionKubeInfo = await statImpl(productionKubeconfig)
    if (!kubeInfo.isFile() || !productionKubeInfo.isFile()) throw Error('invalid')
    const secret = await execFileImpl('kubectl', ['--kubeconfig', kubeconfig,
      '--server', kubeServer, '--insecure-skip-tls-verify', '--request-timeout=15s',
      '-n', 'db-dev', 'get', 'secret', 'woodpecker-poller-credentials', '-o', 'json'],
    { timeout: 20000, maxBuffer: 1024 * 1024 })
    const encoded = JSON.parse(secret.stdout)?.data?.WOODPECKER_TOKEN
    if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw Error('invalid')
    woodpeckerToken = Buffer.from(encoded, 'base64').toString('utf8')
    if (!woodpeckerToken || /\s/.test(woodpeckerToken)) throw Error('invalid')
    const result = await execFileImpl('gh', ['auth', 'token'], { timeout: 15000, maxBuffer: 8192 })
    githubToken = result.stdout.trim()
    if (!githubToken || /\s/.test(githubToken)) throw Error('invalid')
    await execFileImpl('docker', ['buildx', 'version'], { timeout: 15000, maxBuffer: 8192 })
  } catch {
    // 不传播 CLI/文件异常，可能包含服务端响应或凭据片段。
    throw new Error('platform_local_credentials_unavailable')
  }
  const uat = createClients({ githubToken, woodpeckerToken, kubeconfig,
    kubeServer, kubeSkipTlsVerify: true, registryDockerCliEnabled: true,
    githubTagWritesEnabled: productionTagWritesEnabled })
  const production = createClients({ kubeconfig: productionKubeconfig })
  let bytebase
  try {
    const credentials = JSON.parse(await readFileImpl(join(root, 'bytebase.json'), 'utf8'))
    if (typeof credentials?.username !== 'string' || !credentials.username
      || typeof credentials?.password !== 'string' || !credentials.password) throw Error('invalid')
    bytebase = createClients({ bytebaseBaseUrl: 'https://bytebase.hiqdat.dev',
      bytebaseCredentials: { username: credentials.username, password: credentials.password } }).bytebase
  } catch {
    // Bytebase 凭据缺失时保持数据变更不可注册；发布客户端仍可独立工作。
  }
  let uatPostgresPlatform
  if (uatPostgres !== undefined) {
    const configured = uatPostgres?.targets
    if (!Array.isArray(configured) || configured.length !== 3
      || !isAbsolute(uatPostgres.receiptDbPath ?? ''))
      throw new Error('platform_uat_postgres_config_invalid')
    try {
      const saved = JSON.parse(await readFileImpl(join(root, 'db-credentials.json'), 'utf8'))
      const credential = saved?.connections?.hiq_editor_uat
      if (!credential || credential.host !== '192.168.8.8' || Number(credential.port) !== 30770
        || typeof credential.user !== 'string' || !credential.user
        || typeof credential.password !== 'string' || !credential.password)
        throw Error('invalid')
      const entries = configured.map(({ project, target }) => ({ project, target,
        connection: { host: credential.host, port: Number(credential.port),
          database: target.database, user: credential.user, password: credential.password } }))
      const { Client } = await loadPostgres()
      uatPostgresPlatform = createUatPostgres({ entries,
        receiptDbPath: uatPostgres.receiptDbPath, Client }).platform
    } catch {
      // 配置请求装配 UAT PostgreSQL 时必须失败关闭，不能留下部分可用的数据变更端口。
      throw new Error('platform_uat_postgres_unavailable')
    }
  }
  let productionPostgresPlatform
  if (productionPostgres !== undefined) {
    if (!Array.isArray(productionPostgres?.targets) || productionPostgres.targets.length !== 3)
      throw new Error('platform_production_postgres_config_invalid')
    try {
      const saved = JSON.parse(await readFileImpl(join(root, 'db-credentials.json'), 'utf8'))
      const credentialNames = { hiq_editor: 'tianyi_editor_slave',
        hiq_background_db: 'tianyi_bg_slave', hiq_admin: 'tianyi_admin_slave' }
      const entries = productionPostgres.targets.map(({ project, target }) => {
        const database = target?.database?.split('/').at(-1)
        const credential = saved?.connections?.[credentialNames[database]]
        if (!credential || credential.host !== '101.89.215.147' || Number(credential.port) !== 5432
          || credential.db !== database || typeof credential.user !== 'string' || !credential.user
          || typeof credential.password !== 'string' || !credential.password) throw Error('invalid')
        return { project, target, connection: { host: credential.host, port: 5432,
          database, user: credential.user, password: credential.password } }
      })
      const { Client } = await loadPostgres()
      productionPostgresPlatform = createProductionPostgres({ entries, Client })
    } catch {
      throw new Error('platform_production_postgres_unavailable')
    }
  }
  const kubernetesFor = namespace => {
    if (namespace === 'hiqlcd-app-prod') return production.kubernetes
    if (['hiqlcd-app-uat2', 'hiqlcd-app-uat3'].includes(namespace)) return uat.kubernetes
    throw new Error('platform_kubernetes_namespace_not_allowed')
  }
  return { release: { ...uat, kubernetes: {
    readDeployment: args => kubernetesFor(args.namespace).readDeployment(args),
    readPods: args => kubernetesFor(args.namespace).readPods(args),
    readEntry: args => uat.kubernetes.readEntry(args),
  } }, ...(bytebase ? { bytebase } : {}),
  ...(uatPostgresPlatform ? { uatPostgres: uatPostgresPlatform } : {}),
  ...(productionPostgresPlatform ? { productionPostgres: productionPostgresPlatform } : {}) }
}

export async function apply(ctx, config = {}, { createHostClients = createHostPlatformClients } = {}) {
  const clients = await createHostClients({ secretsDirectory: config.secretsDirectory,
    productionTagWritesEnabled: config.productionTagWritesEnabled === true,
    uatPostgres: config.uatPostgres, productionPostgres: config.productionPostgres })
  ctx.provide('dingtalkTaskWorkflowPlatformClients', clients)
}
