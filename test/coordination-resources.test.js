import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, access, rm, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createCoordinationResourceTools, readPublicResource } from '../packages/dingtalk-dsh-assistant/coordination-resources.js'
import { createDwsAdapter } from '../packages/dingtalk-dsh-assistant/dws-adapter.js'

test('真实xlsx附件完整保留多sheet、Y列、空行位置与公式缓存且清理下载文件', async t => {
  const ExcelJS = createRequire(new URL('../packages/dingtalk-dsh-assistant/package.json', import.meta.url))('exceljs')
  const workbook = new ExcelJS.Workbook()
  const first = workbook.addWorksheet('审核条目')
  first.getCell('A1').value = '数据集'
  first.getCell('A3').value = 'fixture-dataset'
  first.getCell('Y3').value = 'expert@example.org'
  first.getCell('B3').value = { formula: '1+2', result: 3 }
  first.mergeCells('C3:D3'); first.getCell('C3').value = '审核中'
  workbook.addWorksheet('说明', { state: 'hidden' }).getCell('A1').value = '行业记录保留'
  let bytes = await workbook.xlsx.writeBuffer()
  const cwd = await mkdtemp(path.join(tmpdir(), 'xlsx-resource-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const adapter = createDwsAdapter({ enabled: true, runner: { cwd, run: async args => {
    const localPath = path.join(args[args.indexOf('--output') + 1], '审核.xlsx')
    await writeFile(path.join(cwd, localPath), bytes)
    return { exitCode: 0, stdout: JSON.stringify({ localPath, sizeBytes: bytes.length }) }
  } } })
  const result = await adapter.readMessageResource('g', 'm', { type: 'fileId', resourceId: 'file' })
  const value = JSON.parse(result.text)
  assert.equal(result.complete, true)
  assert.equal(value.formulasRecalculated, false)
  assert.equal(value.sheets.length, 2)
  assert.deepEqual(value.sheets[0].rows.map(row => row.row), [1, 3])
  const cells = value.sheets[0].rows[1].cells
  assert.equal(cells.find(cell => cell.address === 'Y3').value, 'expert@example.org')
  assert.deepEqual(cells.find(cell => cell.address === 'B3').value, { formula: '1+2', result: 3 })
  assert.equal(cells.find(cell => cell.address === 'D3').mergedInto, 'C3')
  assert.equal(value.sheets[1].state, 'hidden')
  assert.deepEqual(await readdir(cwd), [])
  bytes = Buffer.from('not a workbook')
  await assert.rejects(adapter.readMessageResource('g', 'm', { type: 'fileId', resourceId: 'file' }))
  assert.deepEqual(await readdir(cwd), [])
})

function harness(options = {}) {
  let active = true
  const request = { requestId: 'r', groupId: 'g', messages: [{ messageId: 'a', text: '当前', quotedMessage: { messageId: 'b' } }] }
  const tools = new Map(createCoordinationResourceTools({ request, assertCurrent(exec) { if (!active || exec?.requestId !== 'r') throw new Error('wrong_request') }, ...options }).map(tool => [tool.name, tool]))
  return { request, stop() { active = false }, call: (name, input, exec = { requestId: 'r' }) => tools.get(name).execute(input, exec), render: (name, value) => tools.get(name).output.render({}, value) }
}

test('引用只沿已验证消息扩展，错群/缺正文/假完整不能成为新授权入口', async () => {
  const messages = { b: { groupId: 'g', messageId: 'b', text: '上游', quotedMessage: { messageId: 'c' } }, c: { groupId: 'g', messageId: 'c', text: '更上游' } }
  let reads = 0
  const h = harness({ readMessage: async (_group, id) => { reads++; return messages[id] } })
  await assert.rejects(h.call('group_message_get', { messageId: 'c' }), /outside_request/)
  assert.equal(reads, 0)
  assert.equal((await h.call('group_message_get', { messageId: 'b' })).message.text, '上游')
  assert.equal((await h.call('group_message_get', { messageId: 'c' })).message.text, '更上游')
  for (const change of [{ groupId: 'other' }, { complete: false }, { hasMore: true }, { text: undefined }, { failures: ['failed'] }]) {
    const bad = harness({ readMessage: async () => ({ ...messages.b, ...change }) })
    await assert.rejects(bad.call('group_message_get', { messageId: 'b' }), /identity_or_completeness/)
    await assert.rejects(bad.call('group_message_get', { messageId: 'c' }), /outside_request/)
  }
})

