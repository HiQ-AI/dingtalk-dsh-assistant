import {readFileSync,writeFileSync,renameSync} from 'node:fs'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import yaml from 'js-yaml'
// 仅删除已废弃且只拒绝调度工具的subagent.toolFilter；所有其余YAML语义和表达式保持。
const [mode,profile,expectedHash] = process.argv.slice(2)
if(!['--check','--apply'].includes(mode)||!profile||!expectedHash)throw Error('需要--check/--apply、profile绝对路径、当前SHA256')
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const before=readFileSync(profile),text=before.toString('utf8')
if(sha(before)!==expectedHash)throw Error('PROFILE_CHANGED')
const schema=yaml.JSON_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js',{kind:'scalar',construct:value=>({__jsExpr:value})}))
const original=yaml.load(text,{schema}),wanted=structuredClone(original)
const schedules=['schedule_create','schedule_delete','schedule_list','schedule_update']
let affected=0
function visit(value){if(!value||typeof value!=='object')return
 if(value.name==='@deepseek-ai/dsh-tool-subagent'&&value.config?.toolFilter){assert.deepEqual(value.config.toolFilter,{deny:schedules});delete value.config.toolFilter;affected++}
 for(const child of Object.values(value))visit(child)
}
visit(wanted)
if(affected!==6)throw Error('EXPECTED_SIX_FILTERS')
const pattern=/^([ ]*)toolFilter:\r?\n\1  deny:\r?\n\1    - schedule_create\r?\n\1    - schedule_delete\r?\n\1    - schedule_list\r?\n\1    - schedule_update\r?\n/gm
let replacements=0
const candidate=text.replace(pattern,()=>{replacements++;return ''})
if(replacements!==affected)throw Error('TEXT_FILTER_COUNT_MISMATCH')
assert.deepEqual(yaml.load(candidate,{schema}),wanted)
if(mode==='--apply'){
 if(sha(readFileSync(profile))!==expectedHash)throw Error('PROFILE_CHANGED_BEFORE_APPLY')
 const temporary=profile+'.startup-repair.tmp'
 writeFileSync(temporary,candidate,{encoding:'utf8',flag:'wx'})
 renameSync(temporary,profile)
 assert.deepEqual(yaml.load(readFileSync(profile,'utf8'),{schema}),wanted)
}
console.log(JSON.stringify({mode,affected,beforeSha256:sha(before),afterSha256:sha(Buffer.from(candidate)),writes:mode==='--apply'?1:0}))
