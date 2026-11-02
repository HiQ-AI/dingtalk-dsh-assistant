"""只读测量实际认证宿主；不保存认证URL、业务正文、截图或原始网络轨迹。"""
import argparse
import json
import re
import time
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--log', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--chrome', default='C:/Program Files/Google/Chrome/Application/chrome.exe')
parser.add_argument('--check', action='store_true')
args = parser.parse_args()
urls = [url for url in re.findall(r'http://127\.0\.0\.1:3080[^\s<>\x1b]*', Path(args.log).read_text(encoding='utf-8', errors='replace')) if 'token=' in url]
assert urls and Path(args.chrome).is_file(), 'BROWSER_PREREQUISITE_MISSING'
if args.check:
    print(json.dumps({'checkOnly': True, 'businessWrites': 0, 'authAvailable': True, 'chromeAvailable': True}))
    raise SystemExit(0)

def route(url):
    parsed = urlparse(url)
    path = re.sub(r'(/state/(?:groups|topics|tasks|authorizations)/)[^/]+', r'\1:id', parsed.path)
    modules = sorted(set(re.findall(r'@(?:deepseek-ai|zzusp)/[a-zA-Z0-9._-]+', parsed.query))) if path == '/plugins/' else []
    return str(parsed.port or '') + path + (':' + ','.join(modules) if modules else '')

request_phases = {}
result = {'installedHost': True, 'browserCache': 'fresh-context', 'cases': [], 'requests': [], 'errors': [], 'businessWrites': 0}
phase = 'host-cold'
probe = '''(() => {
 const probe=window.__observerProbe={active:0,events:[]};
 const original=window.fetch;
 window.fetch=function(...args){
  const item={url:String(args[0]),start:performance.now(),headers:null,end:null,status:null};
  item.observer=new URL(item.url,location.href).port==='18998';
  probe.events.push(item);if(item.observer)probe.active++;
  return original.apply(this,args).then(response=>{
   item.headers=performance.now();item.status=response.status;
   const json=response.json.bind(response);
   response.json=()=>json().finally(()=>{item.end=performance.now()});
   return response;
  }).finally(()=>{if(item.observer)probe.active--});
 };
})()'''
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=args.chrome, headless=True)
        try:
            context = browser.new_context(viewport={'width': 1440, 'height': 1000})
            context.add_init_script(probe)
            page = context.new_page()
            def finished(request):
                if urlparse(request.url).port not in (3080, 18998):
                    return
                timing = request.timing
                result['requests'].append({'phase': request_phases.get(id(request), phase), 'route': route(request.url), 'method': request.method,
                    'type': request.resource_type, 'elapsedMs': round(timing['responseEnd'], 2),
                    'firstByteMs': round(timing['responseStart'], 2), 'bytes': request.sizes().get('responseBodySize'),
                    'status': request.response().status if request.response() else None})
                if urlparse(request.url).port == 18998 and request.method not in ('GET', 'HEAD', 'OPTIONS'):
                    result['businessWrites'] += 1
            page.on('request', lambda request: request_phases.__setitem__(id(request), phase))
            page.on('requestfinished', finished)
            page.on('requestfailed', lambda request: result['errors'].append({'route': route(request.url), 'kind': 'requestfailed'}))
            page.on('pageerror', lambda error: result['errors'].append({'kind': 'pageerror'}))
            start = time.perf_counter()
            page.goto(urls[-1], wait_until='domcontentloaded', timeout=120000)
            board = page.get_by_role('button', name='钉钉群聊运行看板', exact=True)
            board.wait_for(timeout=120000)
            result['hostEntryMs'] = round((time.perf_counter()-start)*1000, 2)
            phase = 'board-first-open'
            start = time.perf_counter()
            board.click()
            panel = page.locator('[data-dingtalk-observer]')
            panel.wait_for(timeout=60000)
            page.wait_for_function('window.__observerProbe.events.some(e=>e.url.includes("/state/groups/")&&e.end!==null) && window.__observerProbe.active===0 && window.__observerProbe.events.filter(e=>e.observer).every(e=>e.end!==null||e.status===null)', timeout=60000)
            page.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
            result['cases'].append({'phase': phase, 'dataMs': round((time.perf_counter()-start)*1000, 2)})
            for round_number in (1, 2):
                for label in ('话题', '任务看板', '人工介入', '历史任务', '告警', '群消息'):
                    phase = f'{round_number}:{label}'
                    start = time.perf_counter()
                    count = page.evaluate('window.__observerProbe.events.length')
                    panel.get_by_role('button', name=label, exact=True).click()
                    page.wait_for_function('(n)=>window.__observerProbe.events.length>n && window.__observerProbe.active===0 && window.__observerProbe.events.slice(n).filter(e=>e.observer).every(e=>e.end!==null||e.status===null)', arg=count, timeout=60000)
                    # 两帧覆盖数据回写后的提交，不使用固定延时冒充可见终态。
                    page.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
                    result['cases'].append({'phase': phase, 'dataMs': round((time.perf_counter()-start)*1000, 2)})
            phase = 'task-detail-readonly'
            count = page.evaluate('window.__observerProbe.events.length')
            panel.get_by_role('button', name='任务看板', exact=True).click()
            page.wait_for_function('(n)=>window.__observerProbe.events.length>n && window.__observerProbe.active===0 && window.__observerProbe.events.slice(n).filter(e=>e.observer).every(e=>e.end!==null||e.status===null)', arg=count, timeout=60000)
            page.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
            cards = panel.locator('article')
            if cards.count():
                cards.first.locator('button').first.click()
                page.wait_for_function('window.__observerProbe.events.some(e=>e.url.includes("/state/tasks/")&&e.url.includes("/detail")&&e.end!==null&&e.status===200)', timeout=60000)
                panel.locator('.observer-session-detail').wait_for(timeout=60000)
                page.wait_for_function('window.__observerProbe.events.some(e=>e.url.includes("/state/tasks/")&&e.url.includes("/decisions?")&&e.end!==null&&e.status===200) && window.__observerProbe.events.some(e=>e.url.includes("/state/tasks/")&&e.url.includes("/executions?")&&e.end!==null&&e.status===200) && window.__observerProbe.active===0', timeout=60000)
                page.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
                result['taskDetail'] = 'PASS'
                panel.get_by_role('button', name='返回看板', exact=True).click()
            else:
                result['taskDetail'] = 'NO_TASK_CARD'
            phase = 'host-session-list-terminal'
            page.wait_for_function('window.__observerProbe.events.some(e=>e.url.includes("api/session/list")&&e.end!==null)', timeout=90000)
            events = page.evaluate('window.__observerProbe.events')
            result['fetches'] = [{'route': route(e['url']), 'startedMs': round(e['start'], 2), 'completedMs': round(e['end'], 2) if e['end'] is not None else None, 'headersMs': round(e['headers']-e['start'], 2) if e['headers'] is not None else None,
                'jsonMs': round(e['end']-e['headers'], 2) if e['end'] is not None and e['headers'] is not None else None, 'status': e['status']} for e in events]
            result['result'] = 'PASS' if result['businessWrites'] == 0 and not result['errors'] else 'FAIL'
        finally:
            browser.close()
except Exception as error:
    result['result'] = 'FAIL'
    result['errorKind'] = type(error).__name__
Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'result': result['result'], 'hostEntryMs': result.get('hostEntryMs'), 'cases': result['cases'], 'requestCount': len(result['requests']), 'errorCount': len(result['errors'])}, ensure_ascii=True))
raise SystemExit(0 if result['result'] == 'PASS' else 1)
