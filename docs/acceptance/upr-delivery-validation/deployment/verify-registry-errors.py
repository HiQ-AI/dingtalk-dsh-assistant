"""在 localhost 验证 Registry 分类，不读取真实凭据或调用部署平台。"""

import argparse
import hashlib
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import threading


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--script", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    media = "application/vnd.oci.image.manifest.v1+json"
    config = "sha256:" + "c" * 64
    raw = json.dumps({"schemaVersion": 2, "mediaType": media,
                      "config": {"digest": config, "size": 12, "mediaType": "application/vnd.oci.image.config.v1+json"},
                      "layers": []}, indent=2).encode()
    digest = "sha256:" + hashlib.sha256(raw).hexdigest()
    cases = {
        "auth-bearer": (401, 'Bearer realm="https://fixture.invalid/private-realm",service="private-fixture"', "authentication_required"),
        "auth-no-challenge": (401, None, "authentication_required"),
        "manifest-ok": (200, None, "verified"),
        "digest-mismatch": (200, None, "body_digest_mismatch"),
    }
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            name = self.path.split("/")[2]
            requests.append(name)
            status, challenge, _ = cases[name]
            body = raw if status == 200 else b"private-fixture-error-body"
            self.send_response(status)
            self.send_header("Content-Type", media)
            self.send_header("Content-Length", str(len(body)))
            if challenge:
                self.send_header("WWW-Authenticate", challenge)
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    results = []
    try:
        for name, (_, _, reason) in cases.items():
            expected = "sha256:" + "0" * 64 if name == "digest-mismatch" else digest
            proc = subprocess.run(["pwsh", "-NoProfile", "-File", str(args.script),
                                   "-Registry", f"http://127.0.0.1:{server.server_port}",
                                   "-Repository", name, "-ExpectedDigest", expected],
                                  capture_output=True, text=True, encoding="utf-8", timeout=20)
            result = json.loads(proc.stdout)
            passed = (result["reason"] == reason and proc.returncode == (0 if reason == "verified" else 1)
                      and requests.count(name) == 1 and not proc.stderr
                      and "private-fixture" not in proc.stdout and "private-realm" not in proc.stdout)
            if name == "auth-bearer":
                passed = passed and result.get("challengeScheme") == "Bearer"
            if name == "auth-no-challenge":
                passed = passed and "challengeScheme" not in result
            if name == "manifest-ok":
                passed = passed and result["configDigest"] == config and result["rawDigest"] == digest
            results.append({"case": name, "passed": passed, "exitCode": proc.returncode, "result": result})
    finally:
        server.shutdown()
        server.server_close()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({"scriptSha256": hashlib.sha256(args.script.read_bytes()).hexdigest(),
                                       "cases": results}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"passed": sum(r["passed"] for r in results), "total": len(results)}))
    return 0 if all(r["passed"] for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
