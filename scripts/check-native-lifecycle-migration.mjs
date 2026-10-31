import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
const base=new URL('../',import.meta.url),require=createRequire(new URL('package.json',base)),{parse}=require('acorn')
const coverage=JSON.parse(readFileSync(new URL('test/native-lifecycle-coverage.json',base)))
const selection=Object.fromEntries([...new Set(coverage.cases.map(row=>row.file))].map(file=>[file,true]))
const ast=s=>parse(s,{ecmaVersion:'latest',sourceType:'module',locations:true})
function walk(n,fn){if(!n||typeof n!=='object')return;fn(n);for(const x of Object.values(n))if(Array.isArray(x))x.forEach(v=>walk(v,fn));else if(x&&typeof x==='object'&&x.type)walk(x,fn)}
function canonical(n){
 if(!n||typeof n!=='object')return n
 if(n.type==='CallExpression'&&n.callee.type==='MemberExpression'&&n.callee.property.name==='step'&&n.arguments.length===1&&n.arguments[0].type==='ArrowFunctionExpression')return canonical(n.arguments[0].body)
 if(Array.isArray(n))return n.map(canonical)
 return Object.fromEntries(Object.entries(n).filter(([key])=>!['start','end','loc','raw'].includes(key)).map(([key,value])=>[key,canonical(value)]))
}
function inspect(source){
 const tree=ast(source), assertions=[],cases=[]
 walk(tree,n=>{
  if(n.type!=='CallExpression')return
  if(n.callee.type==='MemberExpression'&&n.callee.object.name==='assert')assertions.push(JSON.stringify(canonical(n)))
  if(!['test','testRunner'].includes(n.callee.name)||n.arguments[0]?.type==='Identifier')return
  const wrapped=n.arguments.find(x=>x.type==='CallExpression'&&x.callee.name==='nativeLifecycle')
  const callback=wrapped?.arguments[1]??n.arguments.find(x=>/FunctionExpression|ArrowFunctionExpression/.test(x.type))
  if(callback)cases.push({name:source.slice(n.arguments[0].start,n.arguments[0].end),line:n.loc.start.line,callback,wrapped,registration:n})
 })
 return{assertions,cases}
}
let preserved=0,pure=0,existing=0,migrated=0,added=0,failures=[];const files=[]
for(const file of Object.keys(selection)){
 const original=execFileSync('git',['-c','safe.directory='+base.pathname.slice(1).replace(/\/$/,''),'show',coverage.basis+':'+file],{cwd:base,encoding:'utf8'}).replaceAll('\r\n','\n')
 const source=readFileSync(new URL(file,base),'utf8'),before=inspect(original),after=inspect(source),remaining=[...after.assertions]
 for(const assertion of before.assertions){const i=remaining.indexOf(assertion);if(i<0)failures.push(file+': original assertion changed');else{remaining.splice(i,1);preserved++}}
 const extra=after.cases.slice(before.cases.length)
 const regression=file==='test/task-session-execution-provider-recovery-native.test.js'&&extra.length===1&&extra[0].name.includes('unified lifecycle construction cancellation')
 if(remaining.length&&!(regression&&remaining.length===4))failures.push(file+': unexpected added assertions')
 added+=remaining.length
 if(before.cases.length!==after.cases.length&&!regression)failures.push(file+': registration count changed')
 for(let i=0;i<before.cases.length;i++){
  const a=before.cases[i],b=after.cases[i];if(!b||a.name!==b.name){failures.push(file+': registration name/order changed');continue}
  const row=coverage.cases.find(x=>x.file===file&&x.originalLine===a.line)
  if(!row){pure++;if(JSON.stringify(canonical(a.callback))!==JSON.stringify(canonical(b.callback)))failures.push(file+': excluded callback modified '+a.line);continue}
  if(row.status==='existing-phased-unchanged'){existing++;if(JSON.stringify(canonical(a.callback))!==JSON.stringify(canonical(b.callback)))failures.push(file+': existing phased callback modified');continue}
  migrated++
  if(!row.fileWrapperOwnsLifecycle){
   if(!b.wrapped)failures.push(row.id+': lifecycle adapter missing')
   else{
    const actual=source.slice(b.wrapped.arguments[0].start,b.wrapped.arguments[0].end)
    if(JSON.stringify(canonical(ast('const budget='+actual).body[0].declarations[0].init))!==JSON.stringify(canonical(ast('const budget='+row.businessBudget).body[0].declarations[0].init)))failures.push(row.id+': business budget mismatch')
    if(b.wrapped.arguments.length!==2)failures.push(row.id+': production limit override')
   }
  }
  let boundaries=0;const visitBody=n=>{if(!n||typeof n!=='object')return;if(/Function/.test(n.type))return;if(n.type==='CallExpression'&&n.callee.type==='MemberExpression'&&n.callee.property.name==='beginBusiness')boundaries++;for(const x of Object.values(n))if(Array.isArray(x))x.forEach(visitBody);else if(x&&typeof x==='object'&&x.type)visitBody(x)}
  visitBody(b.callback.body)
  if(boundaries!==1)failures.push(row.id+': must have exactly one explicit business handoff')
  row.currentLine=b.line
 }
 files.push({file,registrations:before.cases.length,originalAssertions:before.assertions.length})
}
if(migrated!==200||existing!==6||pure!==44)failures.push('Scope count mismatch')
const result={basis:coverage.basis,files:files.length,migrated,existingUnchanged:existing,excludedCallbacksUnchanged:pure,assertionsPreserved:preserved,newConstructionRegressionAssertions:added,failures,details:files}
// This is a migration audit against the preserved basis, not a runtime test.

console.log(JSON.stringify(result,null,2))
if(failures.length)process.exitCode=1
