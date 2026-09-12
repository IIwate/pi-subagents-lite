# AGENTS.md

pi-subagents-lite is a Pi extension for isolated subagent sessions, model access, and parent result delivery. [README.md](README.md) owns product usage; [CONTEXT.md](CONTEXT.md) owns terminology and product boundaries.

## Repository layout

| Location | Responsibility |
|---|---|
| [src/index.ts](src/index.ts), [registration.ts](src/registration.ts), [events.ts](src/events.ts) | Extension entry, tool/shortcut registration, and service lifecycle assembly. |
| [src/runtime.ts](src/runtime.ts) | Activation ownership, native task discovery, and resource teardown. |
| [src/domain/](src/domain/), [src/engine/](src/engine/), [src/drivers/](src/drivers/) | Accepted policy, admission, native execution, durable results, and host adapters. |
| [src/agents/](src/agents/) | Agent definitions, discovery, and tool handlers. |
| [src/spawn/](src/spawn/) | Same-repository worktree validation. |
| [src/models/](src/models/), [src/config/](src/config/) | Model authorization and thinking resolution; configuration loading, persistence, and applied settings. |
| [src/prompt/](src/prompt/) | Context extraction, skills, deterministic guidance, and selected-message formatting. |
| [src/ui/](src/ui/) | Input routing, transcript rendering, navigation, delivery selection, and settings views. |
| [test/](test/) | Module tests, cross-module scenarios, and shared resource fixtures; see [development](docs/development.md#test-layers). |
| [.agents/notes/](.agents/notes/README.md) | Decision rationale, trade-offs, and verification obligations. |

## Runtime invariants

- **Execution records and durable results have separate owners.** `TaskEngine` and its drivers own execution resources; native session values own saved deliveries. Never reconstruct executable records from outbox entries or apply the UI retention timer to durable results ([delivery](.agents/notes/implemented/architecture/2026-09-11-native-execution-and-parent-delivery-adapters.md)).
- **ACK requires a durable receipt.** Verify the matching delivery in the parent session log before acknowledging it; sending a message, rendering it, or completing a model turn is insufficient. Preserve results when persistence or acknowledgement fails.
- **Delivery retains its origin.** Automatic delivery requires the original parent session and active origin branch; explicit `AgentStatus` reads are session-wide. Native task discovery remains isolated by parent session ID.
- **Human takeover leaves subsequent output for explicit selection.** The editor sends instructions; the delivery selector selects existing messages. A taken-over terminal run does not automatically create a automatic outbox entry or wake Main ([takeover](.agents/notes/implemented/architecture/2026-09-11-native-execution-and-parent-delivery-adapters.md)).
- **Accepted work keeps its policy.** Running and queued agents retain the accepted configuration. Every run respects both Model and Provider ceilings; each reservation releases at most once, and a blocked settled-session continuation returns a local rejection ([concurrency](.agents/notes/implemented/architecture/2026-09-09-hierarchical-concurrency-ceilings.md)).
- **Model routing grants access.** Omitted `model` selects the exact parent model; rejected explicit choices must fail visibly. Alternate access uses Pi availability and active scope, while dormant saved rules remain intact ([model access](.agents/notes/implemented/architecture/2026-09-09-model-routing-and-access-policy.md)).
- **Tool registration stays stable.** Register Agent tools once; dynamic access belongs in `before_agent_start` system guidance. Equal effective state produces byte-stable guidance; result messages and tool cards retain the existing silent presentation ([registration](.agents/notes/implemented/architecture/2026-09-09-stealth-tool-registration.md), [guidance](.agents/notes/implemented/architecture/2026-09-09-byte-stable-guidance-contract.md)).
- **Resolve services and release resources through their owners.** Capture the owning ExtensionRuntime in registration closures and reject stale session callbacks. Timers, subscriptions, child sessions, and UI replacements need matching teardown; retain cancellation and shutdown ordering ([lifecycle](.agents/notes/implemented/architecture/2026-09-12-explicit-runtime-and-native-task-ownership.md)).
- **Terminal output and focus are explicit.** Pass model/tool text through [displayText](src/ui/format.ts) before rendering. Preserve [navigator](src/ui/agent-navigator.ts) cursor ownership, including removal of editor cursor markers while the list is focused, and restore the host components owned by a screen swap.

## Engineering conventions

- Respond in Simplified Chinese. Code comments, JSDoc, test names/descriptions/assertions, commits, and PR descriptions use English.
- Match surrounding style. Comments explain non-obvious behavior, ownership, failure limits, and trade-offs.
- Keep changes scoped; avoid speculative abstractions, fallback behavior, compatibility layers, and migration shims. Persisted-format or public-contract breaks require an explicit migration/version decision.
- Validate configuration, model/tool JSON, and persisted input at entry. Trust values already established by typed internal APIs.
- An intentionally ignored error names the expected failure and why no further action is needed; keep the protected operation narrow.
- Use English Conventional Commits, with concise `- ` bullets for non-trivial commits and no AI attribution. Follow the [release procedure](docs/releasing.md) before tagging or publishing; release tags are immutable.

## Verification and test standards

Use Bun for package management. The [development guide](docs/development.md) owns commands, test execution, and worktree setup.

- **Evidentiary value and anti-mirror rule:** Tests verify observable behavior, system boundaries, and failure invariants. Never write mirror tests that merely duplicate internal implementation logic or assert facts already guaranteed by TypeScript types, the runtime, or upstream frameworks.
- **Minimal runnable proof:** Add one focused check for non-trivial logic. Trivial changes, pure refactors, and formatting need no extra test.
- **Layer discipline:** Prefer `test/unit/` for pure logic and single-module invariants. Keep `test/scenarios/` focused and restrained to cross-module lifecycle, filesystem persistence, and Pi session reconciliation.
- **Determinism and hygiene:** Never rely on arbitrary sleeps or polling; coordinate via deterministic events or fake clocks. All resources, subscriptions, and temporary directories must register with `createTestHarness` for deterministic teardown.
- **Local testing is strictly bounded:** Run only the narrowest test covering the changed behavior (e.g. `bun run test:unit <path>`). Complete logic and typecheck before running tests; never run tests in speculative, fragmented rerun loops. Once the narrow test passes, converge and proceed to delivery immediately.
- **CI owns the full suite — no pre-commit test ritual:** CI owns exhaustive full-suite execution across operating systems. **Never run the full test suite (`bun run test`) locally during routine development or before committing.** Run the full suite locally only for: (1) an explicit user request, (2) CI failure diagnosis, or (3) repository-wide changes with no narrower evidence.
- **Never repeat passing checks:** If evidence already passed on the unchanged working tree, do not rerun tests merely because a commit, tag, or push follows.
- Run `npm run verify-notes` for affected Notes and their references. Before committing, run `git diff --cached --check`.

## Documentation ownership

Keep root rules self-contained in one to three sentences and link their detailed owner. Contributor procedures belong in [docs/](docs/); keep detailed facts in one place, and preserve conditions and failure limits when condensing them.

<!-- BEGIN WRITE-NOTES GUARDRAILS -->
## 架构决策留痕与防撞规范（脚手架受管区，请勿手工编辑）

在进行涉及系统设计决策与架构基线的非平凡变更（技术选型、核心模块重构、破坏性接口变更、系统级缺陷复盘、特性裁撤）前：
1. 遵循 [.agents/skills/write-notes/SKILL.md](.agents/skills/write-notes/SKILL.md)。
2. 既有模块重构优先就地更新对应 Note 的事实部分，严禁只改代码不改 Note，严禁追加流水账。
3. 路径分流：单轮闭环交付（随代码同批合入）直接在 `.agents/notes/implemented/` 以现在时编写事实；仅跨会话异步评审/分期立项才走 `.agents/notes/proposed/`。
4. 必须包含 `## Alternatives considered` 章节，且必须包含维持现状选项与对手方案的最强论据。
5. 源码反向锚点遵循“单一主宿主”原则（类型优先，流程次之，一 Note 一锚点，禁止全库散弹式打标）。
6. 代码块分级防护：核心契约用 `type-equiv`，普通行为逻辑用标准 ts 编译检查，严禁为凑门禁虚构无意义类型。
7. 免除范围（严禁建 Note）：纯文档修改（README/Wiki/使用指南/API 文档）、注释调整、单测增补、常规依赖升级与非架构性日常日常修复，直接提交即可，严禁新建任何 Note。
<!-- END WRITE-NOTES GUARDRAILS -->
