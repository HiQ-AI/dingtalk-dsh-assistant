# Round 2

## 结论

本地正式安装、目标表配置、启动与手动同步、三个连续定时周期、旧尾行清理和目标群读取授权均通过。受控浏览器 helper 无法附着 WebView，本轮没有新增设置页截图；接口、bundle 和设置页自动化测试证据保持有效。

## 安装与运行态

- 停机前稳定存储只读预检通过：domainVersion 7，groups 1、scheduler 1、tasks 48、alerts 71、activities 8055，invalidRecords 0、strippedFields 0、unknownTables 0。
- 稳定存储、profile `package.json` 和 `cordis.patch.yml` 已备份到仓库外 `D:/dsh_home/backups/task-board-sheet-sync-20260914-1618`；存储 SHA-256 为 `7E4B0D006165ECE21C1944D8BD74ECC612FEEE113F9B915B6CD1B6544C6765F3`。
- 首次安装发现 profile 的 `node_modules` 沿用 `C:/Users/64554/.dsh/profiles/web/node_modules/.pnpm` virtual store；按 `.modules.yaml` 的真实 `virtualStoreDir` 重跑安装成功，没有迁移整个依赖树。
- profile 依赖已指向本轮 tgz；`task-sheet-sync.js`、`client.js`、`web-client.js`、`resident.js`、`store.js` 和 `http.js` 的安装文件 SHA-256 均与提交源码一致，原 `cordis.patch.yml` 哈希保持不变。
- 新实例 PID 812208 同时监听 3080/18998；`/health` 返回 ok，群监听与个人回复监听均为 ready，recoveryIssueCount 0。

## 同步与回读

- 连接检查返回“小小鹏任务表”、nodeId `14dA3GK8gjN40j3jiE5azAZGJ9ekBD76`、Sheet1/sheetId `kgqie6hm`；保存配置回读 `enabled=true`、`intervalMs=180000`。
- 启动同步于 16:20:26 触发并成功，任务数 23；手动同步于 16:21:27 成功。
- 三个连续 timer 批次分别于 16:23:26、16:26:26、16:29:26 触发，均约 3 秒完成，批次 ID 分别为 `007cf64a-f4f7-46f3-8536-9e68619ffbe9`、`539a156d-14dc-4db3-913a-319e8e889811`、`89ffa48b-ca56-40e4-adb9-11521bfd68f0`，任务数均为 23。
- 在 A30 写入 `OLD_TAIL_MARKER` 后执行手动同步，写前读到标记、写后为空；最终完整读取 A1:N200 返回 `complete=true`、`hasMore=false`、23 条数据、尾部非空行 0。

## 权限与边界

- `drive permission get-setting` 回读权限模式为 INHERITED、visibility 为 PRIVATE，没有扩大公开范围。
- `drive permission list` 完整返回 2 条授权：文档所有者，以及“广场＆编辑器迭代中...”群的 READER；群内同事具有读取授权。
- 未使用第二个同事账号做交互登录验证，也未修改任何分享权限。
