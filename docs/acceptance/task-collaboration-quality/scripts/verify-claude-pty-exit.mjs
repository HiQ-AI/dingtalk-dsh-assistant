import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';

const [consumerPath, cliPath, outputPath] = process.argv.slice(2);
assert.ok(consumerPath && cliPath && outputPath);
const consumer = createRequire(resolve(consumerPath));
const { Context } = consumer('@deepseek-ai/cordis');
const { LocalSubprocessRuntime } = consumer('@deepseek-ai/dsh-subprocess-local');
const ctx = new Context();
new LocalSubprocessRuntime(ctx);
const result = { wrapperPid: process.pid, modelCalls: 0, cases: [] };
try {
  for (const argument of ['--help', '--version']) {
    const terminal = await ctx.subprocess.spawnTerminal({ argv: [resolve(cliPath), argument], cwd: process.cwd(), rows: 40, cols: 160, terminalType: 'xterm-256color', graceMs: 3000 });
    let bytes = 0;
    const reading = (async () => { for await (const chunk of terminal.output) bytes += chunk.length; })();
    const outcome = await terminal.done;
    await reading;
    const pid = terminal.pid;
    await terminal.terminate();
    assert.equal(outcome.exitCode, 0);
    assert.ok(bytes > 0);
    assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
    result.cases.push({ argument, pid, outcome, bytes, status: 'PASS' });
  }
} finally { await ctx.fiber.dispose(); }
await writeFile(resolve(outputPath), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
process.once('beforeExit', async () => {
  await writeFile(resolve(outputPath) + '.natural-exit.json', JSON.stringify({ wrapperPid: process.pid, at: new Date().toISOString() }) + '\n');
});
