"""在仓库根运行；只读取本轮本地包并与工作区逐字节核对，不安装包。"""
import datetime
import hashlib
import json
import pathlib
import tarfile

root = pathlib.Path.cwd()
archive = root / "docs/tmp/framework-package/zzusp-dingtalk-dsh-assistant-0.5.15.tgz"
files = []
with tarfile.open(archive, "r:gz") as package:
    for item in package.getmembers():
        if item.isfile() and item.name.endswith(".js"):
            name = item.name.removeprefix("package/")
            actual = package.extractfile(item).read()
            expected = (root / "packages/dingtalk-dsh-assistant" / name).read_bytes()
            assert actual == expected, name
            files.append(name)
assert "task-workflow-contracts.js" in files
report = {
    "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "package": archive.name,
    "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
    "matchedJavaScriptFiles": len(files),
    "newContractIncluded": True,
    "status": "PASS",
    "deployed": False,
}
destination = root / "docs/acceptance/topic-context-completeness/round-41/package-check.json"
destination.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
print(json.dumps(report, indent=2))
