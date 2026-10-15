# 轮次25：真实输入计量与初版投影

精确读取原task-session原生lease178的投影及rawHostMessageId对应原审计输入。用户粘贴文本为59451字节，持久原生JSON为59587字节；差异属于粘贴表示，均为UTF-8字节，不是token。

初版投影一度降到23372字节，但终态执行裁掉input/resultRef，且source.body被遗漏；只跑model-context用例未暴露完整原生链路回归。此数字不是最终交付结果。完整来源与执行目录仍可回读，量化脚本保留精确原身份，业务正文不归档。

第一次model-context测试暴露live execution taskId遗漏，补回后8项通过。下一轮必须验证真实原生委派、人工答复和续办，不以局部投影通过宣布闭环。
