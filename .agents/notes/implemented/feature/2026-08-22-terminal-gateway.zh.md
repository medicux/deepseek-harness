# Agent Note：终端网关——工作台背后的用户 shell

Status: implemented

[English](2026-08-22-terminal-gateway.md) | 中文

## Problem

GUI 新增的工作台栏没有占用者，而 harness 没有可供活动终端骑乘的服务端表面：现有终端能力是 agent 形态的（owner-session 栅栏、沙箱策略、有界的按命令读取、固定 PTY 尺寸），而交互式终端需要原始按键写入、随视口的 resize 与连续输出流。没有网关，工作台栏就只是一纸空契约。

## Decision

[`packages/host/terminal-gateway`](../../../../packages/host/terminal-gateway/README.md) 在 webserver 上注册五个精确匹配的 `/api/terminal.*` 路由：`open` 经由 `ctx.subprocess.spawnTerminal` 生成操作者的 `$SHELL`（完整用户权限——VS Code 集成终端语义；刻意不复用被沙箱化的 agent 终端 seam），并收养可选的仍存活缓存 id 而不再生成（过期 id 在同一请求内落回全新生成），`write` 在固定 64 KiB 上界内投递原始按键文本，`resize` 把视口变化经 seam 新增的 `resize` 转发，`close` 终止单个会话，`stream` 以 base64 输出块的 Server-Sent Events 应答，使传输与载体无关（TCP 与桌面 stdio carriage 表现一致）。每个精确路由都施加 connection 插件的浏览器信任栅（基于共享 `trustedHosts` 配置的 `isTrustedApiRequest`），因为精确路径在分发优先级上绕过了 `/api` 前缀栅栏——伪造的跨站 Host 在触及任何 shell 之前就会得到 403。会话是带品牌的 UUID，并带有一份每个接入流都会完整收到的有界滚动输出历史（约 512 KiB），因此刷新重建的是整个回滚缓冲而不只是脱离窗口；响应头立即冲刷，因此静默会话也能完成客户端 fetch；每条流以 `exit` 事件结束；销毁时终止所有存活会话。客户端半部——注册进 `workbench` slot 的基于 xterm 的插件——随后落地。

## Alternatives considered

**复用 agent 终端能力（`dsh-terminal`）。** 否决：它在 owner Agent 会话上设栅并解析沙箱策略，两者对用户自有的 shell 都无意义；其 sanitizer 与有界读取是为模型消费调校的。

**扩展 MuxFrame 联合、骑乘会话事件下行。** 否决：终端输出不是会话日志内容，会把一条高频通道拖进与会话流共享的联合类型。

**connection 包的通用 RPC 通道。** 否决：它尚无任何消费方；显式命名路由让终端的线形保持可检视，并与其它 `/api` 路径一样受信任栅保护。

## Consequences

按设计，每个 `/api/terminal.*` 请求都会以桌面用户身份执行任意 shell 命令——该路由族继承 webserver 的信任栅，绝不能暴露到回环或受监督的 stdio carriage 之外。子进程 PTY seam 现已携带 `resize`，未来任何句柄实现都必须提供它。网关在插件生命周期内为每个 open 会话持有一个 PTY；会话数量目前仅受操作系统限制，直到证明需要客户端侧上限。

## Testing

路由规格驱动真实回环 HTTP 服务器与假 PTY 句柄：生成 spec 形状（argv 覆盖、home cwd、客户端视口）、经 schemastery 归一化的空 shell 覆盖解析为 `$SHELL` 而非无程序的 argv、不生成即收养存活 id 加过期 id 落回、滚动历史抵达后续订阅者世代（附着期与脱离期的块皆达）、live base64 块投递及结束流的 exit 事件、write/resize 直传与 413 载荷上界、先 close 后 404、各路由的未知会话 404、dispose 终止所有存活会话、以及伪造 Host 在所有一元路由上的 403。
