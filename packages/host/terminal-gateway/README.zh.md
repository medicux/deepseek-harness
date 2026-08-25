# @deepseek-ai/dsh-host-terminal-gateway

[English](README.md) | 中文

宿主插件，通过 `/api/terminal.*` 路由为 GUI 提供交互式用户终端。它经由子进程能力的 PTY seam（`ctx.subprocess.spawnTerminal`）生成普通用户 shell——默认是操作者的 `$SHELL` 并拥有完整用户权限，可用 `config.shell` 固定 argv 覆盖——并将原始 PTY 输出以 base64 块的 Server-Sent Events 流式推送到浏览器，因此该表面在 TCP 与桌面 stdio carriage 上的表现完全一致。会话 id 是 open 时铸造的带品牌 UUID；`open` 还接受可选的缓存 id，对仍存活的会话执行收养而非再生成（未知或已退出的 id 落回全新生成），这正是整页刷新能回到同一 shell 并把会话滚动输出历史回放进新视图的机制。一元路由以 JSON 应答，未知会话应答 404，超大写入在固定线界（`MAX_WRITE_BYTES`、请求体上限）下应答 413。每条接入的流都先收到一份有界的全会话输出滚动历史（约 512 KiB），重连方因此能跨订阅者世代重建回滚缓冲。销毁时注销路由并终止所有存活会话；每个会话的流在其 shell 退出时以 `exit` SSE 事件结束。客户端半部（基于 xterm 的工作台占用者）注册进框架的 `workbench` slot。

## Model Experience

无：本包在 HTTP 路由之后承载 PTY 会话，没有任何内容进入模型请求。

#### KV Cache effect

无；本包既不组装也不发送提供方请求。

## Known Limitations and Deferred Work

- **回放历史是有界的，不等于完整回滚缓冲** —— 每条接入的流收到的是保留的滚动历史（约 512 KiB）；被上限挤出的块不可恢复，重度输出后重连的客户端只能重建截断后的视图。持久化的服务端回滚缓冲仍是待办。
