# Agent Note：工作台终端——栏的首个占用者

Status: implemented

[English](2026-08-22-workbench-terminal.md) | 中文

## Problem

工作台栏按设计保持未占用，而终端网关没有客户端：没有任何东西渲染活动 shell，第四栏保持不可见，网关路由也无人调用。

## Decision

[`packages/client/ui-terminal`](../../../../packages/client/ui-terminal/README.zh.md) 将 xterm.js 面板注册进 ui-layout 的 root 作用域 `workbench` slot。展开该栏即打开一个网关会话并在面板挂载期间绑定：输出以 base64 SSE 帧从 `/api/terminal.stream` 流入并直接解码进模拟器，按键原样转发到 `/api/terminal.write`（PTY 负责回显与行规程），ResizeObserver 经由 fit 插件建议的网格驱动 `/api/terminal.resize` 并跳过无变化的 resize。关闭该栏只是隐藏视图：一个网关会话伴随面板的完整生命周期，重新展开即回到同一 shell（PTY 回滚缓冲完好无损），已退出的 shell 会在下次展开时重新生成。xterm 样式表逐字内置并带出处头注，使打包保持在共享 tsdown 预设支持的 `?inline` CSS 路径内；宿主侧桩包通过一条 cordis 行（web-app patch 中的 `ui-terminal` 与 `terminal-gateway`）组合两半。

## Alternatives considered

**插件挂载时自动打开工作台。** 否决：可见性变化属于 `ctx.layout` 的调用方，且每次 GUI 加载都未经提示地生成 shell 令人意外；该栏在用户要求时打开。

**用 EventSource 替代 fetch 流式读取 SSE。** 否决：EventSource 会向已死的会话 id 自动重连，且无法区分退出与传输中断；手动读取器拥有重试策略。

**不用 xterm、以 pre + 隐藏输入渲染。** 否决：在已有维护良好的模拟器时手写终端模拟违反 dependencies-over-hand-rolling 政策。

## Consequences

`workbench` slot 现在有了真实占用者，其所有者份额契约（`collapsed`/`width`）因此承重：面板在闭合的栏背后保持 PTY、回滚缓冲与输出流全部存活，且零测量的宿主绝不能到达 fit 插件的提议值——其 2x1 下限否则会把隐藏中的 PTY 调整到该尺寸。整页刷新会回到正在运行的 shell：面板把会话 id 缓存在 sessionStorage 并在 `open` 时出示，其收养优先路径直接返回存活会话而不重新生成——未知或已退出的 id 在同一请求内落回全新生成，过期缓存因此自愈；网关的滚动输出历史回放进新模拟器，重建整个回滚缓冲。由于复制标签页会连带复制 sessionStorage，副本会收养原标签的会话：fan-out 承载额外的读者，而两个视图交错发送的按键是设计上接受的行为。内置样式表须随 xterm 升级重新复制。

## Testing

apply 规格钉住 slot 契约：注册落入声明的 root 作用域单 slot 且组件正确，而无插件的上下文使同一声明 slot 保持为空。传输行为（回放顺序、块解码、退出处理、resize 直传）由网关路由规格在真实回环服务器上覆盖；`tests/terminal-panel.client.spec.tsx` 以 fetch/xterm/ResizeObserver 测试替身钉住客户端生命周期：首次展开仅生成一次、折叠期间不关闭任何东西、零测量时保持几何不变、shell 退出后重新生成、刷新时收养缓存 id（含过期 id 落回与缓存更新）、子树销毁时带 keepalive 关闭。工作台终端流程还在真实组合上以无密钥实时车道运行（`apps/web/tests/workbench-terminal.e2e.ts`）：折叠/重开仅一次生成且零关闭、经 SSE 应答结束检测退出后的重新生成、以及真实 `page.reload()` 后的重开收养存活会话——open 多一次而总会话仍两个——且刷新前屏幕内容经缓冲回放重现。