test('资源ID必须来自当前消息，文本真实分页，读取失败不缓存为完整', async () => {
  let reads = 0
  const h = harness({ readMessage: async (_group, id) => ({ groupId: 'g', messageId: id, text: '上游', resourceRefs: [{ type: 'fileId', resourceId: 'file-a' }] }), readResource: async () => { reads++; return reads === 1 ? { text: '错误正文', complete: false } : { text: '甲'.repeat(9000), mediaType: 'text/plain' } } })
  await assert.rejects(h.call('group_resource_get', { messageId: 'b', type: 'fileId', resourceId: 'foreign' }), /outside_request/)
  assert.equal(reads, 0)
  const args = { messageId: 'b', type: 'fileId', resourceId: 'file-a' }
  await assert.rejects(h.call('group_resource_get', args), /read_incomplete/)
  await assert.rejects(h.call('group_resource_get', { ...args, offset: 8000 }), /unread_gap/)
  const first = await h.call('group_resource_get', args)
  assert.equal(first.complete, false)
  assert.equal(first.hasMore, true)
  const next = await h.call('group_resource_get', { ...args, offset: first.nextOffset })
  assert.equal(next.complete, true)
  assert.equal(first.text + next.text, '甲'.repeat(9000))
  assert.equal(reads, 2)
  assert.equal(first.contentFingerprint, next.contentFingerprint)
})

test('公网链接限于精确消息引用，异步读取后请求过期不能交付', async () => {
  let calls = 0
  const h = harness({ readMessage: async (_group, id) => ({ groupId: 'g', messageId: id, text: 'https://example.org/report' }), readUrl: async () => { calls++; h.stop(); return { text: '公开资料' } } })
  await assert.rejects(h.call('group_resource_get', { messageId: 'b', type: 'url', resourceId: 'https://example.org/other' }), /outside_request/)
  assert.equal(calls, 0)
  await assert.rejects(h.call('group_resource_get', { messageId: 'b', type: 'url', resourceId: 'https://example.org/report' }), /wrong_request/)
})

test('外链拒绝凭据、非HTTPS和私有/保留DNS地址且不建立连接', async () => {
  for (const url of ['http://example.org', 'https://user:secret@example.org', 'https://example.org:8080']) await assert.rejects(readPublicResource(url), /not_public_https/)
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.0.1', '100.64.0.1', '0.0.0.0']) await assert.rejects(readPublicResource('https://example.org', { resolve: async () => [{ address, family: 4 }] }), /private_address/)
})

test('原生图片先验证附件字节，缺失图片不能返回完整', async () => {
  const attachment = { attachmentId: 'image-a', mediaType: 'image/png', bytes: 5, width: 1, height: 1 }
  const h = harness({ request: { requestId: 'r', groupId: 'g', messages: [{ messageId: 'a', text: '图片', imageRefs: [attachment] }] }, readImage: async () => { throw new Error('image_missing') } })
  await assert.rejects(h.call('group_resource_get', { messageId: 'a', type: 'attachment', resourceId: 'image-a' }), /image_missing/)
  const valid = harness({ request: h.request, readImage: async () => ({ ref: attachment, data: new Uint8Array(5) }) })
  const own = harness({ request: { requestId: 'r', groupId: 'g', messages: [{ messageId: 'a', text: '图片', imageRefs: [attachment] }] }, readImage: async () => ({ ref: attachment, data: new Uint8Array(5) }) })
  const output = await own.call('group_resource_get', { messageId: 'a', type: 'attachment', resourceId: 'image-a' })
  assert.equal(output.complete, true)
  assert.deepEqual(own.render('group_resource_get', output).at(-1), { type: 'image', attachment })
  // 独立请求没有继承上一个请求的附件身份。
  await assert.rejects(valid.call('group_resource_get', { messageId: 'a', type: 'attachment', resourceId: 'image-a' }), /outside_request/)
})

test('DWS资源下载实际检查大小与路径，正文读取后清理临时文件', async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'coord-resource-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  let mismatch = false
  const adapter = createDwsAdapter({ enabled: true, profile: 'test-profile', runner: { cwd, async run(args) {
    assert.ok(args.includes('+messages-resource-download'))
    assert.equal(args[args.indexOf('--type') + 1], 'fileId')
    assert.equal(args[args.indexOf('--profile') + 1], 'test-profile')
    const localPath = path.join(args[args.indexOf('--output') + 1], 'resource.txt')
    await writeFile(path.join(cwd, localPath), '正文')
    return { exitCode: 0, stdout: JSON.stringify({ localPath, sizeBytes: mismatch ? 1 : 6 }) }
  } } })
  assert.equal((await adapter.readMessageResource('g', 'm', { type: 'fileId', resourceId: 'file' })).text, '正文')
  await assert.rejects(access(path.join(cwd, 'resource.txt')))
  mismatch = true
  await assert.rejects(adapter.readMessageResource('g', 'm', { type: 'fileId', resourceId: 'file' }), /size_invalid/)
  await assert.rejects(access(path.join(cwd, 'resource.txt')))
})

