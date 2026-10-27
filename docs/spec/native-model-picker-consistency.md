# 统一原生模型选择器

目标：三个字段直接复用宿主 conversation.input.model 注册的 ModelSelect，搜索、提供方分组、模型/深度菜单和键盘行为均由宿主维护；三者使用同一 remote.session.modelCatalog 返回值。

现状：插件 ModelIdInput 是浏览器 select，候选限定在字段当前 provider；默认配置保存忽略 provider，无法正确跨提供方选择。宿主组件不从模块导出，但 SlotRegistry.entriesOfSlot 的公开注册视图提供 component。只复用该 component，不调用其 session inject/select，避免写当前会话。

方案：通过设置页注入一个原生选择桥，加载并共享原生 catalog，给三个组件分别提供只读目录快照及草稿 select 回调；保存仍走唯一 Agent 入口。默认配置随草稿保存 provider，服务端校验 provider/model/effort 后再写；独立配置保留继承语义，用明确复选框控制继承。

验证：原生实际 bundle 组件身份及浏览器搜索/分组/键盘；三个目录同源及同名跨 provider 精确身份；跨 provider 保存与失败预检；构建及映射回归。保留现有业务数据，不调用真实 session.selectModel。新 PR 交付，不沿已合并 PR 推送。
