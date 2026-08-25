# Agent Note：子进程终端句柄新增 PTY resize

Status: implemented

[English](2026-08-22-subprocess-terminal-resize.md) | 中文

## Problem

`SubprocessTerminalHandle` 此前能在固定单元格网格上生成 PTY 并写入输入，却无法在生成后调整大小。交互式终端消费方需要跟随其视口；没有 `resize`，每次面板几何变化都得杀掉并重新生成 shell。

## Decision

seam 在 `write` 旁新增 `resize(cols, rows): Promise<void>`。本地 node-pty 提供方在与 `write` 相同的保留 promise 语义下同步调整大小（包括对已退出句柄的拒绝），E2B 提供方则在其 tracked-operation 包装内转发到 `sandbox.pty.resize(pid, {cols, rows})`，因此终止操作仍能取消进行中的 resize。两个提供方都对已退出的终端拒绝调用，与 `write` 一致。

## Alternatives considered

**由消费方采用"重生成以调整大小"的约定。** 否决：每次几何变化都会丢失 shell 状态，并把底层知识推进每个调用方。

**可选的 `resize?` 成员。** 否决：能力 seam 携带完整契约；可选性会迫使每个消费方对提供方支持与否做分支。

## Consequences

现有句柄 fake 均已补充该方法，任何新的 `SubprocessTerminalHandle` 实现都必须提供真实的 resize 或大声失败。远程传输保持异步形态，未来的远程提供方无需改动 seam 即可实现。

## Testing

扩展后的 seam 在本地提供方、E2B 提供方与所有现有句柄 fake 上编译通过；subprocess 与 terminal-bash 套件保持绿色（224 通过）。行为级 resize 覆盖随其首个消费方 terminal-gateway 插件落地。
