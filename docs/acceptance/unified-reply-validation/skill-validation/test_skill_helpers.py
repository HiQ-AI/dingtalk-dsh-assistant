"""离线回归 skill helper；只用进程内替身和禁止网络的本地 Edge 页面。"""

import argparse
import importlib.util
import json
import sys
import tempfile
import threading
import traceback
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import quote

sys.dont_write_bytecode = True
parser = argparse.ArgumentParser()
parser.add_argument("--skills-root", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--browser", required=True)
args = parser.parse_args()
output = Path(args.output).resolve()
output.parent.mkdir(parents=True, exist_ok=True)


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, Path(args.skills_root) / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


auth = load("hiq_auth", "baibu-uat-account-verify/scripts/hiq_uat_session.py")
ui = load("page_acceptance", "business-development/scripts/page_acceptance.py")
ORIGIN = "https://uat-fixture.invalid"
TOKEN = "synthetic-in-memory-token"
USER_ID = "fixture-user"


class Reply:
    def __init__(self, body):
        self.body = body

    def json(self):
        return self.body


class FakeContext:
    """模拟认证服务：只有本次令牌匹配才能注销，注销后该令牌 current 拒绝。"""

    def __init__(self, *, identity="match", revoke=True, fail_logout=False, cookie_user=USER_ID):
        self.request = self
        self.active = True
        self.identity = identity
        self.revoke = revoke
        self.fail_logout = fail_logout
        self.cookie_user = cookie_user
        self.events = []
        self.closed = False
        self.cleared = False

    def cookies(self, origin):
        assert origin == ORIGIN
        return [{"name": "user", "value": quote(json.dumps({"userId": self.cookie_user, "accessToken": TOKEN}))}]

    def _authenticated(self, headers):
        return headers.get("authorization") == TOKEN and headers.get("userid") == USER_ID

    def get(self, url, *, headers):
        assert url == ORIGIN + auth.HiqUatSession.CURRENT
        self.events.append("current")
        if not self.active or not self._authenticated(headers):
            return Reply({"code": 401})
        if self.identity == "unavailable":
            return Reply({"code": 503})
        return Reply({"code": "200", "data": {"user": {"id": USER_ID if self.identity == "match" else "another-user"}, "menus": []}})

    def post(self, url, *, headers, data):
        assert url == ORIGIN + auth.HiqUatSession.LOGOUT and data == {}
        self.events.append("logout")
        if self.fail_logout:
            raise RuntimeError("synthetic secret must never enter output")
        if not self._authenticated(headers):
            return Reply({"code": 401})
        if self.revoke:
            self.active = False
        return Reply({"code": 200})

    def clear_cookies(self):
        self.cleared = True

    def close(self):
        self.closed = True


def login_without_response_header(session):
    session.mark_login_submitted()
    # 此响应没有任何 Authorization 头；认证来源为本 context 的 user Cookie。
    session.record_login({"code": "200", "data": {"userId": USER_ID}})


class AuthScenarios(unittest.TestCase):
    def test_managed_login_without_authorization_response_header(self):
        context = FakeContext()
        with auth.HiqUatSession(context, ORIGIN) as session:
            login_without_response_header(session)
            data = session.verify_identity()
            self.assertEqual(data["menus"], [])
        self.assertTrue(session.evidence["logoutVerified"])
        self.assertEqual(context.events, ["current", "logout", "current"])
        self.assertTrue(context.closed and context.cleared)

    def test_page_failure_after_login_before_identity_still_cleans(self):
        context = FakeContext()
        with self.assertRaisesRegex(RuntimeError, "fixture navigation failed"):
            with auth.HiqUatSession(context, ORIGIN) as session:
                session.mark_login_submitted()
                response = Reply({"code": 200, "data": {"userId": USER_ID}})
                response.url = ORIGIN + auth.HiqUatSession.LOGIN
                response.request = SimpleNamespace(method="POST")
                session.observe(response)
                raise RuntimeError("fixture navigation failed")
        self.assertTrue(session.evidence["logoutVerified"])
        self.assertEqual(context.events, ["current", "logout", "current"])

    def test_current_request_headers_are_reused_without_cookie_fallback(self):
        context = FakeContext(cookie_user="unrelated-cookie")
        with auth.HiqUatSession(context, ORIGIN) as session:
            login_without_response_header(session)
            response = Reply({"code": 200, "data": {"user": {"id": USER_ID}}})
            response.url = ORIGIN + auth.HiqUatSession.CURRENT
            response.request = SimpleNamespace(method="GET", all_headers=lambda: {"Authorization": TOKEN, "UserId": USER_ID, "Cookie": "must-not-be-copied"})
            session.observe(response)
            session.verify_identity()
        self.assertTrue(session.evidence["logoutVerified"])
        self.assertNotIn(TOKEN, json.dumps(session.evidence))

    def test_identity_unavailable_still_attempts_owned_logout(self):
        context = FakeContext(identity="unavailable")
        with self.assertRaises(auth.SessionCheckFailed):
            with auth.HiqUatSession(context, ORIGIN) as session:
                login_without_response_header(session)
                session.verify_identity()
        self.assertIn("logout", context.events)
        self.assertFalse(session.evidence["logoutVerified"])
        self.assertEqual(session.evidence["cleanupState"], "identity-unverified")
        self.assertEqual(session.evidence["postLogoutCode"], 401)

    def test_mismatched_identity_is_not_logged_out(self):
        context = FakeContext(identity="mismatch")
        with self.assertRaises(auth.SessionCheckFailed):
            with auth.HiqUatSession(context, ORIGIN) as session:
                login_without_response_header(session)
                session.verify_identity()
        self.assertNotIn("logout", context.events)
        self.assertTrue(context.closed)
        self.assertEqual(session.evidence["cleanupState"], "unknown")

    def test_wrong_cookie_identity_does_not_supply_cleanup_material(self):
        context = FakeContext(cookie_user="another-user")
        with auth.HiqUatSession(context, ORIGIN) as session:
            login_without_response_header(session)
        self.assertEqual(context.events, [])
        self.assertEqual(session.evidence["cleanupState"], "unknown")

    def test_logout_200_without_revocation_is_failure(self):
        context = FakeContext(revoke=False)
        with auth.HiqUatSession(context, ORIGIN) as session:
            login_without_response_header(session)
            session.verify_identity()
        self.assertFalse(session.evidence["logoutVerified"])
        self.assertEqual(session.evidence["cleanupState"], "failed")

    def test_logout_exception_does_not_prevent_close_or_leak(self):
        context = FakeContext(fail_logout=True)
        with auth.HiqUatSession(context, ORIGIN) as session:
            login_without_response_header(session)
            session.verify_identity()
        self.assertTrue(context.closed)
        self.assertEqual(session.evidence["cleanupState"], "unknown")
        serialized = json.dumps(session.evidence)
        for secret in (TOKEN, USER_ID, "synthetic secret"):
            self.assertNotIn(secret, serialized)

    def test_unknown_login_is_preserved_without_retry(self):
        context = FakeContext()
        with auth.HiqUatSession(context, ORIGIN) as session:
            session.mark_login_submitted()
        self.assertEqual(context.events, [])
        self.assertEqual(session.evidence["cleanupState"], "unknown-login-result")

    def test_current_request_error_is_sanitized_at_helper_boundary(self):
        class BrokenContext(FakeContext):
            def get(self, url, *, headers):
                raise RuntimeError("authorization=DO-NOT-PERSIST " + TOKEN)
        context = BrokenContext()
        try:
            with auth.HiqUatSession(context, ORIGIN) as session:
                login_without_response_header(session)
                session.verify_identity()
        except auth.SessionCheckFailed as error:
            self.assertEqual(str(error), "auth.current-request")
            diagnostic = "".join(traceback.format_exception(error))
            self.assertNotIn("DO-NOT-PERSIST", diagnostic)
            self.assertNotIn(TOKEN, diagnostic)
        else:
            self.fail("unsafe request error must become a fixed SessionCheckFailed")
        self.assertTrue(context.closed)
        self.assertIn("logout", context.events)
        self.assertEqual(session.evidence["cleanupState"], "unknown")

    def test_finish_is_idempotent(self):
        context = FakeContext()
        with auth.HiqUatSession(context, ORIGIN) as session:
            login_without_response_header(session)
        session.finish()
        self.assertEqual(context.events.count("logout"), 1)


class PageScenarios(unittest.TestCase):
    def test_readonly_post_exact_path_and_origin(self):
        policy = ui.ReadOnlyApiPolicy(ORIGIN, {("POST", "/api/dataset/approval/list")})
        self.assertTrue(policy.allows("POST", ORIGIN + "/api/dataset/approval/list"))
        self.assertFalse(policy.allows("POST", ORIGIN + "/api/dataset/approval/approve?accessToken=dummy-secret"))
        self.assertFalse(policy.allows("POST", "https://other.invalid/api/dataset/approval/list"))
        self.assertFalse(policy.allows("GET", ORIGIN + "/api/dataset/approval/list"))
        self.assertNotIn("dummy-secret", json.dumps(policy.blocked))
        self.assertEqual(policy.blocked[0]["path"], "/api/dataset/approval/approve")

    def test_readonly_account_without_add_is_correct(self):
        report = ui.PageAcceptance()
        report.check_control_permission("unit-page", set(), "UnitBaseCreate", False)
        self.assertTrue(all(c["passed"] for c in report.checks))
        with self.assertRaises(ui.AcceptanceFailure):
            report.check_control_permission("unit-page", {"UnitBaseCreate"}, "UnitBaseCreate", False)
        self.assertEqual(report.checks[-1]["expected"], True)
        self.assertEqual(report.checks[-1]["actual"], False)

    def test_missing_permissions_cannot_be_assumed_readonly(self):
        report = ui.PageAcceptance()
        with self.assertRaisesRegex(ui.AcceptanceFailure, "permissions-read"):
            report.check_control_permission("unit-page", None, "UnitBaseCreate", False)

    def test_failed_assertion_has_safe_stage_expected_and_actual(self):
        report = ui.PageAcceptance()
        with self.assertRaisesRegex(ui.AcceptanceFailure, "unit-page:legacy-entry-count"):
            report.check("unit-page", "legacy-entry-count", 0, 2)
        self.assertEqual(report.result()["status"], "FAIL")
        self.assertEqual(report.checks[-1], {"stage": "unit-page", "assertionId": "legacy-entry-count", "expected": 0, "actual": 2, "passed": False})
        with self.assertRaises(ValueError):
            report.check("auth", "unsafe-response", TOKEN, TOKEN)

    def test_pending_visual_review_and_conflicting_error_image(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "fixture.bin"
            file.write_bytes(b"local screenshot substitute for hash binding")
            checks = ui.PageAcceptance()
            checks.check("unit-page", "legacy-entry-count", 0, 0)
            checks.add_screenshot("unit-page", file)
            automatic = checks.result()
            self.assertEqual(automatic["status"], "PENDING_VISUAL_REVIEW")
            reviewed = ui.finalize_visual_reviews(automatic, {"unit-page": (file, 1)})
            self.assertEqual(reviewed["status"], "FAIL")
            self.assertEqual(reviewed["checks"][-1]["assertionId"], "visual-errors")
            # 失败结果不能在后续填写 0 后被冲掉，必须保留旧轮次另行修复。
            self.assertEqual(ui.finalize_visual_reviews(reviewed, {"unit-page": (file, 0)})["status"], "FAIL")

    def test_screenshots_without_automatic_assertions_never_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "fixture.bin"
            file.write_bytes(b"only an image is not business acceptance")
            checks = ui.PageAcceptance()
            checks.add_screenshot("one", file)
            report = ui.finalize_visual_reviews(checks.result(), {"one": (file, 0)})
            self.assertEqual(report["status"], "PENDING_AUTOMATIC_CHECKS")
            self.assertEqual(report["automaticCheckCount"], 0)
            self.assertEqual(ui.finalize_visual_reviews(report, {"one": (file, 0)})["status"], "PENDING_AUTOMATIC_CHECKS")

    def test_clean_visual_review_checks_all_files_and_hashes(self):
        with tempfile.TemporaryDirectory() as directory:
            first, second = Path(directory) / "one.bin", Path(directory) / "two.bin"
            first.write_bytes(b"one")
            second.write_bytes(b"two")
            checks = ui.PageAcceptance()
            checks.check("pages", "visible-errors", 0, 0)
            checks.add_screenshot("one", first)
            checks.add_screenshot("two", second)
            report = ui.finalize_visual_reviews(checks.result(), {"one": (first, 0)})
            self.assertEqual(report["status"], "PENDING_VISUAL_REVIEW")
            self.assertEqual(ui.finalize_visual_reviews(report, {"two": (second, 0)})["status"], "PENDING_VISUAL_REVIEW")
            self.assertEqual(ui.finalize_visual_reviews(report, {"one": (first, 0), "two": (second, 0)})["status"], "PASS")
            second.write_bytes(b"replacement")
            self.assertEqual(ui.finalize_visual_reviews(report, {"two": (second, 0)})["status"], "FAIL")

    def test_external_exception_cannot_be_swallowed_as_pass(self):
        checks = ui.PageAcceptance()
        checks.record_failure("unit-page", "query-button-timeout")
        self.assertEqual(checks.result()["status"], "FAIL")

    def test_actual_local_browser_error_and_clean_pages(self):
        from playwright.sync_api import sync_playwright
        # 不访问 UAT、不加载任何远端页面。网络请求全部中止。
        fixtures = output.parent / "browser-fixtures"
        fixtures.mkdir(exist_ok=True)
        browser_results = {}
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, executable_path=args.browser)
            try:
                page = browser.new_page(viewport={"width": 900, "height": 480})
                page.route("**/*", lambda route: route.abort())
                for variant in ("error", "clean"):
                    error_html = '<div class="el-message--error">Network Error</div>' if variant == "error" else ""
                    page.set_content('<style>body{font:24px sans-serif;padding:30px;background:#eef3f9}button{padding:10px 24px}.el-message--error{background:#fce4e4;color:#9e1111;padding:20px;margin-bottom:25px}table{margin-top:20px;width:100%;background:white}td{padding:20px}</style><h1>Local acceptance fixture</h1>' + error_html + '<button>Query</button><table><tr><td>Read-only row</td></tr></table>')
                    checks = ui.PageAcceptance()
                    checks.check_control_permission("unit-page", set(), "UnitBaseCreate", page.get_by_role("button", name="Add", exact=True).count() > 0)
                    errors = page.locator(".el-message--error:visible").count()
                    try:
                        checks.check("unit-page", "visible-errors", 0, errors)
                    except ui.AcceptanceFailure:
                        pass
                    screenshot = fixtures / (variant + ".png")
                    page.screenshot(path=str(screenshot))
                    checks.add_screenshot("unit-page", screenshot)
                    report = checks.result()
                    browser_results[variant] = report
                    self.assertEqual(report["status"], "FAIL" if variant == "error" else "PENDING_VISUAL_REVIEW")
                (fixtures / "automatic-results.json").write_text(json.dumps(browser_results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            finally:
                browser.close()

    def test_browser_allows_reviewed_post_and_blocks_business_write(self):
        from playwright.sync_api import sync_playwright
        received = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *unused):
                pass

            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(b"<p>Local query policy fixture</p>")

            def do_POST(self):
                received.append(self.path)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"code":200}')

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        origin = f"http://127.0.0.1:{server.server_port}"
        policy = ui.ReadOnlyApiPolicy(origin, {("POST", "/api/query")})
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True, executable_path=args.browser)
                try:
                    page = browser.new_page()
                    def handle(route):
                        req = route.request
                        if req.url.startswith(origin + "/api/"):
                            route.continue_() if policy.allows(req.method, req.url) else route.abort()
                        elif req.url == origin + "/" and req.method == "GET":
                            route.continue_()
                        else:
                            route.abort()
                    page.route("**/*", handle)
                    page.goto(origin)
                    result = page.evaluate("""async () => {
                        const query = await fetch('/api/query', {method:'POST'}).then(r=>r.json());
                        const writeBlocked = await fetch('/api/save', {method:'POST'}).then(()=>false,()=>true);
                        return {queryCode:query.code, writeBlocked};
                    }""")
                    self.assertEqual(result, {"queryCode": 200, "writeBlocked": True})
                    self.assertEqual(received, ["/api/query"])
                    self.assertEqual(policy.blocked, [{"method": "POST", "path": "/api/save", "sameOrigin": True}])
                finally:
                    browser.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


class EvidenceResult(unittest.TextTestResult):
    def __init__(self, *params, **kwargs):
        super().__init__(*params, **kwargs)
        self.cases = []

    def addSuccess(self, test):
        super().addSuccess(test)
        self.cases.append({"case": test.id().split(".")[-1], "status": "PASS"})

    def addFailure(self, test, error):
        super().addFailure(test, error)
        self.cases.append({"case": test.id().split(".")[-1], "status": "FAIL"})

    def addError(self, test, error):
        super().addError(test, error)
        self.cases.append({"case": test.id().split(".")[-1], "status": "ERROR"})


suite = unittest.TestSuite([unittest.defaultTestLoader.loadTestsFromTestCase(AuthScenarios), unittest.defaultTestLoader.loadTestsFromTestCase(PageScenarios)])
result = unittest.TextTestRunner(verbosity=2, resultclass=EvidenceResult).run(suite)
report = {"passed": result.wasSuccessful(), "testsRun": result.testsRun, "failures": len(result.failures), "errors": len(result.errors), "cases": result.cases,
          "scope": "in-memory auth service plus isolated Edge and localhost-only API; no credentials, UAT login or messaging"}
output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
sys.exit(0 if result.wasSuccessful() else 1)
