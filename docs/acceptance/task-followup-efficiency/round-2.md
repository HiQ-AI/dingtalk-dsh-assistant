# 相关技能更新与执行效率验证

## 已验证的行为

- 实际业务开发 skill 三个文件已修改，SHA 与 after 快照逐字节一致，九个相对引用存在；Python 原生 UTF-8 模式的结构校验通过。两个现有脚本未改，具体 SHA 见 skill-update/readback.json。
- 独立评估四个场景：阶段恢复、低成本检查/夹具失败、页面初始化、业务验证后的精确收尾，见 skill-update/independent-behavior-review.md。评估支持当前指引可导出必要且有边界的动作，不声称实际任务已提速。
- skill-refresh-unit-round-4.log：6/6，通过；验证普通二十个步骤不重读正文、原生变更通知后检查、根目录切换、观察失败不推翻成功结果、旧会话提示、同名替换/失败不记已读，以及结果未落盘前崩溃的恢复边界。
- skills-native-round-8.log：2/2，通过；真实原生 registry、filesystem、skill/read、会话持久化及原执行续办，模型调用由确定性夹具驱动。只更新引用且不改入口也在续办首次模型步骤可见；重读后最新运行上下文清除提醒，旧结果保留。

## 失败与修订

保留 skills-native-round-1 至 round-8、skills-native-debug 和 unit-round-1 至 round-4。初稿额外自定义事件没有原生可忽略标记，改用独立安装副本的 appendPluginRecord 又遇到 Session 私有类身份不一致；最终复用原生 user/message 上下文和 surfaceOp，不改变 Session 格式。技能版本提示最初用了在 pre-step 之前组装的 section，改为请求准入前重新取值的 required runtime context；旧快照仍保留，断言只检查最新 runtime context。成功 tool/result 观察先于原生结果落盘，因此摘要带 callId，恢复时只有对应持久成功结果也存在才恢复基线。

独立源码复核指出的 preset fs、异步观察、换根旧引用、附加观察异常、正文重复读取及崩溃窗口均有定点修订。复核记录在 skill-update/runtime-refresh-review.md。没有放宽原生权限、删除失败断言或通过重复业务操作补证。

## 剩余交付

最终相关原生整组与包验证；双来源追问修订复验；验收表、报告和 PR 回读。本轮不合并、不部署、不触发 CI、不发送真实钉钉消息。
