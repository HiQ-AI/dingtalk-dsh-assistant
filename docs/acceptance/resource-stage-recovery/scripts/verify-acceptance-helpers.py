"""隔离 localhost 实跑公共 Registry 脚本与 UAT 版本 helper；不读取实际凭据。"""

import argparse
import copy
import hashlib
import importlib.util
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import threading
from urllib.request import urlopen


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--registry-script", type=Path, required=True)
    parser.add_argument("--version-helper", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    digest = lambda raw: "sha256:" + hashlib.sha256(raw).hexdigest()
    image_type = "application/vnd.oci.image.manifest.v1+json"
    index_type = "application/vnd.oci.image.index.v1+json"
    descriptor = {"mediaType": "application/vnd.oci.image.config.v1+json", "size": 9, "digest": "sha256:" + "c" * 64}
    manifest = {"schemaVersion": 2, "mediaType": image_type, "config": descriptor, "layers": [], "annotations": {"test": "原始字节非规范排版"}}
    encode = lambda value: json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
    good = encode(manifest)
    cases = {}

    def add(name, raw=good, status=200, content_type=image_type, expected_reason="verified", header="auto", expected=None):
        cases[name] = {"raw": raw, "status": status, "type": content_type, "reason": expected_reason,
                       "header": digest(raw) if header == "auto" else header, "expected": expected or digest(raw)}

    add("raw-utf8-bytes")
    add("header-optional", header=None)
    add("secure-auth")
    add("http-error-secret", raw=b'credential-fixture-private-error', status=401, expected_reason="http_status")
    add("redirect-refused", status=302, expected_reason="http_status")
    add("body-digest-mismatch", expected="sha256:" + "0" * 64, expected_reason="body_digest_mismatch")
    add("header-digest-mismatch", header="sha256:" + "0" * 64, expected_reason="header_digest_mismatch")
    add("html-response", raw=b"<html>fixture</html>", content_type="text/html", expected_reason="content_type_invalid")
    add("invalid-json", raw=b"{broken", expected_reason="json_invalid")
    add("invalid-utf8", raw=b"\xff", expected_reason="json_invalid")
    add("json-array", raw=encode([]), expected_reason="manifest_shape_invalid")
    for name, value in (("schema-string", "2"), ("schema-bool", True), ("schema-float", 2.0)):
        body = copy.deepcopy(manifest)
        body["schemaVersion"] = value
        add(name, raw=encode(body), expected_reason="manifest_shape_invalid")
    body = copy.deepcopy(manifest)
    body["config"]["size"] = "9"
    add("descriptor-size-string", raw=encode(body), expected_reason="manifest_shape_invalid")
    body = copy.deepcopy(manifest)
    body["layers"] = {}
    add("layers-object", raw=encode(body), expected_reason="manifest_shape_invalid")
    body = copy.deepcopy(manifest)
    body["mediaType"] = index_type
    add("media-type-mismatch", raw=encode(body), expected_reason="manifest_shape_invalid")
    child = {"mediaType": image_type, "digest": digest(good), "size": len(good), "platform": {"os": "linux", "architecture": "arm64", "variant": "v8"}}
    index = {"schemaVersion": 2, "mediaType": index_type, "manifests": [child]}
    add("platform-index", raw=encode(index), content_type=index_type)
    index_no_platform = copy.deepcopy(index)
    del index_no_platform["manifests"][0]["platform"]
    add("unknown-platform-kept", raw=encode(index_no_platform), content_type=index_type)
    index_bad = copy.deepcopy(index)
    index_bad["manifests"][0]["platform"]["architecture"] = 64
    add("platform-invalid", raw=encode(index_bad), content_type=index_type, expected_reason="manifest_shape_invalid")
    records = []
    fixture_token = "Bearer fixture-synthetic-auth-only"
    versions = [2, "2", 0, "0", 3, True, 2.0, None, "02", " 2", "+2", "２", -1, "-1", "", {}, []]

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path == "/versions":
                raw = json.dumps(versions).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
                return
            parts = self.path.split("/")
            name = parts[2] if len(parts) == 5 and parts[1] == "v2" and parts[3] == "manifests" else "unexpected"
            records.append((name, self.headers.get("Authorization"), self.path))
            if name not in cases:
                self.send_error(500)
                return
            fixture = cases[name]
            self.send_response(fixture["status"])
            self.send_header("Content-Type", fixture["type"])
            self.send_header("Content-Length", str(len(fixture["raw"])))
            if fixture["header"] is not None:
                self.send_header("Docker-Content-Digest", fixture["header"])
            if fixture["status"] == 302:
                self.send_header("Location", "/must-not-follow")
            self.end_headers()
            self.wfile.write(fixture["raw"])

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{server.server_port}"
    results = []
    try:
        for name, fixture in cases.items():
            argv = ["pwsh", "-NoProfile", "-File", str(args.registry_script), "-Registry", origin,
                    "-Repository", name, "-ExpectedDigest", fixture["expected"]]
            if name == "secure-auth":
                quote = lambda value: "'" + value.replace("'", "''") + "'"
                command = "$auth = ConvertTo-SecureString '" + fixture_token + "' -AsPlainText -Force; & " + quote(str(args.registry_script))
                command += f" -Registry {quote(origin)} -Repository secure-auth -ExpectedDigest {quote(fixture['expected'])} -Authorization $auth"
                argv = ["pwsh", "-NoProfile", "-Command", command]
            run = subprocess.run(argv, capture_output=True, text=True, encoding="utf-8", timeout=20)
            body = json.loads(run.stdout)
            expected_ok = fixture["reason"] == "verified"
            assert run.returncode == (0 if expected_ok else 1), (name, "exit", run.returncode, body)
            assert body["verified"] is expected_ok and body["reason"] == fixture["reason"], (name, body)
            assert fixture_token not in run.stdout + run.stderr
            assert "credential-fixture-private-error" not in run.stdout + run.stderr
            assert records[-1][0] == name and records[-1][2].endswith(fixture["expected"]), (name, "digest-addressed-get")
            if name == "raw-utf8-bytes":
                assert body["rawDigest"] == digest(good) and body["byteLength"] == len(good)
                assert body["kind"] == "image-manifest" and body["layerCount"] == 0
            if name == "secure-auth":
                assert records[-1][1] == fixture_token
            if name == "platform-index":
                assert body["kind"] == "image-index" and body["children"][0]["digest"] == digest(good)
                assert body["children"][0]["architecture"] == "arm64"
            if name == "unknown-platform-kept":
                assert "architecture" not in body["children"][0]
            results.append({"case": name, "status": "PASS", "exit": run.returncode, "reason": body["reason"]})
        assert len(records) == len(cases), "redirect or retry unexpectedly issued another request"
        spec = importlib.util.spec_from_file_location("hiq_uat_session", args.version_helper)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with urlopen(origin + "/versions", timeout=5) as response:
            actual_values = json.load(response)
        for index, actual in enumerate(actual_values):
            expected = 0 if index in (2, 3) else 2
            if index <= 3:
                assert module.assert_snapshot_version(actual, expected) == expected
                outcome = "semantic-equality"
            else:
                error_type, error_id = (AssertionError, "snapshot-version.mismatch") if index == 4 else (ValueError, "snapshot-version.invalid-type-or-value")
                try:
                    module.assert_snapshot_version(actual, expected)
                    raise AssertionError("invalid version unexpectedly accepted")
                except error_type as error:
                    assert str(error) == error_id
                outcome = error_id
            results.append({"case": f"version-http-json-{index}", "status": "PASS", "reason": outcome})
        try:
            module.assert_snapshot_version(2, True)
            raise AssertionError("invalid expected version unexpectedly accepted")
        except ValueError as error:
            assert str(error) == "snapshot-version.invalid-type-or-value"
        results.append({"case": "expected-version-invalid", "status": "PASS"})
    finally:
        server.shutdown()
        server.server_close()
    report = {"status": "PASS", "caseCount": len(results), "registryGetCount": len(records), "cases": results,
              "registryScriptSha256": hashlib.sha256(args.registry_script.read_bytes()).hexdigest(),
              "versionHelperSha256": hashlib.sha256(args.version_helper.read_bytes()).hexdigest(),
              "boundary": "localhost fixtures only; no live Registry, business writes, login or deployment"}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("status", "caseCount", "registryGetCount")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
