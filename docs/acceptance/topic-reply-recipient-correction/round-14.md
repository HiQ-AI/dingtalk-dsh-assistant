# Round 14 — 材料历史 group-ingest/helper 定向验证

日期：2026-10-29（Asia/Shanghai）

## 结果

- 原始 PowerShell 命令：

```powershell
$env:DSH_NATIVE_TEST_PROFILE='D:/dsh_home/profiles/web/package.json'; node -e 'const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),cp=require("node:child_process");const dir=fs.mkdtempSync(path.join(os.tmpdir(),"topic-material-test-"));try {const r=cp.spawnSync(process.execPath,["--test","--test-name-pattern=source text and actual attachment bytes are materialized","D:/project/dingtalk-dsh-assistant/.claude/worktrees/topic-reply-recipient-correction/test/task-session-material-history.test.js"],{cwd:dir,stdio:"inherit",env:process.env});process.exitCode=r.status??1}finally{fs.rmSync(dir,{recursive:true,force:true})}'
```

- 1 pass、0 fail、0 cancel、0 skip，5968.4886 ms，exit 0。
- source text 与实际 attachment bytes 被 materialize 到其自身 task 并复用，没有再次下载。
- 临时 cwd 在 `finally` 中清理；使用指定 native profile、脚本模型与通知桩。

## 边界

该结果只证明所述材料历史/helper 路径，不将 `task-session-material-history` 按名称当作 release=false 历史 lane，也不推导未运行的 helper 或 group-ingest 路径通过。不是正式 LLM 或真实钉钉送达；未创建最终 `report.md`。
