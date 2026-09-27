# UAT2 双项目接入第一轮

日期：2026-09-26。用户明确本次使用 UAT2，数据库仍为共享 UAT；没有选择或修改生产环境。

## 后端用例失败及清理

正式 runner 从冻结候选重新构建、启动带后台关闭模式的 Dataset，构建与启动均成功。首次单位分页用例错误使用 `pageNo/pageSize` 和 `data.records`；真实契约为 `page/size`，`data` 直接为数组。用例命令失败，runner 返回 `passed=false`，没有放行。

命名空间：`acceptance-6745def16103d8907ff610a81c969abf`。失败后注销本次会话，独立两次确认无效；本地服务停止，收据 `dataCleaned=true, processStopped=true, mode=read-only, createdResources=0`。此处未创建业务数据，不代表执行了数据库删除。

收据：`docs/tmp/uat2-local-integration-20260926/dataset-attempt1-receipt.json`；冻结准备：同目录 `dataset-attempt1-prepared.json`。原始明细保存在仓库外私有证据目录，不提交凭据和会话缓存。

## 修正与下一轮

修正接入验收脚本的参数及结果投影；只读执行器未把错误字段默认为成功。下一轮重新冻结、重新构建并执行，最终结果见 round-24。前端独立检查继续执行，不将手工页面启动当作完整 runner 回执。

## 前端请求规则遗漏

首轮前端完成冻结候选构建（627916ms）、绑定后端启动（45195ms）、前端启动（186655ms）。本地后端 origin/SHA 和就绪比对通过后，浏览器规则阻止了正常的应用配置读取和版本 HEAD 检查，因此用例命令失败，未放行。命名空间 `acceptance-75d855219d4e063c552a8b42d57c31c1`；收据确认浏览器关闭、前端及后端均停止，没有登录和业务数据写入。

源码定位：Dataset Web `src/utils/app-config.js:104` 读取本地 `app-config.json`，`src/utils/version.js:9` 请求 `HEAD /?cv=<随机数>`。按精确方法、路径和参数补充规则；仍阻断未知业务请求、写接口及外部遥测。原失败收据保留在 `docs/tmp/uat2-local-integration-20260926/dataset-web-receipt.json`。

增加单位页用例的中间一轮在前端启动阶段返回 `LOCAL_ACCEPTANCE_PROCESS_INSPECTION_FAILED`，随后清理、停止前端与后端、独立回读均成功。该回执未保存系统检查失败的底层原因，不能将超时或编译负载推测当作已证实根因；没有进入业务用例。证据为 `docs/tmp/uat2-local-integration-20260926/web-final/dataset-web-receipt.json`。最终规则使用独立新一轮执行，保留失败记录。

第三轮真实登录页检查通过；已认证单位页因正常枚举接口 `/api/dataset/enum/process/common` 不在只读规则内而失败。核对后端为静态枚举读取后，补入精确 GET 路径，仍禁止未知请求。该轮 62 条请求回放检查已消除正常只读请求误拦截，但回放不计为实际浏览器验收通过。证据在 `web-round3/dataset-web-receipt.json`。

第四轮仍在前端启动阶段遇到进程检查失败，未进入浏览器；清理及独立验证通过，见 `web-round4/dataset-web-receipt.json`。修订 runner 的就绪轮询：先等待无凭据 HTTP 成功，再核对实际 PID，每个业务用例前仍核对双服务归属。新增安全失败诊断，避免下一次无法区分检查失败原因；并通过延迟就绪、HTTP 成功但错误 PID、检查命令无法启动三个反例。完整 runner 定向测试 11/11 通过（172.43 秒）。最终真实执行另起第五轮，不覆盖前四轮失败记录。
