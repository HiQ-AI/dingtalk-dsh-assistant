import { spawn } from 'node:child_process'
import { readFile, realpath, lstat, mkdir, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { openSync, closeSync, writeSync } from 'node:fs'
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const fail = code => { throw Object.assign(new Error(code), { code }) }
const canonical = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
const inside = (root, path) => { const value = relative(canonical(root), canonical(path)); return !value || (!value.startsWith('..' + sep) && value !== '..' && !isAbsolute(value)) }
async function checked(path, directory = false) {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\0\r\n]/.test(path)) fail('PROJECT_PATH_INVALID')
  const meta = await lstat(path)
  if (meta.isSymbolicLink() || (directory ? !meta.isDirectory() : !meta.isFile()) || canonical(await realpath(path)) !== canonical(path)) fail('PROJECT_PATH_INVALID')
  return path
}
function origin(value, local = false) {
  let url; try { url = new URL(value) } catch { fail('PROJECT_ORIGIN_INVALID') }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || (local ? url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port : url.protocol !== 'https:')) fail('PROJECT_ORIGIN_INVALID')
  return url.origin
}
export function parseArguments(args) {
  const [command, ...rest] = args
  if (!['prepare-dataset', 'prepare-web', 'serve-web'].includes(command) || rest.length % 2) fail('PROJECT_ARGUMENT_INVALID')
  const values = {}
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]
    if (!['--config', ...(command === 'serve-web' ? ['--host', '--port'] : [])].includes(key) || Object.hasOwn(values, key)) fail('PROJECT_ARGUMENT_INVALID')
    values[key] = rest[i + 1]
  }
  if (!isAbsolute(values['--config'] ?? '')) fail('PROJECT_ARGUMENT_INVALID')
  if (command === 'serve-web' && (values['--host'] !== '127.0.0.1' || !/^\d{1,5}$/.test(values['--port'] ?? '') || Number(values['--port']) < 1024 || Number(values['--port']) > 65535)) fail('PROJECT_ARGUMENT_INVALID')
  return { command, configPath: values['--config'], port: values['--port'] }
}
export async function readConfiguration(configPath, directory) {
  await checked(configPath)
  if (inside(directory, configPath) || (await lstat(configPath)).size > 16384) fail('PROJECT_CONFIG_LOCATION_INVALID')
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  if (!/^uat[1-9]$/.test(config.uatEnvironment ?? '')) fail('PROJECT_UAT_REQUIRED')
  for (const key of ['javaExecutable', 'nodeExecutable', 'yarnCli']) await checked(config[key])
  for (const key of ['mavenHome', 'externalSpringConfigDirectory']) { await checked(config[key], true); if (inside(directory, config[key])) fail('PROJECT_CONFIG_LOCATION_INVALID') }
  config.ssoOrigin = origin(config.ssoOrigin)
  return config
}
export function validateContext(context, expectedEnvironment) {
  if (!/^uat[1-9]$/.test(expectedEnvironment ?? '') || !context || context.uatEnvironment !== expectedEnvironment || !/^[a-zA-Z0-9-]{1,96}$/.test(context.namespace ?? '') || !context.plan || !Array.isArray(context.plan.cases)) fail('PROJECT_CONTEXT_INVALID')
  origin(context.baseUrl, true)
  return context
}
export function proxyConfiguration(config, context) {
  const backend = context.services?.dataset
  if (!backend || !/^[a-f0-9]{64}$/.test(backend.artifactSha256 ?? '')) fail('PROJECT_LOCAL_BACKEND_REQUIRED')
  return JSON.stringify([['/api/dataset', origin(backend.baseUrl, true), ''], ['/set/api', origin(backend.baseUrl, true), ''], ['/api/sso', origin(config.ssoOrigin)]])
}
export async function datasetArguments(config, directory) {
  await checked(join(directory, 'pom.xml'))
  const required = [
    'com/ecdigit/ecdata/task/ApprovalReminderTask.java', 'com/ecdigit/ecdata/task/DataQualityReportTask.java',
    'com/ecdigit/ecdata/task/DatasourceVersionCalculateTask.java', 'com/ecdigit/ecdata/task/VersionDiffReportTimeoutTask.java',
    'com/hiqdata/convertor/domain/task/reconcile/TaskReconciler.java', 'com/ecdigit/ecdata/config/RedisStreamConsumerConfig.java',
    'com/ecdigit/ecdata/controller/internal/ApprovalReminderDebugController.java',
  ]
  for (const file of required) {
    const path = join(directory, 'src/main/java', file); await checked(path)
    if (!/@ConditionalOnProperty\s*\(\s*name\s*=\s*"app\.background-jobs\.enabled"\s*,\s*havingValue\s*=\s*"true"\s*,\s*matchIfMissing\s*=\s*true\s*\)/.test(await readFile(path, 'utf8'))) fail('PROJECT_BACKGROUND_CONTROL_REQUIRED')
  }
  const cachePath = join(directory, 'src/main/java/com/ecdigit/ecdata/service/BlacklistCacheService.java')
  await checked(cachePath)
  if (!(await readFile(cachePath, 'utf8')).includes('${app.background-jobs.enabled:true}')) fail('PROJECT_BACKGROUND_CONTROL_REQUIRED')
  const boot = join(config.mavenHome, 'boot'), jars = (await readdir(boot)).filter(name => /^plexus-classworlds-[a-zA-Z0-9.-]+\.jar$/.test(name))
  if (jars.length !== 1) fail('PROJECT_MAVEN_INVALID')
  const jar = join(boot, jars[0]); await checked(jar); await checked(join(config.mavenHome, 'bin/m2.conf'))
  return ['-classpath', jar, `-Dclassworlds.conf=${join(config.mavenHome, 'bin/m2.conf')}`, `-Dmaven.home=${config.mavenHome}`,
    `-Dmaven.multiModuleProjectDirectory=${directory}`, 'org.codehaus.plexus.classworlds.launcher.Launcher', '-DskipTests', '-DskipJarEncryption', 'package', '-q']
}
function run(executable, args, { directory, fd, env }) {
  return new Promise((resolveDone, reject) => {
    const child = spawn(executable, args, { cwd: directory, env, shell: false, windowsHide: true, stdio: ['ignore', fd, fd] })
    child.once('error', () => reject(Object.assign(new Error('PROJECT_COMMAND_FAILED'), { code: 'PROJECT_COMMAND_FAILED' })))
    child.once('exit', code => code === 0 ? resolveDone() : reject(Object.assign(new Error('PROJECT_COMMAND_FAILED'), { code: 'PROJECT_COMMAND_FAILED' })))
  })
}
export async function verifyBackground(config, directory, logs, env, artifact) {
  const source = fileURLToPath(new URL('./LocalAcceptanceBackground.java', import.meta.url))
  if (artifact && (!isAbsolute(artifact.path ?? '') || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? ''))) fail('PROJECT_COMPANION_IDENTITY_INVALID')
  const jar = artifact?.path ?? join(directory, 'target/jimudataset.jar'), javac = join(dirname(config.javaExecutable), process.platform === 'win32' ? 'javac.exe' : 'javac')
  for (const path of [source, jar, javac]) await checked(path)
  const sha = async path => createHash('sha256').update(await readFile(path)).digest('hex')
  const jarSha256 = await sha(jar), probeSha256 = await sha(source)
  if (artifact && jarSha256 !== artifact.sha256) fail('PROJECT_COMPANION_IDENTITY_INVALID')
  const classes = join(logs, `background-probe-${process.pid}`)
  await mkdir(classes, { recursive: false, mode: 0o700 })
  const output = join(classes, 'probe.log'), fd = openSync(output, 'wx', 0o600)
  try {
    await run(javac, ['-encoding', 'UTF-8', '-d', classes, source], { directory, fd, env })
    await run(config.javaExecutable, [`-Dloader.path=${classes}`, '-Dloader.main=LocalAcceptanceBackground', '-cp', jar,
      'org.springframework.boot.loader.PropertiesLauncher', jar], { directory, fd, env })
  } finally { closeSync(fd) }
  const markers = (await readFile(output, 'utf8')).split(/\r?\n/).filter(line => line.startsWith('HOST_BACKGROUND_PROOF:'))
  if (markers.length !== 1 || await sha(jar) !== jarSha256 || await sha(source) !== probeSha256) fail('PROJECT_BACKGROUND_PROOF_INVALID')
  const result = JSON.parse(markers[0].slice('HOST_BACKGROUND_PROOF:'.length))
  if (typeof result.outboxPresent !== 'boolean' || result.disabledBeans !== (result.outboxPresent ? 8 : 7) || result.initialReads !== 1 || result.disabledScheduledReads !== 0 || result.normalModesVerified !== true || !(result.scannedClasses > 0)) fail('PROJECT_BACKGROUND_PROOF_INVALID')
  const proof = { version: 1, jarSha256, probeSha256, ...result }
  await writeFile(join(classes, 'proof.json'), JSON.stringify(proof), { flag: 'wx', mode: 0o600 })
  return proof
}
export async function main(args = process.argv.slice(2), input = process.stdin, directory = process.cwd()) {
  const parsed = parseArguments(args), config = await readConfiguration(parsed.configPath, directory)
  let raw = ''; for await (const chunk of input) { raw += chunk; if (Buffer.byteLength(raw) > 65536) fail('PROJECT_CONTEXT_INVALID') }
  const context = validateContext(JSON.parse(raw), config.uatEnvironment)
  if (context.evidenceRoot !== undefined && !isAbsolute(context.evidenceRoot)) fail('PROJECT_CONTEXT_INVALID')
  const logs = join(context.evidenceRoot ?? join(dirname(parsed.configPath), 'logs'), context.namespace)
  await mkdir(logs, { recursive: true, mode: 0o700 }); await checked(logs, true)
  const fd = openSync(join(logs, `${parsed.command}-${process.pid}.log`), 'wx', 0o600)
  const env = { ...process.env, NODE_OPTIONS: '--openssl-legacy-provider', NODE_ENV: 'development', YARN_PRODUCTION: 'false' }
  delete env.HTTP_API_PROXY; delete env.LOCAL_HTTP_API_PROXY; delete env.VUE_CLI_CONTEXT
  if (parsed.command === 'serve-web') {
    if (canonical(process.execPath) !== canonical(config.nodeExecutable) || process.versions.node.split('.')[0] !== '22'
      || !process.execArgv.includes('--openssl-legacy-provider')) fail('PROJECT_NODE22_REQUIRED')
    env.LOCAL_HTTP_API_PROXY = proxyConfiguration(config, context)
    // Vue CLI 4 在非 production 模式会自行注入 websocket 客户端，单独 hot:false 不足以关闭。
    env.NODE_ENV = 'production'
    Object.assign(process.env, env); delete process.env.HTTP_API_PROXY; delete process.env.VUE_CLI_CONTEXT
    const cli = join(directory, 'node_modules/@vue/cli-service/bin/vue-cli-service.js'); await checked(cli)
    const redirect = (chunk, encoding, callback) => { writeSync(fd, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined)); (typeof encoding === 'function' ? encoding : callback)?.(); return true }
    process.stdout.write = redirect; process.stderr.write = redirect
    const require = createRequire(import.meta.url), vueConfigPath = join(directory, 'vue.config.js'); await checked(vueConfigPath)
    const vueConfig = require(vueConfigPath), datasetProxy = vueConfig.devServer?.proxy?.['/api/dataset'], backend = context.services.dataset
    if (!datasetProxy || datasetProxy.target !== origin(backend.baseUrl, true)) fail('PROJECT_PROXY_BINDING_INVALID')
    Object.assign(vueConfig.devServer, { hot: false, hotOnly: false, injectClient: false, liveReload: false })
    const previous = datasetProxy.onProxyRes
    datasetProxy.onProxyRes = function (response, ...args) {
      previous?.call(this, response, ...args)
      response.headers['x-local-acceptance-dataset-origin'] = backend.baseUrl
      response.headers['x-local-acceptance-dataset-sha256'] = backend.artifactSha256
    }
    // 同进程加载 Vue CLI，确保监听端口归属于 runner 启动的 PID。
    process.argv = [process.execPath, cli, 'serve', '--host', '127.0.0.1', '--port', parsed.port]
    require(cli)
    return
  }
  let backgroundProof
  try {
    if (parsed.command === 'prepare-dataset') {
      await run(config.javaExecutable, await datasetArguments(config, directory), { directory, fd, env })
      backgroundProof = await verifyBackground(config, directory, logs, env)
    }
    else {
      if (!config.companionArtifact) fail('PROJECT_COMPANION_IDENTITY_REQUIRED')
      backgroundProof = await verifyBackground(config, directory, logs, env, config.companionArtifact)
      await checked(join(directory, 'package.json')); await checked(join(directory, 'yarn.lock'))
      // 构建检查已在 verify-candidate 执行；新目录只安装冻结依赖，serve-web 编译当前候选。
      await run(config.nodeExecutable, ['--openssl-legacy-provider', config.yarnCli, 'install', '--frozen-lockfile'], { directory, fd, env })
    }
  } finally { closeSync(fd) }
  process.stdout.write(JSON.stringify({ phase: parsed.command, passed: true, ...(backgroundProof ? { backgroundProof } : {}) }) + '\n')
}
if (process.argv[1] && canonical(fileURLToPath(import.meta.url)) === canonical(process.argv[1])) main().catch(error => {
  process.stderr.write(JSON.stringify({ error: /^PROJECT_[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'PROJECT_FAILED' }) + '\n'); process.exitCode = 1
})
