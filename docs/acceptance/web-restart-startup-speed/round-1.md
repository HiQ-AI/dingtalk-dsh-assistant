# 本地启动速度实测

## 实际根因及修复

完整profile boot的默认Node加载路径有可复现的百秒延迟。正常无诊断重启PID78684：ServiceReady171.18s/总181.54s；只改为Node原生同步load透传、无任何网络/子进程/文件计时干预的PID65708：17.65/29.91s。正式入口PID56220：17.64/29.43s，降幅分别89.7%与83.8%。控制库、profile、Node版本、已安装插件保持；每次原生历史快照独立核验通过。

诊断测量第一次有同步hook混杂，已明确保留纠正；不能用带hook的1.48秒库加载推翻正常启动慢。真正无hook/同步hook的9库图1.605/1.608s、exports相同，说明小库图不替代完整boot。全诊断本轮CLI kubectl244/gh137/docker484ms、Bytebase110ms/DWS549ms，未支持网络/凭据百秒解释。没有硬猜磁盘/Windows底层原因。

安全重启等待由每轮全CIM/双Get-NetTCPConnection/读登录日志，改为.NET原生监听快照、HTTP及必要的独立Owner核验。原生监听快照10–11ms；单次双端口Cmdlet3079ms、过滤后直接CIM1092ms。加入阶段耗时和每10秒等待说明；保留原生排空/封存/快照一致性、旧PID退出、新PID双端口、匿名401、恢复派发，240秒超时不重启。

## 验证

Windows隔离等待及ESM/CJS/动态导入/worker语义 + 发布启动入口相关12/12 PASS；末次cleanup安全断言新增后对应语义1/1再过。部署原生合同与无历史备份PowerShell回归已实跑；证据为私有restart/deploy日志，不向用户输出登录令牌、CLI输出或凭据。

源码脚本落盘到scripts/并部署DSH_HOME/launchers三文件，逐SHA独立一致；桌面薄入口已更新。正式自启Action指向持久启动脚本与真实ProjectRoot，UserId/Enabled保持，无NODE_OPTIONS全局设置或临时preload。普通本地部署无历史副本。主检出原未提交AGENTS.md保留。

最终PID56220延迟86.3s仍存活、前PID65708退出，3080/18998同归属；health=ok/recoveryIssueCount0/inboundProcessing=true，维护false/revision441、自启Enabled=true。匿名Web401，控制历史回读通过。未把启动健康声明为完整浏览器/新消息业务验收。

## 证据配方

运行node --test test/restart-web.test.js test/release-workflow.test.js；先桌面-Check零写预检后正常执行，收集TimingSeconds并独立回读健康、维护、自启和PID/端口归属。正式启动不含计时诊断hook。原始私有计时及安全摘要在docs/tmp/dsh-startup-speed，不进Git。
