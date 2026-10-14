import {readFileSync,writeFileSync,statSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
const check=process.argv.includes('--check');
const profile='D:/dsh_home/profiles/web/cordis.patch.yml';
const store='D:/baibu-agent/task-session-runtime-clean/.dsh/resident/dingtalk_dsh_assistant.json';
const next='D:/baibu-agent',previous=next+'/task-session-runtime-clean';
assert.equal(realpathSync(next),resolve(next));assert.ok(statSync(next+'/AGENTS.md').isFile());
const text=readFileSync(profile,'utf8'), raw=readFileSync(store,'utf8'),value=JSON.parse(raw);
assert.equal(resolve(value.tables.scheduler.runtime.agentWorkspaceDir),resolve(previous));
const oldLine="            agentWorkspaceDir: 'D:/baibu-agent/task-session-runtime-clean'";
assert.equal(text.split(oldLine).length,2);
const anchor='              dbPath: D:/baibu-agent/task-session-runtime-clean/.dsh/task-sessions.sqlite';
assert.equal(text.split(anchor).length,2);
assert.ok(!text.includes('              workspaceDir: D:/baibu-agent/task-session-runtime-clean'));
const changed=text.replace(oldLine,"            agentWorkspaceDir: 'D:/baibu-agent'").replace(anchor,'              workspaceDir: D:/baibu-agent/task-session-runtime-clean\n'+anchor);
const cloned=structuredClone(value);cloned.tables.scheduler.runtime.agentWorkspaceDir=resolve(next);
const hash=x=>createHash('sha256').update(x).digest('hex');
const result={checkOnly:check,writes:check?0:2,agentWorkspace:resolve(next),taskDataRoot:resolve(previous),dbUnchanged:true,oldProfileSha256:hash(text),newProfileSha256:hash(changed)};
if(!check){
 try{process.kill(61872,0);throw Error('OLD_PROCESS_STILL_RUNNING')}catch(e){if(e.code!=='ESRCH')throw e}
 try{
  writeFileSync(profile,changed);writeFileSync(store,JSON.stringify(cloned,null,2)+'\n');
  assert.equal(readFileSync(profile,'utf8'),changed);
  const saved=JSON.parse(readFileSync(store));assert.equal(saved.tables.scheduler.runtime.agentWorkspaceDir,resolve(next));
  saved.tables.scheduler.runtime.agentWorkspaceDir=value.tables.scheduler.runtime.agentWorkspaceDir;assert.deepEqual(saved,value);
 }catch(e){writeFileSync(profile,text);writeFileSync(store,raw);throw e}
}
console.log(JSON.stringify(result));
