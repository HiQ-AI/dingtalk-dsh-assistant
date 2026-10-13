# Round 10：整轮上下文去重

## 结果

取消每次原生工具结束的独立coordinator回执，引用附在原工具结果中；block保留原反馈。SDK value替换继续原生schema校验与渲染，凭据通过既有材料索引可查。固定解释进入完整Owner系统提示。

需求、来源、验收项和目录保留一份可见ownerContextBase，续轮只带动态字段；当前内容变化替换基线，压缩丢失则从当轮Host输入恢复。sameAs指向合成后的逻辑上下文。历史快照仅保留短superseded标记，审计原文不变，历史工具通知不删除。

## 证据

- `node --test test/task-owner-context.test.js test/task-owner-session-native.test.js`：80/80 PASS。
- 真实SDK覆盖成功/失败的原文及引用同一tool-result、block/value分支保真、无独立通知、连续两轮goal及来源正文各一份、动态controlRevision更新。
- 投影测试覆盖基线变更及删除旧约束、压缩丢失后的恢复、Task/session隔离、合并后逐字段精确一致、sameAs可解析。
- 用户样本原始14737字符；本轮投影5487。新注入2102字符，基础信息消息3494字符，两者合计5596；固定系统说明374字符另计。未变化基线新增消息数0。不能把2102与之前整包5839直接比较为整体token降幅。
- 独立源码审查无阻断发现。未验证模型真实业务判断，不代做原UAT核验。

## 部署

零写预检失败：正式维护接口不可用；随后独立Get-NetTCPConnection未见3080/18998监听，health请求失败。未执行安装、停机或重启。本轮不调查或改动外部会话的运行态，不将离线与SDK验证当作线上生效。
