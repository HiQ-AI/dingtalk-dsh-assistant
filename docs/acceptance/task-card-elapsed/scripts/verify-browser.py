"""Full Observer/React fixture; synthetic HTTP only, no live backend or account.

--assets contains matching React 18 UMD react.js/react-dom.js from installed deps.
Host primitives are semantic substitutes; this is not authenticated DSH E2E.
"""
import argparse
import datetime
import json
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
from urllib.parse import urlsplit, parse_qs
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument('--assets', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--browser', default=r'C:\Program Files\Google\Chrome\Application\chrome.exe')
args = parser.parse_args()
root = Path(__file__).resolve().parents[4]
source = (root / 'packages/dingtalk-dsh-observer/web-client.js').read_text('utf-8')
needle = "module.exports = { name: 'dingtalk-dsh-observer-client'"
assert source.count(needle) == 1
source = source.replace(needle, "module.exports = { ObserverContent, name: 'dingtalk-dsh-observer-client'")
html = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;font:14px "Microsoft YaHei",sans-serif;color:#202124}button{font:inherit;box-sizing:border-box;padding:5px 10px}#app{padding:12px}</style>
<div id="app"></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>
sessionStorage.setItem('dingtalk-dsh-observer.active-page','tasks');
window.intervals=new Map();const set=window.setInterval.bind(window),clear=window.clearInterval.bind(window);
window.setInterval=(fn,ms,...args)=>{const id=set(fn,ms,...args);intervals.set(id,ms);return id};
window.clearInterval=id=>{intervals.delete(id);return clear(id)};
const h=React.createElement;const primitives={Button:({variant,size,children,...props})=>h('button',props,children),
Pill:({children,...props})=>h('span',props,children),StateDot:()=>h('span',null,'•'),
Menu:({anchor})=>anchor,IconChecklistOutlineRegular:()=>null,IconChevronDownOutlineRegular:()=>null,IconChevronUpOutlineRegular:()=>null};
window.__ModuleLoader__={load:({factory})=>{window.observer=factory(name=>name==='react'?React:primitives)}};
</script><script src="/observer.js"></script><script>ReactDOM.createRoot(document.getElementById('app')).render(h(observer.ObserverContent,{openSession:async()=>{}}))</script></html>'''
assets = {'/': html.encode(), '/observer.js': source.encode(),
          '/react.js': (args.assets / 'react.js').read_bytes(), '/react-dom.js': (args.assets / 'react-dom.js').read_bytes()}
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = assets.get(self.path)
        self.send_response(200 if body else 404)
        self.send_header('Content-Type', 'text/html;charset=utf-8' if self.path == '/' else 'text/javascript;charset=utf-8')
        self.end_headers()
        self.wfile.write(body or b'')
    def log_message(self, *unused):
        pass

now = datetime.datetime(2026, 11, 3, 12, tzinfo=datetime.timezone.utc)
iso = lambda value: value.isoformat().replace('+00:00', 'Z')
def task(identity, state, minutes, active=False):
    return {'taskId': identity, 'title': identity, 'objective': '隔离卡片验证，非业务任务。', 'groupId': 'g',
            'state': state, 'status': 'active' if active else 'completed', 'executionCount': 0,
            'updatedAt': '2026-11-03T11:21:44Z',
            'elapsedTiming': {'complete': True, 'closedMs': 0 if active else minutes * 60000,
                              'activeSince': iso(now - datetime.timedelta(minutes=minutes)) if active else None}}
tasks = [task('pending', 'queued', 0.25, True), task('running', 'running', 63, True),
         task('waiting', 'waiting', 35, True), task('completed', 'completed', 243),
         task('days', 'completed', 1560), {**task('unknown', 'completed', 0), 'elapsedTiming': {'complete': False, 'closedMs': None, 'activeSince': None}}]
modes = {'freeze': False, 'fail': False}
requests, unexpected, archive_calls, errors = [], [], [], []
server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
origin = f'http://127.0.0.1:{server.server_port}'
args.output.mkdir(parents=True, exist_ok=True)
try:
    with sync_playwright() as driver:
        browser = driver.chromium.launch(headless=True, executable_path=args.browser, args=['--no-proxy-server'])
        context = browser.new_context(viewport={'width': 1440, 'height': 1000}, locale='zh-CN', timezone_id='Asia/Shanghai', reduced_motion='reduce', service_workers='block')
        try:
            def route(route):
                request, url = route.request, urlsplit(route.request.url)
                if url.scheme + '://' + url.netloc == origin:
                    return route.continue_()
                requests.append((request.method, url.path))
                if url.scheme + '://' + url.netloc != 'http://127.0.0.1:18998':
                    unexpected.append('external'); return route.abort()
                if request.method == 'POST' and url.path == '/tasks/completed/archive':
                    archive_calls.append(url.path)
                    return route.fulfill(json={**tasks[3], 'archivedAt': iso(now), 'archivedBy': 'synthetic'})
                if request.method != 'GET':
                    unexpected.append('mutation'); return route.abort()
                if url.path == '/health':
                    return route.fulfill(json={'status': 'ok'})
                if url.path == '/state/groups':
                    return route.fulfill(json=[{'groupId': 'g', 'name': '隔离验证'}])
                if url.path == '/state/tasks':
                    if modes['fail']:
                        return route.fulfill(status=503, json={'error': 'synthetic refresh failure'})
                    state = parse_qs(url.query).get('state', [''])[0]
                    items = [{**item, 'state': 'completed', 'elapsedTiming': {**item['elapsedTiming'], 'activeSince': None}} if modes['freeze'] else item for item in tasks]
                    items = [item for item in items if item['state'] == state]
                    return route.fulfill(json={'items': items, 'total': len(items), 'offset': 0, 'limit': 10, 'revision': 'fixture'})
                unexpected.append(url.path); return route.abort()
            context.route('**/*', route)
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.clock.install(time=now)
            page.goto(origin)
            page.locator('.observer-task-footer').first.wait_for()
            page.wait_for_function("document.querySelectorAll('.observer-task-footer').length===6")
            card = lambda name: page.locator('article').filter(has=page.locator('strong', has_text=name))
            values = {name: card(name).locator('.observer-task-elapsed').inner_text() for name in ['pending','running','waiting','completed','days','unknown']}
            assert values == {'pending':'· <1m','running':'· 1h 3m','waiting':'· 35m','completed':'· 4h 3m','days':'· 1d 2h','unknown':'· —'}, values
            assert page.locator('.observer-task-activity').all_text_contents() == ['2026/11/3 19:21:44'] * 6
            assert page.evaluate("Array.from(intervals.values()).filter(ms=>ms===1000).length") == 1
            footer_height = card('completed').locator('.observer-task-footer').bounding_box()['height']
            page.screenshot(path=str(args.output / 'desktop.png'), full_page=True)
            for width in [1440, 320]:
                page.set_viewport_size({'width': width, 'height': 1000})
                for footer in page.locator('.observer-task-footer').all():
                    metrics = footer.evaluate("el=>{const d=el.querySelector('.observer-task-activity'),b=el.querySelector('button');const r=el.getBoundingClientRect();return {overflow:el.scrollWidth-el.clientWidth,dateOverflow:d.scrollWidth-d.clientWidth,buttonRight:b?b.getBoundingClientRect().right:r.right,right:r.right,dateRight:d.getBoundingClientRect().right,buttonLeft:b?b.getBoundingClientRect().left:r.right}}")
                    assert metrics['overflow'] <= 1 and metrics['dateOverflow'] <= 1, metrics
                    assert metrics['buttonRight'] <= metrics['right'] + 1 and metrics['dateRight'] <= metrics['buttonLeft'], metrics
            page.screenshot(path=str(args.output / 'narrow.png'), full_page=True)
            page.clock.run_for(61000)
            assert card('pending').locator('.observer-task-elapsed').inner_text() == '· 1m'
            assert card('completed').locator('.observer-task-elapsed').inner_text() == '· 4h 3m'
            assert card('completed').locator('.observer-task-footer').bounding_box()['height'] == footer_height
            assert not any('/detail' in path or '/executions' in path for method,path in requests)
            modes['fail'] = True
            page.clock.run_for(6000)
            assert card('completed').locator('.observer-task-activity').inner_text() == '2026/11/3 19:21:44'
            modes.update(fail=False, freeze=True)
            page.clock.run_for(6000)
            page.wait_for_function("Array.from(intervals.values()).filter(ms=>ms===1000).length===0")
            archive = card('completed').get_by_role('button', name='归档任务：completed', exact=True)
            archive.focus()
            archive.press('Enter')
            page.get_by_text('已归档：completed', exact=True).wait_for()
            assert len(archive_calls) == 1 and not unexpected and not errors, (archive_calls, unexpected, errors)
            result = {'passed': True, 'cards': 6, 'requests': len(requests), 'oneSharedClock': True,
                      'dateUnchanged': True, 'archiveCalls': len(archive_calls), 'unexpected': unexpected, 'pageErrors': errors,
                      'limits': 'real Observer and React; synthetic HTTP and host primitive adapters; no authenticated DSH E2E'}
            (args.output / 'results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), 'utf-8')
            print(json.dumps(result, ensure_ascii=False))
        finally:
            context.close()
            browser.close()
finally:
    server.shutdown()
    server.server_close()
