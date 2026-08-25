# Agent Note: Web search providers resolve credential references per search

Status: implemented

[English](2026-08-21-web-search-provider-credential-reference.md) | 中文

## 问题

每个 `WebSearchProvider` 每次搜索都需要 API 密钥，但已发布的提供方插件对密钥来源的约定不一致：`dsh-web-search-deepseek` 在每次搜索时通过可选的 `ctx.credentials` seam 解析一个 `CredentialRef`，而 `dsh-web-search-exa` 在注册时捕获字面量配置密钥或一次启动环境读取。因此，通过 harness 管理密钥的部署（Models 页面写入 `.credentials.yaml`）完全无法把 Exa 提供方指向托管存储：切换搜索提供方意味着把原始密钥粘贴进组合文件，或把变量导出到长驻服务器进程的启动 shell 中，轮换时还得再改一遍。

## 决策

每个已发布的搜索提供方插件都按同一约定为每次搜索解析密钥：

1. 配置中非空的字面量 `apiKey` 优先。
2. 否则插件安装解析器，读取 `apiKeyEnv`——一个默认为该提供方文档变量的 `CredentialRef`——在挂载了 `ctx.credentials` 时从该 seam 读取，否则从启动环境读取。
3. 两者都没有取到值时，该次搜索以 `WebError` `WEB_PROVIDER_CREDENTIAL_MISSING` 失败并指名未解析的引用；稳定的 `web_search` schema 保持注册状态。
4. 提供方对每个操作做一次选项快照，因此一次搜索绝不会把从一个引用解析出的密钥发往另一个引用命名的端点。
5. 只要存在字面量或解析器，`available()` 即报告可用；被引用的存储当前是否持有值是执行时事实，不是注册时事实。

`dsh-web-search-deepseek` 本就如此工作；`dsh-web-search-exa` 现在也是。`dsh-web-search-perplexity` 仍在注册时捕获，是已知缺口。

## 已考虑的替代方案

**要求在服务器启动环境中导出 `EXA_API_KEY`。** 落选：托管凭据存储存在的意义就是让密钥无需重启进程即可轮换；环境导出既无法从产品内部设置，也无法从产品内部轮换。

**以字面量 `apiKey` 为主要路径（`role('secret')`，无解析器）。** 作为兜底保留、作为主路径否决：配置平面中的密钥可被所有配置界面读取且只能靠编辑轮换；引用路径让配置保持无密钥、轮换即时生效。

**给 Exa 单独定制凭据路径而不动 DeepSeek。** 否决：同一 seam 下两个提供方的不一致正是本次缺口的成因；第二种方言只会把它翻倍。

## 后果

通过凭据 seam 存入或轮换的密钥无需重新注册即可作用于下一次搜索；在合规的提供方之间切换 seam 配置的提供方 id 也共享同一运维模型。代价是诚实的不可用语义：`available()` 无法证明密钥存在，被选中但无密钥的提供方会通过选择、再以指名引用的可操作错误使搜索失败。逐操作预检现由两个提供方共享的 `@deepseek-ai/dsh-web` provider-support seam 承载。

## 测试

单元覆盖固定了字面量优先于解析器、解析器供给 bearer 认证、`WEB_PROVIDER_CREDENTIAL_MISSING` 的代码与指名引用的消息、包装后的凭据后端失败、预检中止以 `WEB_ABORTED` 呈现且不发起请求，以及每搜索单快照语义；插件套件覆盖启动环境回退与 HMR 安全注册。该行的部署组合由消费方的 profile 补丁层演练。
