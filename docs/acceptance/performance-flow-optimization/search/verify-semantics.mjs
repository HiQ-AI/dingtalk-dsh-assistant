import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const {values}=parseArgs({options:{rg:{type:'string'}}});
if(!values.rg){console.error('Usage: node verify-semantics.mjs --rg <rg-binary>');process.exit(2);}
const rgPath=path.resolve(values.rg);
const root=fileURLToPath(new URL('./fixtures/',import.meta.url));
for(const name of ['docs/a.md','docs/.hidden.md','docs/ignored.md','docs/nested/a.md','docs/node_modules/pkg/a.md','docs/.git/config','docs/.gitignore','elsewhere/a.md']){const f=path.join(root,name);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,name.endsWith('.gitignore')?'ignored.md\nnode_modules/\n':'fixture\n');}
const excludes=['.git','.svn','.hg','.bzr','.jj','.sl'].flatMap(n=>[`--glob=!**/${n}`,`--glob=!**/${n}/**`]);
function run(pattern,searchRoot){const p=spawnSync(rgPath,['--files',`--glob=${pattern}`,'--sort=modified','--no-ignore','--hidden',...excludes,'--',searchRoot],{encoding:'utf8',windowsHide:true,cwd:root});assert.ok([0,1].includes(p.status),p.stderr);return p.stdout.trim().split(/\r?\n/).filter(Boolean).map(p=>path.relative(root,p).replaceAll('\\','/')).sort();}
const results=[];
for(const [original,narrowed] of [['docs/*.md','docs/*.md'],['docs/**/*','docs/**/*'],['docs/a.md','docs/a.md']]){const baseline=run(original,root),actual=run(narrowed,path.join(root,'docs'));assert.deepEqual(actual,baseline);results.push({original,narrowed,baseline,equal:true});}
assert.ok(results[0].baseline.includes('docs/.hidden.md'));
assert.ok(results[0].baseline.includes('docs/ignored.md'));
assert.ok(!results[0].baseline.includes('docs/nested/a.md'));
assert.ok(results[1].baseline.includes('docs/node_modules/pkg/a.md'));
assert.ok(!results[1].baseline.includes('docs/.git/config'));
const unsafe=run('*.md',path.join(root,'docs'));assert.notDeepEqual(unsafe,results[0].baseline);
fs.writeFileSync(new URL('./semantics-results.json',import.meta.url),JSON.stringify({results,unsafeBasenameRewriteExtra:unsafe.filter(p=>!results[0].baseline.includes(p))},null,2));
console.log('PASS: 3 exact sets; hidden/ignored included, VCS excluded; basename rewrite counterexample confirmed');
