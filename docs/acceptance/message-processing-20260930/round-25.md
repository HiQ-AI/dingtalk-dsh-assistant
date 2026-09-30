# 第25轮：原生模型结束状态与实际重放

## 已核验

- 静态容量覆盖提案未实施，按用户追加要求改修 DSH 适配器。正常 stop 不再按本地模型目录二次改判；实际 error、截断与取消仍按原生状态处理。
- 消息 Host 采用单一 180 秒窗口，真实错误诊断入节点账；容量错误等待系统修复，不自动重复同一输入。过期租约错误不能改写当前来源状态。
- `node --test test/message-workflow.test.js test/message-ledger.test.js test/message-repair-coordination.test.js`：161/161 通过。
- `node --test test/observer-client.test.js`：20/20 通过。看板沿用现有 `traceReason`，等待说明与状态提示使用同一映射，未更改布局和交互。
- 原真实 R 输入 980715 字节、inputHash 相同，正式配置无容量 override，候选适配器在 29683 毫秒自然 stop；输出1827字节，schema及来源校验通过。该结果仍为候选分页，不能作为最终归属通过证据。
- 原已有 IB 输入39562字节，同候选及正式配置22529毫秒自然 stop，通过结构和来源校验；不代表后来完整材料及连续阶段请求已验收。

## 部署候选

- Assistant：SHA256 `8207cf2c552117656d84d25e94382ba6fcb63b7d4ac4e30f896a1addfda2820d`。
- Observer：SHA256 `9bfcf4e9f55a0ccec5de08517bcb081529209242bc0e300b11fcf1498ff2e644`。
- DSH pi-ai adapter：同已安装版本对应发布 tag 源码构建；SHA256 `cbf6f3d68a6ff708bb55ab301ae97fad735b43d60655fdde1bb2083b92719b79`。Codex provider 外部导入该依赖，不需要更换模型或 provider 包。
- 上游修复本地提交 `5de815800d0ee1434c7d8f59cf0700e0dd43257b`，未向外部远程推送；适配器与Loader定向128项通过，包编译及文档quick15项通过。全库doc-sync 23通过/9失败，涉及未安装整站依赖和未改动文件既有JSDoc问题，未声称全库检查通过。
- 原始探针、运行输入及输出只保存在本机 `docs/tmp/message-processing-deploy/`，不提交真实消息内容。

## 尚未验收

受控安装、完整候选关联、含新材料的实际 IB、原命令继续执行、Task 发起、阶段授权条件及通知回读仍需完成。第24轮 A14 的 FAIL 保留；不能用当前单页模型成功代替整条业务链通过。

## 用户取消备份后的正式安装

用户明确要求不要备份，本轮已停止备份核验，未把中断目录记为完整可用备份；已有文件保留。续接零写预检核对封存状态与22个原任务，未创建新备份。原生安装首次回读发现hoisted依赖树仍命中同版本旧adapter；通过profile package.json的pnpm.overrides将该依赖统一指向精确本地tgz，再原生安装。没有热改已安装代码或模型settings。

新PID 29924实际解析adapter入口摘要为d89e121bbfa64cd079762e46dd38eb0219eb929437a16ac39e4aa5f6b8ed68aa；三包120文件核验通过。历史22任务、76节点、29运行及68 legacy记录通过；健康ok、认证Web200。维护revision177恢复，原失败来源版本6受控递增至7；其余原命令不重建。业务重放仍在运行，尚未判定A14通过。
