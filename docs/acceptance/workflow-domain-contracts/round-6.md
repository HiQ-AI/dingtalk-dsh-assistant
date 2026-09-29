# 同领域多个工程阶段反例

第五轮 555 项通过后，补查“保留已成功工程前缀，再追加另一工程要求”的场景。当前计划允许多个工程阶段，需求修订也会累积 Owner 验收项；不能假定一个领域只对应一个 Run。

复现使用 `test/workflow-engineering.test.js` 已有的实际工程交付证明夹具：当前工程冻结条目 A，另一个条目 B 引用后续工程产物。预期当前工程只核对 A，实际因策略把整个工程领域的 A/B 都与当前 Run 冻结输入匹配而返回 false。

命令：`node --test --test-name-pattern='工程交付证明复用同一 Run 工件并要求显式业务 E2E 检查' test/workflow-engineering.test.js`。

修改实现前执行结果为 0 PASS、1 FAIL，断言 `false !== true`，原始输出见 `round-6/engineering-policy-red.log`。这是有效结果被误拒，与第四轮的无关结果误接纳分别记录。

修正只作用于当前工程完成准入策略：先验证阶段绑定和完整交付证明，再用该阶段的产物引用筛选其负责条目，最后匹配冻结验收标准。没有承担条目的工程阶段也不能跳过交付证明。历史工厂和 `readEngineeringDeliveryProof` 不变。

修复后的正例、绑定反例及无承担条目时的损坏证明反例进入第七轮，不覆盖本轮失败记录。
