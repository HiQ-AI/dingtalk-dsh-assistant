# 第5轮：首次正式启动失败与原生策略反证

实际失败：计划任务首次新Node退出1，3080/18998均无监听；stdout明确ERR_MODULE_NOT_FOUND cordis-plugin-group。旧任务维护已drained/sealed，保持停机；没有Resume或再次启动。

根因：alpha2 initProfile原生pnpm-workspace要求nodeLinker hoisted/autoInstallPeers false；初次candidate仅packages[.]而使用默认isolated/autoPeers。11 direct依赖在正式策略下不完整，peer缺失被初次隔离环境自动补齐。native package声明审出required-peer闭包25缺项，补上group/include/timer等完整core为32directCore（DSH27/Cordis5）；仅安装core packages不改变bundle/patch/业务状态。

原部署已冻结PS/helper/proposal及产物，不修改它们或失败证据。新薄续接入口复用冻结函数与native checker/helper，在相同seal与owner lock下CAS补manifest，产生独立新证据；通过原Readback再Resume。需新candidate逐字正式安装策略cold boot/真实API/UI，全部guard负例、零写Check及rootreview。

已有历史迁移、五包字节、81会话与writer证据仍成立；正式启动这层明确FAIL，不能用install exit0掩盖。
