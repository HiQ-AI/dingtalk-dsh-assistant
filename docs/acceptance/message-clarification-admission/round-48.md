# 第48轮：阶段引用修复部署与同候选检查配置恢复

40da8e5f包SHA256为40da8e5f8fc8e1e2af4fffe3de691fdb35fabba8b69c9a578110cec2044edacf，729992字节。新PID146784，100文件回读一致，认证Web200、健康ok，6条Task与156旧节点历史核验通过。部署保持maintenance494、busy全零，用于既有checks checkpoint操作。

## 检查失败原因独立回读

- f559 generation5：依赖安装exit0、197980ms；三个不存在的固定测试路径导致下一步exit1、158ms，构建尚未执行。候选9997461d44c27427cdc894ef0e63baa613e8657b2a8390a18bb0ec782faba40c，七个成功节点及其工件保留。
- 1edb generation1：2698个源码文件全部展开后启动测试，67014ms退出。Host固定筛选两个不存在的Merge测试类，Surefire报No tests were executed，后续打包未执行。该错误不能证明候选缺少本需求测试；先修Host检查选择与报告核验。

本轮不取消业务Task，不修改候选源码，不伪造检查通过。后端检查工具的单独修复与验证见round49；检查恢复点及恢复派发结果在本轮后续记录。

私有证据：stage-deployment、stage-deployment-independent-proof.json、stage-checks-before-proof.json。尚未把部署健康视为业务交付完成。
