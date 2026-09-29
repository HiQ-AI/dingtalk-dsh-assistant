package com.ecdigit.ecdata.task;
// 合成候选：Outbox 故意缺少开关，必须被真实 Spring 容器拒绝。
@org.springframework.boot.autoconfigure.condition.ConditionalOnProperty(name = "app.background-jobs.enabled", havingValue = "true", matchIfMissing = true)
public class DatasourceVersionCalculateTask {}
