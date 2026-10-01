import { readFile, writeFile, mkdir, copyFile, constants } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

const root = 'D:/dsh_home/workflows/runtime-v2/local-acceptance'
const runtimePath = `${root}/uat2-runtime.json`
const runtime = JSON.parse(await readFile(runtimePath, 'utf8'))
if (runtime.uatEnvironment !== 'uat2') throw new Error('UAT2 configuration required')
const scripts = ['local-acceptance-project.mjs', 'local-acceptance-readonly.mjs']
const source = await Promise.all(scripts.map(name => readFile(resolve('scripts', name))))
const digest = createHash('sha256').update(Buffer.concat(source)).digest('hex')
const toolsDirectory = `${root}/tools/${digest}`
await mkdir(toolsDirectory, { recursive: true })
for (let i = 0; i < scripts.length; i++) {
  const path = `${toolsDirectory}/${scripts[i]}`
  try { await writeFile(path, source[i], { flag: 'wx' }) } catch (error) { if (error.code !== 'EEXIST' || !source[i].equals(await readFile(path))) throw error }
}
const jarSource = 'D:/project/worktrees/dataset-uat2-local-acceptance/target/jimudataset.jar'
const jarDigest = createHash('sha256').update(await readFile(jarSource)).digest('hex')
const artifactDirectory = `${root}/artifacts/${jarDigest}`
await mkdir(artifactDirectory, { recursive: true })
const jar = `${artifactDirectory}/jimudataset.jar`
try { await copyFile(jarSource, jar, constants.COPYFILE_EXCL) } catch (error) { if (error.code !== 'EEXIST') throw error }
if (createHash('sha256').update(await readFile(jar)).digest('hex') !== jarDigest) throw new Error('artifact mismatch')
const profilePath = `${root}/shared-uat/profile.json`
const profile = JSON.stringify({ environment: 'uat', env: { JAVA_HOME: 'D:/soft/jdk-11.0.2' } })
try { await writeFile(profilePath, profile, { flag: 'wx' }) } catch (error) { if (error.code !== 'EEXIST' || await readFile(profilePath, 'utf8') !== profile) throw error }
const command = (file, mode) => ({ executable: runtime.nodeExecutable, args: ['--openssl-legacy-provider', `${toolsDirectory}/${file}`, mode, '--config', runtimePath] })
const java = artifact => ({ executable: runtime.javaExecutable, args: ['-jar', artifact, '--spring.profiles.active=local', `--spring.config.additional-location=file:${runtime.externalSpringConfigDirectory}`, '--server.address=127.0.0.1', '--server.port={port}', '--app.background-jobs.enabled=false'], readyPath: '/ready' })
const common = { version: `uat2-readonly-${digest.slice(0, 12)}`, sharedDataProfilePath: profilePath, cleanup: command(scripts[1], 'cleanup'), verifyCleanup: command(scripts[1], 'verify-cleanup') }
const boundary = '仅限用户明确指定 UAT2 的本地验收。当前支持只读查询/页面读取，不创建业务测试数据；写入、合并计算、删除等要求须有对应真实验收场景，不可用登录页或通用查询代替。场景实际结果须与任务验收条件逐项对应；无法覆盖时停止并说明缺失场景。'
const bundle = {
  dataset: { ...common, instructions: `${boundary} 本地服务必须保留真实鉴权，使用local profile。候选源码须具备app.background-jobs.enabled总开关，关闭后台任务与Redis消费，黑名单仅保留启动时只读加载；缺失时须将用户已批准的本地验收模式一并纳入修改方案，不能在冻结候选后补代码。`, prepareSteps: [command(scripts[0], 'prepare-dataset')], service: java('target/jimudataset.jar'), scenarios: [{ ...command(scripts[1], 'api'), id: 'uat-readonly-api', description: '真实UAT2登录后查询本地候选。parameters={endpoint:units|drafts|workspace,body:请求对象,projections:[{name,path:字段路径数组,op:value|type|count|nonempty}]}；actual为这些真实字段的JSON。仅支持只读查询，不支持写入功能验收。' }] },
  'dataset-web': { ...common, instructions: `${boundary} 浏览器访问本地候选前端，/api/dataset代理到本次自动启动并校验SHA的本地后端，SSO使用UAT2。后端伴随产物基于UAT2提交9101283277add9fd34fa85f302420c0fd718ba3a，后端功能变更需另行更新绑定产物。`, prepareSteps: [command(scripts[0], 'prepare-web')], service: { ...command(scripts[0], 'serve-web'), args: [...command(scripts[0], 'serve-web').args, '--host', '127.0.0.1', '--port', '{port}'], readyPath: '/login' }, companionServices: [{ id: 'dataset', ...java(jar), artifactPath: jar, artifactSha256: jarDigest }], scenarios: [{ ...command(scripts[1], 'browser'), id: 'uat-readonly-browser', description: '独立Edge读取真实本地页面，校验本地后端origin/SHA。parameters={path:站内路径,selector:CSS选择器,read:text|count|visible,authenticate:布尔值}；actual为实际DOM值。只允许单位/草稿/工作区查询和当前用户读取，其他业务请求阻断，不支持写入验收。' }] },
}
const bundleContent = JSON.stringify(bundle, null, 2)
const bundleDigest = createHash('sha256').update(bundleContent).digest('hex')
const bundlePath = `${root}/projects-${bundleDigest.slice(0, 12)}.json`
try { await writeFile(bundlePath, bundleContent, { flag: 'wx' }) } catch (error) { if (error.code !== 'EEXIST' || await readFile(bundlePath, 'utf8') !== bundleContent) throw error }
console.log(JSON.stringify({ bundlePath, toolsDirectory, jarDigest }))
