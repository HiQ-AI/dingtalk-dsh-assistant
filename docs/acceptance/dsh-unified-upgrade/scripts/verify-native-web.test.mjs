import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyNativeWeb } from './verify-native-web.mjs';

function fixture(t, { location = './', status = 303, cookies = ['session=fixture; HttpOnly'], recovery = 0, htmlStatus = 200, html = '<!doctype html><html></html>' } = {}) {
  const root = fileURLToPath(new URL('../../../tmp/', import.meta.url));
  fs.mkdirSync(root, { recursive: true }); const dir = fs.mkdtempSync(path.join(root, 'native-web-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'stdout.log'); fs.writeFileSync(log, 'Web: http://127.0.0.1:3080/?token=fixture-secret\n');
  const requests = [];
  const mock = async (url, options) => {
    requests.push({ url: String(url), options });
    if (requests.length === 1) return { ok: true, json: async () => ({ status: 'ok', recoveryIssueCount: recovery, inboundProcessing: true }) };
    if (requests.length === 2) return { status, headers: { get: () => location, getSetCookie: () => cookies } };
    return { status: htmlStatus, text: async () => html };
  };
  return { log, mock, requests };
}
for (const location of ['/', './', 'http://127.0.0.1:3080/']) test(`native root redirect ${location} exchanges cookie then reads actual HTML`, async t => {
  const f = fixture(t, { location }); const result = await verifyNativeWeb(f.log, f.mock);
  assert.equal(result.normalizedExchangeTarget, 'http://127.0.0.1:3080/');
  assert.equal(f.requests[1].options.redirect, 'manual');
  assert.equal(f.requests[2].url, 'http://127.0.0.1:3080/');
  assert.equal(f.requests[2].options.headers.cookie, 'session=fixture');
  assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
});
for (const location of ['http://example.org/', '//example.org/', '/other', '/?query=1', '/#fragment', null]) test(`rejects invalid root exchange ${location}`, async t => {
  const f = fixture(t, { location }); await assert.rejects(verifyNativeWeb(f.log, f.mock), /DEPLOY_WEB_AUTH_FAILED/);
  assert.equal(f.requests.length, 2);
});
for (const options of [{ status: 302 }, { cookies: [] }]) test(`rejects invalid exchange ${JSON.stringify(options)}`, async t => {
  const f = fixture(t, options); await assert.rejects(verifyNativeWeb(f.log, f.mock), /DEPLOY_WEB_AUTH_FAILED/);
});
test('recovery issue rejects before credential exchange', async t => {
  const f = fixture(t, { recovery: 1 }); await assert.rejects(verifyNativeWeb(f.log, f.mock), /DEPLOY_RECOVERY_ISSUES/); assert.equal(f.requests.length, 1);
});
for (const options of [{ htmlStatus: 401 }, { html: 'not HTML' }]) test(`requires authenticated 200 HTML ${JSON.stringify(options)}`, async t => {
  const f = fixture(t, options); await assert.rejects(verifyNativeWeb(f.log, f.mock), /DEPLOY_WEB_READBACK_FAILED/);
});
test('network errors containing credentials are sanitized', async t => {
  const f = fixture(t); await assert.rejects(verifyNativeWeb(f.log, async () => { throw Error('fixture-secret session=fixture'); }), error => error.message === 'DEPLOY_WEB_PROBE_FAILED');
});
