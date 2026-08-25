# Agent Note：tsconfig paths 精确键必须指向入口文件

Status: implemented

[English](2026-08-24-tsconfig-paths-exact-keys-target-entry-files.md) | 中文

## Problem

测试源平面通过 `vite-tsconfig-paths` 读取 `tsconfig.base.json` 的 `paths` 映射来解析裸的 `@deepseek-ai/*` 说明符；这张映射的存在意义，是让测试与静态门永远看到 `src/` 的同一份共享模块拷贝，而不是构建出的 `lib/` bundle。这一保证曾静默失效：`packages/host/apiproxy` 的十二个用例以笼统的 `code: 'internal'` 错误失败，原因是 api-proxy 代码里 `instanceof SessionTitleInvalidError` 与 `instanceof TypertLookupFailure` 为 false——尽管两侧引用的是同名类。代理模块实际执行的是内置依赖拷贝的构建产物，而相邻导入解析到了别处，类身份于是跨模块图分裂。纯净 HEAD 树之所以能通过，只是因为它那一代 lib 恰好自洽；一次干净构建就会暴露失败，而且配置里没有任何东西能区分正常状态与损坏状态。

## Decision

`tsconfig.base.json` 中每个精确键 `paths` 条目都指向一个存在的入口文件（`src/index.ts`、`src/client/index.ts`……），绝不指向源码目录；通配符 `…/*` 键保留目录目标，因为其替换结果总是在使用处指名具体文件。此前六十九个目录目标的精确键已全部转换，并删除一条死条目（`@deepseek-ai/dsh-agent/brand` → 不存在的 `brand.ts`，无任何消费方）。该规则是受门强制执行的，而非仅靠约定：[scripts/check-workspace-constraints.ts](../../../../scripts/check-workspace-constraints.ts) 中的 `checkTsconfigPathsTargets`（即 `constraints` 卫生门）会拒绝目标缺失或为目录的精确键。

要求文件目标的理由：产生可解析文件路径的重写在任何解析环境下行为确定；目录目标则依赖回退索引解析，在某些环境会静默跳过，由此落入 node_modules 的结果在成功与失败之间不可区分，直到某个依赖类型身份的断言在远离成因之处崩溃。

## Alternatives considered

**让宿主 bundle 外部化 `@deepseek-ai/*` 依赖**，使构建库共享同一模块拷贝。否决：打包形态由各包自己的 tsdown 配置负责，外部化会改变发布产物，且类型平面漂移依旧存在。

**把 paths 映射镜像为 vitest 的 `resolve.alias`。** 否决：这会把权威映射复制成必然漂移的第二事实来源；本修复让所有权继续单一地落在 `tsconfig.base.json`。

**让用例改用相对 `src/…` 路径导入兄弟模块。** 否决：逐用例治标，并把同一隐患重新施加给未来的每个用例，而不是一次性消除。

## Consequences

换来的：每个裸工作区说明符的源平面身份确定性——十二个失败在未改动产品代码的情况下消失——外加一道把未来回归转化为指名道姓、定位明确的响亮报错的门。付出的：六十三处机械映射修改搭车在转换变更里，无关外观的 diff 追责都会落到此处；且强制只覆盖精确键——通配键的基目录若消失，仍要等到首次使用才失败。

## Testing

转换后的映射上 `pnpm run constraints` 通过；临时重新引入一个目录目标会产生恰好一条定位明确的违规，恢复后重新变绿。转换后的完整本地电池全绿：typecheck、build、`test:gui`（4031 通过）、hygiene、duplication、doc-sync。
