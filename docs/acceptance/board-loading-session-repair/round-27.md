# 调查事实与任务联合验收分工

真实反证：stage7调查只掌握目录事实，无法独立声明审批/执行已核实；冻结调查合同却要求所有不足仅由后续阶段补齐。已存在的stage6受信证明被时间顺序规则排除，最终在语义校验前返回false。

当前Host调查策略核对原冻结需求和结构完整性；未引用历史调查只核对自身结果，当前绑定项交给全任务联合验收。调查合同2/3/4共用结构v2，v1保留原路径；冻结工厂源码不改。各领域保留结构、授权和原生执行核验，所有显式绑定条目及证据只作一次共享语义判断，无关阶段不参与。

本轮调查/agent-work/contracts整文件35/35、Service相关14/14及真实v4复合正反例2/2通过。用例包含无校验器、结构缺失、blocked、全事实仍不足、跨项与无关证据拒绝。冻结调查摘要常量保持。

正式包SHA256 `6f7212a8c396910c591d5b2cfcd3234fc2a288a971a8cc7804599e08e45141ed`；零写Check通过，安装进行中，原Task最终完成待核验。

正式部署、Readback、Resume通过：PID48368，health=ok、maintenance.active=false/revision399、自启Ready，无备份。04:29只读生产再次确认表存在/name不存在。readonly重评event256复用原Owner/session/7个成功阶段。

真实最终验收FAIL：native seq24836提交complete，24837仍返回无明细TASK_OWNER_COMPLETION_UNVERIFIED；随后seq25328 wait被接受，Owner153/lease46。当前不能宣布任务完成。继续从真实全部7阶段复现首次失败门禁并补充可纠正诊断，避免仅覆盖最后两阶段的夹具盲点。

首次失败门禁已用真实全部7阶段收敛：manifest.complete=true、missing为空、planning未截断。实际合同顺序为调查2/3/4、external4、调查5、external4、调查5；最后调查为工作流v9/合同5，selector仅2/3/4而漏选，仍调用冻结后续-only策略。此前按v8构造的夹具判断错误，保留本轮FAIL；下一轮改按结果结构选择并补真实v9及全部7阶段复现。
