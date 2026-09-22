# Workflow v8 到 v9 存储切换

本流程只针对 JSON backend 的 `dingtalk_dsh_assistant.json`。迁移脚本不连接钉钉、不启动 Agent、不执行任务，不自动切换运行目录。

## 切换前提

1. 停止原 Host、入站桥接及所有叶子执行，确认没有旧进程继续写入；保存源目录备份和哈希。
2. 对账所有未结 Decision、Task reservation、pending Outbox、待撤回消息及待回复人工阻塞。脚本遇到这些状态明确拒绝写目标，不能删除记录绕过。
3. 单独选择不存在的目标目录；禁止原地迁移。v6/v7 先使用原 `migrate-topic-storage.js` 到独立 v8 目录，再走本文。旧迁移使用冻结的 `storage-v8-schema.js`，不会读当前 v9 schema。

## 执行

使用当前仓库根目录，在 PowerShell 中给实际环境赋值。路径由操作者选择，以下变量不绑定个人机器：

```powershell
$sourceUnit = 'D:\storage-backup\v8\dingtalk_dsh_assistant.json'
$targetUnit = 'D:\storage-cutover\v9\dingtalk_dsh_assistant.json'
node scripts/migrate-workflow-storage.mjs --source $sourceUnit --target $targetUnit --check
```

确认 `ready:true`，再执行同一条命令去掉 `--check`。自检不会创建目标目录；执行使用独占创建，不覆盖任何已有目标。脚本通过真实 DSH DomainFacility/JsonStorageBackend 重开目标并逐表比对，再核对源字节不变；回执须为 `verified:true`、`sourceUnchanged:true`。

```powershell
node scripts/migrate-workflow-storage.mjs --source $sourceUnit --target $targetUnit
node scripts/check-resident-storage.mjs --check --source $targetUnit
Get-FileHash -Algorithm SHA256 -LiteralPath $sourceUnit
```

核对源 SHA256 与脚本 `sourceSha256`。输出只含元数据及问题类型，不输出消息正文。目标文件本身含业务数据，按原存储的访问规则保管。

## 历史与恢复规则

- 终态只有结果版本与 `task-completed` 事件一致才迁为 `succeeded`；明确且匹配本轮的取消事实才为 `cancelled`。其他为 `legacy-unknown`，不能从完成文字推断成功。
- 活动任务全部进入 `waiting/system`，附 `migrationReview:required`。输入版本递增，替换稳定新叶子会话 ID，原完整 Task 放入迁移事件保存；旧模型会话不能接着执行。
- 旧字符串只生成 `historical-unverified` 候选，不生成已核验计划或通过证据。显式恢复前人工核对授权、来源、外部结果和候选；新一轮必须重新确认结构化计划。
- 源中未知表、schema 将剥除的字段、无效记录或未结副作用会使 `ready:false`。先查明来源或完成对账，再重新生成到新目录；不能改脚本跳过校验。
- 成功目标存在时再次执行也拒绝覆盖；独立只读检查用于验证已有目标。

## 回退边界

尚未启动新 Host、没有新业务写入或外部副作用时，可以恢复原软件及完整源目录。v9 开始接收输入或执行副作用后，禁止简单还原 v8 快照：会遗失已收消息并重复外部动作。此时停写、逐项对账，优先前向修复；需回退时制定保留新增事实的专门方案。

第一次启动必须保持入站关闭，检查新版本、目标目录、阻塞任务数和旧会话未运行，再逐步放开。健康接口、迁移成功和工具回执不代替真实业务或渠道验收。
