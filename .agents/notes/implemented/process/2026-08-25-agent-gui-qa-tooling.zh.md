# Agent Note：面向 agent 的 GUI QA 工具——落地的泳道与启动顺序修复

Status: implemented

[English](2026-08-25-agent-gui-qa-tooling.md) | 中文


- **领域：** client UI · web e2e 泳道 · 视觉泳道 · docs/research
- **取代：** 无 · **相关：** [web e2e 泳道](../../../../apps/web/tests/README.zh.md) · [统一标签分类](2026-08-08-unified-github-label-taxonomy.zh.md)

## Problem

agent 没有直接查看并驱动其构建产品的途径：交互式 QA 只能靠手写 Playwright 脚本（单向截图、对 SSE 不友好的 `networkidle` 等待、overlay mask 导致的点击超时），无障碍合规没有度量，绘制输出的回归没有门禁，定位器依赖在源与产物之间漂移的本地化文案。另一条线上，合并后的 jsdom 泳道所有组装组合场景一启动就红（`slot "workbench" is not declared`），因为 entry 创建与 slot 父级初始化存在竞速。

## Decision

按 [docs/research/gui-qa-tooling.md](../../../../docs/research/gui-qa-tooling.md) 调研结论采用 Playwright 家族作为 QA 栈：`@axe-core/playwright` 在稳定 shell 与设置对话框上把 WCAG 2.x A/AA 变成泳道失败项（`apps/web/tests/accessibility-axe.e2e.ts`）；独立的 `@playwright/test` 视觉泳道（`apps/web/visual/`，`pnpm run test:web:visual`) 经 `toHaveScreenshot` 按平台固定像素基线；主骨架落地稳定 `data-testid` 锚点（`settings-trigger`、`settings-dialog`、`composer-input`、`drag-handle-*`），让定位器免疫语言漂移。启动顺序在两层变为确定性：`orderByModuleGraph` 把 `inject` 名字视为图边；`runPluginBoot` 依赖分层创建 entry（`dependencyLevels`），保证 slot 父级先于 occupant 注册进 children 初始化。需要 vitest `expect` 的 golden 工具移入 `tests/goldens.ts`，`scaffold.ts` 因此可在纯 node+tsx 下加载，视觉泳道得以在 vitest 之外启动真实组合。

## Alternatives considered

**MCP 优先的交互。** 否决为默认：本 harness 永远有 shell，而 Microsoft 把有 shell 的编码 agent 从 MCP 工具 schema 导向 CLI/skills；Chrome DevTools MCP 仍是性能/console 深潜的建议项。

**SaaS 视觉/agentic-QA 平台（Percy、Chromatic、Applitools、Checkly、Momentic、mabl）。** 暂缓：云基线或绑定供应商的 runner 对一个已被原生驱动的回环目标没有增益；仅当 DSH 出现托管部署再议。

**在 vendor/loader 内修 slot 竞速。** 否决：loader 拒绝迟到的父级是正确行为；问题在我们的组合未按依赖排序创建 entry，修复完全落在一方代码。

**大范围铺开 `data-testid`。** 暂缓于四个主骨架锚点之外，待交互式 QA 覆盖更多界面；约定（Playwright 默认属性名）已写入调研笔记。

## Consequences

泳道在快速求值环境下确定性地启动，而不再依赖 HTTP 延迟；组装组合场景重新触达真正的断言。无障碍违规现在是泳道失败项，新骨架必须过 WCAG 2.x A/AA 或携带书面豁免。像素基线按平台隔离并入库（`apps/web/visual/snapshots/<platform>/…`）；新平台贡献者用 `--update-snapshots` 重生成本平台目录而不是硬啃外来基线。master 上已知残留、本 PR 未变：`built-boot.snapshot.ts` 仍因 jsdom harness 的品牌 profile 守卫失败（official 品牌 bundle 只有走完整流水线构建才折叠 `DSH_CLIENT_BUILD_PROFILE`），另有三个 `lifecycle-chrome` golden 的既有 aria 漂移与 tooltip 抖动——都需各自诊断。
