# 工作区根迁移只读审计

本次仅盘点，未移动、删除或修改现场数据。证据为同目录 inventory.json；它记录每个源文件的大小与 SHA256、原生绑定、路径字段位置和目标冲突，不记录业务正文或凭据。在线 SQLite/WAL 与日志清单不是跨文件原子快照，正式停机后须重新核验。

## 当前范围

源根为 `D:/baibu-agent/task-session-runtime-clean`，目标根为 `D:/baibu-agent`。

| 桶 | 文件数 | 字节 | 说明 |
| --- | ---: | ---: | --- |
| `.dsh` | 5 | 10800214 | resident JSON、控制 SQLite、WAL、SHM、初始化标记 |
| `tasks` | 8 | 7869059 | 3 个会话路由、3 个原生 JSONL、2 个材料文件 |
| `session-workspaces` | 0 | 0 | 仅“消息归类”“话题决策”空目录 |

总计 13 个文件、18669273 字节。遍历不跟随 reparse；源内未发现 reparse 或 `.git` 文件/目录，未发现托管业务仓库、worktree 或外部仓库链接。该结论只覆盖源三桶的当前物理条目，不代表会话历史引用的外部仓库被纳入迁移。

目标已有 `tasks` 与 `session-workspaces` 父目录；`tasks` 下现有 `tasks` 子目录，`session-workspaces` 下现有“消息问答”。源具体子项均未碰撞。目标 `.dsh` 当前不存在。迁移须逐子项合并，不能删除或覆盖目标已有父目录及无关子项。

## 必须同步的当前绑定

1. 正式 profile 中仍引用旧根的三个配置位置：resident storage `root`、preset `workspaceDir`、taskSessions `dbPath`。全局 agentWorkspaceDir 已恢复目标根，不能因迁移再改回旧根。
2. 源 `tasks/.session-routes/` 的 3 个 route.cwd。
3. 三个原生日志 header.cwd，以及原生日志后端以 cwd 编码的父目录。仅更改 route 或仅物理移动日志均不够：当前路由 open/create 校验原生 header.cwd 与 route.cwd 完全一致。必须使用明确的原生迁移方法与独立读回，不能将正文全局替换当作日志迁移。
4. `D:/dsh_home/storages/dingtalk-dsh-assistant-v9-pr116/workspace.json` 中当前任务 Workspace 的 path，仍指向旧根任务目录；session IDs 保持原值。投影缓存中也有旧路径，但属于派生状态，须按其正式重建/失效合同处理，不能把缓存当权威原生日志。
5. 材料 source JSON 的自身 path、resource.path、value.image.path 仍指向旧根；后续读取会按字节大小与 SHA256 核验资源。需要迁移工具显式处理当前材料路径并保留图片字节与摘要。

## 不能盲改的历史与摘要保护字段

SQLite 当前两条 execution 中有 15 个旧根路径字段，主要是 definition.protectedPaths、input.materialPaths，以及嵌套 previousExecutions。执行 input 对应 inputDigest，旧版本 inputHistory 和 command receipts 也保存原始输入/结果。控制收据中另有 405 个旧根路径字段；36 个字符串字段内嵌旧根引用，清单仅记录字段位置与长度，不导出正文。

这些值不是可任意替换的运行配置。禁止对 SQLite body、原生日志事件、收据及业务正文做全局字符串替换；这会破坏既有 digest、幂等 receipt 和可审计历史。应区分现行可变绑定（profile、route、Workspace 位置、当前材料定位）与不可变历史事实，使用显式迁移映射或正式迁移 API；后续恢复必须保留原 taskId、sessionId、executionId、输入版本及真实授权边界。

## 停机后核验边界

先排空原生执行与效果、确认精确旧 PID 退出，再核验 SQLite/WAL 一致性与所有文件摘要。不得在线复制主 SQLite 而漏掉 WAL，不删除活跃 WAL/SHM。此审计没有批准任何目录覆盖，也没有生成历史数据副本。迁移成功须分别证明：目标内容与原始对应、源和目标冲突没有覆盖、配置绑定一致、原生会话可读且 Host 能继续原任务、收信与通知仍独立正常。

## 当前安全绑定与 Workspace 补充核验

当前执行记录的 `definition.protectedPaths` 可以作为受信 Host 当前安全绑定进行精确离线映射，目标为新控制库、WAL、SHM 和 initialized 四路径；这不授权改写历史输入。隔离测试已证实：仅更新当前 execution 的该数组，保留 dispatchDigest、inputDigest、input 和 receipts，正式 store 重开成功，随后同 execution.continue 保留新保护路径。初始 dispatchDigest 是首次 dispatch 的幂等身份，continuation 本来使用独立摘要；没有针对整个当前 definition 的新增摘要约束。迁移必须逐行记录修改前后 SHA256，仅匹配明确旧四路径，拒绝未知值，不能重算历史摘要来掩盖范围扩大。

当前 Workspace 绑定精确位置为：`D:/dsh_home/storages/dingtalk-dsh-assistant-v9-pr116/workspace.json` 的 `$.tables.workspaces.14990941-5d23-4a16-9627-9c3f32d05f94.path`。正式 `workspaceRegistry` 提供 `resolveByPath`、`create`、`sessionKnown`，Workspace 提供 `attachSession`、`detachSession`，未发现公开 setPath/relocate。attachSession 会读取原生 header.cwd 并核验与 Workspace 路径一致。故通过正式 API 迁移关联时，应先完成原生路径迁移，再对原 session ID 执行 sessionKnown，解析或创建目标 Workspace，从旧 Workspace detach，再向目标 attach；不得把只改 workspace.json 当作已经核验原生绑定。旧 Workspace 记录是否保留或删除须由明确迁移方案决定，不能顺便清理其他 Workspace。
