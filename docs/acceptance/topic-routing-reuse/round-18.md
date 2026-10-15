# 最终话题复用首次部署与历史归并

- Assistant SHA256 90a21792f7d2c03824bb1214015a160f4aa18ea9d7008515d3c285a787618fc2，Observer 67e1438d448db76936a233ce0d2ac7930d2c13d6fccedd2c3a02f0b8ef79136d，PID29832，profile未变，接入与DWS就绪。
- 正式Check零写，明确四source、两个唯一target，摘要240d6e20；任务/全部子执行排空。
- 正式单group事务归并后，默认话题2、档案6，其中4个closed/mergedInto；两个目标revision8及4，消息分别6→8和2→4。旧来源revision1各保留一条，revision2当前归属0。
- final-readback.json独立比较原任务、会话、需求/控制版本、topic/source refs、applied operation及全部execution/operation状态不变；Web消息当前仅有一个话题归属。
- 浏览器点击真实话题，2话题及1关联任务可见。截图仅保留本地，不进入源码提交；复现为Chrome现有本地3080页→钉钉群聊运行看板→话题→专家撤回话题。
- 浏览器发现归并后消息按entry插入顺序成为9,14,12,13，后续round-19修正为按来源sequence读取；此轮不声称时间线完整通过。
