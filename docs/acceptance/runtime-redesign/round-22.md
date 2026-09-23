# 第22轮：最终回归与交付检查

## 实际发现与修正

- 第4次全仓命令使用 Node 默认递归发现，误扫描 `docs/tmp/dataset-workflow-check` 中临时业务仓库，结果1232项、1207通过、25失败。全部失败定位临时业务测试；该轮保留为FAIL，不能当作本插件通过证据。
- 独立 `git ls-files` 确认本插件全部受版本控制测试均位于 `test/*.test.js`。根 package.json 的 `pnpm test` 改为显式此范围，README同步，避免验收材料改变默认测试集合。
- 最终源码已包含32KiB输出、无损日志编码、失败节点证据、独立阶段预算与C01/C02/C09/C13阻塞反例。
- `node scripts/build-web-client.mjs` exit0；生成内容无实质diff。`git diff --check` exit0。

## 最终结果

第5轮显式范围回归819项，818通过、0失败、1取消：真实两代交付在20核默认并发下触及测试120秒限制。将默认测试文件并发固定为4，未改该测试timeout或产品预算。第6轮 `pnpm test` 最终 **819/819 PASS**，0失败/0取消/0跳过，226041ms；原两代用例93860ms通过。日志 `docs/tmp/runtime-redesign-final-tests-6.log` SHA256：`5B338506F0A21C7EA736ADDEF4D80233D5C74E25AAA40801FA502F7E4E1B6E2B`。此时仍未切换部署，真实业务完整安装/build独立进行。

