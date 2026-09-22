import test from 'node:test'
import assert from 'node:assert/strict'
import { buildMaterialManifest } from '../packages/dingtalk-dsh-assistant/coordination-context.js'

test('材料分页乱序与重叠合并，但缺口不得显示完整', () => {
  const input = { requestId: 'r1', materials: [{ id: 'm1', version: 1, text: 'abcdef', pages: [{ offset: 4, text: 'ef' }, { offset: 0, text: 'ab' }] }] }
  let result = buildMaterialManifest(input)
  assert.equal(result.complete, false)
  assert.equal(result.entries[0].nextOffset, 2)
  input.materials[0].pages.push({ offset: 1, text: 'bcde' })
  result = buildMaterialManifest(input)
  assert.equal(result.complete, true)
  assert.equal(result.entries[0].readChars, 6)
  assert.deepEqual(result.entries[0].readRanges, [{ start: 0, end: 6 }])
  assert.equal(JSON.stringify(result).includes('abcdef'), false)
})

test('缺失原因显式输出，正文存在不等于已读，空正文可完整', () => {
  const result = buildMaterialManifest({ requestId: 'r1', materials: [{ id: 'missing', version: 1, missingReason: 'attachment_unavailable' }, { id: 'unread', version: 1, text: 'available' }, { id: 'empty', version: 1, text: '' }] })
  assert.deepEqual(result.entries.map(item => item.status), ['missing', 'partial', 'complete'])
  assert.equal(result.entries[0].missingReason, 'attachment_unavailable')
})

test('摘要绑定版本和分页，拒绝错误内容及重复身份', () => {
  const input = { requestId: 'r1', materials: [{ id: 'm1', version: 1, text: 'abc', pages: [{ offset: 0, text: 'abc' }] }] }
  const original = buildMaterialManifest(input)
  input.materials[0].version++
  assert.notEqual(buildMaterialManifest(input).manifestFingerprint, original.manifestFingerprint)
  input.materials[0].pages[0].text = 'fake'
  assert.throws(() => buildMaterialManifest(input), /page_mismatch/)
  assert.throws(() => buildMaterialManifest({ requestId: 'r1', materials: [{ id: 'm', version: 1 }, { id: 'm', version: 2 }] }), /duplicate_identity/)
})
