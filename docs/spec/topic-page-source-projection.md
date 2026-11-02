# 话题页共享进程停顿修复

## 证据

2026-11-02 本机 18998 与 3080 同属 Node PID 43704。原生 HTTP 同时测得话题列表、health、Web 401 首字节等待约 3151/3150/3152 ms，而 TCP 连接 0 ms；话题列表仅约 8 KB，正常 5–15 ms。运行进程短时 CPU 采样（不暂停、不重启；结束关闭本次开启的 inspector）定位到 task-session-service 的周期恢复和 kickGroup -> projectSource -> resolveTopicMessages/topicMessages，以及 listSourceDispatchOwnership 的整组 JSON 深拷贝。GC 约 1.3%，JSON backend serialize 约 2.7%，不是本次首要热点。

## 决策

1. 不改前端分页：既有 10 项摘要、按需展开历史已生效；减少加载提示不能修复 health 同步停顿。
2. 不把缓存/跳过“已完成来源”当修复：后续 Topic 版本、事项移除、退役和未完成判断仍必须重新核对，粗略跳过会使来源账失真。
3. 采用消息身份索引：复用 topic-model 的按 revision 活跃引用缓存，建立准确 messageId/version -> entries 索引；来源结算只查询元数据，不展开其他消息正文。完整消息读取继续原校验。
4. 归属账复用已有 list/get 接口，list 可按 source identity 在深拷贝之前筛选；活跃 unit 沿既有单项 getter 读取，保留旧版本归属语义，避免每来源两次复制全组快照。

## 验证

以合成大量历史来源复现实跑，核对新旧完成判定一致、引用扫描及正文投影次数、可观察 HTTP 响应延迟。覆盖 add/remove、旧消息版本、多 unit、Topic 更新及退役边界，运行相关 Topic、归属、来源投影、原生 Host 回归。只修改本仓源码；不改宿主依赖和运行数据，不以本地未合并代码替换正式安装。
