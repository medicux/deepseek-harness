# @deepseek-ai/dsh-client-ui-terminal

[English](README.md) | 中文

交互式用户终端的浏览器半部：注册进 ui-layout 的 root 作用域 `workbench` slot 的 xterm.js 面板（该栏的首个占用者）。展开工作台即打开一个网关会话（`/api/terminal.open`）；输出以 base64 SSE 块从 `/api/terminal.stream` 直接流入模拟器，按键原样转发到 `/api/terminal.write`（PTY 负责回显与行规程），ResizeObserver 经由 `/api/terminal.resize` 使网格跟随渲染视口。关闭该栏只是隐藏视图：一个会话伴随面板的完整生命周期，重新展开即回到同一 shell（PTY 回滚缓冲完好无损），已退出的 shell 会在下次展开时重新生成；整页刷新也会回到同一 shell——面板出示 sessionStorage 缓存的 id 请求收养，页面离开期间缓冲的输出会回放进新模拟器。xterm 样式表逐字内置（出处见 `src/client/xterm.css` 头注），使打包保持在 `?inline` CSS 加载器路径内。

## Model Experience

无：本包只渲染浏览器终端视图，没有任何内容进入模型请求。

#### KV Cache effect

无；本包既不组装也不发送提供方请求。

## Known Limitations and Deferred Work

- **缓存的会话 id 以浏览器标签页为界** —— 收养读取的是 `sessionStorage`，复制出的标签页会出示同一 id，两个视图于是接到同一 shell；任一标签的按键都落入同一 PTY。等出现真正需要按视图隔离的消费方，再把缓存迁移到逐视图存储。
