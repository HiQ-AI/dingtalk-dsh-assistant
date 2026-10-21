# v2.1.0 之后的混合历史测试拆分候选

## 本地交付边界

基线 `7ca36c26ad1c52e8b1896fdc76a7e8aed1c9a697`，隔离分支 `fix/release-test-classification`。本记录对应提交PR前的本地验证阶段；该阶段未commit/push/PR/merge、触发或重跑CI、发布或部署。原仓未提交内容未修改；未引入实验分支、协调层方案、服务或凭据变更。三个生产package及release.yml无diff，v2.1.0版本、tag和发行包未改。

## 分类与改动

三份源测试202个注册、220个展开用例完整保留。38个当前/保留兼容或未知混合注册留Release，164个纯历史注册（182个展开用例）在三个 `*-history.test.js` 中保留原断言、选项、超时和清理。逐项ID、原行号、SHA256、变体、目标和依据见 `test/mixed-test-contracts.json`。

- workflow：31注册/45用例，保留原#1/#9；junction外部零写和v10摘要不变合同继续门禁，旧固定工程Git/HTTP/Run链移历史。
- local acceptance：22注册/26用例，保留#19/#20；当前共享目录安全及保守身份合同不退出。
- runtime：149注册/149用例，保留34项Store/Topic/Bridge、配置及疑义混合覆盖；115项旧单叶子、阶段审阅、Goal、活动投影、在线工作区切换及旧任务迁移协议移历史。不是按旧模块导入整组退出。

依据：55个发布JS根的字面量相对导入闭包仍55；当前README、resident装配及清洁启动明确退出旧Task/Run/节点入口。发布成员关系不是单独排除理由。冻结历史字节/摘要合同和仍发布共享模块的实际断言继续门禁。

共享非测试部分物理提取到 `test/fixtures/*-mixed.js`，只改相对导入并增加导出。固定Git blob契约验证原注册/变体、完整helper和保留ID；目标/fixture完整摘要、严格注册以及实际发现集合交叉核对防止静默漏测。Acorn仅用于此审定与守恒，不执行测试源码来发现注册。

package接通 `test:history`；`test/test:all` 顺序执行全部七组。手动CI scope=all/history，无定时或push/PR触发。Release六组及同run/同SHA artifact、权限边界不变。新测试未审定退出时保守进入Release。最终映射270文件：unit41、native15/14、compat66/66/65、history3；新增契约测试始终在Release。Windows native/compat/history文件并发1，unit4。

## 实际验证

| 检查 | 实测结果 |
| --- | --- |
| 拆分前两个工程相关样本 | 2通过，565.8517ms总耗时 |
| 拆分后38项Release混合覆盖首次执行 | 36通过、2失败、0跳过；11556.7652ms；两失败为祖先realpath的EPERM |
| 两项安全测试针对性审批后串行重跑 | 2通过、0失败、0跳过；38197.4346ms |
| 三个历史文件各一项选定smoke（串行） | 3通过，0失败，1236.0103ms；未执行其余历史用例 |
| 最终校验器、release workflow及artifact定向测试 | 24通过，0失败/取消/跳过；19047.9308ms |
| 映射及diff格式 | 270文件各一次、history3、删除0；git diff --check通过 |
| 依赖锁一致性 | pnpm10.13.1冻结离线安装成功，1.2s；Node24.19.0 |

最初两失败目标是 `<user-home>` 的祖先realpath，普通沙箱返回EPERM；不是自动审批政策拒绝。后续仅两项原测试的正常 `require_escalated` 请求获准执行，保留原断言，串行2/2通过。未改ACL/全局设置，未更换路径绕过拒绝。其他36项源代码/fixture未再改变，因此没有为汇总重复运行38项。首次命令使用Node默认文件并发；后续使用显式串行或映射并发。

pnpm读取用户rc有权限警告，原生依赖构建脚本仍被忽略；这不构成当前产品完整原生Host验证。没有运行本地全量、完整历史真实进程链、完整package-native smoke或真实渠道/部署验收。

## 独立review与收益边界

独立review分别核对workflow/local、Runtime语义分类与物理提取、CI/package/runbook、守恒/发现/Windows隔离。发现的“分类目标可改成非.test.js而不被发现”漏洞已关闭，并用自洽manifest反例验证；复查确认，无其他阻断发现。review本身未跑测试。

父线程提供的旧成功run观察：unit14s/native1 97s/native0 238s/compat1 307s，compat0/2曾超过10分钟且最终compat0最长；最终3302pass/5skip/0fail。这里未独立读旧日志。新候选未跑CI，不给出整体节省秒数；182个历史用例移出自动发行是执行范围变化，不是测得的提速。环境准备、其余保守覆盖及旧Runtime模块加载仍可能决定长尾；两安全用例批准后本机共约38秒，不能由迁移比例估算CI时间。

GitHub CLI只读run请求曾在本机 `<user-home>\AppData\Roaming\GitHub CLI\config.yml` 返回Access is denied，尚未访问仓库run资源；未换路径/凭据重试。该日志来源缺口不阻塞本地候选实现。

## 后续审阅入口

操作与合同边界见 `docs/ops/release-test-mapping.md`、npm-release第4步、AGENTS。修改旧源码或共享fixture时需显式验证相关历史路径；不默认跑全历史，不因失败改变分类。提交及创建PR由后续授权交付；任何CI/发布/部署需要另行授权。
