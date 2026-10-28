# 开发与审查技能补强

仅修改两个现有参考文件的四个条目，两个 SKILL.md 入口保持不变，没有新增技能、固定用例表或交付门禁。

- `business-development/references/procedure.md:63`：导入导出用代表数据覆盖实际转换链，关注实际受影响的身份、空值和派生状态；不穷举字段或固定加验收轮次。
- 同文件第 108 行：集成改变依赖、签名或格式时，同步已有测试构造、mock 和样本，复用原有代表用例；第 112 行已有禁止削弱业务/测试约束的要求，未重复添加。
- `review-code-implementation/references/checklist.md:82,85`：审阅同一转换链和夹具同步，按风险选断言，维持只读审查边界。

## 实际验证

- `python -X utf8 .../quick_validate.py D:/dsh_home/skills/business-development`：退出 0，`Skill is valid!`。
- 相同命令验证 `review-code-implementation`：退出 0，`Skill is valid!`。
- `skills.patch` 对修改前副本 `git apply --check` 和实际 apply 均退出 0；回放文件与已安装文件字节一致，两文件摘要见 `readback.json`。
- 修改前后副本在本目录 `before/`、`after/`，只作本地回放，已忽略入库。补丁路径相对于 skill 根目录。

首次结构检查因 Windows Python 默认 GBK 解码 UTF-8 文档失败；使用 Python 原生 `-X utf8` 后通过，未改验证器或文件编码。首次回放受当前仓库 `core.autocrlf` 转 CRLF 影响，字节比对失败；以 `git -c core.autocrlf=false -c core.eol=lf apply` 保留源 LF 后通过。未放宽内容或摘要断言。

结构检查和补丁回放不证明模型决策正确。由主会话安排少量独立行为验证，重点看能否发现转换缺陷、保持生产校验，以及不扩成全字段或真实环境验收。
