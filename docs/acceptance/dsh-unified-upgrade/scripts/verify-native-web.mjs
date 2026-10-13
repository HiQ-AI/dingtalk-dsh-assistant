import { readFile } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';
import { pathToFileURL } from 'node:url';

const fail = code => { throw new Error(code); };

/** 复用原Web验收合同；仅把303 Location按原生URL语义解析为同origin根目标。 */
export async function verifyNativeWeb(logPath, fetchImpl = fetch) {
  try {
    const healthResponse = await fetchImpl('http://127.0.0.1:18998/health', { signal: AbortSignal.timeout(10000) });
    if (!healthResponse.ok) fail('DEPLOY_HEALTH_UNAVAILABLE');
    const health = await healthResponse.json();
    if (!['ok', 'degraded'].includes(health.status)) fail('DEPLOY_HEALTH_UNAVAILABLE');
    if (health.recoveryIssueCount !== 0) fail('DEPLOY_RECOVERY_ISSUES');
    const log = stripVTControlCharacters(await readFile(logPath, 'utf8'));
    const urls = (log.match(/https?:\/\/[^\s<>]+:3080[^\s<>]*/g) ?? []).flatMap(value => { try { return [new URL(value)]; } catch { return []; } });
    const url = urls.filter(value => value.protocol === 'http:' && value.hostname === '127.0.0.1' && value.port === '3080' && value.searchParams.has('token')).at(-1);
    if (!url) fail('DEPLOY_WEB_CREDENTIAL_UNAVAILABLE');
    const exchange = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    const location = exchange.headers.get('location');
    let target;
    try { if (!location) fail('DEPLOY_WEB_AUTH_FAILED'); target = new URL(location, url); } catch { fail('DEPLOY_WEB_AUTH_FAILED'); }
    if (exchange.status !== 303 || target.origin !== url.origin || target.pathname !== '/' || target.search || target.hash) fail('DEPLOY_WEB_AUTH_FAILED');
    const cookie = exchange.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
    if (!cookie) fail('DEPLOY_WEB_AUTH_FAILED');
    const web = await fetchImpl(new URL('/', url), { redirect: 'manual', headers: { cookie }, signal: AbortSignal.timeout(10000) });
    if (web.status !== 200 || !(await web.text()).match(/<!doctype html|<html[\s>]/i)) fail('DEPLOY_WEB_READBACK_FAILED');
    return { recoveryIssueCount: 0, authenticatedWebStatus: 200, tokenExchangeStatus: 303,
      normalizedExchangeTarget: target.origin + '/', controlHealth: health.status,
      inboundProcessing: health.inboundProcessing === true, credentialPrinted: false };
  } catch (error) {
    // 原生fetch异常可能携带请求信息；返回固定代码，不输出token/cookie/log。
    if (/^DEPLOY_[A-Z_]+$/.test(error?.message ?? '')) throw error;
    fail('DEPLOY_WEB_PROBE_FAILED');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--log') fail('DEPLOY_WEB_ARGUMENTS_INVALID');
    console.log(JSON.stringify(await verifyNativeWeb(args[1])));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
