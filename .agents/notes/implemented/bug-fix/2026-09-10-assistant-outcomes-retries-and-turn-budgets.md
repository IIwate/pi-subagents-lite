# Agent Note: Assistant 终态、瞬态重试与回合预算

Status: implemented

## Problem

Pi 的 `session.prompt()` 可以正常 resolve, 同时最后一条 assistant message 带有 provider error. 网关也可能用正常 stop 结束空白或只有 thinking 的流. 仅检查 Promise 是否 reject, 或从整个历史寻找任意非空文字, 会把错误或中途片段报告为完成. 另一方面, 工具循环必须有终止边界, 并给模型留出写阶段性结论的机会.

## Decision

[runner](../../../../src/agents/agent-runner.ts) 为每次初始执行和继续执行单独收集 `message_end` 中最后一条 assistant message. 只提取 `type: "text"` 内容. `stopReason: "error"` 优先抛出 provider 错误; 没有错误说明时使用明确的缺失说明错误. 非 aborted、非 turn-limited 的空文本抛错. 只有整段匹配 `call:<name>{...}` 的文本被判为未执行工具调用; 含普通解释的文字不因出现 `call:` 就被拒绝. thinking 和 toolCall 不能充当最终正文.

重试沿用 Pi 的次数、退避、队列和上下文回滚. 扩展仅按 session 包裹私有 `_isRetryableError`, 保留原判定及 `this`, 并通过 Symbol 避免重复包裹. 原判定为 false 时, 增补两类信号:

- error message 中的 stream/socket/network/transport 断开、EOF、ECONNRESET、ETIMEDOUT、EPIPE、无效 SSE JSON 和明确 upstream error.
- 正常终态没有非空 text 且没有 toolCall/tool_use, 包括纯 thinking. 为此填充 `Empty assistant response received` 诊断. aborted 和原本的 error 不经过这个空白分支.

这是可恢复失败的分类启发式, 不能证明空白必然来自断网. 配额、认证、内容过滤等永久错误不因“无正文”被额外放宽为可重试. 私有方法缺失时使用 Pi 原行为, 最终空文本守卫仍生效. [retry compatibility test](../../../../test/unit/agents/pi-retry-compat.test.ts) 则在依赖升级时显式报告方法消失.

`maxTurns` 未设置或为 0 表示不限回合. `turn_end` 达到软上限时发送含剩余预算的 steer, 默认 grace 为 6. 后续 `turn_end` 达到硬上限时设 aborted 并请求 abort. grace 为 0 或 1 均实际留一个后续 turn, 因软上限分支和硬停止分支不在同一事件执行. `steer()`/`abort()` 的 Promise rejection 在事件回调中被处理, 避免逃逸为 unhandled rejection; 已设置的停止事实不因 abort reject 消失.

继续执行的预算按本次 prompt 计算, 展示的 turnCount 累加此前执行. `max_tokens` 通过子会话 model 副本的原生 `maxTokens` 交给 Pi, 不修改父模型或 registry, 不再依赖 provider-specific payload 字段. [状态说明](../../../../src/status-note.ts) 区分预算硬停止、软截断和用户/模型主动停止, 防止将 partial output 当结论.

## Alternatives considered

- **保留 Promise 成功即完成, 或使用最近非空历史回答.** 最少适配 Pi 细节, 但 provider error 可以不 reject, 历史正文也可能只是任务中间阶段.
- **扩展自建重试循环或自动派发替代 Agent.** 可控制所有策略, 但需重复实现 Pi 的回滚、steering、退避和取消, 且可能重做已有工具副作用. 当前仅扩展分类, 不承诺工具副作用恰好一次.
- **接受 thinking 为结果, 或把所有空白 error 都重试.** 能隐藏部分异常, 但前者混淆推理和报告, 后者会反复请求永久拒绝. 最终错误仍必须可见.
- **达到 maxTurns 立即 abort.** 预算边界直接, 但不给模型汇总机会. 软提示加硬停止保留可读的部分成果, 代价是额外 grace 回合.

## Consequences

正常完成要求本次执行有最终正文; budget/abort 仍可能没有正文, 由明确状态说明表达. 重试耗尽返回 terminal error, 不保证最终成功. 升级 Pi 时必须核对私有分类器、事件顺序和原生 maxTokens 的语义. 重试期间的人工输入与 Esc 见 [子屏交互](2026-09-09-subagent-screen-retry-and-steering-visibility.md).

Debug fault 在真实 session 配置完成后、首次 prompt 前注入, 只消耗下一个实际启动的任务一次; 入队本身不消耗. 它验证可继续的失败路径, 不模拟真实 provider 网络. UI status preview 仅改展示, 不改变执行状态.

## Evidence

- `5fd169f`, `37fc553`: terminal assistant 元数据和伪工具调用正文守卫.
- `f87a115`, `9d03c06`, `4e5ac95`, `cef94ba`: Pi retry 扩展、传输错误及纯 thinking/空白分类.
- `bda06c2`, `bf4c335`, `68d72f2`, `1e75d1a`: grace、软硬停止和停止发起者说明.
- `cbbefae`, `65d1690`: output token 限制的 provider payload 方案与 Pi 原生模型参数方案.
- `7e985ec`, `4d8a115`, `ab1e595`, `19ed1dd`: Debug 注入、诊断及即时 terminal error.

## Verification

[runner outcomes](../../../../test/unit/agents/runner/agent-runner.outcomes.test.ts)、[limits](../../../../test/unit/agents/runner/agent-runner.limits.test.ts)、[setup](../../../../test/unit/agents/runner/agent-runner.setup.test.ts)、[Pi session scenarios](../../../../test/scenarios/agents/pi-session.test.ts) 和 [provider delivery](../../../../test/scenarios/agents/provider-result-delivery.test.ts) 分别验证终态、预算、模型副本和真实 Pi 离线重试链路. [manager lifecycle](../../../../test/unit/agents/manager/agent-manager.lifecycle.test.ts) 覆盖 Debug 消耗时机; [status-note tests](../../../../test/unit/status-note.test.ts) 覆盖状态说明.
