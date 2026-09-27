# 同路径新增文本冲突的工作区准入

本轮实际失败为 `WORKSPACE_CONFLICT_UNSUPPORTED`，失败发生在正式 prepare-workspace，尚未产生候选。可信 taskBase 为 `bb022f5279483e8b8814d6486ccf82d63ef3f1ec`，开发 head 为 `81e6a99f760205f04396888e79b5da47fac7f88e`，冻结 UAT3 为 `6d87153d09f645b2b461db87ce0451057c168fc4`。原始起点之后双方独立新增 `MergePreviewCalculator.java`，stage2/stage3 均为 100644 UTF8；原规则仅接纳 stage1/2/3，故在模型分析前拒绝。

保留原 taskBase 与 Git 三方语义，最小准入范围增加 `[2,3]` 的同路径文本 add/add：祖先 tree 不含该路径，双方相对祖先的原生 rename-aware diff 都须标为 A；仍校验模式一致、合并 tree 含该文件、所有 blob 无 NUL 且为有效 UTF8。只输出原生 merge-tree 冲突标记，不能择一覆盖。未移除标记不能冻结交付；删除、rename/add、rename/rename、二进制继续阻断。

仅修改 Host 工作区构造与定向测试。真实业务源码、索引、ref、远端和运行控制账保持只读；取证计算通过 D 盘临时 Git 对象目录写派生对象。部署后旧失败任务不改账重试，由正式新任务重新运行验证。
