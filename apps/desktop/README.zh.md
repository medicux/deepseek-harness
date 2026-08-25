# dsh desktop

[English](README.md) | 中文

`@deepseek-ai/dsh-desktop` 是 Electron 桌面外壳：它把 DeepSeek Harness 的 Web UI 呈现进一个原生窗口。外壳只拥有原生窗口生命周期与受管服务器进程的生命周期——此外无他。Harness 组合、HTTP 载体与 Web 客户端仍归其现有表面所有。

## 窗口的 UI 从何而来

主进程以受管子进程方式启动真实的 `dsh --profile web --carrier stdio` 表面（`src/launch.ts`、`src/server-process.ts`），读取其就绪行——`dsh web-stdio: ready`，即 [web-app bundle](../../packages/bundle/web-app/src/index.ts) 的 stdio 载体信号。子进程不绑定任何套接字：请求与响应以 NDJSON 帧走文件描述符 3 和 4（[frames.ts](src/frames.ts)，与 webserver 的线上契约互为镜像）。渲染端完全不接触网络栈：preload 安装 `__DSH_IPC_CARRIER__` 席位（[preload.ts](src/preload.ts)），connection 包的选择逻辑看到席位后把 `WebApiClient` 换成 `DesktopIpcApiClient` 与桥接版 Connection RPC 调用方；[carrier.ts](src/carrier.ts) 经每流 IPC 通道应答一元请求并泵送两条事件流，转发到子进程时走帧通道。窗口加载 `dsh://app/`——一个特权自定义协议（[protocol.ts](src/protocol.ts)），其处理器在主进程侧把每个请求转发给子进程——因此渲染端不感知任何形式的 authority：HTML、静态包、boot 清单与插件包都经转发到达，子进程仍是唯一的组装归属。`DSH_DESKTOP_CARRIER=tcp` 可为诊断恢复回环监听；该模式下外壳改为用普通 `fetch` 访问上报的 URL，而非帧通道。

这是 [Electron 桌面外壳 Agent Note](../../.agents/notes/implemented/feature/2026-08-22-electron-desktop-shell.md) 中分阶段计划的交付形态：页面侧套接字数为零，子进程监听器默认不复存在，而监督接缝让 Electron 与 harness 之间只隔着几个小模块：

| 模块 | 契约 |
|---|---|
| `launch.ts` | 解析启动目标：默认经 tsx 进行仓库源码启动；打包形态通过 `DSH_DESKTOP_SERVER_BIN` 使用 `dsh` 可执行文件；`DSH_DESKTOP_NODE_BIN` 指定 Node 运行时。 |
| `readiness.ts` | 针对累计 stdout 的纯解析器：在同级通告行中找出就绪 URL 行。 |
| `server-process.ts` | 一个受管子进程：spawn → 就绪 → 有界停止升级（先 SIGTERM，超过宽限期后 SIGKILL）；失败携带输出尾部。 |
| `watchdog.ts` | 父进程死亡守卫：服务器运行在一个原生 Node 看门狗之下，外壳无论因何种原因消失——Electron 无法可靠地把 SIGTERM 送达 JavaScript，故清理绝不依赖它——看门狗都会在一秒内终止服务器。 |

## 运行

```sh
pnpm install                     # once; downloads the Electron runtime
pnpm run build                   # builds lib/types and bundles lib/main.js
electron apps/desktop            # or: pnpm --filter @deepseek-ai/dsh-desktop run start
```

再次启动会聚焦既有窗口，而不是再起一套 harness 栈（单实例锁）。

### 配置

