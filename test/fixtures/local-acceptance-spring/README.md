# 本地验收的真实 Spring 测试夹具

本目录仅包含合成候选类，不包含业务代码或业务 JAR。独立 Maven 项目是必要的：测试必须使用真实 Spring 容器及 Spring Boot PropertiesLauncher，不能以伪造框架类替代原背景开关验证。

在 JDK 11 和 Maven 环境中，从仓库根执行：

```powershell
mvn -B -f test/fixtures/local-acceptance-spring/pom.xml package
node --test test/local-acceptance-project.test.js
```

测试读取 JAVA_HOME 下的真实 java/javac。前端同进程用例还要求 NODE22_EXECUTABLE 指向真实 Node.js 22 可执行文件。

Maven 从标准仓库解析固定 Spring Boot 2.7.18 的真实依赖，并将 ZIP 布局的可执行 JAR 生成至 docs/tmp/task-unified-file-storage/release-1.0.0/spring-fixture/local-acceptance-spring.jar。构建产物不提交；CI 和 Release 验证须在运行测试前执行同一构建命令。

七个合成候选类具有真实 ConditionalOnProperty 注解；ApprovalNotificationOutboxTask 刻意遗漏开关。生产 Host 探针先扫描真实字节码，再交由 AnnotationConfigApplicationContext 注册。disabled 模式必须拒绝唯一仍注册的 Outbox，继续断言 CONTROLLED_BEAN_MODE_INVALID:false:[com.ecdigit.ecdata.task.ApprovalNotificationOutboxTask]，且不得继续安装前端依赖。夹具用于反例，不能作为成功后台证明。
