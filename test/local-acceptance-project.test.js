import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises'
import { join, dirname, basename, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { parseArguments, readConfiguration, validateContext, proxyConfiguration, datasetArguments } from '../scripts/local-acceptance-project.mjs'

const companionPath = fileURLToPath(new URL('../docs/tmp/task-unified-file-storage/release-1.0.0/spring-fixture/local-acceptance-spring.jar', import.meta.url))
const companionArtifact = { path: companionPath, sha256: createHash('sha256').update(await readFile(companionPath)).digest('hex') }
const javaExecutable = join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
const script = fileURLToPath(new URL('../scripts/local-acceptance-project.mjs', import.meta.url))
const context = { namespace: 'fixture-uat2', uatEnvironment: 'uat2', baseUrl: 'http://127.0.0.1:19999', plan: { cases: [] },
  services: { dataset: { baseUrl: 'http://127.0.0.1:19998', artifactSha256: 'a'.repeat(64) } } }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'project-acceptance-test-')), cwd = join(root, 'candidate')
  t.after(async () => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('project-acceptance-test-')); await rm(root, { recursive: true, force: true, maxRetries: 3 }) })
  const mavenHome = join(root, 'maven'), externalSpringConfigDirectory = join(root, 'spring'), yarnCli = join(root, 'yarn.cjs'), configPath = join(root, 'host.json')
  for (const path of [cwd, join(mavenHome, 'boot'), join(mavenHome, 'bin'), externalSpringConfigDirectory]) await mkdir(path, { recursive: true })
  await writeFile(join(mavenHome, 'boot/plexus-classworlds-2.7.0.jar'), 'fixture')
  await writeFile(join(mavenHome, 'bin/m2.conf'), 'fixture')
  const trace = join(root, 'trace.jsonl')
  await writeFile(yarnCli, `require('fs').appendFileSync(${JSON.stringify(trace)},JSON.stringify(process.argv.slice(2))+'\\n'); console.log('x'.repeat(70000));`)
  await writeFile(join(cwd, 'package.json'), '{}'); await writeFile(join(cwd, 'yarn.lock'), '# fixture')
  const config = { uatEnvironment: 'uat2', javaExecutable: process.execPath, nodeExecutable: process.execPath, yarnCli, mavenHome, externalSpringConfigDirectory, ssoOrigin: 'https://uat2.example.invalid' }
  await writeFile(configPath, JSON.stringify(config))
  return { root, cwd, configPath, config, trace }
}
async function execute(executable, args, cwd, payload) {
  const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''; child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
  child.stdin.end(JSON.stringify(payload))
  const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit) })
  return { code, stdout, stderr }
}
test('入口只接受固定命令、明确配置的UAT及受控回环伴随后端，不猜环境', async t => {
  const f = await fixture(t)
  assert.equal(parseArguments(['serve-web', '--config', f.configPath, '--host', '127.0.0.1', '--port', '20001']).port, '20001')
  assert.throws(() => parseArguments(['serve-web', '--config', f.configPath, '--host', '0.0.0.0', '--port', '20001']), { code: 'PROJECT_ARGUMENT_INVALID' })
  assert.throws(() => parseArguments(['prepare-web', '--config', f.configPath, '--anything', ';rm']), { code: 'PROJECT_ARGUMENT_INVALID' })
  assert.throws(() => validateContext({ ...context, uatEnvironment: 'uat1' }, 'uat2'), { code: 'PROJECT_CONTEXT_INVALID' })
  assert.throws(() => validateContext(context), { code: 'PROJECT_CONTEXT_INVALID' })
  assert.throws(() => validateContext({ ...context, uatEnvironment: 'uat10' }, 'uat10'), { code: 'PROJECT_CONTEXT_INVALID' })
  assert.equal(validateContext({ ...context, uatEnvironment: 'uat3' }, 'uat3').uatEnvironment, 'uat3')
  assert.throws(() => proxyConfiguration(f.config, { ...context, services: undefined }), { code: 'PROJECT_LOCAL_BACKEND_REQUIRED' })
  assert.throws(() => proxyConfiguration(f.config, { ...context, services: { dataset: { ...context.services.dataset, baseUrl: 'https://uat2.example.invalid' } } }), { code: 'PROJECT_ORIGIN_INVALID' })
  assert.deepEqual(JSON.parse(proxyConfiguration(f.config, context)), [['/api/dataset', 'http://127.0.0.1:19998', ''], ['/set/api', 'http://127.0.0.1:19998', ''], ['/api/sso', 'https://uat2.example.invalid']])
  const localConfig = join(f.cwd, 'host.json'); await writeFile(localConfig, JSON.stringify(f.config))
  await assert.rejects(readConfiguration(localConfig, f.cwd), { code: 'PROJECT_CONFIG_LOCATION_INVALID' })
})
test('后端UAT3配置独立读取，执行环境不符在运行命令前拒绝', async t => {
  const f = await fixture(t)
  await writeFile(f.configPath, JSON.stringify({ ...f.config, uatEnvironment: 'uat3', ssoOrigin: 'https://uat3.example.invalid' }))
  assert.equal((await readConfiguration(f.configPath, f.cwd)).uatEnvironment, 'uat3')
  const result = await execute(process.execPath, [script, 'prepare-web', '--config', f.configPath], f.cwd, context)
  assert.equal(result.code, 1)
  assert.match(result.stderr, /PROJECT_CONTEXT_INVALID/)
  await assert.rejects(readFile(f.trace), { code: 'ENOENT' })
})
test('真实Spring夹具伴随JAR后台关闭无效，准备阶段阻断且未安装依赖', async t => {
  const f = await fixture(t)
  await writeFile(f.configPath, JSON.stringify({ ...f.config, javaExecutable, companionArtifact }))
  const result = await execute(process.execPath, [script, 'prepare-web', '--config', f.configPath], f.cwd, context)
  assert.equal(result.code, 1); assert.match(result.stderr, /PROJECT_COMMAND_FAILED/)
  await assert.rejects(readFile(f.trace), { code: 'ENOENT' })
  const logs = join(f.root, 'logs', context.namespace), files = await readdir(logs)
  const probe = files.find(name => name.startsWith('background-probe-'))
  assert.match(await readFile(join(logs, probe, 'probe.log'), 'utf8'), /CONTROLLED_BEAN_MODE_INVALID:false:\[com.ecdigit.ecdata.task.ApprovalNotificationOutboxTask\]/)
})

