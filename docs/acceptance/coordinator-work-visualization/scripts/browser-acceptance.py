"""Actual observer + native primitives in Chrome; API responses are never fabricated."""
import argparse
import json
import hashlib
import re
import sys
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import urlopen
from playwright.sync_api import expect, sync_playwright

sys.stdout.reconfigure(encoding="utf-8")


ACCEPTANCE_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ACCEPTANCE_ROOT / "round-3"


def artifact_output(value):
    output = Path(value).resolve()
    if ACCEPTANCE_ROOT not in output.parents and output != ACCEPTANCE_ROOT:
        raise argparse.ArgumentTypeError(f"output-dir must stay under {ACCEPTANCE_ROOT}")
    return output


def read_status(url):
    try:
        with urlopen(url, timeout=5) as response:
            return response.status, json.loads(response.read())
    except HTTPError as error:
        return error.code, json.loads(error.read())


def run(args, manifest):
    cases = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=args.chrome, headless=True)
        page = browser.new_page(viewport={"width": 390, "height": 844} if args.mobile else {"width": 1440, "height": 1000}, color_scheme=args.theme)
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(args.web, wait_until="networkidle")
        page.get_by_role("button", name="钉钉群聊运行看板").click()
        page.get_by_role("button", name="协调工作", exact=True).click()
        expect(page.get_by_text(f"共 {args.expected_total} 条", exact=False)).to_be_visible()
        assert "无法连接 resident 插件" not in page.locator("body").inner_text()
        host = page.evaluate("({react:window.__acceptanceHost.realReact,primitives:window.__acceptanceHost.realPrimitives.length})")
        assert host["react"] == "18.3.1" and host["primitives"] > 100, host
        cases.append("actual-observer-native-primitives-and-http")
        if args.output_dir:
            output = Path(args.output_dir)
            output.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(output / f"{args.prefix}-list.png"), full_page=True)
        if args.expected_total == 0:
            expect(page.get_by_text("暂无协调输入", exact=True)).to_be_visible()
            cases.append("empty-store")
        else:
            page.get_by_role("button", name="下一页", exact=True).click()
            expect(page.get_by_text("第 2 页", exact=False)).to_be_visible()
            page.get_by_role("button", name="下一页", exact=True).click()
            expect(page.get_by_text("第 3 页", exact=False)).to_be_visible()
            cases.append("real-source-pagination")

            def choose(key):
                source = page.locator(f'[data-source-id="{manifest["sources"][key]}"]')
                source.click()
                article = page.get_by_role("article", name="协调工作详情")
                expect(article.get_by_role("heading", name="收到的输入")).to_be_focused()
                return article, source

            if not args.mobile:
                delayed_id = manifest["sources"]["reserved"]
                page.evaluate("id=>{const original=window.fetch;window.__acceptanceOriginalFetch=original;window.fetch=async(...args)=>{const response=await original(...args);if(String(args[0]).includes('/state/coordination-sources/'+id))await new Promise(ok=>setTimeout(ok,1200));return response}}", delayed_id)
                page.locator(f'[data-source-id="{delayed_id}"]').click()
                expect(page.get_by_text("正在读取协调详情…", exact=True)).to_be_visible()
                article, source = choose("rejected")
                expect(article.get_by_text("未接纳原因：", exact=False)).to_be_visible()
                page.wait_for_timeout(1400)
                assert "本条已接收，尚未形成正式安排。" not in article.inner_text(), "Late previous detail leaked"
                page.evaluate("window.fetch=window.__acceptanceOriginalFetch")
                article.get_by_role("button", name="返回协调输入").click()
                cases.append("delayed-real-response-does-not-overwrite-new-selection")
            for key, expected in [("reserved", "该输入尚未关联协调安排。"), ("rejected", "未接纳原因："), ("clarification", "需要澄清：")]:
                article, source = choose(key)
                expect(article.get_by_text(expected, exact=False)).to_be_visible()
                article.get_by_role("button", name="返回协调输入").click()
                expect(source).to_be_focused()
                cases.append(key + "-detail-and-keyboard-focus")
            if args.mutate:
                article, source = choose("reserved")
                mutation = page.request.post(args.web + "/__acceptance/mutate?sourceId=" + manifest["sources"]["reserved"])
                assert mutation.ok, mutation.text()
                expect(article.get_by_text("本次判断存在故障记录", exact=False)).to_be_visible(timeout=12000)
                cases.append("poll-observes-real-sqlite-production-command")
                article.get_by_role("button", name="返回协调输入").click()
            article, source = choose("completed")
            proof = article.get_by_text("正式完成证明引用", exact=True)
            expect(proof).to_be_visible()
            proof.click()
            expect(article.get_by_text("事件：", exact=False)).to_be_visible()
            cases.append("formal-completion-proof")
            article.get_by_role("button", name="返回协调输入").click()
            article, source = choose("accepted")
            expect(article.get_by_text("前置事项：", exact=False).filter(has_text="synthetic-A")).to_be_visible()
            expect(article.get_by_text("暂无当前指令的正式完成证明。", exact=True).first).to_be_visible()
            assert "等待" in article.inner_text()
            cases.append("accepted-dependency-and-waiting-not-completion")
            if args.mobile:
                assert page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth"), "mobile page overflow"
                overflow = page.locator("[data-dingtalk-observer]").evaluate("e=>({width:e.clientWidth,scroll:e.scrollWidth,overflow:[...e.querySelectorAll('*')].filter(x=>x.getBoundingClientRect().right>e.clientWidth+2).slice(0,12).map(x=>({tag:x.tagName,className:x.className,right:x.getBoundingClientRect().right,text:x.textContent.slice(0,70)}))})")
                assert overflow["scroll"] <= overflow["width"], json.dumps(overflow, ensure_ascii=False)
                cases.append("390px-detail-no-horizontal-overflow")
            if args.output_dir:
                page.screenshot(path=str(output / f"{args.prefix}-detail.png"), full_page=True)
            article.get_by_role("button", name="查看任务", exact=True).first.click()
            task_detail = page.get_by_role("region", name="任务会话详情")
            expect(task_detail.get_by_role("heading", name="[合成测试数据] synthetic-A", exact=True)).to_be_visible()
            expect(task_detail.get_by_role("heading", name="目标与要求", exact=True)).to_be_visible()
            task_status, task_dto = read_status(args.api + "/state/tasks/synthetic-A/detail")
            assert task_status == 200 and task_dto["timeline"]["version"] == 1 and task_dto["state"] == "running", task_dto
            task_detail.get_by_role("button", name="返回看板", exact=True).click()
            article = page.get_by_role("article", name="协调工作详情")
            expect(article.get_by_text("前置事项：", exact=False).filter(has_text="synthetic-A")).to_be_visible()
            expect(page.get_by_text("共 25 条 · 第 3 页", exact=True)).to_be_visible() if not args.mobile else None
            cases.append("production-task-service-drill-through-and-source-return")
            article.get_by_role("button", name="返回协调输入").click()
            page.get_by_role("button", name="筛选协调群组").click()
            page.get_by_role("menuitem", name="合成空群（非真实业务）").click()
            expect(page.get_by_text("暂无协调输入", exact=True)).to_be_visible()
            expect(page.get_by_text("共 0 条 · 第 1 页", exact=True)).to_be_visible()
            cases.append("native-select-empty-filter-and-page-reset")
            page.get_by_role("button", name="筛选协调群组").click()
            page.get_by_role("menuitem", name="全部群组", exact=True).click()
            expect(page.get_by_text(f"共 {args.expected_total} 条", exact=False)).to_be_visible()
            # Abort a real request to exercise network failure, without synthetic API data.
            pattern = "**/api/state/coordination-sources?*"
            page.route(pattern, lambda route: route.abort("failed"))
            page.get_by_role("button", name="刷新协调记录").click()
            expect(page.get_by_role("alert").filter(has_text="保留上次列表")).to_be_visible()
            cases.append("network-failure-explicit-stale-state")
            page.unroute(pattern)
            page.get_by_role("button", name="重试列表", exact=True).click()
            expect(page.get_by_role("alert").filter(has_text="保留上次列表")).to_have_count(0)
            cases.append("network-recovery")
        assert not errors, errors
        browser.close()
    return cases


