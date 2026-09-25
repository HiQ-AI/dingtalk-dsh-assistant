import { stat } from 'node:fs/promises'
import { resolve, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { execFile as execFileCallback } from 'node:child_process'
import { createPlatformClients } from './workflow-platform-clients.js'

const execFile = promisify(execFileCallback)

export const name = 'dingtalk-task-workflow-platform-clients'

/** 凭据在 Host 进程内闭包持有；不得放入 profile YAML、工作流配置或执行账。 */
export async function createHostPlatformClients({ secretsDirectory,
  statImpl = stat, execFileImpl = execFile, createClients = createPlatformClients } = {}) {
  if (!isAbsolute(secretsDirectory ?? '')) throw new Error('platform_secrets_directory_absolute_required')
  const root = resolve(secretsDirectory)
  const kubeconfig = join(root, 'k3s', 'kubeconfig-uat.yml')
  const kubeServer = 'https://192.168.8.8:6443'
  let woodpeckerToken, githubToken
  try {
    const kubeInfo = await statImpl(kubeconfig)
    if (!kubeInfo.isFile()) throw Error('invalid')
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
  return { release: createClients({ githubToken, woodpeckerToken, kubeconfig,
    kubeServer, kubeSkipTlsVerify: true, registryDockerCliEnabled: true }) }
}

export async function apply(ctx, config = {}, { createHostClients = createHostPlatformClients } = {}) {
  const clients = await createHostClients({ secretsDirectory: config.secretsDirectory })
  ctx.provide('dingtalkTaskWorkflowPlatformClients', clients)
}
