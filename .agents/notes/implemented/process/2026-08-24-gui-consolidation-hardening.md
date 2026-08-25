# GUI consolidation hardening: batched settings writes, raw SSE passthrough, desktop fd probe, closure manifest export

English | [中文](2026-08-24-gui-consolidation-hardening.zh.md)

Date: 2026-08-24

## Context

The GUI shell, web-search provider mount, and terminal stack landed across several branches. A consolidation review surfaced four cross-cutting weaknesses worth fixing before release rather than per-feature: multi-field settings cards wrote one Host mutation per field, the desktop carrier re-parsed SSE blocks that the main process had already serialized, the web-app bundle trusted its supervising parent without proof, and the desktop packager's dependency closure was only computable by running its CLI.

## Decisions

### `SettingsScope.setMany` batches card saves

`CardForm.save()` now plans every field write up front and sends section fields as one `setMany(ops)` call; secret fields keep their individual `write` controls because each secret owns its control flow. The stub in `test-support/client-runtime` implements `setMany` with matching semantics so plugin tests exercise the real batching path. Rationale: a five-field card save previously produced five durable writes and five validation passes; a refused third field left the first two applied with no user-visible recovery. With one mutation the Host validates the composed result once, and the form read-backs the user layer afterwards to decide success.

### Provider switches pre-clear incompatible staged fields

The web-search controller mirrors each provider's accepted field set (`FIELD_PROVIDERS`) and stages clears for overrides the newly selected provider would refuse (for example a `baseURL` override while switching to duckduckgo, which has no base URL). The card renders a `clearedBySwitch` notice naming what the switch discarded. Without this, switching providers saved stale overrides that failed validation on next load.

### Desktop carrier pumps whole SSE blocks verbatim

`DesktopIpcApiClient` no longer splits stream payloads into synthetic `data:` events; it forwards each raw block and consumers parse through the shared `sse-blocks.ts` (`sseDataPayload` / `sseEventName`). Named events survive transport, and a block without a `data:` field is skipped silently — the previous parser treated such blocks as malformed frames and logged noise for benign `event:`-only blocks. The stdio webserver carrier keeps emitting `data:`-only blocks, pinned by a parity test duplicated in both suites' codec blocks.

### Web-app startup proves the supervising parent owns pipe fds

Before adopting the stdio frame carrier, `web-app` startup fstats fds 3 and 4 and refuses loud when either is not a FIFO, naming the offending kind. This turns a silent hang (carrier waiting on pipes nothing will ever write) into an immediate diagnostic. `surfaceContext` stays gated on the `tcp` carrier because context injection rides the HTTP surface the stdio mode does not open.

### Desktop packager exports its closure computation

`package-desktop.ts` exports `main`, `writeClosureManifest`, and `computeClosureDependencies` behind a `pathToFileURL(process.argv[1])` CLI guard so tests import the functions directly instead of spawning the script. Test-support roots are excluded from both the edge walk and existing-pin merge, which also removed three stale hand-pinned externals (vitest, `@testing-library/*`) from the regenerated closure manifest.

## Consequences

Multi-field saves are atomic at the Host boundary; consumers of `desktop-carrier` must handle named events or use `sse-blocks` helpers; anything launching the web bundle outside the desktop shell needs real FIFOs on 3/4 or an explicit `DSH_DESKTOP_CARRIER=tcp`; packaging tests no longer shell out. The gateway's route plumbing remains under the coverage exemption with an updated comment.
