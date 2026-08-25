# GUI 整合加固：批量设置写入、SSE 原文透传、桌面 fd 探测、闭包清单导出

[English](2026-08-24-gui-consolidation-hardening.md) | 中文

日期：2026-08-24

## 背景

GUI 外壳、web-search 提供方挂载与终端栈分布在多个分支上落地。整合评审发现四个值得在发布前修复的横切弱点，而不是按特性各自修补：多字段设置卡片逐字段发起 Host 写入；桌面载体重新解析主进程已经序列化好的 SSE 块；web-app 打包产物在无证明的情况下信任监督父进程；桌面打包器的依赖闭包只能通过运行其 CLI 来计算。

## 决策

### `SettingsScope.setMany` 批量化卡片保存

`CardForm.save()` 现在预先规划每个字段写入，并把 section 字段作为一次 `setMany(ops)` 调用发送；secret 字段保留各自的 `write` 控件，因为每个 secret 拥有自己的控制流。`test-support/client-runtime` 中的桩以匹配的语义实现 `setMany`，使插件测试走真实的批处理路径。理由：此前保存一张五字段卡片会产生五次持久写入与五次校验；第三个字段被拒绝时，前两个已经生效且用户无法感知恢复。合并为一次变更后，Host 对组合结果只校验一次，表单随后回读 user 层来判定成功。

### 切换提供方时预清除不兼容的暂存字段

web-search 控制器镜像每个提供方接受的字段集合（`FIELD_PROVIDERS`），并为新选中的提供方会拒绝的覆盖项暂存清除（例如切换到没有 baseURL 概念的 duckduckgo 时清除 `baseURL` 覆盖）。卡片渲染 `clearedBySwitch` 提示，说明本次切换丢弃了什么。否则切换提供方会保存陈旧的覆盖项，在下次加载时校验失败。

### 桌面载体按原文透传整个 SSE 块

`DesktopIpcApiClient` 不再把流负载拆成合成 `data:` 事件，而是转发每个原始块，由消费方通过共享的 `sse-blocks.ts`（`sseDataPayload` / `sseEventName`）解析。命名事件得以在传输中存活；缺少 `data:` 字段的块会被静默跳过——旧解析器把这类块当作畸形帧，为无害的仅 `event:` 块记录噪音。stdio webserver 载体继续发出仅含 `data:` 的块，两套测试的 codec 块中各有一份对等性钉住这一点。

### Web-app 启动时证明监督父进程持有管道 fd

采纳 stdio 帧载体之前，`web-app` 启动会对 fd 3 和 4 执行 fstat，任一不是 FIFO 时响亮失败并指出具体种类。这把静默挂起（载体等待永远不会有人写入的管道）变成即时诊断。`surfaceContext` 继续以 `tcp` 载体为门控，因为上下文注入依赖 stdio 模式不会打开的 HTTP 面。

### 桌面打包器导出其闭包计算

`package-desktop.ts` 在 `pathToFileURL(process.argv[1])` CLI 守卫之后导出 `main`、`writeClosureManifest` 与 `computeClosureDependencies`，使测试直接导入函数而不是派生脚本。test-support 根目录同时从边遍历与既有 pin 合并中排除，这也让重新生成的闭包清单删掉了三个过时的手工 pin（vitest、`@testing-library/*`）。

## 后果

多字段保存在 Host 边界上是原子的；`desktop-carrier` 的消费方必须处理命名事件或使用 `sse-blocks` 辅助函数；在桌面外壳之外启动 web bundle 需要 3/4 上有真实 FIFO 或显式设置 `DSH_DESKTOP_CARRIER=tcp`；打包测试不再派生 shell。网关的路由管线仍处于覆盖率豁免之下，注释已同步更新。