test('DWS 文件卡片只允许同名同 fileId 的精确下载尾注差异，真实内容或资源变更仍拒绝', async () => {
  const base = '[文件] 翻译测试_260922.xlsx fileId: fixture-file-translation-001'
  const source = { messageId: 'a', sourceKind: 'dingtalk', text: `${base} 注意：如需下载使用dws drive download命令下载` }
  const remote = { messageId: 'a', groupId: 'g', text: base, resourceRefs: [{ type: 'fileId', resourceId: 'fixture-file-translation-001', name: '翻译测试_260922.xlsx' }] }
  const make = (message = remote, inbound = source) => harness({ request: { requestId: 'r', groupId: 'g', messages: [inbound] }, readMessage: async () => message, readResource: async () => ({ text: '测试正文' }) })
  const h = make()
  assert.equal((await h.call('group_message_get', { messageId: 'a' })).message.text, base)
  assert.equal((await h.call('group_resource_get', { messageId: 'a', type: 'fileId', resourceId: remote.resourceRefs[0].resourceId })).text, '测试正文')
  for (const changed of [
    { ...remote, resourceRefs: [{ ...remote.resourceRefs[0], resourceId: 'different-file' }] },
    { ...remote, resourceRefs: [{ ...remote.resourceRefs[0], name: '另一个文件.xlsx' }] },
    { ...remote, resourceRefs: [] },
    { ...remote, text: base.replace('260922', '260923') },
    { ...remote, text: '已经修改的普通文本', resourceRefs: [] },
  ]) await assert.rejects(make(changed).call('group_message_get', { messageId: 'a' }), /coordination_message_version_changed/)
  await assert.rejects(make({ ...remote, text: '原文', resourceRefs: [] }, { ...source, text: '原文 注意：如需下载使用dws drive download命令下载' }).call('group_message_get', { messageId: 'a' }), /coordination_message_version_changed/)
  await assert.rejects(make(remote, { ...source, text: `${source.text} 追加业务要求` }).call('group_message_get', { messageId: 'a' }), /coordination_message_version_changed/)
})

test('SQL附件经精确受管下载仅按UTF8读取，保留正文且拒绝坏编码并清理', async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'sql-resource-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const text = "-- 先两条测试，验证后执行正式数据\r\nBEGIN;\r\nUPDATE review SET expert = '新专家';\r\nROLLBACK;\r\n"
  let bytes = Buffer.from(text), calls = 0
  const adapter = createDwsAdapter({ enabled: true, profile: 'test-profile', runner: { cwd, async run(args) {
    calls++
    assert.ok(args.includes('+messages-resource-download'))
    for (const [flag, value] of [['--profile', 'test-profile'], ['--open-conversation-id', 'g'], ['--message-id', 'm'], ['--resource-id', 'sql-file'], ['--type', 'fileId']])
      assert.equal(args[args.indexOf(flag) + 1], value)
    const localPath = path.join(args[args.indexOf('--output') + 1], '审核修复.SQL')
    await writeFile(path.join(cwd, localPath), bytes)
    return { exitCode: 0, stdout: JSON.stringify({ localPath, sizeBytes: bytes.length }) }
  } } })
  const result = await adapter.readMessageResource('g', 'm', { type: 'fileId', resourceId: 'sql-file' })
  assert.equal(result.text, text); assert.equal(result.mediaType, 'text/plain'); assert.equal(calls, 1)
  assert.deepEqual(await readdir(cwd), [])
  bytes = Buffer.from([0xff, 0xfe, 0xff])
  await assert.rejects(adapter.readMessageResource('g', 'm', { type: 'fileId', resourceId: 'sql-file' }), { code: 'ERR_ENCODING_INVALID_ENCODED_DATA' })
  assert.equal(calls, 2); assert.deepEqual(await readdir(cwd), [])
})

