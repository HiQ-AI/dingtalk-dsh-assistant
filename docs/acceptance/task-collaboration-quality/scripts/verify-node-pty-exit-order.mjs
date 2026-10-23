import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const [consumerPath, outputPath] = process.argv.slice(2);
assert.ok(consumerPath && outputPath);
const consumer = createRequire(resolve(consumerPath));
const provider = createRequire(consumer.resolve('@deepseek-ai/dsh-subprocess-local'));
const ptyMain = provider.resolve('node-pty');
const { WindowsPtyAgent } = provider(join(dirname(ptyMain), 'windowsPtyAgent.js'));
const original = WindowsPtyAgent.prototype._$onProcessExit;
const calls = [];
WindowsPtyAgent.prototype._$onProcessExit = function(code) {
  // Deterministically exercise native callback ordering; never used by production.
  setTimeout(() => { calls.push(code); original.call(this, code); }, 2500);
};
const result = { wrapperPid: process.pid, cases: [] };
for (const expected of [0, 7]) {
  const terminal = provider('node-pty').spawn(process.execPath, ['-e', `console.log('exit-order');process.exitCode=${expected}`], { cwd: process.cwd(), cols: 80, rows: 24, useConptyDll: true });
  const data = terminal.onData(() => {});
  const outcome = await new Promise(resolveExit => terminal.onExit(resolveExit));
  result.cases.push({ expected, outcome, nativeCallbacksAtExit: [...calls] });
  await delay(2600);
  terminal.kill(); data.dispose();
}
WindowsPtyAgent.prototype._$onProcessExit = original;
await writeFile(resolve(outputPath), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
for (const item of result.cases) assert.equal(item.outcome.exitCode, item.expected);
