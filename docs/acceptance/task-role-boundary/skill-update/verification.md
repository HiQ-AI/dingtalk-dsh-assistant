# 技能修改与结构验证

本轮只修改实际安装的三个文件：

- `D:/dsh_home/skills/group-file-delivery/SKILL.md`
- `D:/dsh_home/skills/group-file-delivery/references/procedure.md`
- `D:/dsh_home/skills/business-development/SKILL.md`

现成文件流程留在技能入口，来源及对象明确后发送、核对原发送状态、简短交付；详细程序仅按生成、修改、转换、异常或明确验收要求进入。统筹委派并读证据，具体操作交执行。业务开发入口排除纯文件查找和转发；仅为定位文件读取源码不自动进入工程调查。未新增技能，未改脚本。

## 已实跑

- `python -X utf8 D:/codex-home/skills/.system/skill-creator/scripts/quick_validate.py D:/dsh_home/skills/group-file-delivery` → `Skill is valid!`
- 同一检查器检查 `D:/dsh_home/skills/business-development` → `Skill is valid!`
- 重新读取三个实际文件，计算前后 SHA256、字节数并检查全部 7 个相对 Markdown 引用 → 均存在。结果见 `readback.json`。

`skill-updates.patch` 为本轮差异；`before/` 是仅供本地回溯的原始完整快照，不应提交。结构和引用检查不证明真实模型决策、消息送达或耗时改善；独立行为评估使用 `forward-scenarios.md`，不发送真实群消息。

## 独立审查后的定点修订

首轮独立审查指出详细程序第 3 节同时出现“再次明确同条”和无条件“当前允许分开发送”，可能使执行者忽略本次已经明确的同条要求。仅修订该节第 3、4 项：未明确同条时才按现有拆发约定；本次明确同条即按该要求核对能力，不要求用户重复表达。首轮发现保留在独立审查记录中，不能因本次修订覆盖为首次通过。

修订后重新运行两个技能结构检查、7 个相对引用检查与三个文件 SHA 回读，均通过；最新差异和摘要已更新。独立场景复验由原审查者另行记录。
