"""归档已授权个人验收 helper 变更；只读实际安装，仅写本任务证据目录。"""

import argparse
import difflib
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace-root", type=Path, required=True)
    parser.add_argument("--skills-root", type=Path, required=True)
    parser.add_argument("--before", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--registry-source", type=Path, required=True)
    args = parser.parse_args()
    groups = {
        "skills": (args.skills_root, {
            "uat-pr/SKILL.md": "uat-pr-SKILL.md",
            "uat-pr/references/procedure.md": "uat-pr-procedure.md",
            "business-development/SKILL.md": "business-development-SKILL.md",
            "business-development/references/procedure.md": "business-development-procedure.md",
            "uat-deployment/SKILL.md": "uat-deployment-SKILL.md",
            "uat-deployment/references/procedure.md": "uat-deployment-procedure.md",
            "baibu-uat-account-verify/SKILL.md": "account-SKILL.md",
            "baibu-uat-account-verify/references/verified-flow.md": "account-verified-flow.md",
            "baibu-uat-account-verify/scripts/hiq_uat_session.py": "hiq_uat_session.py",
        }),
        "workspace": (args.workspace_root, {"docs/ops/woodpecker-uat.md": "woodpecker-uat.md"}),
    }
    sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
    args.output.mkdir(parents=True, exist_ok=True)
    records = []
    for group, (root, files) in groups.items():
        patch = ""
        for relative, before_name in files.items():
            before, after = args.before / before_name, root / relative
            patch += "".join(difflib.unified_diff(before.read_bytes().decode("utf-8").splitlines(keepends=True),
                                                 after.read_bytes().decode("utf-8").splitlines(keepends=True),
                                                 fromfile="a/" + relative, tofile="b/" + relative))
            records.append({"group": group, "path": relative, "beforeSha256": sha(before), "afterSha256": sha(after), "bytes": after.stat().st_size})
        patch_path = args.output / f"{group}.patch"
        patch_path.write_text(patch, encoding="utf-8", newline="\n")
        # 真正从 before 副本 git apply；验证安装配方，不只匹配补丁文本。
        with tempfile.TemporaryDirectory(prefix="replay-", dir=args.output) as directory:
            stage = Path(directory)
            for relative, before_name in files.items():
                target = stage / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(args.before / before_name, target)
            for flags in (("--check",), ()):
                subprocess.run(["git", "-c", "core.autocrlf=false", "apply", *flags, str(patch_path.resolve())], cwd=stage, check=True, capture_output=True)
            for relative in files:
                assert sha(stage / relative) == sha(root / relative), relative
    installed_source = args.workspace_root / "scripts/read-registry-manifest.ps1"
    assert sha(installed_source) == sha(args.registry_source), "archived Registry source differs from installed helper"
    records.append({"group": "workspace", "path": "scripts/read-registry-manifest.ps1", "beforeSha256": None,
                    "afterSha256": sha(installed_source), "bytes": installed_source.stat().st_size,
                    "source": "../scripts/read-registry-manifest.ps1"})
    checked_links = 0
    for relative in groups["skills"][1]:
        path = args.skills_root / relative
        if path.suffix != ".md":
            continue
        for target in re.findall(r"\]\(([^)]+)\)", path.read_text(encoding="utf-8-sig")):
            if "://" in target or target.startswith("#"):
                continue
            assert (path.parent / target.split("#")[0]).exists(), (relative, target)
            checked_links += 1
    result = {"status": "PASS", "replay": "two patches applied against original before bytes; SHA256 matches actual installation",
              "relativeLinksChecked": checked_links, "registrySourceMatchesInstalled": True, "files": records}
    (args.output / "installed-readback.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": "PASS", "fileCount": len(records), "relativeLinksChecked": checked_links}))


if __name__ == "__main__":
    main()
