import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)
for (let attempt = 1; attempt <= 20; attempt++) {
  const startedAt = new Date().toISOString()
  const child = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' })
  await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
  const closedAt = new Date().toISOString()
  const script = `$ErrorActionPreference='Stop'; $all=@(Get-CimInstance Win32_Process); $owned=[System.Collections.Generic.HashSet[int]]::new(); [void]$owned.Add(${child.pid}); do { $added=$false; foreach($item in $all){if($owned.Contains([int]$item.ParentProcessId) -and $owned.Add([int]$item.ProcessId)){$added=$true}} } while($added); $live=@($all | Where-Object { $owned.Contains([int]$_.ProcessId) } | Select-Object ProcessId,ParentProcessId,CreationDate,Name); ConvertTo-Json -InputObject $live -Compress`
  const { stdout } = await exec('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10000 })
  const live = JSON.parse(stdout)
  console.log(JSON.stringify({ attempt, pid: child.pid, startedAt, closedAt, live }))
  if (live.length) break
}
