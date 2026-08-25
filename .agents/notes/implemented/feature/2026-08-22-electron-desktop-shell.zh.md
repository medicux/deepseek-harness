# Agent Note: Electron 桌面外壳——受管 `dsh web` 载体与帧管道 IPC 投递

Status: implemented

[English](2026-08-22-electron-desktop-shell.md) | 中文

## 问题

Web UI 需要一个窗口化、可独立分发的桌面应用。前端并非独立应用——只有 Node 服务器注入 `window.__DSH_BOOT__`、服务 `/api/*` 并承载 WebSocket 下行（[GUI 分层](../architecture/2026-07-19-gui-layering-and-rpc-protocol.md)）——因此桌面应用必须以某种方式运行该服务器。分层笔记预留了终局设计（Electron 外壳经 IPC fetch 载体复用客户端包、零端口），但该外壳当时并不存在；一步到位会在任何原生窗口出现之前就先撞上其最难的部分。

## 决策

### 一个监督真实 `dsh --profile web` 表面的薄 Electron 外壳

[`apps/desktop`](../../../../apps/desktop/README.md)（`@deepseek-ai/dsh-desktop`）把已发布的 `dsh --profile web` 表面作为受管子进程启动——源码启动传 `--carrier stdio`，子进程不绑定任何套接字；`DSH_DESKTOP_CARRIER=tcp` 可为诊断恢复回环监听——随后解析 web-app bundle 在 Loader 结算后打印的就绪行（stdio 模式为 `dsh web-stdio: ready`；tcp 模式为 `dsh web: <url>`）。渲染端就是普通 Web 客户端，但其 API 流量走 IPC 载体而非任何网络栈：preload 安装 `__DSH_IPC_CARRIER__` 座位，连接包在检测到该座位时选用 `DesktopIpcApiClient` 及经桥接的 Connection RPC 调用器，外壳把一元请求转发给受管子进程，并把两条事件流以 ServerRequest JSON 文本的形式经每流 IPC 通道泵送——线格式与 WebSocket 载体逐字节一致。座位还携带一个可选的原生目录选择器，由外壳的 `dialog.showOpenDialog` 应答——Host 的操作系统选择器后端没有 macOS 对话框——工作区运行时在桥暴露它时优先使用，其余环境回退到 `host.pickDirectory` RPC。窗口从 `dsh://app/` 这一特权重载方案加载：主进程处理器把 HTML、静态 bundle、boot 清单与插件包转发给子进程——渲染端看不到任何传输端点，组合所有权保持不变。外壳仍不新增任何模型可见内容，也不新增任何会话日志事件。

### 无边框窗口外观与桌面同客户端的契约

窗口是无边框但原生的（macOS `hiddenInset`，其余平台 `hidden`）：内容与顶边齐平，Codex 风格。客户端用 `data-dsh-window-drag`（浏览器中的惰性属性）标记其头部行（侧栏品牌行、会话头、详情头），外壳注入样式表将其变为拖拽区，并对所有可交互后代做 `no-drag`。两项外壳自有的细化在不预留任何布局的前提下塑造顶部区域：品牌行携带 `brand` 属性值，使外壳把它下移到红绿灯 / 窗口控制按钮带之下（其自身内边距即可拖拽）；一条横贯窗口顶部的 6px 透明边缘，让空白 Hero 隐藏会话头时仍能从任一列顶端拖动窗口。失去原生控件的平台会收到经沙箱 preload 桥接线的小型注入覆盖层；该桥是外壳唯一的 IPC。标准应用菜单提供 macOS 把 Cmd+C/Cmd+V 送进输入框所必需的 Edit 角色。

拖放附加与剪贴板粘贴不需要任何桌面代码：二者都是客户端能力（文档级 drop 处理器与输入框粘贴），一旦文件导航被抑制，窗口即原样继承。

监督接缝是四个模块，各持一条单一契约：启动目标解析（`launch.ts`）、就绪解析（`readiness.ts`，纯函数）、进程生命周期（`server-process.ts`：spawn → 就绪 → 有界 SIGTERM→SIGKILL 升级；失败携带输出尾部；就绪后的死亡通过模态对话框响亮失败），以及父进程死亡看门狗（`watchdog.ts`）。看门狗的存在理由是：外部送达的 SIGTERM/SIGINT 会在 Electron 的 JavaScript 运行任何处理器之前被 Chromium 收割——因此清理绝不能依赖本进程继续存活。一个原生 Node 包装进程拥有服务器并每秒轮询其父进程，于是外壳的崩溃、SIGKILL 或信号终止仍会在约一秒内拆除整棵树。生命周期规则：所有平台（含 macOS）上的退出都同时关闭窗口**并**停止服务器（后端已死的驻留 dock 外壳只会提供连接错误）；单实例锁聚焦既有窗口。

启动目标是接缝而非硬编码：仓库检出像 `pnpm dsh` 一样经 tsx 源码启动。打包形态将 harness 运行时作为纯依赖清单（`apps/desktop/closure/package.json`，与 Python SDK 运行时的部署根同构）的物化部署放在 `Resources/dsh-runtime`，并以 `ELECTRON_RUN_AS_NODE=1` 启动：Electron 自身二进制兼作普通 Node，应用内不携带第二个运行时，`@electron/rebuild` 在闭包内为 `node-pty` 提供 Electron 的模块 ABI。`DSH_DESKTOP_SERVER_BIN` 仍是外部 `dsh` 可执行文件的逃生口；所有形态接受相同旗标，因此打包改变的是配置而非架构。

