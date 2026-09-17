// 正式回归入口：只运行单消息多事项、独立反馈、显式修订和长消息原子路由场景。
// 使用真实 Store/Coordinator 与内存后端，不连接 DWS，也不触碰实际 profile。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

const names = [
  'A/B 独立提交不要求覆盖其他 Topic，先完成 B 不消费 A',
  '超长消息路由必须按冻结原文坐标连续读完，未读完不能原子接受',
  '#1066 单消息拆成三个事项，各自建 Task 且已完成事项不等待兄弟事项反馈',
  '同消息复核不能改 unitKey 重授执行权，显式拆分保留旧固定版本',
]

const pattern = names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
const child = spawn(process.execPath, [
  '--test',
  '--test-name-pattern',
  pattern,
  'test/topic-runtime.test.js',
], {
  cwd: new URL('../../../../', import.meta.url),
  stdio: 'inherit',
  shell: false,
})

const exitCode = await new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('exit', resolve)
})

assert.equal(exitCode, 0, '单消息多事项正式回归失败')
