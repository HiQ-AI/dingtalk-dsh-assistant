# 第8轮：原发布执行权限恢复

## 结论与反证

原c5 input8发布已接续但真实受阻，不能再归因为委派入口缺失。git add被outputs唯一写根拒绝，真实index.lock位于原common-dir；git ls-remote的现有MSYS认证辅助程序创建命名对象被受限token拒绝，非目录ACL或凭据失效。拒绝后HEAD未变、staged为空，未产生提交/推送/部署。对正常当前用户原检出远端读取成功，进一步排除凭据失效。精确原回包见docs/tmp/coordination-mode-fix-20261028/publish-turn8-denial-evidence.json。

用户补充要求拉取最新代码。已fetch并合入origin/main@36f3d52a（PR286），独立核验该SHA是当前HEAD祖先；该主线独立执行已full，但协调artifact分支仍强制workspace-write并阻止提权，不能声称上游已去掉本条限制。主检出保留用户未提交文件，没有改动。

## 修复

统一产物归档与原生执行模式分开；artifact.3保留binding/session cwd，默认workspace/read-only边界保持，尊重原生受信显式模式与真正批准的逐次模式。复用operator human reply/check，对精确execution/inputVersion记录原生模式纠正；配置operator、版本、执行归属/排空/DSH/目标未决效果及受信来源均重校验，source/permission/reply/wake原子提交。Host只把正式ledger/source核验过的记录作为顶层run参数，模型input不能提权；只纠正原发布会话，不改Owner、同伴、profile patch或凭据。

## 验证

- 最新主线合入后，store/http/纠正相关209/209 PASS，19.45秒。
- execution-session-native及policy-upgrade97/97 PASS。
- 原生human-reply纠正1/1 PASS（同execution input1→2、同session原生mode事件、Check零写、来源与rr/cr保持）；无纠正对照也通过。
- 显式本轮artifact.3：真实临时Git worktree/common-dir位于artifact外，默认git add拒绝且staged为空、MSYS sh拒绝；原生完整模式同路径git add及sh exit0成功；默认产物内写成功，原cwd和binding保持。历史绑定/模式用例通过。
- 最新实际双包RELEASE_PACKAGE_DIRECTORY路径的release-smoke14/14 PASS，无skip。最初未指定profile时2项skip，补跑实际profile首次npm复制打包开销使第一用例30秒取消；保留失败记录，改用现有正式预打包输入（未放宽超时/删断言），实际安装包用例通过。
- 旧4个Owner直写artifact用例仍因现行task_tool_outside_role失败，未放宽Owner或删断言；不声称全量绿。它们与当前原发布执行的权限恢复分开记录。
- suite map324文件逐文件唯一、历史3、删除0；最新主线新增测试保留。

## 安装

源代码在合入最新main后的HEAD6f7015f9冻结，Assistant包SHA256 5e2e08774a70cabaaeb5f84d49e8e27a4b21abae3d88a85867ea3138f022df9c，Observer 2beb89f5eee6e9b5c85684d6566a7dcf064f98326f288b984e1c15e80a783ef2，policy artifact.3入口45b57f9eae2940017263172919cc676edfb3482a1771d948281cbef2aa60ec23。Check零写、精确旧PID44064自然排空后原生SIGINT；原Host/收信父进程退出后，核对captured PID+CreationDate+命令清理仅遗留只读dws broker38224，conhost同步退出。未停止活动业务执行。

官方plugin add安装后独立89文件/真实dsh-base policy消费者校验通过，profile patch SHA6fe4ab...14e7e保持；新进程22748已创建，在线及原执行恢复由后续独立回读补录。证据docs/tmp/publish-permissions-20261028/native-deployment。

首次正式check拒绝的真实原因：原Task业务owner与配置operator不同；这是权限纠正实现中新增的错误门禁，并非用户缺授权。已仅删除permissionCorrection链3处相等要求，保留配置operator/source及其他全部校验，artifactScopeCorrection不变。独立operator≠业务owner的store17/17、native1/1通过。不得冒用原业务owner或修改配置身份来绕过。

最新主线详细页另返回OBSERVER_PAGINATION_MIGRATION_REQUIRED，属于PR286显式离线索引迁移前置，不能把503误报权限修复失败，也不能为此隐式全库迁移。当前权限恢复使用精确原执行/原请求正式入口，现场状态通过精确ID只读SQL补证，不运行历史全库检查。

最终安装追加：operator修正包SHA7868360ffc0e3ff2d56e6fbf9300239257a4365fa498a9b5068c0e9cad807d72。原file路径同版本重包被安装缓存复用，独立字节回读以INSTALLED_SOURCE_MISMATCH拦住启动；保留原failure收据，在同包SHA新不可变路径按官方CLI接续安装后89文件匹配，再恢复计划任务，新PID21912。未直接修改node_modules。源头部署脚本改成按SHA物化不可变包（policy有效提案与override同步），12/12定向测试通过，Check仍零写。

正式原human request reply/check ready=true、writes=0，随后reply成功；原执行permissionCorrection.sourceId正式落账，需求/控制13/13、context16不变，原Owner lease171/drained=false继续。至此只证明原发布权限纠正登记和Owner接续，原c5仍input8时不能冒称原发布新轮已执行；后续原生事件另补录。

原Owner171后续未成功决定：三次task_execution_read真实arguments均{}，id错误达到既有三次预算后halt；不是执行不存在或权限再次失败。完整模型内容读取曾成功返回技术答复，尚不能区分模型空参生成与gateway流丢参。正式context纠错入口另被最新main的getTaskSessionDetail/分页索引503挡住，已改为精确task.get身份预检，当前Task context/archive、legacy410、missing404三项定向测试通过；不为技术输入隐式做全库索引迁移。仅纠正原调用参数一次，再观察原执行，不循环重复唤醒。