test('后端准备逐项要求后台写入开关，再构造固定Java/Maven argv', async t => {
  const f = await fixture(t); await writeFile(join(f.cwd, 'pom.xml'), '<project/>')
  const files = ['com/ecdigit/ecdata/task/ApprovalReminderTask.java', 'com/ecdigit/ecdata/task/DataQualityReportTask.java', 'com/ecdigit/ecdata/task/DatasourceVersionCalculateTask.java', 'com/ecdigit/ecdata/task/VersionDiffReportTimeoutTask.java', 'com/hiqdata/convertor/domain/task/reconcile/TaskReconciler.java', 'com/ecdigit/ecdata/config/RedisStreamConsumerConfig.java', 'com/ecdigit/ecdata/controller/internal/ApprovalReminderDebugController.java', 'com/ecdigit/ecdata/service/BlacklistCacheService.java']
  for (const file of files) {
    const path = join(f.cwd, 'src/main/java', file); await mkdir(dirname(path), { recursive: true })
    await writeFile(path, file.includes('BlacklistCache') ? '${app.background-jobs.enabled:true}' : '@ConditionalOnProperty(name = "app.background-jobs.enabled", havingValue = "true", matchIfMissing = true)')
  }
  const args = await datasetArguments(f.config, f.cwd)
  assert.deepEqual(args.slice(-4), ['-DskipTests', '-DskipJarEncryption', 'package', '-q'])
  assert.equal(args[5], 'org.codehaus.plexus.classworlds.launcher.Launcher')
  await writeFile(join(f.cwd, 'src/main/java', files[0]), 'class MissingControl {}')
  await assert.rejects(datasetArguments(f.config, f.cwd), { code: 'PROJECT_BACKGROUND_CONTROL_REQUIRED' })
})
test('serve-web同进程启动VueCLI并覆盖传入环境中的UAT1代理', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const f = await fixture(t), node22 = process.env.NODE22_EXECUTABLE
  f.config.nodeExecutable = node22; await writeFile(f.configPath, JSON.stringify(f.config))
  const cli = join(f.cwd, 'node_modules/@vue/cli-service/bin/vue-cli-service.js'); await mkdir(dirname(cli), { recursive: true })
  await writeFile(join(f.cwd, 'vue.config.js'), `module.exports={devServer:{proxy:{'/api/dataset':{target:JSON.parse(process.env.LOCAL_HTTP_API_PROXY)[0][1],onProxyRes(response){response.headers['original-hook']='kept'}}}}}`)
  await writeFile(cli, `const devServer=require(process.cwd()+'/vue.config.js').devServer,proxy=devServer.proxy['/api/dataset'];const response={headers:{}};proxy.onProxyRes(response);require('http').createServer((req,res)=>res.end(JSON.stringify({pid:process.pid,args:process.argv.slice(2),proxy:JSON.parse(process.env.LOCAL_HTTP_API_PROXY),headers:response.headers,nodeEnv:process.env.NODE_ENV,hot:devServer.hot,liveReload:devServer.liveReload}))).listen(Number(process.argv.at(-1)),'127.0.0.1');`)
  const probe = createServer(); await new Promise(resolveListen => probe.listen(0, '127.0.0.1', resolveListen)); const port = probe.address().port; await new Promise(resolveClose => probe.close(resolveClose))
  const child = spawn(node22, ['--openssl-legacy-provider', script, 'serve-web', '--config', f.configPath, '--host', '127.0.0.1', '--port', String(port)],
    { cwd: f.cwd, env: { ...process.env, HTTP_API_PROXY: 'uat1', LOCAL_HTTP_API_PROXY: 'uat1' }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let exited = false; const completion = new Promise(resolveExit => child.once('exit', () => { exited = true; resolveExit() }))
  child.stdin.end(JSON.stringify({ ...context, baseUrl: `http://127.0.0.1:${port}` }))
  try {
    let result
    for (let i = 0; i < 60 && !exited; i++) { try { result = await (await fetch(`http://127.0.0.1:${port}`)).json(); break } catch { await new Promise(resolveWait => setTimeout(resolveWait, 100)) } }
    assert.equal(result?.pid, child.pid)
    assert.deepEqual(result.args, ['serve', '--host', '127.0.0.1', '--port', String(port)])
    assert.equal(result.proxy[0][1], context.services.dataset.baseUrl)
    assert.equal(result.headers['original-hook'], 'kept')
    assert.equal(result.headers['x-local-acceptance-dataset-origin'], context.services.dataset.baseUrl)
    assert.equal(result.headers['x-local-acceptance-dataset-sha256'], context.services.dataset.artifactSha256)
    assert.equal(result.nodeEnv, 'production'); assert.equal(result.hot, false); assert.equal(result.liveReload, false)
    assert.ok(!JSON.stringify(result).includes('uat1'))
  } finally { if (!exited) child.kill(); await completion }
})

test('前端缺少伴随身份或SHA错误时，在依赖安装前失败', async t => {
 for (const artifact of [undefined, { ...companionArtifact, sha256: '0'.repeat(64) }]) {
  const f = await fixture(t)
  await writeFile(f.configPath, JSON.stringify({ ...f.config, javaExecutable, companionArtifact: artifact }))
  const result = await execute(process.execPath, [script, 'prepare-web', '--config', f.configPath], f.cwd, context)
  assert.equal(result.code, 1); assert.match(result.stderr, /PROJECT_COMPANION_IDENTITY_(REQUIRED|INVALID)/)
  await assert.rejects(readFile(f.trace), { code: 'ENOENT' })
 }
})
