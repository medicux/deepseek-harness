# Agent Note：web-search 抗抖动加固与内部整合

Status: implemented

[English](2026-08-24-web-search-flake-hardening-and-internal-consolidation.md) | 中文

## 问题

整合后的搜索包及其测试通道暴露了三个缺陷。第一，`packages/client/ui-trajectory` 间歇性抖动：完整 GUI 测试电池以一条未处理的 `ReferenceError: window is not defined` 失败，错误被归因于 jsdom 环境拆除之后某个 `@tanstack/react-virtual` 的定时器。机制是：vitest 的 jsdom 通道在环境拆除时删除浏览器全局量，且 vitest 把 `document.defaultView` 重写为 worker 的 Node 全局，于是 virtual-core 把 `targetWindow` 解析到了该全局——它的 150 毫秒滚动偏移去抖因此成了普通 Node 定时器。上游没有任何路径在卸载时取消它，所以文件末尾 150 毫秒内的一次滚动事件会留下一个活回调，射向已被删除的全局。第二，loader-smoke 的 SIGKILL 截止时间在实测 tsx 启动成本后被当作裸常量提到 30s → 60s；比开发基线更慢的机器没有任何办法抬高它，除非修改 harness 代码。第三，五个带密钥的搜索后端各自私藏同一套机制——凭据解析与缺钥诊断、传输失败翻译、带中止/不可处理/`WebError` 直通守卫的响应体映射、以及按形状区分的提供方错误封套提取器——任何语义修复都要落五个地方。

## 决策

把 `@tanstack/react-virtual` 从 ^3.14.9 升到 ^3.14.10，它固定 `@tanstack/virtual-core` 3.17.8——上游恰好补上了缺失的取消（`debounce(...).cancel()` 由偏移观察者的退订调用），于是卸载现在会杀掉排队的重置而不是泄漏它。`table.client.spec.tsx` 新增一个确定性回归测试，在我们的层面钉住该不变量：从滚动事件起追踪环境调度的每个定时器，要求卸载取消全部（已验证对被削除取消逻辑的 3.17.8 dist 会失败）。

冒烟截止时间变成一步自有解析：`resolveSmokeProcessTimeoutMs()` 依次采用显式选项、经校验的 `DSH_SMOKE_PROCESS_TIMEOUT_MS` 条目、实测默认值；`LOADER_SMOKE_TEST_TIMEOUT_MS` 由其推导——vitest 上限永远不可能先于 subprocess 自有截止触发。

在 `@deepseek-ai/dsh-web-search` 内部，一个内部模块现在独占每类重复翻译：`resolveSearchKey`（凭据平面加共享缺钥诊断）、`translateSearchTransportError`（fetch 失败 → `WEB_ABORTED`/`WEB_PROVIDER_ERROR`）、`mapResponseJson`/`mapResponseText`（响应体读取加映射器同处一个中止/不可处理/`WebError` 直通守卫）、`providerErrorDetail`（所有已观测错误封套共用一个提取器），以及服务 `available()` 谓词的 `hasCredential`。Exa 与 Perplexity 弃用手工 POST 客户端改用既有 `postJson`；按提供方的错误封套类型随之死亡并被删除。

## 考虑过的替代方案

**通过 `patchedDependencies` 本地打补丁。** 在上游 3.17.8 发布了完全相同的修复后否决：补丁会把维护负担钉在未来每次升级上，而相对正式版本零收益。

**在 spec 的 `afterEach` 里排空去抖（睡过 150 毫秒）。** 否决：永久性向文件里每个测试征税，掩盖而非消除泄漏，且未来任何滚动 virtualizer 的测试套件都会静默重新引入抖动。

**保留五份后端拷贝、依赖 jscpd。** 否决：克隆检测器通过是因为请求头名称和封套形状略有差异，但语义活在五个地方——这正是本次整合移除的漂移面。

## 后果

买到：无论哪个套件滚动它，trajectory 台账都不可能再遗留越过拆除的定时器；受限的 CI 机器改一个环境变量即可，不必给测试代码打补丁；新增搜索后端只需写映射器和默认值，不必重新推导错误翻译。付出：react-virtual 升级是把全仓 lockfile 变更搭在本 PR 上；两个新的内部助手带着依赖类型参数调用机制的泛型映射签名；`DSH_SMOKE_PROCESS_TIMEOUT_MS` 是又一个只在此处和 JSDoc 中记录的旋钮。

## 测试

`table.client.spec.tsx` 新增卸载即取消的回归测试（对修复前的 virtual-core 会失败）；`loader-smoke.spec.ts` 覆盖解析器的默认值、合法覆盖与畸形覆盖拒绝；web-search 各套件在整合后保持 211 个测试全绿且逐文件覆盖率不变。完整 GUI 电池（293 文件）、免密快照电池（13 文件）、hygiene、重复检测（0 克隆）、lint 与 typecheck 全部通过。
