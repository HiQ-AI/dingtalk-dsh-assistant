# DSH 统一宿主升级方案

2026-10-13，本轮实施快照。用户已明确批准DSH、Codex Connect、当前插件及压缩插件统一升级，Bytebase一起升级，已卸载插件市场且不恢复。

## 精确组合与当前来源

DSH0.2.1-alpha.2、Cordis4.0.5-alpha.1、Loader1.0.6-alpha.1；钉钉Assistant/Observer来自已合入main b2fb1ac；Convergent来自17d7c54；Bytebase定向移到alpha2；Codex0.2.0-alpha.3使用suite的本地alpha2源码适配，不能当作registry同版本。

全部本地包单独计算SHA256，正式安装路径使用带hash的不可变文件名；不覆盖旧包，也不恢复退役DSH直接依赖/override。profile原metadata/bundles、storage/model/search及业务配置保留；Convergent基于完整官方preset插件列表逐项替换，保留现有instruction参数。

## 现场历史迁移阻塞与方案

旧实例81个v0日志包含82个业务owned身份事件。官方0→1/1→2冻结vocabulary拒绝这些ignorable事件；官方rc2分段升级已实跑失败。runtime注册迁移、删除回插及类型替身都无法保留正确seq/cut/Surface语义，不采用。

维护官方两个迁移边源码的最小本地补丁：以已确认生产schema识别四种历史事件，要求ignorable=true，保留完整data/time并由原边内部map/emit推进序号。其余未知与已知恶形事件拒绝。后续官方2→3→4继续处理；V4事件规范namespace，原v0bytes不改。提交安全合成fixture/源码patch和重建配方，不提交生产内容。两个包仅用精确pnpm.override文件引用，声明与实际安装字节双重核验，禁止宿主版本豁免。

## 切换与验证

先通过组件原生测试、全套隔离安装/启动、所有现场会话副本read与代表writer/reopen、未知和malformed拒绝。随后使用现有deploy-owner-repair.ps1的维护排空、seal、Stop、owner锁、安装、启动、readback、resume顺序；新增HostUpgradeProposal仅在完整离线维护中CAS更新manifest并追加patch，不复造编排。

零写check冻结提案、脚本和所有引用tgz。安装后结构深比较、actual包字节、维护许可及Task/Run快照核验均通过才恢复。旧v0原本保留；新版继续写入后不能盲目降级，新模型网络/渠道发送边界独立报告。
