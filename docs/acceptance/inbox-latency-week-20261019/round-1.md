# 实施取证与修前基线

此目录仅承载可提交的脱敏工程证据；原分析 report/CSV 和唯一 goal/matrix/shared-tasks 留在原任务根，不覆盖、不同步业务明细到 PR。

## 已有修复：源码与安装分层

- `git merge-base --is-ancestor 4444f6a 0535038`、`3d9c85e 0535038` 均退出 0：来源续办、协调契约修复已在本次实施基线中，不重新实现。
- 对已安装 profile 的 `createRequire(profile).resolve` 所指 Assistant 实际目录与当前 tgz 做只读比对。六成员的 archive/installed 原始字节相同；与基线 Git blob 在 LF→CRLF 后一致，不能称 Git 原始 blob 字节相同。独立复核哈希见 `round-1/installed-baseline.json`。
- 该证据只证明修复代码已安装，不能证明历史阻塞已全部恢复或本 PR 已部署。历史会话只读取证脚本不是安装包比对脚本。

## 真浏览器修前症状

完整旧 Observer + React 18.3.1/ReactDOM + 实际 HTTP handler + 合成 runtime；宿主 slots/primitives 为适配替身。随机 loopback fixture server，所有业务 API 请求拦截到 fixture，非 GET 拒绝，外部连接拒绝。

- 旧 Observer SHA256 `e771c6b5221d8d698cb483a899d3f1f95db8fc21206709de75adaea8a5bb414d`。
- API 不含 topics 时，尚未完成 Topic、尚未判断 source 两条消息均误显“已处理”。真实 Edge 156 断言通过；无 JS 错误、无业务写入；修前截图已目视确认。
- 修前证据只在原任务根 `round-1/ui-baseline/` 保存，不提交本机业务快照。
- 首次因缺匹配 ReactDOM 失败；在 job 临时目录安装 18.3.1 后，脚本显式接收 `--react-dom` 并校验与 React 同版，再实跑通过。

## 反例与未收敛项

并非缺 topics 就证明后台未处理；这里证明的是前端没有完成证据仍判成功。后端真实来源/Topic 完成门禁、同版 unit revision、通知版本和失败路径另做永久回归。历史最大空窗没有入站时钟，仍不能归因为锁等待或纯模型，不据此盲改并发。

## 首次原生组合回归失败

实施中间态三文件组合 `coordination-latency-native / independent-coordination-native / task-session-service-native`：63 tests，25 pass / 38 fail / 0 skipped，303624ms。主要已证根因为 `source.stage` 用默认正整数校验拒绝入口 `attempt=0`，埋点阻断 ingest；另有等待超时及 errors 断言，不能把全部失败未经复跑归为同因。该轮不作通过证据；修复后需完整同组复跑。

早期 SG1 首次误在主检出运行的 skip 和授权用例 20s timeout 同样不计 PASS；后续通过不能抹去这些失败历史。
