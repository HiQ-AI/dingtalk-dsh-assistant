"""Read-only entity acceptance: installed host or isolated React/HTTP/SQLite host."""
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
FAILED_SOURCE = 'fcc522d86cd7d242fc9c7240ab672a19bc0ecbf19eb6964831e642e1ea254a16'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--forced-colors', action='store_true')
    parser.add_argument('--relations', action='store_true', help='Verify named prerequisite-to-dispatch relations and target task waiting links')
    parser.add_argument('--mobile', action='store_true')
    parser.add_argument('--web', default='http://127.0.0.1:3080')
    parser.add_argument('--api', default='http://127.0.0.1:18998')
    parser.add_argument('--log', default='D:/project/dingtalk-dsh-assistant/docs/tmp/dsh-web-local/web.log')
    parser.add_argument('--theme', choices=['light', 'dark'], default='light')
    args = parser.parse_args()
    out = args.output.resolve()
    if ROOT not in out.parents or not re.fullmatch(r'round-[1-9][0-9]*', out.name):
        parser.error('output must be a round-N under the feature acceptance root')
    prefix = f"after-{'mobile' if args.mobile else 'desktop'}-{args.theme}" + ('-forced' if args.forced_colors else '')
    target = out / f'{prefix}.json'
    if target.exists():
        parser.error('evidence already exists; choose a new round')
    out.mkdir(parents=True, exist_ok=True)
    result = dict(result='FAIL', cases=[], synthetic=urlparse(args.web).port != 3080, screenshots={}, errors=[], failedObserverApi=[], mutations=[])
    result['sourceHashes'] = {}
    for relative in ['packages/dingtalk-dsh-observer/web-client.js', 'packages/dingtalk-dsh-assistant/coordination-observer.js', 'packages/dingtalk-dsh-assistant/task-session-service.js', 'docs/acceptance/coordinator-work-visualization/scripts/refinement-browser-acceptance.py']:
        raw = (ROOT.parents[2] / relative).read_bytes()
        result['sourceHashes'][relative] = dict(bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())

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
        listing = read('/state/coordination-work?limit=100&groupId=' + quote(first['groupId'], safe=''))
        works = listing['works']
        assert len({w['id'] for w in works}) == len(works)
        result['firstGroupWorkCount'] = listing['total']
        failed_id = 'schedule:synthetic-once-failed'
        if not result['synthetic']:
            source = read('/state/coordination-sources/' + FAILED_SOURCE)
            schedule = source['snapshot']['schedules'][0]
            failed_id = 'schedule:' + schedule['scheduleId']
            assert source['source']['state'] == 'accepted'
            assert schedule['state'] == 'active' and schedule['nextDueAt'] is None
            assert source['snapshot']['occurrences'][0]['deliveryState'] == 'failed'
            assert source['snapshot']['jobs'][0]['state'] == 'completed'
            result['originalFailureFacts'] = dict(sourceAccepted=True, planActive=True, nextDueAt=None, deliveryFailed=True, jobCompleted=True)
        failed = next(w for w in works if w['id'] == failed_id)
        assert failed['result']['label'] == '提醒发送失败'
        result['cases'].append('stable-entity-dedup-and-original-failure-api')
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path='C:/Program Files/Google/Chrome/Application/chrome.exe', headless=True)
            page = browser.new_page(viewport={'width': 390, 'height': 844} if args.mobile else {'width': 1440, 'height': 1000}, color_scheme=args.theme)
            if args.forced_colors:
                page.emulate_media(forced_colors='active')
            later = page.get_by_role('button', name='稍后提醒', exact=True)
            page.add_locator_handler(later, lambda: later.click())
            reads = []
            def is_api(url):
                parsed = urlparse(url)
                return parsed.port == urlparse(args.api).port or (result['synthetic'] and parsed.port == urlparse(args.web).port and parsed.path.startswith('/api/'))
            def request(req):
                if is_api(req.url):
                    if '/state/coordination-work?' in req.url:
                        reads.append(req.url)
                    if req.method not in ['GET', 'HEAD', 'OPTIONS']:
                        result['mutations'].append(req.method)
            page.on('request', request)
            page.on('pageerror', lambda e: result['errors'].append('pageerror'))
            page.on('console', lambda m: result['errors'].append('console-error') if m.type == 'error' else None)
            page.on('response', lambda res: result['failedObserverApi'].append(res.status) if is_api(res.url) and '/state/' in res.url and res.status >= 400 else None)
            url = args.web
            if not result['synthetic']:
                log = Path(args.log).read_text(encoding='utf-8', errors='replace')
                url = [u for u in re.findall(r'http://127\.0\.0\.1:3080[^\s<>\x1b]*', log) if 'token=' in u][-1]
            page.goto(url, wait_until='domcontentloaded')
            page.get_by_role('button', name='钉钉群聊运行看板').click()
            page.get_by_role('button', name='协调工作', exact=True).click()
            panel = page.get_by_role('region', name='协调工作', exact=True)
            refresh = panel.get_by_role('button', name='刷新协调记录', exact=True)
            expect(refresh).to_be_visible()
            menu = panel.get_by_role('button', name='筛选协调群组')
            expect(menu).to_contain_text(first.get('name') or first['groupId'])
            expect(panel.get_by_text(f"共 {listing['total']} 条", exact=False)).to_be_visible()
            assert reads and all('groupId=' in u for u in reads)
            result['cases'].append('default-first-group-no-all-request')
            rows = panel.locator('[data-work-id]')
            result['visibleRows'] = rows.evaluate_all("es=>es.filter(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.width>0}).length")
            result['rowHeights'] = rows.evaluate_all('es=>es.map(e=>Math.round(e.getBoundingClientRect().height))')
            def shot(name):
                # Screenshots do not trigger locator handlers; dismiss a late Host notice normally.
                if later.is_visible():
                    later.click()
                expect(later).not_to_be_visible()
                path = out / f'{prefix}-{name}.png'
                masks = [page.locator('aside'), menu, page.locator('.observer-coordination-title, .observer-coordination-group, .observer-coordination-disclosure .observer-coordination-text, article section[aria-label] .observer-coordination-text, .observer-session-detail, article h2, article h4, article li')]
                if args.relations:
                    # Keep relation/gate/result semantics readable; mask only sensitive titles and unrelated task content.
                    masks = [page.locator('aside'), menu, page.locator('.observer-coordination-group, article h2, .observer-coordination-disclosure, [data-screenshot-private-title]'), page.locator('.observer-coordination-title').filter(has_not_text='→')]
                    if not result['synthetic']:
                        # Wrap only real task-name text; retain arrows, condition, result and waiting reason.
                        native_works = read('/state/coordination-work?limit=100')['works']
                        titles = sorted({item['title'] for work in native_works for relation in work.get('relations', [])
                                         for item in [relation['target'], *relation['prerequisites']] if item.get('title')}, key=len, reverse=True)
                        page.evaluate('''titles => {
                          const root = document.querySelector('[data-dingtalk-observer]');
                          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), nodes = [];
                          while (walker.nextNode()) nodes.push(walker.currentNode);
                          for (const node of nodes) {
                            if (!node.parentElement.closest('.observer-coordination-title, [data-dispatch-target], [data-prerequisite-task]')) continue;
                            const text = node.textContent, parts = document.createDocumentFragment(); let at = 0, matched = false;
                            while (at < text.length) {
                              const hits = titles.map(title => ({title, start: text.indexOf(title, at)})).filter(hit => hit.start >= 0).sort((a,b) => a.start-b.start || b.title.length-a.title.length);
                              if (!hits.length) { parts.append(text.slice(at)); break; }
                              const {title, start} = hits[0]; parts.append(text.slice(at, start));
                              const mask = document.createElement('span'); mask.dataset.screenshotPrivateTitle = ''; mask.textContent = title; parts.append(mask);
                              at = start + title.length; matched = true;
                            }
                            if (matched) node.replaceWith(parts);
                          }
                        }''', titles)
                try:
                    page.locator('[data-dingtalk-observer]').screenshot(path=str(path), mask=[] if result['synthetic'] else masks, mask_color='#8b929b')
                    if name.startswith('native-relation-'):
                        # The relation can sit below the mobile viewport; retain an unclipped detail image.
                        if later.is_visible():
                            later.click()
                        expect(later).not_to_be_visible()
                        detail_path = out / f'{prefix}-{name}-detail.png'
                        page.get_by_role('article', name='协调工作详情').locator('[data-dispatch-target]').first.screenshot(path=str(detail_path), mask=masks, mask_color='#8b929b')
                        detail_raw = detail_path.read_bytes()
                        result['screenshots'][detail_path.name] = dict(bytes=len(detail_raw), sha256=hashlib.sha256(detail_raw).hexdigest())
                finally:
                    page.locator('[data-screenshot-private-title]').evaluate_all("es=>es.forEach(e=>{const parent=e.parentNode;e.replaceWith(document.createTextNode(e.textContent));parent.normalize()})")
                raw = path.read_bytes()
                result['screenshots'][path.name] = dict(bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
            shot('list')
            def select_work(work, candidates):
                while panel.get_by_role('button', name='上一页', exact=True).is_enabled():
                    panel.get_by_role('button', name='上一页', exact=True).click()
                    expect(refresh).to_be_enabled()
                index = next(i for i, w in enumerate(candidates) if w['id'] == work['id'])
                for _ in range(index // 10):
                    panel.get_by_role('button', name='下一页', exact=True).click()
                    expect(refresh).to_be_enabled()
                row = panel.locator('[data-work-id="' + work['id'] + '"]')
                expect(row).to_contain_text(work['result']['label'])
                assert row.locator('[data-work-result]').count() == 1
                row.click()
                assert row.get_attribute('aria-pressed') == 'true'
                if args.forced_colors:
                    assert row.evaluate("e=>getComputedStyle(e).borderInlineStartWidth") == '2px'
                else:
                    assert row.evaluate("e=>getComputedStyle(e).boxShadow") != 'none'
                article = page.get_by_role('article', name='协调工作详情')
                expect(article).to_be_visible()
                expect(article.get_by_role('heading', level=2)).to_be_focused()
                expect(article.locator('[data-work-result]').first).to_have_text(work['result']['label'])
                return row, article
            if args.relations and result['synthetic']:
                with urlopen(args.web + '/manifest.json', timeout=20) as response:
                    relation_cases = json.load(response)['relationCases']
                result['relationCases'] = []
                for relation_case in relation_cases:
                    work = next(w for w in works if w['id'] == relation_case['workId'])
                    _, relation_article = select_work(work, works)
                    relation = relation_article.locator('[data-dispatch-target="' + relation_case['target'] + '"]')
                    expect(relation).to_be_visible()
                    prerequisite = relation.locator('[data-prerequisite-task="' + relation_case['prerequisite'] + '"]')
                    expect(prerequisite).to_be_visible()
                    expect(relation).to_contain_text('调度')
                    assert '当前指令已有正式完成证明' not in relation_article.inner_text()
                    if relation_case['name'] == 'waiting':
                        expect(relation).to_contain_text('等待')
                        with page.expect_response(lambda response: '/state/tasks/' in response.url and response.status == 200, timeout=20000):
                            relation.get_by_role('button', name=re.compile(r'^查看目标任务：')).click()
                        target_detail = page.get_by_role('region', name='任务会话详情')
                        expect(target_detail).to_be_visible()
                        gate = target_detail.get_by_role('region', name='前置任务等待')
                        expect(gate).to_be_visible()
                        expect(gate).to_contain_text('等待')
                        link = gate.locator('[data-prerequisite-task="' + relation_case['prerequisite'] + '"]')
                        expect(link).to_be_visible()
                        shot('task-waits-for-prerequisite')
                        with page.expect_response(lambda response: '/state/tasks/' in response.url and response.status == 200, timeout=20000):
                            link.click()
                        expect(page.get_by_role('region', name='任务会话详情')).to_be_visible()
                        page.get_by_role('button', name='返回看板', exact=True).click()
                        expect(relation_article).to_be_visible()
                    elif relation_case['name'] == 'pending':
                        expect(relation).to_contain_text('等待调度')
                    else:
                        expect(relation).to_contain_text('调度成功')
                        assert '尚未正式完成' not in relation.inner_text()
                    shot('relation-' + relation_case['name'])
                    result['relationCases'].append(dict(name=relation_case['name'], target=relation_case['target'], prerequisite=relation_case['prerequisite'], result=work['result']['code']))
                    relation_article.get_by_role('button', name='返回协调工作', exact=True).click()
                result['cases'].append('waiting-pending-receipted-dispatch-and-prerequisite-task-link')
            row, article = select_work(failed, works)
            for label in ['输入与变更历史', '证据与读取边界']:
                for node in article.locator('details').filter(has=page.locator('summary', has_text=label)).all():
                    assert node.get_attribute('open') is None
            expect(article.get_by_text('无后续触发安排', exact=False).first).to_be_visible()
            expect(article.get_by_text('无重试安排', exact=False).first).to_be_visible()
            shot('failed-reminder')
            article.get_by_role('button', name='返回协调工作', exact=True).click()
            expect(row).to_be_focused()
            page.keyboard.press('Tab'); page.keyboard.press('Shift+Tab')
            expect(row).to_be_focused()
            assert row.evaluate("e=>e.matches(':focus-visible')&&getComputedStyle(e).outlineWidth!=='0px'")
            result['cases'].append('failure-prominent-next-step-disclosure-and-focus')
            if result['synthetic']:
                observed = []
                for work in works:
                    if not work['id'].startswith('schedule:synthetic-') or work['id'] == 'schedule:synthetic-daily':
                        continue
                    _, article = select_work(work, works)
                    expected = 'cancelled' if work['id'].endswith('-unsent') else 'delivery_failed' if work['id'].endswith('-failed') else 'delivered' if work['id'].endswith('-delivered') else 'delivery_unknown' if work['id'].endswith('-unknown') else 'delivery_pending'
                    assert work['result']['code'] == expected
                    if 'cancelled-' in work['id'] or 'paused-' in work['id']:
                        assert work['nextStep']['triggerAt'] is None
                    if 'recurring-failed' in work['id']:
                        assert work['plan']['state'] == 'active' and work['nextStep']['triggerAt']
                    observed.append(dict(id=work['id'], result=work['result']['label']))
                    article.get_by_role('button', name='返回协调工作', exact=True).click()
                result['syntheticRenderedResults'] = observed
                assert len(observed) == 10
                result['cases'].append('ten-persisted-reminder-scenarios-rendered')
            selected_group = groups[-1] if not result['synthetic'] else first
            menu.click()
            page.get_by_role('menuitem', name=selected_group.get('name') or selected_group['groupId'], exact=True).click()
            expect(refresh).to_be_enabled()
            previous_reads = len(reads)
            refresh.click(); expect(refresh).to_be_enabled()
            page.wait_for_timeout(5600)
            assert len(reads) >= previous_reads + 2
            expect(menu).to_contain_text(selected_group.get('name') or selected_group['groupId'])
            other = read('/state/coordination-work?limit=100&groupId=' + quote(selected_group['groupId'], safe=''))['works']
            dispatch = next(w for w in other if w['kind'] in ['dispatch', 'trigger'] and w['counts']['total'] > 0)
            row, article = select_work(dispatch, other)
            expect(article.get_by_role('heading', name='任务调度关系', exact=True)).to_be_visible()
            with page.expect_response(lambda response: '/state/tasks/' in response.url and response.status == 200, timeout=20000):
                article.get_by_role('button', name=re.compile(r'^查看目标任务：')).first.click()
            expect(page.get_by_role('region', name='任务会话详情')).to_be_visible()
            page.get_by_role('button', name='返回看板', exact=True).click()
            expect(article).to_be_visible()
            expect(menu).to_contain_text(selected_group.get('name') or selected_group['groupId'])
            shot('dispatch')
            result['cases'].append('dispatch-task-return-manual-and-five-second-refresh')
            if args.relations and not result['synthetic']:
                article.get_by_role('button', name='返回协调工作', exact=True).click()
                candidates = [w for w in other if any(r.get('prerequisites') for r in w.get('relations', []))]
                assert candidates, 'NO_EXISTING_NATIVE_DEPENDENCY_RELATION'
                result['nativeRelations'] = []
                for candidate in candidates:
                    _, relation_article = select_work(candidate, other)
                    relation_data = next(r for r in candidate['relations'] if r.get('prerequisites'))
                    relation = relation_article.locator('[data-dispatch-target="' + relation_data['target']['taskId'] + '"]')
                    expect(relation).to_be_visible()
                    expect(relation).to_contain_text('前置')
                    assert relation_data['state'] not in ['running', 'completed', 'task_completed']
                    expect(relation.locator('[data-dispatch-state]')).to_have_attribute('data-dispatch-state', relation_data['state'])
                    shot('native-relation-' + str(len(result['nativeRelations']) + 1))
                    with page.expect_response(lambda response: '/state/tasks/' in response.url and response.status == 200, timeout=20000):
                        relation.get_by_role('button', name=re.compile(r'^查看目标任务：')).click()
                    target_detail = page.get_by_role('region', name='任务会话详情')
                    expect(target_detail).to_be_visible()
                    target_relation = target_detail.locator('[data-dispatch-target="' + relation_data['target']['taskId'] + '"]')
                    expect(target_relation).to_be_visible()
                    expect(target_relation.locator('[data-dispatch-state]')).to_have_attribute('data-dispatch-state', relation_data['state'])
                    if relation_data['state'] == 'waiting':
                        gate = target_relation.get_by_role('region', name='前置任务等待')
                        expect(gate).to_be_visible()
                        assert gate.locator('[data-prerequisite-task]').count() == sum(not item['fulfilled'] for item in relation_data['prerequisites'])
                    else:
                        assert target_relation.get_by_role('region', name='前置任务等待').count() == 0
                    result['nativeRelations'].append(dict(prerequisiteCount=len(relation_data['prerequisites']), state=relation_data['state'], receipt=relation_data['dispatch']['receipt'], targetPageLinked=True))
                    page.get_by_role('button', name='返回看板', exact=True).click()
                    expect(relation_article).to_be_visible()
                    relation_article.get_by_role('button', name='返回协调工作', exact=True).click()
                _, article = select_work(dispatch, other)
                result['cases'].append('existing-native-dependency-relations-and-target-pages')

            article.get_by_role('button', name='返回协调工作', exact=True).click()
            menu.click()
            page.get_by_role('menuitem', name='全部群组', exact=True).click()
            expect(refresh).to_be_enabled()
            expect(menu).to_contain_text('全部群组')
            assert any('groupId=' not in u for u in reads)
            refresh.click(); expect(refresh).to_be_enabled()
            expect(menu).to_contain_text('全部群组')
            result['cases'].append('explicit-all-selection-retained')
            if result['synthetic']:
                empty = groups[-1]
                menu.click()
                page.get_by_role('menuitem', name=empty.get('name') or empty['groupId'], exact=True).click()
                expect(panel.get_by_text('暂无协调工作', exact=True)).to_be_visible()
                assert panel.locator('[data-work-id]').count() == 0
                expect(menu).to_contain_text(empty.get('name') or empty['groupId'])
                result['cases'].append('empty-selected-group-not-fallback-all')
            result['actualTheme'] = page.locator('body').evaluate("e=>e.hasAttribute('data-ds-dark-theme')?'dark':getComputedStyle(e).backgroundColor")
            result['widths'] = page.evaluate('({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth})')
            assert result['widths']['scroll'] <= result['widths']['client']
            assert not result['errors'] and not result['mutations'] and not result['failedObserverApi']
            result['cases'].append('no-overflow-console-api-errors-or-mutations')
            browser.close()
        result['result'] = 'PASS'
    except Exception as e:
        result['failureType'] = type(e).__name__
        result['failureSignals'] = [s for s in ['intercepts pointer events', 'not visible', 'not attached', 'waiting for locator'] if s in str(e)]
        result['failureLine'] = next((f.lineno for f in reversed(traceback.extract_tb(e.__traceback__)) if f.filename == __file__), None)
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(dict(result=result['result'], file=str(target), cases=result['cases'], failureType=result.get('failureType'), failureLine=result.get('failureLine')), ensure_ascii=True))
    return 0 if result['result'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