test('新旧消息钉钉文档共用canonical引用且只经DWS读取，普通URL仍走公网读取', async () => {
  const url = 'https://alidocs.dingtalk.com/i/nodes/Node123'
  for (const resourceRefs of [undefined, [{ type: 'url', resourceId: url + '?source=old' }], [{ type: 'dingtalkDoc', resourceId: 'Node123' }]]) {
    const reads = [], publicReads = []
    const h = harness({ request: { requestId: 'r', groupId: 'g', messages: [{ sourceKind: 'web', messageId: 'a', text: `${url}?from=message https://example.com/manual`, resourceRefs }] },
      readResource: async (...args) => { reads.push(args); return { text: '文档正文', complete: true } },
      readUrl: async value => { publicReads.push(value); return { text: '普通网页' } } })
    const message = await h.call('group_message_get', { messageId: 'a' })
    assert.deepEqual(message.resourceRefs, [{ type: 'dingtalkDoc', resourceId: 'Node123' }, { type: 'url', resourceId: 'https://example.com/manual' }])
    assert.equal((await h.call('group_resource_get', { messageId: 'a', type: 'dingtalkDoc', resourceId: 'Node123' })).text, '文档正文')
    assert.deepEqual(reads, [['g', 'a', { type: 'dingtalkDoc', resourceId: 'Node123' }]])
    await assert.rejects(h.call('group_resource_get', { messageId: 'a', type: 'url', resourceId: url + '?from=message' }), /outside_request/)
    await assert.rejects(h.call('group_resource_get', { messageId: 'a', type: 'dingtalkDoc', resourceId: 'other' }), /outside_request/)
    assert.deepEqual(publicReads, [])
    assert.equal((await h.call('group_resource_get', { messageId: 'a', type: 'url', resourceId: 'https://example.com/manual' })).text, '普通网页')
  }
})

test('钉钉文档DWS读取失败不退回公网HTML', async () => {
  let publicReads = 0
  const h = harness({ request: { groupId: 'g', messages: [{ messageId: 'a', sourceKind: 'web', text: 'https://alidocs.dingtalk.com/i/nodes/Node123' }] },
    readResource: async () => { throw new Error('dws_denied') }, readUrl: async () => { publicReads++; return { text: '登录页' } } })
  await assert.rejects(h.call('group_resource_get', { messageId: 'a', type: 'dingtalkDoc', resourceId: 'Node123' }), /dws_denied/)
  assert.equal(publicReads, 0)
})


const documentEnvelope = data => ({ok:true,outcome:'success',data})
const documentInspection = () => documentEnvelope({status:'success',complete:true,data:{file:{fileId:'document-node',extension:'adoc',type:'FILE'}}})
const fullDocument = () => ({contractVersion:'doc.content.v1',status:'success',complete:true,
 target:{canonicalId:'document-node',product:'doc',name:'规则文档'},
 content:{data:{revision:7,markdown:'标题\n正文',jsonml:JSON.stringify(['root',{},['h1',{uuid:'h'},'标题'],['table',{uuid:'t'},['tr',{},['td',{},'数据集']]],['p',{uuid:'p'},'正文']])}}})

test('钉钉文档使用已绑定profile原生全文命令并保留JSONML结构与稳定元数据',async()=>{
 const calls=[];let read=0
 const adapter=createDwsAdapter({enabled:true,profile:'corp:actor',runner:{run:async args=>{calls.push(args);return {exitCode:0,stdout:JSON.stringify(args[1]==='+inspect'?documentInspection():documentEnvelope({...fullDocument(),readAt:`read-${++read}`,requestId:`request-${read}`}))}}}})
 const a=await adapter.readMessageResource('g','m',{type:'dingtalkDoc',resourceId:'document-node'})
 const b=await adapter.readMessageResource('g','m',{type:'dingtalkDoc',resourceId:'document-node'})
 assert.deepEqual(calls[1],['doc','+fetch','--node','document-node','--scope','full','--detail','full','--format','json','--profile','corp:actor'])
 assert.equal(a.text,b.text);assert.notEqual(a.metadata.readAt,b.metadata.readAt)
 assert.equal(a.complete,true);assert.equal(a.mediaType,'application/json')
 const parsed=JSON.parse(a.text);assert.deepEqual(parsed.content,fullDocument().content);assert.equal(parsed.target.name,'规则文档')
})

