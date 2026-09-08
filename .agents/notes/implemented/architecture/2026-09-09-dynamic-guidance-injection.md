# Agent Note: 基于 before_agent_start 钩子的动态提示词注入机制

Status: implemented

## Problem

由于 Agent 工具采用了极简 Schema（见 [2026-09-09-stealth-tool-registration.md](2026-09-09-stealth-tool-registration.md)），父大语言模型（Parent LLM）无法直接从工具定义本身获知：
- 当前环境中发现了哪些可用的子代理类型（Agent Types）；
- 子代理的核心调用准则（如 fresh conversation、后台运行、worktree 路径边界）；
- 当前父模型的具体标识；
- 经过权限配置过滤后，各个子代理具体有哪些可用的备选模型。

这些信息直接取决于运行时的动态上下文（父模型切换、配置重载、可用模型列表变更）。如果静态写死在初始化配置中，将无法响应会话内的变更；如果向会话历史中插入虚拟消息，会污染对话上下文并随窗口滑动被遗忘；如果依赖用户手动运行命令刷新，则存在严重的人工失误风险。

## Decision

系统接入宿主环境提供的 `before_agent_start` 扩展生命周期事件，在父 LLM 每次执行推理前，无缝、动态地拦截并追加最新的 Guidance 块至系统提示词尾部：

1. **热路径动态拦截**：
   在 `src/events.ts` 的 `before_agent_start` 监听器中，每次均基于当前最新的会话状态（`ctx.model`、`ctx.modelRegistry`、`ctx.scopedModels` 及路由配置）实时生成 Guidance 文本。
2. **条件挂载契约**：
   仅当当前会话激活了 `Agent` 工具时（`event.systemPromptOptions.selectedTools?.includes("Agent")`），才追加引导内容：
   ```ts ignore-check
   return {
     message: resultMessage,
     systemPrompt: `${event.systemPrompt}\n\n${guidance}`,
   };
   ```
   若未启用 `Agent` 工具，则不注入任何子代理相关的提示词，杜绝无关干扰。
3. **零轮次与免刷新体验**：
   无论用户何时在交互中切换模型（`model_select`）或更新模型路由规则，改动均会在下一次父 LLM 运行前自动生效，无需重启会话或执行 `/reload`。

## Alternatives considered

- **在会话开始时（`session_start`）一次性注入系统提示词** — 简单直接，但完全无法感知会话进行中用户切换模型或调整路由权限的动作，导致模型认知与真实权限脱节。
- **向会话历史中插入 Briefing 虚拟消息** — 能够在前端界面显式展示规则，但其不仅污染正常的对话上下文，还会随着多轮对话历史窗口的滑动被截断失效，且每次更新规则都需要多跑一轮 LLM 生成，已被明确否决（详见 [2026-09-09-lazy-tool-registration-and-session-briefing.md](../../rejected/architecture/2026-09-09-lazy-tool-registration-and-session-briefing.md)）。
- **通过调试命令（如 `/agents briefing`）由用户手动同步** — 将运行时同步责任推给用户，违背自动化原则。

## Consequences

- **收益**：运行时模型与配置变更能够毫秒级无感同步给父 LLM，无需触发额外交互轮次或重启应用；条件注入机制确保非 Agent 会话保持干净。
- **代价与已知上限**：注入逻辑位于每次 LLM 触发前的关键链路上，因此 Guidance 的构建必须为纯内存的同步高效计算，不得包含阻塞性 I/O。
