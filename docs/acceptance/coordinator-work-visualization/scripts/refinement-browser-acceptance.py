"""Read-only coordination refinement: same-size native before/after or isolated source."""
import argparse
import hashlib
import json
import re
import sys
import traceback
from pathlib import Path
from urllib.parse import quote, urlparse
from urllib.request import urlopen
from playwright.sync_api import expect, sync_playwright

sys.stdout.reconfigure(encoding='utf-8')
ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--forced-colors', action='store_true')
    parser.add_argument('--baseline', action='store_true')
    parser.add_argument('--mobile', action='store_true')
    parser.add_argument('--web', default='http://127.0.0.1:3080')
    parser.add_argument('--api', default='http://127.0.0.1:18998')
    parser.add_argument('--log', default='D:/project/dingtalk-dsh-assistant/docs/tmp/dsh-web-local/web.log')
    parser.add_argument('--theme', choices=['light', 'dark'], default='light')
    args = parser.parse_args()
    out = args.output.resolve()
    if ROOT not in out.parents or not re.fullmatch(r'round-[1-9][0-9]*', out.name):
        parser.error('output must be a round-N under the feature acceptance root')
    prefix = f"{'before' if args.baseline else 'after'}-{'mobile' if args.mobile else 'desktop'}-{args.theme}"
    if args.forced_colors:
        prefix += '-forced'
    target = out / f'{prefix}.json'
    if target.exists():
        parser.error('evidence already exists; choose a new round')
    out.mkdir(parents=True, exist_ok=True)
    source = ROOT.parents[2] / 'packages/dingtalk-dsh-observer/web-client.js'
    raw_source = source.read_bytes()
    result = dict(sourceIdentity=dict(bytes=len(raw_source), sha256=hashlib.sha256(raw_source).hexdigest()), result='FAIL', cases=[], synthetic=urlparse(args.web).port != 3080, screenshots={}, errors=[], failedObserverApi=[], mutations=[])

    def read(path):
        with urlopen(args.api + path, timeout=20) as response:
            return json.load(response)

    try:
        groups = read('/state/groups')
        if isinstance(groups, dict):
            groups = groups.get('groups', [])
        groups = [g for g in groups if g.get('groupId')]
        assert groups, 'NO_VALID_GROUP'
        first = groups[0]
        sources = read('/state/coordination-sources?limit=100&groupId=' + quote(first['groupId'], safe=''))
        result['firstGroupSourceCount'] = sources['total']
        details = [read('/state/coordination-sources/' + quote(s['id'], safe='')) for s in sources['sources']]
        result['dataShape'] = dict(groups=len(groups), taskSources=sum(bool(d['members']) for d in details), scheduleSources=sum(bool((d.get('snapshot') or {}).get('schedules')) for d in details))
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path='C:/Program Files/Google/Chrome/Application/chrome.exe', headless=True)
            page = browser.new_page(viewport={'width': 390, 'height': 844} if args.mobile else {'width': 1440, 'height': 1000}, color_scheme=args.theme)
            if args.forced_colors:
                page.emulate_media(forced_colors='active')
            later = page.get_by_role('button', name='稍后提醒', exact=True)
            def dismiss_host_update():
                later.click()
                result['hostUpdateNoticeDismissals'] = result.get('hostUpdateNoticeDismissals', 0) + 1
            # Host polling can reopen this unrelated notice; use its ordinary dismiss action.
            page.add_locator_handler(later, dismiss_host_update)
            reads = []
            page.on('pageerror', lambda e: result['errors'].append('pageerror'))
            page.on('console', lambda m: result['errors'].append('console-error') if m.type == 'error' else None)
            def request(req):
                if urlparse(req.url).port != urlparse(args.api).port:
                    return
                if '/state/coordination-sources?' in req.url:
                    reads.append(req.url)
                if req.method not in ['GET', 'HEAD', 'OPTIONS']:
                    result['mutations'].append(req.method)
            page.on('response', lambda res: result['failedObserverApi'].append(res.status) if urlparse(res.url).port == urlparse(args.api).port and '/state/' in res.url and res.status >= 400 else None)
            page.on('request', request)
            url = args.web
            if not result['synthetic']:
                log = Path(args.log).read_text(encoding='utf-8', errors='replace')
                url = [u for u in re.findall(r'http://127\.0\.0\.1:3080[^\s<>\x1b]*', log) if 'token=' in u][-1]
            page.goto(url, wait_until='domcontentloaded')
            page.get_by_role('button', name='钉钉群聊运行看板').click()
            page.get_by_role('button', name='协调工作', exact=True).click()
            panel = page.get_by_role('region', name='协调工作', exact=True)
            expect(panel.get_by_role('button', name='刷新协调记录', exact=True)).to_be_visible()
            later = page.get_by_role('button', name='稍后提醒', exact=True)
            if later.is_visible():
                later.click()
            menu = panel.get_by_role('button', name='筛选协调群组')
            expect(panel.get_by_text('共 ', exact=False).first).to_be_visible()
            result['initialAllGroupRequests'] = sum('groupId=' not in u for u in reads)
            if args.baseline:
                menu.click()
                page.get_by_role('menuitem', name=first.get('name') or first['groupId'], exact=True).click()
            else:
                assert result['initialAllGroupRequests'] == 0, 'FLASHED_ALL_GROUPS'
                expect(menu).to_contain_text(first.get('name') or first['groupId'])
                result['cases'].append('default-first-group-no-all-request')
            expect(panel.get_by_text(f"共 {sources['total']} 条", exact=False)).to_be_visible()
            rows = panel.locator('[data-source-id]')
            if sources['total']:
                expect(rows.first).to_be_visible()
            result['visibleRows'] = rows.evaluate_all("es=>es.filter(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.width>0}).length")
            result['rowHeights'] = rows.evaluate_all('es=>es.map(e=>Math.round(e.getBoundingClientRect().height))')
            result['viewport'] = page.viewport_size
            def shot(name):
                path = out / f'{prefix}-{name}.png'
                masks = [page.locator('aside'), menu, page.locator('.observer-coordination-source > span, .observer-coordination-group, .observer-coordination-text, .observer-session-detail, article h2, article h4, article li, .observer-coordination-title')]
                page.locator('[data-dingtalk-observer]').screenshot(path=str(path), mask=[] if result['synthetic'] else masks, mask_color='#8b929b')
                raw = path.read_bytes()
                result['screenshots'][path.name] = dict(bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
            shot('list')
            chosen = max(details, key=lambda d: (bool(d['members']), bool((d.get('snapshot') or {}).get('schedules'))), default=None)
            if chosen:
                row = panel.locator('[data-source-id="' + chosen['source']['id'] + '"]')
                index = next(i for i, source in enumerate(sources['sources']) if source['id'] == chosen['source']['id'])
                for _ in range(index // 10):
                    panel.get_by_role('button', name='下一页', exact=True).click()
                    expect(panel.get_by_role('button', name='刷新协调记录', exact=True)).to_be_enabled()
                if row.count():
                    if not args.baseline:
                        row.focus()
                        page.keyboard.press('Tab')
                        page.keyboard.press('Shift+Tab')
                        expect(row).to_be_focused()
                        focus = row.evaluate("e=>({visible:e.matches(':focus-visible'),width:getComputedStyle(e).outlineWidth})")
                        assert focus['visible'] and focus['width'] != '0px'
                        result['keyboardFocus'] = focus
                    row.click()
                    if not args.baseline and not args.mobile:
                        selected = row.evaluate("e=>({pressed:e.getAttribute('aria-pressed'),border:getComputedStyle(e).borderWidth,marker:getComputedStyle(e).boxShadow,bg:getComputedStyle(e).backgroundColor})")
                        assert selected['pressed'] == 'true'
                        if args.forced_colors:
                            assert page.evaluate("matchMedia('(forced-colors: active)').matches")
                            assert row.evaluate("e=>getComputedStyle(e).borderInlineStartWidth") == '2px'
                        else:
                            assert selected['border'] == '0px' and selected['marker'] != 'none'
                        result['selectedStyle'] = selected
                    article = page.get_by_role('article', name='协调工作详情')
                    expect(article).to_be_visible()
                    expect(article.get_by_role('heading', level=2)).to_be_focused()
                    if not args.baseline:
                        expect(article.get_by_text('已接纳不等于已完成', exact=False)).to_be_visible()
                        if chosen['members']:
                            expect(article.get_by_role('heading', name='任务调度', exact=True)).to_be_visible()
                            expect(article.get_by_text('下一动作：', exact=False).first).to_be_visible()
                        if not (chosen.get('snapshot') or {}).get('schedules'):
                            assert not article.get_by_role('heading', name='定时安排', exact=True).count()
                        if (chosen.get('snapshot') or {}).get('schedules'):
                            expect(article.get_by_role('heading', name='定时安排', exact=True)).to_be_visible()
                            expect(article.get_by_text('下次触发：', exact=False).first).to_be_visible()
                            expect(article.get_by_text('周期：', exact=False).first).to_be_visible()
                        for label in ['原始输入', '证据与读取边界']:
                            node = article.locator('details').filter(has=page.locator('summary', has_text=label)).first
                            assert node.get_attribute('open') is None
                        result['cases'].append('focus-type-priority-and-progressive-disclosure')
                        if chosen['members']:
                            article.get_by_role('button', name='查看任务', exact=True).first.click()
                            expect(page.get_by_role('region', name='任务会话详情')).to_be_visible()
                            page.get_by_role('button', name='返回看板', exact=True).click()
                            expect(article).to_be_visible()
                            expect(menu).to_contain_text(first.get('name') or first['groupId'])
                            result['cases'].append('task-return-keeps-source-and-group')
                    shot('detail')
                    article.get_by_role('button', name='返回协调输入').click()
                    expect(row).to_be_focused()
                    result['cases'].append('source-focus-restoration')
            if not args.baseline:
                timed = next((d for d in details if (d.get('snapshot') or {}).get('schedules')), None)
                if timed:
                    while not panel.get_by_text('第 1 页', exact=False).count():
                        panel.get_by_role('button', name='上一页', exact=True).click()
                        expect(panel.get_by_role('button', name='刷新协调记录', exact=True)).to_be_enabled()
                    index = next(i for i, s in enumerate(sources['sources']) if s['id'] == timed['source']['id'])
                    for _ in range(index // 10):
                        panel.get_by_role('button', name='下一页', exact=True).click()
                        expect(panel.get_by_role('button', name='刷新协调记录', exact=True)).to_be_enabled()
                    panel.locator('[data-source-id="' + timed['source']['id'] + '"]').click()
                    article = page.get_by_role('article', name='协调工作详情')
                    expect(article.get_by_role('heading', name='定时安排', exact=True)).to_be_visible()
                    expect(article.get_by_text('下次触发：', exact=False).first).to_be_visible()
                    expect(article.get_by_text('周期：', exact=False).first).to_be_visible()
                    if not timed['members']:
                        assert not article.get_by_role('heading', name='任务调度', exact=True).count()
                    shot('schedule')
                    article.get_by_role('button', name='返回协调输入').click()
                    result['cases'].append('real-schedule-status-next-trigger-rule-no-empty-task')
                selected_group = groups[1] if len(groups) > 1 else first
                menu.click()
                page.get_by_role('menuitem', name=selected_group.get('name') or selected_group['groupId'], exact=True).click()
                expect(menu).to_contain_text(selected_group.get('name') or selected_group['groupId'])
                refresh = panel.get_by_role('button', name='刷新协调记录', exact=True)
                expect(refresh).to_be_enabled()
                refresh.click()
                expect(refresh).to_be_enabled()
                page.wait_for_timeout(5600)
                expect(menu).to_contain_text(selected_group.get('name') or selected_group['groupId'])
                other_sources = read('/state/coordination-sources?limit=100&groupId=' + quote(selected_group['groupId'], safe=''))
                other_details = [read('/state/coordination-sources/' + quote(s['id'], safe='')) for s in other_sources['sources']]
                dispatch = next((d for d in other_details if d['members']), None)
                if dispatch:
                    index = next(i for i, s in enumerate(other_sources['sources']) if s['id'] == dispatch['source']['id'])
                    for _ in range(index // 10):
                        panel.get_by_role('button', name='下一页', exact=True).click()
                        expect(refresh).to_be_enabled()
                    panel.locator('[data-source-id="' + dispatch['source']['id'] + '"]').click()
                    article = page.get_by_role('article', name='协调工作详情')
                    expect(article.get_by_role('heading', name='任务调度', exact=True)).to_be_visible()
                    expect(article.get_by_text('下一动作：', exact=False).first).to_be_visible()
                    update_notice = page.get_by_role('button', name='稍后提醒', exact=True)
                    if update_notice.is_visible():
                        update_notice.click()
                        result['hostUpdateNoticeDismissedBeforeTask'] = True
                    with page.expect_response(lambda response: '/state/tasks/' in response.url and response.status == 200, timeout=20000):
                        article.get_by_role('button', name='查看任务', exact=True).first.click()
                    expect(page.get_by_role('region', name='任务会话详情')).to_be_visible()
                    page.get_by_role('button', name='返回看板', exact=True).click()
                    expect(article).to_be_visible()
                    expect(menu).to_contain_text(selected_group.get('name') or selected_group['groupId'])
                    result['cases'].append('other-group-dispatch-and-task-return')
                    shot('dispatch')
                assert all('groupId=' in u for u in reads), 'UNEXPECTED_ALL_REQUEST'
                result['cases'].append('manual-selection-retained-on-refresh-and-poll')
            result['actualTheme'] = page.locator('body').evaluate("e=>e.hasAttribute('data-ds-dark-theme')?'dark':getComputedStyle(e).backgroundColor")
            result['widths'] = page.evaluate("({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth})")
            assert result['widths']['scroll'] <= result['widths']['client']
            result['cases'].append('no-horizontal-overflow')
            assert not result['errors'] and not result['mutations'] and not result['failedObserverApi']
            browser.close()
        result['result'] = 'PASS'
    except Exception as e:
        result['failureType'] = type(e).__name__
        result['failureSignals'] = [signal for signal in ['intercepts pointer events', 'not stable', 'outside of the viewport', 'not visible', 'not attached', 'waiting for locator'] if signal in str(e)]
        result['failureLine'] = next((frame.lineno for frame in reversed(traceback.extract_tb(e.__traceback__)) if frame.filename == __file__), None)
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(dict(result=result['result'], file=str(target), visibleRows=result.get('visibleRows'), cases=result['cases'], failureType=result.get('failureType')), ensure_ascii=True))
    return 0 if result['result'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
