"""Read-only acceptance of the actual authenticated installed DSH host, never a fixture."""
import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urlparse
from urllib.request import urlopen

from playwright.sync_api import expect, sync_playwright

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parents[1]
API = "http://127.0.0.1:18998"


def read(path):
    with urlopen(API + path, timeout=20) as response:
        assert response.status == 200
        return json.load(response)


def digest(path):
    data = path.read_bytes()
    return {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def run(args, result):
    # The native launch URL is a local credential; never include it in output/errors.
    log = Path(args.log).read_text(encoding="utf-8", errors="replace")
    urls = [u for u in re.findall(r"http://127\.0\.0\.1:3080[^\s<>\x1b]*", log) if "token=" in u]
    assert urls, "NATIVE_AUTH_UNAVAILABLE"
    sources = read("/state/coordination-sources?limit=100&offset=0")
    all_sources = list(sources["sources"])
    for offset in range(100, sources["total"], 100):
        all_sources.extend(read(f"/state/coordination-sources?limit=100&offset={offset}")["sources"])
    assert all_sources, "NO_EXISTING_COORDINATION_RECORDS"
    # Only counts and state labels leave memory; no messages, actor/group/source IDs.
    details = []
    for source in all_sources:
        detail = read("/state/coordination-sources/" + quote(source["id"], safe=""))
        details.append(detail)
    target = max(details, key=lambda d: (bool(d["members"]), sum(bool(m.get("completionProof")) for m in d["members"]), sum(bool(m["dependencies"]) for m in d["members"])))
    result["existingData"] = {
        "sourceCount": sources["total"], "states": sorted({s["state"] for s in all_sources}),
        "associatedDetails": sum(bool(d["members"]) for d in details),
        "dependencyMembers": sum(bool(m["dependencies"]) for d in details for m in d["members"]),
        "proofMembers": sum(bool(m.get("completionProof")) for d in details for m in d["members"]),
    }
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=args.chrome, headless=True)
        context = browser.new_context(viewport={"width": 390, "height": 844} if args.mobile else {"width": 1440, "height": 1000}, color_scheme=args.theme)
        page = context.new_page()
        errors, failed_api, observed, mutation_requests = [], [], [], []
        page.on("pageerror", lambda error: errors.append("pageerror"))
        page.on("console", lambda msg: errors.append("console-error") if msg.type == "error" else None)

        def response(res):
            parsed = urlparse(res.url)
            if parsed.port == 18998:
                if res.status >= 400:
                    failed_api.append({"status": res.status, "route": "coordination" if "/coordination-sources" in parsed.path else "other-observer"})
                if "/state/coordination-sources" in parsed.path and res.status == 200:
                    observed.append({"kind": "detail" if "/coordination-sources/" in parsed.path else "list", "time": datetime.now(timezone.utc).isoformat()})
        page.on("response", response)
        page.on("request", lambda req: mutation_requests.append(req.method) if urlparse(req.url).port == 18998 and req.method not in ("GET", "HEAD", "OPTIONS") else None)
        page.goto(urls[-1], wait_until="domcontentloaded")
        page.get_by_role("button", name="钉钉群聊运行看板").click()
        page.get_by_role("button", name="协调工作", exact=True).click()
        panel = page.get_by_role("region", name="协调工作", exact=True)
        expect(panel.get_by_text(f"共 {sources['total']} 条", exact=False)).to_be_visible()
        result["cases"].append("actual-authenticated-host-and-installed-coordination-entry")
        result["requestedColorScheme"] = args.theme
        result["actualTheme"] = page.locator("body").evaluate("e => e.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'")
        if result["actualTheme"] != args.theme:
            result["unverified"].append("Requested color scheme differs from persisted Host theme; no Host settings changed")

        def screenshot(name):
            path = args.output / f"{args.prefix}-{name}.png"
            # Mask business text, group names, task titles and evidence; controls/layout stay real.
            masks = [page.locator(".observer-coordination-source > span:nth-child(2), .observer-coordination-source > span:nth-child(3)"),
                     page.locator(".observer-coordination-text, article h4, article ul, article ol"),
                     page.get_by_role("button", name="筛选协调群组"),
                     page.locator("aside"), page.locator(".observer-session-detail")]
            page.locator("[data-dingtalk-observer]").screenshot(path=str(path), mask=masks, mask_color="#8b929b")
            result["screenshots"][path.name] = digest(path)

        screenshot("list")
        initial = len(observed)
        page.wait_for_function("n => performance.getEntriesByType('resource').filter(e=>e.name.includes('/state/coordination-sources')).length >= n", arg=3, timeout=16000)
        page.wait_for_timeout(5500)
        assert len(observed) >= initial + 2, "AUTOMATIC_POLLING_NOT_OBSERVED"
        result["cases"].append("real-readonly-five-second-polling")
        # Dismiss the real unrelated plugin update notice using its ordinary UI.
        # Never remove an overlay or force a click through it.
        later = page.get_by_role("button", name="稍后提醒", exact=True)
        if later.is_visible():
            later.click()
            result["hostUpdateNoticeDismissed"] = True
        refresh = panel.get_by_role("button", name="刷新协调记录", exact=True)
        expect(refresh).to_be_enabled()
        with page.expect_response(lambda r: "/state/coordination-sources?" in r.url and r.status == 200):
            refresh.click()
        result["cases"].append("manual-refresh-real-http")
        if sources["total"] > 10:
            panel.get_by_role("button", name="下一页", exact=True).click()
            expect(panel.get_by_text("第 2 页", exact=False)).to_be_visible()
            panel.get_by_role("button", name="上一页", exact=True).click()
            result["cases"].append("existing-source-pagination")

        groups = read("/state/groups")
        if isinstance(groups, dict):
            groups = groups.get("groups", [])
        usable = next((g for g in groups if any(s["groupId"] == g["groupId"] for s in all_sources)), None)
        if usable:
            panel.get_by_role("button", name="筛选协调群组").click()
            # Host Menu uses native menu roles; inspect only its known existing label.
            label = usable.get("name") or usable["groupId"]
            with page.expect_response(lambda r: "/state/coordination-sources?" in r.url and "groupId=" in r.url and r.status == 200):
                page.get_by_role("menuitem", name=label, exact=True).click()
            panel.get_by_role("button", name="筛选协调群组").click()
            page.get_by_role("menuitem", name="全部群组", exact=True).click()
            expect(panel.get_by_text(f"共 {sources['total']} 条", exact=False)).to_be_visible()
            result["cases"].append("actual-group-filter-and-reset")
        else:
            result["unverified"].append("No configured group matches existing coordination sources")

        index = next(i for i, source in enumerate(all_sources) if source["id"] == target["source"]["id"])
        for _ in range(index // 10):
            panel.get_by_role("button", name="下一页", exact=True).click()
            expect(refresh).to_be_enabled()
        selected = panel.locator(f'[data-source-id="{target["source"]["id"]}"]')
        selected.click()
        article = page.get_by_role("article", name="协调工作详情")
        expect(article.get_by_role("heading", name="收到的输入")).to_be_focused()
        for label in ["已记录的判断与变更", "任务与依赖", "定时安排与触发", "证据与读取边界"]:
            expect(article.get_by_role("heading", name=label, exact=True)).to_be_visible()
        expect(article.get_by_text("已接纳不等于已完成", exact=False)).to_be_visible()
        result["cases"].append("existing-source-details-focus-and-completion-boundary")
        if any(m["dependencies"] for m in target["members"]):
            expect(article.get_by_text("前置事项：", exact=False).first).to_be_visible()
            result["cases"].append("existing-dependencies-visible")
        if any(m.get("completionProof") for m in target["members"]):
            proofs = article.locator("summary").filter(has_text="完成证明引用")
            assert proofs.count() > 0
            proofs.first.click()
            result["cases"].append("existing-version-bound-proof-visible")
        else:
            result["unverified"].append("Selected existing source has no formal proof; no proof fabricated")
        article.get_by_role("heading", name="收到的输入").scroll_into_view_if_needed()
        screenshot("detail")
        if target["members"]:
            with page.expect_response(lambda r: re.search(r"/state/tasks/[^/]+/detail", r.url) and r.status == 200):
                article.get_by_role("button", name="查看任务", exact=True).first.click()
            expect(page.get_by_role("region", name="任务会话详情")).to_be_visible()
            page.get_by_role("button", name="返回看板", exact=True).click()
            article = page.get_by_role("article", name="协调工作详情")
            expect(article.get_by_role("heading", name="收到的输入")).to_be_visible()
            result["cases"].append("actual-task-service-drill-through-and-source-return")
        article.get_by_role("button", name="返回协调输入").click()
        expect(panel.locator(f'[data-source-id="{target["source"]["id"]}"]')).to_be_focused()
        result["cases"].append("source-focus-restored")
        widths = page.evaluate("""() => ({document:{client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth},observer:(()=>{const e=document.querySelector('.observer-main');return {client:e.clientWidth,scroll:e.scrollWidth}})()})""")
        result["widths"] = widths
        assert all(v["scroll"] <= v["client"] for v in widths.values()), "HORIZONTAL_PAGE_OVERFLOW"
        result["cases"].append("no-document-or-observer-horizontal-overflow")
        result["pageConsoleErrors"] = errors
        result["failedObserverApi"] = failed_api
        result["businessMutationRequests"] = mutation_requests
        result["coordinationReadResponses"] = observed
        assert not errors and not failed_api and not mutation_requests, "BROWSER_OR_API_ERROR"
        browser.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--log", default="D:/project/dingtalk-dsh-assistant/docs/tmp/dsh-web-local/web.log")
    parser.add_argument("--chrome", default="C:/Program Files/Google/Chrome/Application/chrome.exe")
    parser.add_argument("--mobile", action="store_true")
    parser.add_argument("--theme", choices=["light", "dark"], default="light")
    args = parser.parse_args()
    args.output = args.output.resolve()
    if ROOT not in args.output.parents or not re.fullmatch(r"round-[1-9][0-9]*", args.output.name):
        parser.error("output must be a round-N under the feature acceptance root")
    args.prefix = f"native-{'mobile' if args.mobile else 'desktop'}-{args.theme}"
    args.output.mkdir(parents=True, exist_ok=True)
    target = args.output / f"{args.prefix}-results.json"
    if target.exists():
        parser.error("result already exists; choose a new round, never overwrite evidence")
    result = {"result": "FAIL", "at": datetime.now(timezone.utc).isoformat(), "actualHost": "http://127.0.0.1:3080", "cases": [], "unverified": [], "screenshots": {}, "credentialPrinted": False, "synthetic": False}
    try:
        run(args, result)
        result["result"] = "PASS"
    except Exception as error:
        # Do not serialize Playwright exceptions: they can contain credentials/business text.
        result["failureType"] = type(error).__name__
        result["failureStage"] = result["cases"][-1] if result["cases"] else "host-entry-or-data-read"
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"result": result["result"], "cases": len(result["cases"]), "file": str(target), "failureStage": result.get("failureStage")}, ensure_ascii=True))
    return 0 if result["result"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
