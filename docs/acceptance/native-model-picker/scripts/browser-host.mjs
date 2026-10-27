import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
const { values }=parseArgs({options:{profile:{type:'string'},deps:{type:'string'},esbuild:{type:'string'},tokens:{type:'string'}}})
for(const key of ['profile','deps','esbuild','tokens'])if(!values[key])throw Error(`--${key} required`)
const root=process.cwd(),profile=resolve(values.profile),deps=resolve(values.deps)
const esbuild=await import(pathToFileURL(resolve(values.esbuild)))
const htmlSource=await readFile(join(profile,'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html'),'utf8')
const themeFiles=[...htmlSource.matchAll(/href="\.\/(assets\/[^" ]+\.css)"/g)].map(match=>match[1])
const theme=await Promise.all(themeFiles.map(file=>readFile(join(profile,'node_modules/@deepseek-ai/dsh-web-frontend/dist',file),'utf8')))
const req=createRequire(join(profile,'node_modules/@deepseek-ai/dsh-client-ui-model-selection/package.json'))
const nativePath=req.resolve('@deepseek-ai/dsh-client-ui-model-selection/client')
const entry=`
import React from 'react';import * as jsxRuntime from 'react/jsx-runtime';import * as ReactDOM from 'react-dom';import {createRoot} from 'react-dom/client';
import * as primitives from ${JSON.stringify(req.resolve('@deepseek-ai/dsh-client-ui-primitives'))};
import * as cordis from ${JSON.stringify(req.resolve('@deepseek-ai/cordis'))};
const store={};
let native,plugin,Picker,card,dictionaries={};
window.__ModuleLoader__={load(spec){const mod=spec.factory(name=>({'react':React,'react/jsx-runtime':jsxRuntime,'react-dom':ReactDOM,'@deepseek-ai/dsh-client-ui-primitives':primitives,'@deepseek-ai/cordis':cordis,'@deepseek-ai/dsh-client-store':store}[name]));if(spec.id.includes('model-selection'))native=mod;else plugin=mod}};
await import('/native.js');
const t=(key,vars={})=>(dictionaries.zh?.[key]??key).replace(/\\{(\\w+)\\}/g,(_,k)=>vars[k]??'');
const slots={inject(key,fn){return fn()},register(spec,component){if(spec.name==='conversation.input.model')Picker=component;else if(spec.name==='settings.plugins.tab')card={spec,component};return()=>{}},entriesOfSlot(){return Picker?[{component:Picker}]:[]}};
const ctx={slots,locale:{register(ns,dict){dictionaries=dict},bind(){return t}},effect:fn=>fn(),plugin(){},inject(keys,fn){if(keys[0]==='slots')fn({slots,modelDirectories:{},sessions:{}})}};
native.apply(ctx);
const efforts={defaultEffort:'low',efforts:[{id:'low',name:'Low'},{id:'high',name:'High'}]};
const groups=[{id:'gateway',name:'cortex-gateway',models:[{id:'sol',name:'GPT-6.1 Sol',reasoning:efforts}]},{id:'openai-codex',name:'OpenAI Codex',models:['Spark','Luna','Sol','Terra','Astra','GPT-6.1 Sol'].map((name,i)=>({id:i===5?'sol':'model-'+i,name,reasoning:efforts}))}];
ctx.remote={session:{modelCatalog:async()=>({ok:true,value:{groups,failures:[]}}),selectModel(){throw Error('REAL SESSION MUST NOT BE MUTATED')}}};
let config={agentNames:[],workspaceDir:'D:/synthetic',provider:'gateway',model:'sol',reasoningEffort:'low',taskSessionModel:{provider:'openai-codex',model:'model-4',reasoningMode:'explicit',reasoningEffort:'low'},coordinationModel:{provider:'openai-codex',model:'model-4',reasoningMode:'explicit',reasoningEffort:'low'},executionBackend:'dsh'};
window.fetch=async(url,options={})=>{const path=new URL(url,location.href).pathname;let value={};if(path==='/state/agent-config')value=config;else if(path==='/config/agent'){config={...config,...JSON.parse(options.body)};value=config;document.getElementById('receipt').textContent=JSON.stringify({provider:config.provider,model:config.model,task:config.taskSessionModel,coordination:config.coordinationModel})}else if(path==='/state/groups'||path==='/state/tasks'||path==='/state/supervisor/alerts')value=[];else if(path==='/state/task-model-options'){const u=new URL(url,location.href);const group=groups.find(g=>g.id===u.searchParams.get('provider'));value={models:group?.models??[],available:!!group,reasoning:efforts}}else if(path==='/health')value={status:'ok'};else if(path==='/state/environment')value={dws:{installed:true}};return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}})};
await import('/plugin.js');plugin.apply(ctx);const Card=card.component;
createRoot(document.getElementById('root')).render(React.createElement(Card,card.spec.inject()));
`
const built=await esbuild.build({stdin:{contents:entry,resolveDir:root,sourcefile:'native-picker-fixture.mjs'},bundle:true,format:'esm',platform:'browser',write:false,outdir:'virtual',nodePaths:[deps,join(root,'node_modules')],alias:{react:join(root,'node_modules/react'),'react-dom':join(deps,'react-dom')},define:{'process.env.NODE_ENV':'"production"'},external:['/native.js','/plugin.js'],loader:{'.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'}})
const files=new Map(built.outputFiles.map(f=>[f.path.endsWith('.css')?'/host.css':'/host.js',f.contents]))
const server=createServer(async(req,res)=>{const p=new URL(req.url,'http://localhost').pathname;if(p==='/theme.css'){res.setHeader('content-type','text/css');res.end(theme.join('\n')+'\n'+await readFile(values.tokens,'utf8'));return}if(p==='/'){res.setHeader('content-type','text/html; charset=utf-8');res.end('<!doctype html><html lang="zh-CN" data-theme="light" data-platform="win32"><meta name="viewport" content="width=device-width,initial-scale=1"><title>原生模型选择器隔离验收</title><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/host.css"><style>body{font:14px sans-serif;color:#222;background:#fff;margin:24px;--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#222}#root{max-width:700px}#receipt{white-space:pre-wrap}</style><p>合成配置 · 真实宿主 ModelSelect · 不连接真实会话或业务接口</p><pre id="receipt"></pre><div id="root"></div><script type="module" src="/host.js"></script>');return}if(p==='/native.js'||p==='/plugin.js'){res.setHeader('content-type','text/javascript');res.end(await readFile(p==='/native.js'?nativePath:resolve(root,'packages/dingtalk-dsh-assistant/web-client.js')));return}if(files.has(p)){res.setHeader('content-type',p.endsWith('.css')?'text/css':'text/javascript');res.end(files.get(p));return}res.writeHead(404).end()})
server.listen(19097,'127.0.0.1',()=>console.log('http://127.0.0.1:19097'))
