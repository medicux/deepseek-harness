# @deepseek-ai/dsh-web-search

[English](README.md) | 中文

Harness 的唯一可配置搜索提供方挂载点，面向 [web 能力 seam](../web/README.zh.md)（`ctx.web`）。一个插件、一个 `web-search` 设置命名空间：其 `provider` 字面量选择后端，插件以该 id 注册恰好一个 `WebSearchProvider` —— 因此 seam 选择无需固定项，提交切换立即生效。

两类后端：

- **原生** —— 搜索在辅助模型请求内由服务端检索完成：`deepseek`（Anthropic 兼容 Messages + `web_search_20250305`）、`claude`（对 Anthropic API 使用同一线协议）、`gemini`（`generateContent` + `google_search` grounding 工具）。
- **外部** —— 直接调用搜索 API：`exa`、`brave`、`duckduckgo`（免密钥）、`perplexity`。

这是一个**实现**包：它向 `ctx.web` 注册，不拥有 `ctx.web` 键，也不注册面向模型的工具（那是 `@deepseek-ai/dsh-tool-web`）。与 `@deepseek-ai/dsh-llm-deepseek` 一样，它是函数/命名空间插件（`inject: ['web']`），注册自己的后端，而非默认导出服务。

## 配置

所有字段均可选；`apply` 会填入所选后端的默认值。对所选提供方不适用的字段在加载时即报错，并拒绝相应设置写入。

| 键 | 适用后端 | 默认 | 含义 |
|---|---|---|---|
| `provider` | — | `deepseek` | 服务搜索的后端；同时是注册 id。 |
| `apiKey` | 除 `duckduckgo` 外 | — | 字面密钥。优先用 `apiKeyEnv`，避免密钥进入配置文件。 |
| `apiKeyEnv` | 除 `duckduckgo` 外 | 各后端约定¹ | 每次搜索解析的凭据引用。 |
| `baseURL` | 除 `duckduckgo` 外² | 各后端默认² | 端点基址。 |
| `model` | `deepseek`、`claude`、`gemini`、`perplexity` | 各后端默认³ | 模型中介后端的模型名。 |
| `apiVersion` | `deepseek`、`claude` | `2023-06-01` | `anthropic-version` 标头值。 |
| `maxTokens` | `deepseek`、`claude`、`perplexity` | `4096` / `1024` | 生成回答的 token 上限。 |
| `maxUses` | `deepseek`、`claude` | `5` | 单次请求原生的 `web_search` 服务端工具使用上限。 |
| `searchType` | `exa` | `auto` | 作为 Exa `type` 发送的检索模式。 |
| `numResults` | `exa`、`brave`、`duckduckgo` | （未设） | 请求未带 `maxResults` 时的默认结果数。 |
| `highlightsPerResult` | `exa` | `1` | 每条结果请求的高亮句数。 |
| `country` | `brave` | （未设） | 两字母国家代码。 |
| `searchLang` | `brave` | （未设） | 搜索语言。 |
| `searchRecency` | `perplexity` | （未设） | 时效窗口：`day`、`week`、`month`、`year`。 |

¹ `$DEEPSEEK_API_KEY` / `$ANTHROPIC_API_KEY` / `$GEMINI_API_KEY` / `$EXA_API_KEY` / `$BRAVE_API_KEY` / `$PERPLEXITY_API_KEY`。² DeepSeek 刻意不复用 `$DEEPSEEK_BASE_URL`：chat-completions 与 Anthropic 兼容 Messages API 是不同端点。端点按「配置节覆盖 → 环境变量 `$DEEPSEEK_SEARCH_BASE_URL` → 内置默认」的顺序解析。³ 分别为 `deepseek-v4-flash`、`claude-sonnet-4-5`、`gemini-2.5-flash`、`sonar`。

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'

- id: web-search
  name: '@deepseek-ai/dsh-web-search'
  config:
    provider: deepseek        # deepseek | claude | gemini | exa | brave | duckduckgo | perplexity

# A different deployment pins another backend:
#   config:
#     provider: exa
```

由于插件只注册一个提供方，seam 无需固定的 `searchProvider` 即可自动选择；挂载两个插件（或设置 `DSH_WEB_SEARCH_PROVIDER`）则为显式选择。

## 实时切换提供方

已提交的设置变更会重新校验并重挂载注册——包括 `provider` 切换：先释放旧注册，任意时刻都恰好存在一个搜索提供方，下一次搜索即使用新后端。选项编辑（端点、预算）通过每次操作入口读取的 section 快照到达下一次搜索；凭据按操作解析，轮换密钥无需重启。

## 日志契约

由 agent 发起的原生搜索会在发出请求前一刻，向相应会话追加仅用于日志的 `web/native-search-llm-request` 会话事件，携带带判别符的请求记录（`provider` 以及发送给后端的确切无密钥端点/版本/请求体）；不包含标头和凭据。外部后端不发模型请求，也不记录任何事件。记录抛出异常会阻止发送，因此模型可见的辅助输入不会逃过日志。

## Model Experience

间接地经由 [`dsh-tool-web`](../tool-web/README.zh.md)：它在 `maxResults` 上限内保留每个后端归一化后的来源（URL、标题、摘要、发布日期，以及后端产生的生成回答），并以消费者错误包装呈现本包稳定的 `WEB_*` 失败；提供方私有的线协议字段留在上下文之外。

#### KV Cache 效应

无直接失效；由上述消费者负责任何请求前缀变化。

## 已知限制与后续工作

- **DuckDuckGo 解析公开 HTML 页面** —— 无官方 API 也无 SLA；标记漂移表现为零来源而非错误。
- **Gemini grounding chunk 不含摘录** —— `snippet` 保持缺省而不臆造；只有 Brave/Exa/DuckDuckGo/Perplexity 提供每条结果摘录。
- **Brave 描述带有轻量 HTML**,已剥离为纯文本；五种常见实体之外的转义将原样保留。
