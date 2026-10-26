"""使用一次性本地 Git 夹具验证已安装的命令取证脚本，不连接外部服务。"""

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RUNNER = Path("D:/dsh_home/skills/business-development/scripts/verification_run.py")


class CaseResults(list):
    def __init__(self, output):
        super().__init__()
        self.output = output

    def append(self, item):
        super().append(item)
        (self.output / "case-results.json").write_text(json.dumps(self, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


@contextmanager
def fixture_directory(output):
    with tempfile.TemporaryDirectory(prefix="runner-fixture-", dir=ROOT) as temporary:
        fixture = Path(temporary)
        try:
            yield fixture
        finally:
            if (fixture / "evidence").exists():
                shutil.copytree(fixture / "evidence", output / "commands")


def invoke(cwd, *args):
    return subprocess.run([sys.executable, "-X", "utf8", str(RUNNER), "--cwd", str(cwd), *args],
                          capture_output=True)


def snapshot(root):
    return {str(path.relative_to(root)): (path.stat().st_mtime_ns, hashlib.sha256(path.read_bytes()).hexdigest())
            for path in root.rglob("*") if path.is_file()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--round", required=True, type=int)
    args = parser.parse_args()
    if args.round < 1:
        parser.error("round must be positive")
    output = ROOT / f"round-{args.round}" / "skill-runner"
    if output.exists():
        raise RuntimeError("本轮证据已存在，请保留原记录并另建轮次")
    output.mkdir(parents=True)
    results = CaseResults(output)
    with fixture_directory(output) as fixture:
        for command in (["git", "init", str(fixture)],
                        ["git", "-C", str(fixture), "config", "user.name", "Skill validation"],
                        ["git", "-C", str(fixture), "config", "user.email", "skill-validation@example.invalid"]):
            subprocess.run(command, check=True, capture_output=True)
        package = fixture / "package.json"
        package.write_text('{"packageManager":"yarn@1.22.22"}\n', encoding="utf-8")
        (fixture / "yarn.lock").write_text("# fixture lock\n", encoding="utf-8")
        (fixture / "pnpm-lock.yaml").write_text("lockfileVersion: 9\n", encoding="utf-8")
        (fixture / "source.txt").write_text("original\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(fixture), "add", "."], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(fixture), "commit", "-m", "local fixture"], check=True, capture_output=True)
        evidence = fixture / "evidence"

        before = snapshot(fixture)
        checked = invoke(fixture, "--check", "--evidence-dir", str(evidence))
        assert checked.returncode == 0, checked.stderr
        tools = json.loads(checked.stdout)["tools"]
        assert tools["packageManager"] == "yarn@1.22.22" and tools["locks"] == ["yarn.lock"]
        assert tools["otherLocks"] == ["pnpm-lock.yaml"]
        assert not evidence.exists() and snapshot(fixture) == before
        results.append({"case": "check-zero-write-and-declared-manager", "status": "PASS"})

        def run(name, program):
            result = invoke(fixture, "--evidence-dir", str(evidence), "--name", name,
                            "--", sys.executable, "-X", "utf8", "-c", program)
            record = json.loads((evidence / (name + ".json")).read_text(encoding="utf-8"))
            return result, record

        positive, record = run("raw-success", "import sys; sys.stdout.buffer.write(('原始输出\\n'*10000).encode('utf-8')); sys.stderr.buffer.write('错误流原文\\n'.encode('utf-8'))")
        expected = ("原始输出\n" * 10000).encode("utf-8")
        assert positive.returncode == 0 and record["validCommandEvidence"] and record["candidateUnchanged"]
        assert (evidence / "raw-success.stdout.log").read_bytes() == expected
        assert (evidence / "raw-success.stderr.log").read_bytes() == "错误流原文\n".encode("utf-8")
        assert record["logs"]["raw-success.stdout.log"]["sha256"] == hashlib.sha256(expected).hexdigest()
        assert record["command"][-1].endswith("encode('utf-8'))")
        results.append({"case": "full-raw-output-and-valid-command", "status": "PASS", "stdoutBytes": len(expected)})

        failed, record = run("exit-seven", "import sys; print('dependency handshake rejected', file=sys.stderr); sys.exit(7)")
        assert failed.returncode == 7 and record["exitCode"] == 7 and not record["validCommandEvidence"]
        assert b"handshake rejected" in (evidence / "exit-seven.stderr.log").read_bytes()
        results.append({"case": "nonzero-exit-propagation", "status": "PASS", "exitCode": failed.returncode})

        changed, record = run("candidate-drift", "from pathlib import Path; Path('source.txt').write_text('changed\\n'); print('command succeeded')")
        assert changed.returncode == 1 and record["exitCode"] == 0
        assert record["candidateUnchanged"] is False and record["validCommandEvidence"] is False
        results.append({"case": "successful-command-does-not-hide-source-drift", "status": "PASS"})

        missing = invoke(fixture, "--evidence-dir", str(evidence), "--name", "missing-command",
                         "--", "fixture-nonexistent-executable-91a873")
        record = json.loads((evidence / "missing-command.json").read_text(encoding="utf-8"))
        assert missing.returncode != 0 and record["state"] == "start-failed" and record["exitCode"] is None
        assert record["validCommandEvidence"] is False
        results.append({"case": "start-failure-is-not-success", "status": "PASS"})

        saved = snapshot(evidence)
        duplicate = invoke(fixture, "--evidence-dir", str(evidence), "--name", "raw-success",
                           "--", sys.executable, "-c", "raise Exception('must not run')")
        assert duplicate.returncode != 0 and snapshot(evidence) == saved
        results.append({"case": "duplicate-round-preserves-original-evidence", "status": "PASS"})

        arguments = [sys.executable, "-X", "utf8", str(RUNNER), "--cwd", str(fixture),
                     "--evidence-dir", str(evidence), "--name", "streaming", "--", sys.executable,
                     "-u", "-c", "import time; print('first raw bytes', flush=True); time.sleep(2); print('done')"]
        streaming = subprocess.Popen(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        deadline = time.monotonic() + 5
        live = False
        while time.monotonic() < deadline and streaming.poll() is None:
            log = evidence / "streaming.stdout.log"
            if log.exists() and b"first raw bytes" in log.read_bytes():
                live = True
                break
            time.sleep(0.02)
        stream_output, error = streaming.communicate(timeout=10)
        assert live and streaming.returncode == 0, (stream_output, error)
        results.append({"case": "stdout-readable-before-command-completes", "status": "PASS"})

        arguments[arguments.index("streaming")] = "concurrent-round"
        first = subprocess.Popen(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        second = subprocess.Popen(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        first.communicate(timeout=10)
        second.communicate(timeout=10)
        assert sorted([first.returncode, second.returncode]) == [0, 2]
        record = json.loads((evidence / "concurrent-round.json").read_text(encoding="utf-8"))
        assert record["validCommandEvidence"] and (evidence / "concurrent-round.stdout.log").read_bytes().count(b"done") == 1
        results.append({"case": "same-round-concurrency-has-single-owner", "status": "PASS"})

        package.write_text("{}\n", encoding="utf-8")
        saved = snapshot(fixture)
        ambiguous = invoke(fixture, "--check")
        assert ambiguous.returncode == 2 and b"ambiguous" in ambiguous.stderr and snapshot(fixture) == saved
        package.write_text('{"packageManager":"yarn@1.22.22"}\n', encoding="utf-8")
        results.append({"case": "ambiguous-manager-fails-without-writing", "status": "PASS"})

        saved = snapshot(fixture)
        dirty_check = invoke(fixture, "--check", "--evidence-dir", str(evidence))
        assert dirty_check.returncode == 0 and snapshot(fixture) == saved, "dirty check changed fixture files"
        results.append({"case": "dirty-candidate-check-does-not-refresh-index", "status": "PASS"})

        saved = snapshot(fixture)
        overbroad = invoke(fixture, "--check", "--evidence-dir", str(fixture))
        assert overbroad.returncode != 0, overbroad.stdout
        after = snapshot(fixture)
        if after != saved:
            differences = {name: {"before": saved.get(name), "after": after.get(name)}
                           for name in saved.keys() | after.keys() if saved.get(name) != after.get(name)}
            (output / "check-file-differences.json").write_text(json.dumps(differences, indent=2) + "\n", encoding="utf-8")
        assert after == saved, "check changed fixture files"
        results.append({"case": "evidence-exclusion-cannot-hide-whole-candidate", "status": "PASS"})
    result = {"runner": str(RUNNER), "passed": len(results), "cases": results,
              "boundaries": ["本地一次性夹具；未连接真实数据库或业务服务", "不替代技能的独立场景评估"]}
    (output / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
