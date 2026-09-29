// 独立命令进程设置任务临时目录；旧检查器函数参与历史摘要，不改其实现。
import { spawn } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { checkedTaskDirectory } from './session-workspaces.js'

const [digest, root, executable, ...args] = process.argv.slice(2)
if (!isAbsolute(root ?? '') || !executable || digest !== createHash('sha256').update((await readFile(fileURLToPath(import.meta.url), 'utf8')).replace(/\r\n/g, '\n')).digest('hex')) throw Error('TASK_COMMAND_INVALID')
await checkedTaskDirectory(root, true)
const temporary = await mkdtemp(join(root, 'check-'))
const child = spawn(executable, args, { cwd: process.cwd(), env: { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary }, shell: false, windowsHide: true, stdio: 'inherit' })
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1 })
