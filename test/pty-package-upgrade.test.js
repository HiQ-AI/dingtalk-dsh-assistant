import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { upgradePty } from '../scripts/pty-package-upgrade.mjs'
const hash = value => createHash('sha256').update(value).digest('hex')
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pty-upgrade-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const profile = join(root, 'profile'); mkdirSync(profile)
  const manifest = { dependencies: { '@deepseek-ai/dsh': 'unchanged' }, pnpm: { overrides: { unrelated: 'keep' } } }
  const bytes = JSON.stringify(manifest); writeFileSync(join(profile, 'package.json'), bytes)
  const specs = [ ['@deepseek-ai/dsh-subprocess-local','0.2.1-rc.2.pty.2',['lib/index.js']], ['node-pty','1.2.0-beta.15.dsh.2',['lib/windowsPtyAgent.js','lib/windowsTerminal.js','lib/unixTerminal.js']] ]
  const packages = specs.map(([name, version, files], i) => {
    const dir = join(root, `pack${i}`), content = join(dir,'package'); mkdirSync(join(content,'lib'), {recursive:true})
    const meta = {name,version,main:'lib/index.js',exports:{'.':'./lib/index.js','./package.json':'./package.json'},...(i===0?{dependencies:{'node-pty':specs[1][1]}}:{})}
    writeFileSync(join(content,'package.json'), JSON.stringify(meta))
    for(const file of files) writeFileSync(join(content,file), `// patched ${file}\n`)
    const path = join(root, `${i}.tgz`)
    execFileSync('tar',['-czf',path,'-C',dir,'package'], {windowsHide:true})
    return {name,version,path,sha256:hash(readFileSync(path)),files:Object.fromEntries(files.map(f=>[f,hash(readFileSync(join(content,f)))]))}
  })
  const proposal=join(root,'proposal.json'), input={schemaVersion:1,expectedPackageJsonSha256:hash(bytes),packages}
  const save=()=>writeFileSync(proposal,JSON.stringify(input));save()
  return {root,profile,proposal,input,save,manifest}
}
test('PTY双包check零写、apply只改两override并CAS拒绝重复应用', t=>{
  const f=fixture(t), path=join(f.profile,'package.json'), before=readFileSync(path)
  assert.equal(upgradePty({...f}).writes,0);assert.deepEqual(readFileSync(path),before)
  const proof=upgradePty({...f,mode:'apply'}), next=JSON.parse(readFileSync(path))
  assert.equal(proof.nextManifestSha256,hash(readFileSync(path)))
  assert.deepEqual(next.dependencies,f.manifest.dependencies);assert.equal(next.pnpm.overrides.unrelated,'keep')
  assert.equal(Object.keys(next.pnpm.overrides).length,3)
  assert.throws(()=>upgradePty({...f,mode:'apply'}),/MANIFEST_CAS/)
})
test('PTY提案缺包、错误名、伪造摘要和删关键文件全部拒绝', t=>{
  for(const mutate of [x=>x.packages.pop(),x=>x.packages[0].name='other',x=>x.packages[0].sha256='0'.repeat(64),x=>delete x.packages[1].files['lib/windowsPtyAgent.js'],x=>delete x.packages[1].files['lib/windowsTerminal.js'],x=>x.packages[1].version='1.2.0-beta.15.dsh.1']){
    const f=fixture(t);mutate(f.input);f.save();assert.throws(()=>upgradePty(f),/PTY_UPGRADE_/)
  }
})
test('PTY安装验证沿实际base consumer拒绝root假成功', t=>{
  const f=fixture(t);upgradePty({...f,mode:'apply'})
  const base=join(f.profile,'node_modules/@deepseek-ai/dsh-base');mkdirSync(base,{recursive:true});writeFileSync(join(base,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh-base',main:'index.js'}));writeFileSync(join(base,'index.js'),'')
  function install(item, parent){
    const dir=join(parent,'node_modules',item.name);mkdirSync(dir,{recursive:true})
    execFileSync('tar',['-xzf',item.path,'-C',dir,'--strip-components=1'],{windowsHide:true});return dir
  }
  // 根包正确，但实际 base bundle 消费者解析到自己的旧 provider，必须拒绝。
  for(const item of f.input.packages)install(item,f.profile)
  const provider=install(f.input.packages[0],base)
  writeFileSync(join(provider,'lib/index.js'),'// stale implementation')
  install(f.input.packages[1],provider)
  assert.throws(()=>upgradePty({...f,mode:'verify'}),/INSTALLED_FILE_HASH/)
  install(f.input.packages[0],base)
  const result=upgradePty({...f,mode:'verify'})
  assert.equal(result.installed.length,2);assert.ok(result.providerEntry.startsWith(base))
  writeFileSync(join(provider,'node_modules/node-pty/lib/windowsTerminal.js'),'// stale exit callback ordering')
  assert.throws(()=>upgradePty({...f,mode:'verify'}),/INSTALLED_FILE_HASH/)
  install(f.input.packages[1],provider)
  writeFileSync(join(provider,'node_modules/node-pty/lib/windowsPtyAgent.js'),'// stale worker')
  assert.throws(()=>upgradePty({...f,mode:'verify'}),/INSTALLED_FILE_HASH/)
})