| 变量 | 作用 |
|---|---|
| `DSH_DESKTOP_SERVER_BIN` | 改为启动该 `dsh` 可执行文件而非仓库源码（打包构建的路径）。旗标集合不变。 |
| `DSH_DESKTOP_NODE_BIN` | 执行源码启动的 Node 二进制；默认取 `PATH` 中的 `node`。 |
| `DSH_DESKTOP_CARRIER` | 设为 `tcp` 可恢复子进程的回环监听与外壳的 fetch 路径（仅诊断用；默认是 stdio 帧载体）。 |
| `DSH_DESKTOP_READY_TIMEOUT_MS` | 就绪预算（毫秒）；默认 120000。非数值会响亮失败。 |
| `DSH_DESKTOP_DEBUG` | 设为 `1` 时在 stderr 上跟踪桌面生命周期转换（就绪、停止请求）。 |

## 窗口外观与桌面集成

窗口是无边框但原生的：内容与顶边齐平（Codex 风格），macOS 红绿灯悬浮在侧栏品牌行之上，失去原生控件的平台会获得一个注入的小型覆盖层。客户端用 `data-dsh-window-drag` 标记其头部行（在浏览器中是惰性属性）；外壳通过注入 CSS 将其变为拖拽区，同时保持所有可交互后代可点击。桌面 IPC 只覆盖两个面：最小窗口控制桥与上文的 IPC 载体；标准应用菜单提供让 Cmd+C/Cmd+V 在输入框中生效的 Edit 角色。

拖放附加与剪贴板粘贴是桌面窗口原样继承的客户端能力：把文件拖到窗口任意处即向输入框附加图片（页面的 drop 处理器自行运行，外壳只抑制文件导航），粘贴图像数据走同一路径。

## 打包

`pnpm --filter @deepseek-ai/dsh-desktop run package` 依照 [electron-builder.yml](electron-builder.yml) 构建可安装应用：

1. **闭包** — 脚本依据实时工作区清单重新生成纯依赖清单 [closure/package.json](closure/package.json)（CLI 与每个可安装 bundle 的 dependencies、peers 及工作区范围的 devDependencies——独立目录树为组合行必须能解析的包集合），随后 `pnpm deploy --legacy --prod` 将其物化到 `dist-closure/`，并把每个符号链接替换为文件内容。与 Python SDK 运行时的部署根同构。
2. **原生 ABI** — `@electron/rebuild` 在闭包内针对 Electron 头文件重编 `node-pty`：打包后的子进程以 `ELECTRON_RUN_AS_NODE=1` 运行，Electron 自身二进制兼作普通 Node，因此应用内不再携带第二个运行时。
3. **打包** — electron-builder 产出 `dist-packages/` 工件（macOS arm64 的 .dmg/.zip，Linux 的 .AppImage/.deb）。

打包形态的主进程经 `app.isPackaged` 识别安装环境并直接启动暂存运行时，无需环境变量；开发检出版本仍走 tsx 源码启动。

## 生命周期规则

- 所有平台上的退出都会关闭窗口**并**停止服务器，macOS 也不例外：这个窗口就是全部产品表面，后端已退出的驻留 dock 外壳只会提供连接错误。
- 就绪后的服务器死亡通过模态对话框响亮失败；静默白屏只会掩盖 harness 故障。
- 停止升级有界：先 SIGTERM 让 harness 处置其树，宽限期过后 SIGKILL。

## 模型 / token / KV-cache 体验

外壳不新增任何模型可见内容，也不新增会话日志事件：它渲染与 `dsh web` 相同的 Web 客户端、走相同的线协议。会话、提示与工具行为与浏览器表面完全一致；模型无法观察客户端是 Electron 还是浏览器标签页。

## 已知限制与延期工作

- **发布签名与 CI leg 暂缓。** `pnpm run package` 以 ad-hoc macOS 身份（`identity: null`）产出本地工件；公证签名与各目标 CI leg 是分发侧剩余工作。在专门设计的图标集落地前，图标沿用 Electron 默认。
- **服务器日志落在平台日志目录**（macOS 为 `~/Library/Logs/@deepseek-ai/dsh-desktop/dsh-web-server.log`，其余平台为对应的每应用 `logs/` 位置）：外壳把子进程的 stdout/stderr 在直通启动终端之外镜像到该文件。
