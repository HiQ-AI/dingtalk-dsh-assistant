# 发行测试映射与复用边界

完整逐文件映射：test/suite-map.json，由 node scripts/test-suites.mjs update 生成，check 对实际测试文件及本地导入闭包重新比对，遗漏/重复/未复审导入变化使CI失败。

- native：实际导入合成原生Host，跨两个独立Windows runner串行运行。
- compat：导入未发布模块或执行真实进程/Git夹具，保留历史兼容、字节摘要与运维合同；三个独立runner串行运行，不因历史文件名退出。
- unit：其他静态、单元或当前合同；并发保持4。

分类用于资源隔离，不决定删测。首版全部文件release=true，0排除。无法静态解析的动态引用不成为排除依据；分类是保守辅助审计，不宣称完整JavaScript语义依赖分析。导入路径及保留理由逐文件存档；冻结合同测试仍在权威Release。包原生测试另对实际artifact执行，证明发布字节，而非重复全量。

每次运行独立短物理TEMP；原生ACL授权仅限该runner测试目录。新测试未入映射不能发行。失败/取消/跳过分别报告，baseline失败不能冒充通过。

正式Release同时保存三个tgz和release-manifest.json四个附件，全部按名称、大小和SHA256回读。清单不是第四个npm包；它用于长期回读原run、源码SHA和三个发行包的身份。
