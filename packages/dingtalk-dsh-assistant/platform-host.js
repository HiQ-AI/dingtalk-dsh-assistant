import { stat, readFile } from 'node:fs/promises'
import { resolve, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { execFile as execFileCallback } from 'node:child_process'
import { createPlatformClients } from './workflow-platform-clients.js'

const execFile = promisify(execFileCallback)

export const name = 'dingtalk-task-workflow-platform-clients'

/** 凭据在 Host 进程内闭包持有；不得放入 profile YAML、工作流配置或执行账。 */
export async function createHostPlatformClients({ secretsDirectory, productionTagWritesEnabled = false,
  statImpl = stat, readFileImpl = readFile, execFileImpl = execFile,
  createClients = createPlatformClients } = {}) {
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
  const kubernetesFor = namespace => {
    if (namespace === 'hiqlcd-app-prod') return production.kubernetes
    if (['hiqlcd-app-uat2', 'hiqlcd-app-uat3'].includes(namespace)) return uat.kubernetes
    throw new Error('platform_kubernetes_namespace_not_allowed')
  }
  return { release: { ...uat, kubernetes: {
    readDeployment: args => kubernetesFor(args.namespace).readDeployment(args),
    readPods: args => kubernetesFor(args.namespace).readPods(args),
    readEntry: args => uat.kubernetes.readEntry(args),
  } }, ...(bytebase ? { bytebase } : {}) }
}

export async function apply(ctx, config = {}, { createHostClients = createHostPlatformClients } = {}) {
  const clients = await createHostClients({ secretsDirectory: config.secretsDirectory,
    productionTagWritesEnabled: config.productionTagWritesEnabled === true })
  ctx.provide('dingtalkTaskWorkflowPlatformClients', clients)
}
