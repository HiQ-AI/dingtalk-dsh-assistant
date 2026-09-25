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
    createClients: args => { observed.push(['clients', Object.keys(args)]); return { github: {}, woodpecker: {},
      kubernetes: { readDeployment: () => {}, readPods: () => {}, readEntry: () => {} } } },
  })
  assert.deepEqual(Object.keys(clients), ['release'])
  assert.deepEqual(observed[5][1].sort(), ['githubToken', 'woodpeckerToken', 'kubeconfig', 'kubeServer', 'kubeSkipTlsVerify', 'registryDockerCliEnabled', 'githubTagWritesEnabled'].sort())
  assert.deepEqual(observed[6][1], ['kubeconfig'])
  assert.deepEqual(observed[2][2].slice(0, 5), ['--kubeconfig', 'C:\\secret-home\\k3s\\kubeconfig-uat.yml',
    '--server', 'https://192.168.8.8:6443', '--insecure-skip-tls-verify'])
})

test('生产与 UAT 的 Kubernetes 身份按固定命名空间选择且默认不启用 Tag 写入', async () => {
  const observed = []
  const service = await createHostPlatformClients({ secretsDirectory: 'C:/secret-home',
    statImpl: async () => ({ isFile: () => true }),
    execFileImpl: async name => ({ stdout: name === 'kubectl'
      ? JSON.stringify({ data: { WOODPECKER_TOKEN: Buffer.from('wood-secret').toString('base64') } }) : 'github-secret' }),
    createClients: args => {
      observed.push(args)
      const identity = args.kubeServer ? 'uat' : 'prod'
      return { github: {}, woodpecker: {}, kubernetes: {
        readDeployment: async () => identity,
        readPods: async () => identity,
        readEntry: async () => identity,
      } }
    },
  })
  assert.equal(observed[0].githubTagWritesEnabled, false)
  assert.equal(await service.release.kubernetes.readDeployment({ namespace: 'hiqlcd-app-prod' }), 'prod')
  assert.equal(await service.release.kubernetes.readPods({ namespace: 'hiqlcd-app-uat3' }), 'uat')
  assert.throws(() => service.release.kubernetes.readDeployment({ namespace: 'other' }),
    /platform_kubernetes_namespace_not_allowed/)
})

test('Host 仅从本机 JSON 读取 Bytebase 凭据并隔离于发布客户端', async () => {
  const created = []
  const clients = await createHostPlatformClients({ secretsDirectory: 'C:/secret-home',
    statImpl: async () => ({ isFile: () => true }),
    readFileImpl: async () => JSON.stringify({ username: 'fixture-user', password: 'fixture-secret' }),
    execFileImpl: async name => ({ stdout: name === 'kubectl'
      ? JSON.stringify({ data: { WOODPECKER_TOKEN: Buffer.from('wood-secret').toString('base64') } }) : 'github-secret' }),
    createClients: args => { created.push(args); return { bytebase: { getDatabase: async () => ({}) },
      github: {}, woodpecker: {}, kubernetes: {
        readDeployment: async () => ({}), readPods: async () => ({}), readEntry: async () => ({}) } } },
  })
  assert.equal(typeof clients.bytebase.getDatabase, 'function')
  assert.equal(created.length, 3)
  assert.deepEqual(Object.keys(created[2]), ['bytebaseBaseUrl', 'bytebaseCredentials'])
  assert.equal(created[0].bytebaseCredentials, undefined)
  assert.equal(created[1].bytebaseCredentials, undefined)
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

test('Host 只用本机连接凭据装配精确三个 UAT PostgreSQL 库', async () => {
  const target = database => ({ instance: 'postgresql/192.168.8.8:30770', database, environment: 'uat' })
  const observed = []
  const clients = await createHostPlatformClients({ secretsDirectory: 'C:/secret-home',
    uatPostgres: { receiptDbPath: 'C:/state/uat-receipts.sqlite',
      targets: ['hiq_editor', 'hiq_background_db', 'hiq_admin']
        .map(database => ({ project: 'projects/flbn', target: target(database) })) },
    statImpl: async () => ({ isFile: () => true }),
    readFileImpl: async path => path.endsWith('db-credentials.json')
      ? JSON.stringify({ connections: { hiq_editor_uat: {
        host: '192.168.8.8', port: 30770, user: 'fixture', password: 'secret' } } })
      : '{}',
    execFileImpl: async name => ({ stdout: name === 'kubectl'
      ? JSON.stringify({ data: { WOODPECKER_TOKEN: Buffer.from('wood-secret').toString('base64') } })
      : 'github-secret' }),
    createClients: () => ({ kubernetes: { readDeployment() {}, readPods() {}, readEntry() {} } }),
    loadPostgres: async () => ({ Client: class {} }),
    createUatPostgres: args => { observed.push(args); return { platform: { getDatabase() {} } } },
  })
  assert.equal(typeof clients.uatPostgres.getDatabase, 'function')
  assert.deepEqual(observed[0].entries.map(entry => entry.target.database),
    ['hiq_editor', 'hiq_background_db', 'hiq_admin'])
  assert.equal(observed[0].entries.every(entry => entry.connection.password === 'secret'), true)
  assert.equal('password' in clients.uatPostgres, false)
})

test('Host 将三个 Bytebase 生产目标分别绑定天翼云只读从库凭据', async () => {
  const databases = ['hiq_editor', 'hiq_background_db', 'hiq_admin']
  const observed = []
  const clients = await createHostPlatformClients({ secretsDirectory: 'C:/secret-home',
    productionPostgres: { targets: databases.map(database => ({ project: 'projects/flbn',
      target: { instance: 'instances/flbnpguaf',
        database: `instances/flbnpguaf/databases/${database}`, environment: 'production' } })) },
    statImpl: async () => ({ isFile: () => true }),
    readFileImpl: async path => path.endsWith('db-credentials.json')
      ? JSON.stringify({ connections: Object.fromEntries([
        ['tianyi_editor_slave', 'hiq_editor'], ['tianyi_bg_slave', 'hiq_background_db'],
        ['tianyi_admin_slave', 'hiq_admin']].map(([key, db]) => [key, {
        host: '101.89.215.147', port: 5432, db, user: `user-${db}`, password: `secret-${db}` }])) })
      : '{}',
    execFileImpl: async name => ({ stdout: name === 'kubectl'
      ? JSON.stringify({ data: { WOODPECKER_TOKEN: Buffer.from('wood-secret').toString('base64') } })
      : 'github-secret' }),
    createClients: () => ({ kubernetes: { readDeployment() {}, readPods() {}, readEntry() {} } }),
    loadPostgres: async () => ({ Client: class {} }),
    createProductionPostgres: args => { observed.push(args); return { getDatabase() {} } },
  })
  assert.equal(typeof clients.productionPostgres.getDatabase, 'function')
  assert.deepEqual(observed[0].entries.map(entry => entry.connection.database), databases)
  assert.deepEqual(observed[0].entries.map(entry => entry.connection.user), databases.map(db => `user-${db}`))
  assert.equal('password' in clients.productionPostgres, false)
})
