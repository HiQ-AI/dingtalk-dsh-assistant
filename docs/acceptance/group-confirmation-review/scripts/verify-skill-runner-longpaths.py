"""仅验证 Windows 深路径候选完整性；不重跑此前 11 项行为检查。"""

import hashlib
import json
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "round-5"
RUNNER = Path("D:/dsh_home/skills/business-development/scripts/verification_run.py")


def main():
    namespace = {"__name__": "verification_runner_test"}
    exec(compile(RUNNER.read_text(encoding="utf-8"), str(RUNNER), "exec"), namespace)
    cases = []
    result_path = OUTPUT / "longpath-result.json"
    if result_path.exists():
        raise RuntimeError("本轮结果已经存在，不覆盖历史证据")
    with tempfile.TemporaryDirectory(prefix="longpath-fixture-", dir=ROOT) as temporary:
        fixture = Path(temporary)

        def raw_git(*args):
            return subprocess.run(["git", "--no-optional-locks", "-C", temporary, *args], capture_output=True)

        for args in (("init",), ("config", "user.name", "Validation"),
                     ("config", "user.email", "validation@example.invalid")):
            assert raw_git(*args).returncode == 0
        (fixture / "tracked.txt").write_text("base", encoding="utf-8")
        assert raw_git("add", ".").returncode == 0
        assert raw_git("commit", "-m", "local fixture").returncode == 0
        deep = fixture / ("long-a-" + "a" * 65) / ("long-b-" + "b" * 65) / ("long-c-" + "c" * 65) / "source.txt"
        deep.parent.mkdir(parents=True)
        deep.write_text("first content", encoding="utf-8")
        config_before = (fixture / ".git" / "config").read_bytes()
        first = namespace["candidate"](fixture)
        assert len(str(deep)) > 260 and first["untrackedFiles"] == 1
        deep.write_text("changed content", encoding="utf-8")
        second = namespace["candidate"](fixture)
        assert second["untrackedFiles"] == 1 and first["head"] == second["head"]
        assert first["untrackedSha256"] != second["untrackedSha256"]
        cases.append({"case": "deep-untracked-content-changes-candidate", "status": "PASS",
                      "pathLength": len(str(deep)), "first": first, "second": second})

        # 真实 Git 在禁用长路径时返回 0，但警告且漏掉文件；不用伪造 subprocess 回执。
        arguments = ("-c", "core.longpaths=false", "ls-files", "--others", "--exclude-standard", "-z")
        omitted = raw_git(*arguments)
        (OUTPUT / "longpath-omission.stdout.log").write_bytes(omitted.stdout)
        (OUTPUT / "longpath-omission.stderr.log").write_bytes(omitted.stderr)
        assert omitted.returncode == 0 and omitted.stderr and not omitted.stdout
        try:
            namespace["git"](fixture, *arguments)
        except ValueError as error:
            diagnostic = str(error)
        else:
            raise AssertionError("Git warning must not produce a trusted candidate")
        cases.append({"case": "zero-exit-path-omission-is-rejected", "status": "PASS",
                      "nativeExitCode": omitted.returncode, "nativeDiagnosticBytes": len(omitted.stderr),
                      "wrapperDiagnostic": diagnostic})

        try:
            namespace["git"](fixture, "rev-parse", "--verify", "missing-validation-ref")
        except ValueError:
            cases.append({"case": "failed-git-read-is-rejected", "status": "PASS"})
        else:
            raise AssertionError("Git read failure must not produce a trusted candidate")
        assert config_before == (fixture / ".git" / "config").read_bytes()
        cases.append({"case": "per-command-longpaths-keeps-config-unchanged", "status": "PASS"})
    result = {"runner": str(RUNNER), "runnerSha256": hashlib.sha256(RUNNER.read_bytes()).hexdigest(),
              "passed": len(cases), "cases": cases,
              "scope": "本轮仅深路径定向检查；此前 11 项结果保留在 round-4"}
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"passed": len(cases), "runnerSha256": result["runnerSha256"]}))


if __name__ == "__main__":
    main()
