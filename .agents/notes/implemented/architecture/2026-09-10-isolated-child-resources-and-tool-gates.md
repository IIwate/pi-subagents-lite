# Agent Note: 独立子会话、接受时策略快照与工具能力门禁

Status: implemented

## Problem

后台排队期间修改 Agent 定义或父模型, 不应悄悄改变已接受任务. 复制父会话完整历史会带入父身份和已完成工作; 完全丢弃扩展状态又会让子会话失去用户当前偏好. Pi 在创建 session 时固定注册 allowlist, 但扩展可能直到 `session_start` 才注册工具, 因而“加载扩展”和“让模型看到工具”必须区分.

## Decision

[Agent 工具入口](../../../../src/agents/tool-execution.ts) 在调用被接受时复制定义、模型和 scope, 解析 thinking、grace 和工具策略. [runner](../../../../src/agents/agent-runner.ts) 消费这份策略, 不在出队时重新授权. `record.display.invocation` 只保存显示身份, 完整策略由 queued spawn 参数携带. [并发上限](2026-09-09-hierarchical-concurrency-ceilings.md) 是另一组可热更新调度状态.

```ts type-equiv: AcceptedRunPolicy from src/types.ts
export interface AcceptedRunPolicy {
  /** Deep-copied definition resolved when the Agent call is accepted. */
  definition: AgentConfig;
  registeredTools: string[];
  restrictToRegisteredTools: boolean;
  tools?: true | string[] | false;
  extensions: true | string[] | false;
  skills: true | string[] | false;
  systemPromptMode: SystemPromptMode;
  includeContextFiles: boolean;
  /** Canonical parent model identity used when this call was authorized. */
  parentModelKey: string;
}
```

子 session 使用 `SessionManager.inMemory(cwd)`, 从新 conversation 开始. 它在 bind extensions 前复制父当前 branch 中每个 customType 的最后一条 custom entry, 使用 structuredClone 隔离可变数据, 并排除 pending-result/result-ack. Custom entry 是扩展状态, 不是 user/assistant 对话; 不复制父信箱, 不建立跨进程 session 恢复.

工具策略由 [agent-types](../../../../src/agents/agent-types.ts) 统一解释:

- `extensions: false` 禁止加载扩展; 数组按扩展名过滤; whitelist 与 blacklist 同时出现时 whitelist 优先并形成 warning. Git/npm/本地扩展路径映射到扩展名, `ext/*` 展开该扩展实际注册的工具.
- `tools: false` 在 registry 层给空 allowlist. 明确工具数组给精确 gate; 含 `ext/*`、未限制 registry 的 Agent 不提前固定 gate, 以便延迟注册工具可用. 显式 `registeredTools` 的 Agent 保留其 registry ceiling.
- bind 完成后重新读取扩展工具映射并执行可见性过滤. 无扩展权限的内建工具不会因“扩展已开启”绕过 whitelist. `tools: true`/未指定的可见集合以 Pi 当前 active tools 为基线, 并非强制激活全部 registered tools.
- `Agent` 从继承工具中排除; [AsyncLocalStorage 门禁](2026-09-09-composition-root-and-shell-singleton.md) 同时阻止子扩展重新注册整套服务. 这是防递归派发规则, 不是操作系统 sandbox.

默认 registered tools 优先采用宿主非空 defaultTools, 去重并排除 Agent; 否则回退内建工具表. Windows 缺少 Bash 时采用 PowerShell, 内建 Explore 也按平台和宿主终端偏好适配. 显式工具数组保持精确含义; 自动替换尊重 excludeTools. Explore 的只读提示与工具集合不阻止 shell 自身写文件, 不能称为强制只读隔离.

## Alternatives considered

- **出队重新读取当前定义和授权.** 可让撤销立即覆盖等待任务, 但改变已接受调用的模型、工具或 prompt 模式. 当前快照选择执行可预测性; 即时撤销需要独立产品决定.
- **复制父 conversation 或 fork 完整 session.** 能继承充分上下文, 但违背独立委派, 增加 token 并可能重复处理父任务. 当前只继承扩展 custom state.
- **始终固定 registry allowlist.** 能在 Pi 最底层限制工具, 但 wildcard 无法预知 `session_start` 新工具. 始终取消 gate 又会削弱明确受限 Agent; 当前按策略区分, bind 后再过滤.
- **维护一套扩展名注册表或无条件切换 PowerShell.** 前者需同步 Pi 安装布局, 后者会改写显式工具选择及 shell 语法. 当前复用已加载扩展信息和宿主能力.

## Consequences

快照固定配置而非文件字节: inherited system prompt、自定义 prompt 文件、skills 和上下文文件在真正启动时读取, 见 [prompt 组装](2026-09-10-child-prompt-and-skill-context.md). 运行中的 Pi session 仍拥有自身模型/工具状态. 工具 gate 不代表扩展代码没有加载时副作用.

## Evidence

- `b3bb3aa`, `e039960`: 独立执行基础与 Agent 工具新建语义; 人工继续由独立交互入口承载.
- `3494a5e`, `47b4177`, `0b7325e`, `7ca5d0d`, `97b8e1e`, `ea4fcb3`, `616f8a8`, `59f5d17`: 工具 whitelist、扩展过滤及延迟注册边界.
- `b2afecd`: 按 customType 复制父扩展状态. `5b71727`, `19ed1dd`: 接受时模型与完整策略锁定.
- `3909432`, `e526f02`: defaultTools/PowerShell 适配及独立 thinking 参数.

## Verification

[policy resolver](../../../../test/unit/agents/agent-types-resolver.test.ts)、[runner tools](../../../../test/unit/agents/runner/agent-runner.tools.test.ts)、[setup](../../../../test/unit/agents/runner/agent-runner.setup.test.ts)、[queued invocation](../../../../test/scenarios/agents/queued-invocation.test.ts) 覆盖 registry/visible 区别、延迟注册、custom state 复制和快照. [PowerShell policy](../../../../test/unit/agents/powershell-policy.test.ts) 与 [execution scenarios](../../../../test/scenarios/agents/powershell-execution.test.ts) 检查平台选择和排除策略.
