# Runmark OpenCode plugin GUI

GUI 使用官方 `TitlebarItem` 的 `window-analytics` 图标，通过 Yuri 补充契约
`yuri.page` / `yuri.pages` 打开全局内容区；不是官方全局页面 API。
宿主复用文件预览的 Solid/DOM 挂载区块，Runmark 只创建 iframe，直接显示现有 Dashboard，
不重写页面。移动端隐藏入口与命令，不使用 IPC 或读取客户端本地 env。

在此插件 options 配置 `endpoint`、`apiKey`。iframe URL 只有公开的 `embedOrigin`，
没有 AK。更新后的 Dashboard 向指定 parent origin 发 ready；插件同时验证
message source 和服务 origin，才向精确服务 origin 发送认证参数。
Dashboard 只在内存保留 AK，沿用原 `apiFetch` 给同源请求附加 X-API-Key；
嵌入模式 omit cookies、拒绝重定向，不依赖第三方 Cookie，也不写 localStorage。
普通独立 Dashboard 仍沿用 Cookie 登录。服务端必须包含认证接收逻辑；旧版服务不会自动取得认证。
服务必须能在当前浏览器中访问，HTTPS 页面不能绕过混合内容限制。

iframe 不随会话/消息/无关 React render 重建；关闭或插件配置/revision/runtime
变化会释放 iframe 和消息监听。宿主容器无额外标题、返回或状态横幅。服务的正常鉴权保护仍是最终权限边界。

Runmark 自己提供 30px 高的 mini 导航栏：24px 后退、前进、刷新按钮与只读地址栏。
地址同步 Dashboard 路由，不显示 `embedOrigin`，不携带 AK。插件内存历史最多保留
128 项，后退后新导航会截断前进分支，替换路由不增加历史；关闭插件后不持久化。
后退/前进通过 `runmark.embed.navigate` 消息切换当前文档的 hash，不调用 Yuri
或父窗口 history。Dashboard 用 `runmark.embed.location` 报告 push/replace/traverse；
双方校验 source、origin 及同一 pathname/search，拒绝跨文档或跨站导航。
导航请求带递增 id，等待最新回应时忽略旧回应。刷新只重载现有 iframe，重新认证，
保留插件内的导航历史。服务端需要同时包含认证与导航桥；旧认证版不会启用导航按钮。

验证：`bun run test __tests__/gui.test.ts`、`bun run typecheck`、`bun run build`。
