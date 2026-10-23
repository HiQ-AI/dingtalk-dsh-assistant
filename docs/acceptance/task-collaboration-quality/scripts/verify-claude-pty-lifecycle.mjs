import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [consumerArgument, outputArgument] = process.argv.slice(2);
assert.ok(consumerArgument && outputArgument, 'Usage: node verify-claude-pty-lifecycle.mjs <consumer/package.json> <new-output-directory>');
const consumer = createRequire(resolve(consumerArgument));
const root = resolve(outputArgument);
await mkdir(root);
const { Context } = consumer('@deepseek-ai/cordis');
const { LocalSubprocessRuntime } = consumer('@deepseek-ai/dsh-subprocess-local');
const result = { wrapperPid: process.pid, modelCalls: 0, cases: [] };
for (const mode of ['silent-exit', 'silent-cancel', 'dispose-running']) {
  const ctx = new Context();
  new LocalSubprocessRuntime(ctx);
  const record = { mode, startedAt: new Date().toISOString() };
  let terminal;
  try {
    const marker = join(root, `${mode}-pid.json`);
    const program = `require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,stdinTTY:process.stdin.isTTY,stdoutTTY:process.stdout.isTTY}));${mode === 'silent-exit' ? '' : 'setInterval(()=>{},1000)'}`;
    terminal = await ctx.subprocess.spawnTerminal({ argv: [process.execPath, '-e', program], cwd: root, rows: 40, cols: 160, terminalType: 'xterm-256color', graceMs: 3000 });
    record.initialPid = terminal.pid;
    const reading = (async () => { for await (const _chunk of terminal.output) { /* Drain without retaining terminal content. */ } })();
    const deadline = Date.now() + 20000;
    let child;
    while (!child && Date.now() < deadline) {
      child = await readFile(marker, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!child) await delay(10);
    }
    assert.ok(child, 'Child must publish its PID before the deadline');
    record.child = child;
    assert.equal(child.stdinTTY, true);
    assert.equal(child.stdoutTTY, true);
    record.readyPid = terminal.pid;
    assert.equal(record.readyPid, child.pid);
    if (mode === 'silent-cancel') await terminal.terminate();
    if (mode === 'dispose-running') await ctx.fiber.dispose();
    record.outcome = await terminal.done;
    await reading;
    if (mode === 'silent-exit') assert.equal(record.outcome.exitCode, 0);
    await terminal.terminate();
    await terminal.terminate();
    assert.throws(() => process.kill(child.pid, 0), error => error.code === 'ESRCH');
    record.status = 'PASS';
  } catch (error) {
    record.status = 'FAIL'; record.error = error.stack; process.exitCode = 1;
  } finally {
    if (terminal) await terminal.terminate();
    await ctx.fiber.dispose();
    record.completedAt = new Date().toISOString();
    result.cases.push(record);
    await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(record));
  }
  if (record.status !== 'PASS') break;
}
process.once('beforeExit', async () => {
  await writeFile(join(root, 'natural-before-exit.json'), JSON.stringify({ wrapperPid: process.pid, at: new Date().toISOString(), activeResources: process.getActiveResourcesInfo() }) + '\n');
});
