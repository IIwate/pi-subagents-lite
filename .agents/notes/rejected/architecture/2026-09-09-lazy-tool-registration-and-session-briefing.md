# Agent Note: 运行时按需延迟注册工具与会话消息注入方案

Status: rejected — 动态注册工具破坏 KV-cache 前缀且会话消息注入易过期污染上下文

## Problem

在设计子代理（Subagent）的工具暴露机制与模型引导策略时，需要解决两个核心问题：
1. **工具何时注册**：如果不加克制地一开始就暴露所有工具，未配置子代理的会话也会看到工具；因此直觉上往往希望“按需延迟注册（Lazy Registration）”，仅在用户开启或调用时才注册 `Agent` 工具。
2. **引导如何传达**：动态变化的子代理类型、核心规则与模型白名单该通过什么媒介同步给父模型？直觉方案是在会话中注入一条系统/用户消息（Briefing Message），或者由用户通过 Slash Command 手动刷新下发。

## Proposal

早期曾提出过动态延迟注册与会话消息注入的交互方案：
- 延迟注册：插件初始化时不注册 `Agent` 等工具；当检测到相关命令或模型具备子代理权限时，动态调用 `registerTool()` 并通过 `refreshTools()` 与 `setActiveToolsByName()` 更新运行时工具列表。
- 会话消息注入：当可用代理类型或路由规则变更时，向会话的消息历史数组中 `push` 一条带有详细规则说明的虚拟消息（Briefing Message）；或提供 `/agents briefing` 指令由用户主动触发消息下发。

## Alternatives considered

- **插件初始化静态注册 + `before_agent_start` 动态系统提示词注入（最终采纳）** — 在插件初始化时一次性完成极简 Schema 的工具注册（见 [2026-09-09-stealth-tool-registration.md](../../implemented/architecture/2026-09-09-stealth-tool-registration.md)），并通过 `before_agent_start` 钩子动态拦截并追加 Guidance 到系统提示词尾部（见 [2026-09-09-dynamic-guidance-injection.md](../../implemented/architecture/2026-09-09-dynamic-guidance-injection.md) 与 [2026-09-09-byte-stable-guidance-contract.md](../../implemented/architecture/2026-09-09-byte-stable-guidance-contract.md)），彻底避免了修改工具集造成的端侧 KV-cache 失效，且完全不污染会话历史。
- **纯静态工具描述与固定配置** — 无法适应运行时会话中的父模型切换和动态模型路由权限。

## Risks

- **为何彻底否决**：
  1. **破坏推理端 KV-cache 前缀**：诸如 llama.cpp、vLLM 等推理引擎通过 Jinja2 模板将可用工具集合直接渲染到系统提示词中。在会话中途调用 `registerTool` / `refreshTools` 会直接改写已固化的工具列表，导致既有的 KV-cache 前缀全部失效，引发严重的重复预填充计算与推理卡顿。
  2. **会话消息污染与滑动截断**：将规则作为消息注入对话历史，不仅虚增上下文长度，而且在长会话发生上下文窗口滑动或压缩裁剪时，该消息极易被整体丢弃，导致模型遗忘子代理规则；此外还会破坏正常的人机会话展示流。
- **重新考虑的前提条件**：
  只有当底层所有主流推理引擎原生支持工具定义的动态热插拔且不影响前缀缓存，或者模型上下文窗口无限大且消息历史具备完美的抗截断与免污染机制时，才可重新评估此方案。
