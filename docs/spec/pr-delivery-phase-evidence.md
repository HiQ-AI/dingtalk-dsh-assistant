# PR 交付阶段证据

当前 PR 适配器将发送前和发送后的读取失败统一记作 unknown，无法证明是否调用过 mutation。此次在受信 repository 的同级固定目录保存不可覆盖的发送意图与调用结束记录，绑定 prepared digest 和 operationKey。文件以排他创建、写入后 fsync 的方式持久化；缺损、身份不符或链接目录一律阻断。发送意图必须持久化后才能调用 gh mutation；重入看到意图只能只读对账，不能重发。记录不保存 stderr、凭据或 PR 正文。

只读 gh 对明确网络错误或 HTTP 429/502/503/504 最多尝试三次；认证、参数、JSON 错误不重试。发送前读取耗尽且尚无发送意图时返回 failed/phase=preflight；意图之后错误保持 unknown，mutation 绝不重试。旧效果没有本协议日志时，原生 reconcile 只读，不补写记录，也不据此判定未发送。

验证包括发送前失败、只读暂态重试、mutation 回执失败、持久意图重启与并发、日志损坏和身份冲突。该改动不直接恢复旧事故或修改远端。
