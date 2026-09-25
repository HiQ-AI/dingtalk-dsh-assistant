import assert from 'node:assert/strict'
import test from 'node:test'
import { createHostPlatformClients, apply } from '../packages/dingtalk-dsh-assistant/platform-host.js'

test('Host 仅从本机路径装配凭据并只提供客户端对象', async () => {
  const observed = []
  const clients = await createHostPlatformClients({ secretsDirectory: 'C:/secret-home',
    statImpl: async path => { observed.push(['stat', path]); return { isFile: () => true } },
    execFileImpl: async (name, args) => { observed.push(['exec', name, args]); return {
      stdout: name === 'kubectl' ? JSON.stringify({ data: { WOODPECKER_TOKEN: Buffer.from('wood-secret').toString('base64') } })
        : 'github-secret\n',
    } },
    createClients: args => { observed.push(['clients', Object.keys(args)]); return { github: {}, woodpecker: {} } },
  })
  assert.deepEqual(Object.keys(clients), ['release'])
  assert.deepEqual(observed[4][1].sort(), ['githubToken', 'woodpeckerToken', 'kubeconfig', 'kubeServer', 'kubeSkipTlsVerify', 'registryDockerCliEnabled'].sort())
  assert.deepEqual(observed[1][2].slice(0, 5), ['--kubeconfig', 'C:\\secret-home\\k3s\\kubeconfig-uat.yml',
    '--server', 'https://192.168.8.8:6443', '--insecure-skip-tls-verify'])
})

test('缺失或歧义凭据时拒绝装配且异常不回显内容', async () => {
  const options = { secretsDirectory: 'C:/secret-home',
    statImpl: async () => ({ isFile: () => true }), execFileImpl: async () => ({ stdout: 'test' }) }
  await assert.rejects(createHostPlatformClients({ ...options,
    execFileImpl: async () => ({ stdout: JSON.stringify({ data: {} }) }) }),
  /platform_local_credentials_unavailable/)
  await assert.rejects(createHostPlatformClients({ ...options,
    execFileImpl: async () => { throw Error('credential contents') } }), error => {
    assert.equal(error.message, 'platform_local_credentials_unavailable')
    return true
  })
})

test('Cordis apply 提供 resident 读取的固定 service 名称', async () => {
  const ctx = { provide(name, value) { this.services ??= {}; this.services[name] = value } }
  const service = { release: {} }
  await apply(ctx, { secretsDirectory: 'C:/secret-home' }, { createHostClients: async () => service })
  assert.equal(ctx.services.dingtalkTaskWorkflowPlatformClients, service)
})
