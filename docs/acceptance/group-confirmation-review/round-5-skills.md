# 第 5 轮：Windows 长路径候选完整性

本轮只修 `business-development/scripts/verification_run.py` 的 Git 读取：所有命令追加原生 `-c core.longpaths=true`，不写用户配置；Git 非零退出或 stderr 有诊断时，不生成可信候选摘要。原因是 Windows 长路径遗漏可仅输出警告并仍返回 0。其余 6 份技能文本未变化，第 4 轮及独立评估证据保留。

定向脚本 `scripts/verify-skill-runner-longpaths.py` 退出 0，4/4 通过：

1. 超过 260 字符的真实未跟踪文件被纳入，内容改变使候选摘要变化，HEAD 保持相同。
2. 原生 Git 在 `core.longpaths=false` 时真实返回 0、输出遗漏警告且枚举为空；读取器拒绝将它当有效结果。
3. 真实 Git 引用读取失败被拒绝。
4. 调用前后的仓库配置文件内容一致。

实际检出只读预检也退出 0：排除当前 `docs/acceptance/group-confirmation-review/` 后记录 792 个未跟踪文件；stderr 为 0 字节。没有删除或改动 `docs/tmp`。这是读取时的候选快照，不替代后续冻结与检查。原输出、退出码及定向结果均在 `round-5/`，临时夹具已清理。

本次业务技能结构校验和脚本 AST 解析通过。最终 7 文件身份见 `round-5/skill-readback.json`；相对第 4 轮的最小补丁为 `round-5/longpaths.patch`，完整可复现技能补丁更新为 `round-5/skill-updates.patch`。第 4 轮 11 项原结果未覆盖或重跑。