for(const [name,exitCode,error,expected]of [
 ['认证',2,{category:'auth'},'DWS_DOC_AUTH_REQUIRED'],
 ['旧进程认证封装',5,{category:'internal',message:'[UNCLASSIFIED] resolve access token: profile retained'},'DWS_DOC_AUTH_REQUIRED'],
 ['权限',4,{reason:'permission_denied'},'DWS_DOC_PERMISSION_DENIED'],
 ['缺失',1,{reason:'not_found'},'DWS_DOC_NOT_FOUND'],
 ['暂时故障',1,{retryable:true,server_error_code:'busy'},'DWS_DOC_TEMPORARY'],
 ['未知故障',5,{category:'internal'},'DWS_DOC_READ_FAILED'],
 ['部分内容',7,{category:'partial_failure'},'DWS_DOC_INCOMPLETE'],
])test(`钉钉文档错误分类：${name}`,async()=>{
 const adapter=createDwsAdapter({enabled:true,runner:{run:async()=>({exitCode,stderr:JSON.stringify({error})})}})
 await assert.rejects(adapter.readMessageResource('g','m',{type:'dingtalkDoc',resourceId:'document-node'}),{code:expected})
})

for(const variant of ['incomplete','fragment','no-body','wrong-node','nested-partial','invalid-json'])test(`钉钉文档拒绝不完整或身份错误正文：${variant}`,async()=>{
 const value=fullDocument()
 if(variant==='incomplete')value.complete=false
 if(variant==='fragment')value.content.data.jsonml='["fragment",{},"局部"]'
 if(variant==='no-body')delete value.content.data.jsonml
 if(variant==='wrong-node')value.target.canonicalId='another-node'
 if(variant==='nested-partial')value.content.data.complete=false
 const adapter=createDwsAdapter({enabled:true,runner:{run:async args=>({exitCode:0,stdout:args[1]==='+inspect'?JSON.stringify(documentInspection()):variant==='invalid-json'?'not json':JSON.stringify(documentEnvelope(value))})}})
 await assert.rejects(adapter.readMessageResource('g','m',{type:'dingtalkDoc',resourceId:'document-node'}),{code:'DWS_DOC_INCOMPLETE'})
})

for (const variant of ['success', 'wrong-node', 'partial', 'unknown-type', 'wrong-receipt-node', 'wrong-size', 'outside', 'invalid-utf8', 'bare-envelope']) test(`原生HTML文档检查下载：${variant}`, async t => {
 const cwd=await mkdtemp(path.join(tmpdir(),'native-document-'));t.after(()=>rm(cwd,{recursive:true,force:true}))
 const body=variant==='invalid-utf8'?Buffer.from([0xff]):Buffer.from('<html><script>neverExecute()</script><body>完整正文</body></html>')
 const calls=[]
 const adapter=createDwsAdapter({enabled:true,profile:'corp:actor',runner:{cwd,run:async args=>{
  calls.push(args)
  assert.deepEqual(args.slice(-2),['--profile','corp:actor'])
  assert.equal(args[args.indexOf('--node')+1],'document-node')
  let data
  if(args[1]==='+inspect')data={status:'success',complete:variant!=='partial',data:{file:{fileId:variant==='wrong-node'?'other':'document-node',type:variant==='unknown-type'?'UNKNOWN':'FILE',extension:'html',fileSize:body.length,name:'document.html',modifyTime:123}}}
  else {
   assert.equal(args[1],'+download')
   const output=variant==='outside'?'outside.html':args[args.indexOf('--output')+1]
   await writeFile(path.join(cwd,output),body)
   data={success:true,nodeId:variant==='wrong-receipt-node'?'other':'document-node',savedPath:output,sizeBytes:body.length+(variant==='wrong-size'?1:0)}
  }
  return {exitCode:0,stdout:JSON.stringify(variant==='bare-envelope'?data:documentEnvelope(data))}
 }}})
 const read=()=>adapter.readMessageResource('g','m',{type:'dingtalkDoc',resourceId:'document-node'})
 if(variant==='success'){
  const result=await read();assert.equal(result.text,body.toString());assert.equal(result.mediaType,'text/html');assert.equal(result.complete,true);assert.equal(result.metadata.nodeId,'document-node');assert.equal(calls.length,2)
 }else if(variant==='invalid-utf8')await assert.rejects(read,{code:'DWS_DOC_INCOMPLETE'})
 else await assert.rejects(read)
 assert.equal((await readdir(cwd)).filter(name=>name.startsWith('coordination-resource-')).length,0)
 if(['wrong-node','partial','unknown-type','bare-envelope'].includes(variant))assert.equal(calls.length,1)
})