parser = argparse.ArgumentParser()
parser.add_argument("--web", default="http://127.0.0.1:19087")
parser.add_argument("--api", default="http://127.0.0.1:19088")
parser.add_argument("--chrome", default="C:/Program Files/Google/Chrome/Application/chrome.exe")
parser.add_argument("--expected-total", type=int, default=25)
parser.add_argument("--mobile", action="store_true")
parser.add_argument("--theme", choices=["light", "dark"], default="light")
parser.add_argument("--output-dir", type=artifact_output, default=DEFAULT_OUTPUT)
parser.add_argument("--mutate", action="store_true", help="Change one synthetic source through the host-owned production command and verify polling")
args = parser.parse_args()
args.prefix = f"{'empty' if args.expected_total == 0 else 'seeded'}-{'mobile' if args.mobile else 'desktop'}-{args.theme}"
if not re.fullmatch(r"round-\d+", args.output_dir.name):
    parser.error("output-dir must be a round-N directory inside this acceptance root")
status, payload = read_status(args.api + "/state/coordination-sources?offset=0&limit=100")
assert status == 200 and payload["total"] == args.expected_total, (status, payload)
invalid_status, invalid_payload = read_status(args.api + "/state/coordination-sources?limit=0")
assert invalid_status == 400 and invalid_payload["error"] == "coordination_query_invalid", (invalid_status, invalid_payload)
_, manifest = read_status(args.web + "/manifest.json")
cases = run(args, manifest)
source_hashes = {}
repo = ACCEPTANCE_ROOT.parents[2]
for name in manifest["sourceHashes"]:
    data = (repo / name).read_bytes()
    source_hashes[name] = {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
assert source_hashes == manifest["sourceHashes"], "Source changed after host startup; restart host before acceptance"
report = {"pass": True, "web": args.web, "api": args.api, "synthetic": manifest["synthetic"], "hostIntegration": manifest["hostIntegration"], "expectedTotal": args.expected_total, "mobile": args.mobile, "theme": args.theme, "cases": cases,
          "hostPid": manifest["pid"], "dataRoot": manifest["dataRoot"], "launchCommand": manifest["launchCommand"], "sourceHashes": source_hashes,
          "apiEvidence": {"sourceList": {"status": status, "total": payload["total"], "returned": len(payload["sources"]), "states": sorted(set(row["state"] for row in payload["sources"]))}, "invalidPaging": {"status": invalid_status, "body": invalid_payload}}}
artifacts = {}
for path in args.output_dir.glob(args.prefix + "-*.png"):
    data = path.read_bytes()
    artifacts[path.name] = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
report["artifacts"] = artifacts
Path(args.output_dir, f"{args.prefix}-results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({"pass": True, "result": str(args.output_dir / (args.prefix + '-results.json')), "cases": cases}, ensure_ascii=False))
