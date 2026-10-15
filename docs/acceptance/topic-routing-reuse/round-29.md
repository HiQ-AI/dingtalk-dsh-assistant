# 轮次29：冷启动收口与发布结果核验

已将原部署脚本的新进程ready等待改为300秒；退出排空保持120秒，没有更换实例或重做安装。PowerShell原生AST无语法错误，实跑提取的WaitFor函数：立即成功、零预算超时、同一新PID实际双端口ready均符合预期（round-28/startup-wait-verification.json）。原冷启动超时仍作为失败历史保留。

独立回读运行包、版本、进程和健康见runtime-readback.json。真实业务已发布：同一deployment UID af1a2e54，generation/observedGeneration 521/521，desired/updated/ready 1/1/1；新Pod dataset-69c84cbf79-qjp82 Ready=True，imageID为sha256:c0d744d93eec0acfadc2976732f3ee78d5cfd0390de439ee25c266bf3657ad28，restartCount0。服务/DB/Redis/gRPC健康UP，入口HTTP200。kubectl与入口独立只读验证保存在uat-runtime-independent.txt，registry精确digest独立读回在uat-image-independent.txt。

流水线289绑定合入提交4e2a1b56；构建/推镜像成功，restart步骤失败、通知步骤killed，流水线整体killed，独立API回读见uat-pipeline-independent.txt。原执行保留该失败，沿原UAT部署目标精确更新工作负载并完成验证；不把运行成功改写为CI全绿。未重复触发构建、未发送额外消息。

task-final.json独立读回原task=completed/drained，原execution输入11=succeeded/drained，waiting0、unknown操作0，原task/session/execution身份保持。未执行真实申请撤回E2E；17项隔离测试与发布运行核验是不同证据层。

9450830已推送PR182，中文正文与OPEN/head独立读回一致。同期origin/main合入PR184中文短名修复，造成service输入与续办名称断言两处冲突；下一轮合流保留两边行为，定向原生验证后更新最终本地包，不中断业务部署。
