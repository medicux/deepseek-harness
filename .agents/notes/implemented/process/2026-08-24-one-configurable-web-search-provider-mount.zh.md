# Agent Note：唯一可配置的 web-search 提供方挂载点

Status: implemented

[English](2026-08-24-one-configurable-web-search-provider-mount.md) | 中文

## 问题

出厂的搜索管线把 DeepSeek 写死：基础 bundle 固定了 `searchProvider: deepseek-official`，且只挂载 `@deepseek-ai/dsh-web-search-deepseek`；Exa 和 Perplexity 作为独立包存在，却没有任何组合注册过它们。部署若想换后端，必须知道三个包名、逐个写进 `cordis.yml`，还要手工保持 seam 的 `searchProvider` 固定项同步——而且由于 harness 自身的对话密钥让 DeepSeek 提供方永远可用，所有部署都在为这条路由买单。设置 UI 用一张仅面向 DeepSeek 的卡片（`web-search-deepseek` 命名空间）加深了这种绑定。

## 决策

一个包取代三个：`@deepseek-ai/dsh-web-search`（插件 id 与命名空间均为 `web-search`）暴露单一判别式配置，其 `provider` 字面量选择后端——原生模型中介搜索（`deepseek`、`claude`、`gemini`）或外部搜索 API（`exa`、`brave`、`duckduckgo`、`perplexity`）——并以该 id 注册恰好一个 `WebSearchProvider`。由于任何时刻只注册一个提供方，基础 bundle 删去 `searchProvider` 固定项，seam 自动选择；切换后端就是一处的一个 `provider:` 值。

DeepSeek 与 Claude 使用同一条 Anthropic 兼容 Messages 协议，因此一个参数化类（`AnthropicNativeSearchProvider`）配合各后端默认值服务两者；Gemini 有自己的 grounding 客户端；外部后端各自一个模块。跨字段校验在加载时即报错并拒绝设置写入：对所选提供方不适用的字段（如 `exa` 下的 `maxUses`）会报出字段名及其适用后端列表，因此切换提供方绝不会留下静默遮蔽新后端的过期选项。已提交的 section 变更会重挂载注册——先释放再注册——所以提供方切换是实时的，不需要重启。发送前的日志事件泛化为 `web/native-search-llm-request`，其判别式载荷横跨两种原生协议；按照预发布立场，携带旧事件名的旧日志在本构建中不可读。

工作台卡片增加提供方下拉框与按后端的字段可见性（免密的 DuckDuckGo 完全隐藏凭据平面），并在客户端侧镜像默认密钥引用——客户端包不得依赖 Host 包。

## 考虑过的替代方案

**保留各提供方独立包，再新增 Brave/DuckDuckGo/Claude/Gemini 同级包。** 否决：这会加剧正在移除的蔓延——七个命名空间、七张卡的设置面、每个后端一份组合接线——只为回避预发布立场明确允许的一次机械合并。

**按哪个 API key 恰好存在来自动选择**（如 `$EXA_API_KEY` 存在时优先 Exa）。否决：基于存在性的选择是隐藏的优先级链；显式配置应胜过环境巧合，且 seam 的既定语义本就以报错拒绝歧义而非猜测。

**提供方切换要求重启（`applies: 'restart'`）。** 在重挂载模式被证明足够简单后否决：在现有 settings 钩子内先释放后注册，使「恰好一个已注册提供方」这一不变量在每个可观察时刻都成立，重启除了停机什么也换不来。

## 后果

得到：新增搜索后端变成单包内「一个模块 + 一条默认值 + 一行适用性表」；用户只需配置一次 "web-search"，组合文件或设置卡片皆可；原生覆盖免费扩展到 DeepSeek 之外，因为四个新后端中有两个复用了既有 Messages 映射器。付出：注册 id 变化（`deepseek-official` → `deepseek`），固定旧 id 的组合会响亮失败直至更新；会话事件改名使此前写入的日志成为孤儿；合并包的覆盖义务大于任何一个前身。

## 测试

合并包携带八个套件的 320+ 单元测试（自前身移植的各后端请求/错误/中止矩阵、插件校验矩阵、经真实内存 settings provider 的实时切换、经本地凭据存储的凭据轮换、Loader 解包形态）、真实 HTTP 重定向夹具，以及自行跳过的真实 API 探针。工作台卡片规格覆盖提供方暂存、免密可见性与按后端的字段渲染。