### 向预留的 IPC 载体设计分阶段演进

Phase 2 在不动外壳生命周期代码的前提下替换了载体。一个 `AbstractApiClient` 子类（dsh-client-connection 的 `desktop-carrier.ts`）经注入的桥对象实现 `doFetch`/流虚函数；投递侧则是 stdio 载体——`dsh-host-webserver` 暴露 `serveStdio`，在子进程 stdin/stdout 上用 NDJSON 帧驱动同一路由分发：应用组装以 `dsh web --carrier stdio` 选用它——`web-startup` 发布 `carrier`，bundle 的 webserver 行转发之，stdio 模式跳过绑定，fd 3（帧入）与 fd 4（帧出）让 stdout/stderr 保持纯日志语义，就绪行变为 `dsh web-stdio: ready`。桌面外壳已将其作为默认：监督者把两条帧管道穿过看门狗传递（macOS 的 posix_spawn 默认对 fd 2 以上 close-on-exec，必须显式 inherit），父侧 `FrameChannel` 按 id 把响应多路分解到 tcp 模式曾用的同一批转发器上——一元 fetch、SSE 流泵与 app 方案协议处理器都由这一个通道应答——真实启动冒烟断言子进程在无监听套接字的情况下服务一切。两条线缆事实保证浏览器信任栅栏与流拆除在该传输上依然成立：`serveStdio` 把无 Host 头的帧绑定为 `127.0.0.1`（监督管道即信任锚——浏览器无法发送 Host，渲染端也不发送，显式 Host 原样透传，伪造的权威仍然封闭失败）；被弃置的流订阅会写入 `{id,t:'cancel'}` 控制帧，令子进程销毁响应、其 SSE 生成器随之收束而不是向无人读取的方向持续泵送；相应地，共享 fetch 处理器在 webserver 运行 stdio 载体时以 SSE 服务事件路径，把 426 upgrade-required 应答留给真正拥有可升级套接字的传输。预留的目的地——渲染端路径上不存在任何套接字或端口——由此以帧管道达成；MessagePort 成帧仅在未来出现需要时才保留为选项。过渡性 tcp 载体保留为诊断后备（`DSH_DESKTOP_CARRIER=tcp`）。

## 已否决的替代

**在 Electron main 内做进程内组装。** 导入 `app-boot` 并复制 `runProfile` 的补丁栈，等于把启动器语义复制进第二个所有者；跨应用导入 apps/cli 则破坏应用互不加载的规则。它还会立刻把 `node-pty` 装进 Electron 的 Node ABI，在任何用户可见成果之前就强制 `@electron/rebuild`。

**Tauri 包裹 URL。** 同样的 spawn 模型，却为同一工作引入第二种外壳技术，且仍需 sidecar 二进制；Electron 让主进程工具链留在我们已经发布的那一门语言里。

**直接上纯 IPC。** 没有需要退役的过渡模式，但流载体（mux/host 流的 MessagePort 帧）、自定义协议 bundle 投递与 ABI 重编译全部落在第一个可运行产物之前。作为第一步被否决；作为目的地保留。

## 后果

**换来**：行为与 `dsh web` 逐字节一致的窗口原生应用（同一 bundle 栈、用户补丁、HMR watch、信任栅栏）；每个桌面专属决策都聚居的四模块接缝；产出可安装 macOS/Linux 工件的本地打包（`pnpm run package`），其运行时是配置而非重设计；让被监督子进程输出在没有启动终端时仍可读取的每应用日志文件。

**付出**：Phase 1 期间多一个 OS 进程与一个回环端口，外加外壳与服务器之间的小型原生 Node 看门狗进程；Windows 与 CLI 的其他界面一样不在范围内；即便外壳代码很小，Electron 运行时（装后约 100MB）仍随行；发布签名、公证、各目标 CI leg 与专门设计的图标仍是未完成的分发工作。

## 必需的验证

单元规格覆盖各接缝模块（`apps/desktop/tests/*.spec.ts`），包括真实进程的看门狗测试，其夹具按生产形态生成五个 stdio 槽位（看门狗的 inherit 需要自身 fd 3/4 存在，否则其内部 spawn 以 `EBADF` 即死）：信号转发会杀死假服务器，被孤儿化的看门狗（父进程遭 SIGKILL）会在轮询间隔内拆除自己的子进程。就绪后的死亡报告对两种载体都会发出——由就绪本身把关，因为 stdio 子进程没有 URL。node↔fetch 桥所读取的请求/响应成员（可异步迭代的 body、`writableEnded`、`destroy`）由 dsh-host-webserver 的规格钉住，并在 dsh-client-connection 的规格里经真实帧栈端到端演练；这些规格还钉住了环回 Host 绑定、取消帧拆除（编解码两侧），以及——在 stdio 模式下对组合后的插件——带取消驱动收束的 SSE mux 流与栅栏对伪造 Host 的拒绝。真实启动冒烟经 `DSH_DESKTOP_SMOKE=1` 显式开启——它需要已构建的工作区库与前端 dist，而单元测试必须在干净树上通过——在看门狗之下以隔离的临时 `DSH_HOME` 启动真实的源码表面，断言 stdio 就绪行且无监听套接字存在，经帧通道服务 `/` 找到注入的 `__DSH_BOOT__`，穿过信任栅栏执行一次真实一元 RPC（`host.describe`），打开并取消帧上的 mux 事件流，并要求监督者 SIGTERM 后退出码为 0。另经实机验证：外部杀死运行中的 Electron 应用后，无任何服务器进程存活。
