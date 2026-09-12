# Agent Note: 精确父模型默认值、备选授权与 Thinking 解析

Status: implemented

## Problem

把“给 Agent 分配默认模型”和“允许 Agent 使用模型”混在一起, 会使省略 model 的含义不确定, 并让禁用 provider 破坏已有规则. Thinking 值跨模型继承时也不一定有效, 但显式请求失败不能通过静默替换掩盖.

## Decision

[model access](../../../../src/models/model-access.ts) 只做授权. 省略 model 使用当前父模型的精确对象; 显式相同 canonical key 或父 model id 也选父模型. 精确父模型直接通过路由、availability 和 scope 检查. 这项隐式授权由父会话当前选择建立, 不允许据此放行同 provider 的其他模型.

非父模型要求 routing enabled、provider gate、该 Agent 的 provider/model grant、Pi getAvailable 和当前 scopedModels 全部通过. 当前父 provider 仅绕过 enabledProviders gate, 其余约束仍有效. scopedModels 为空表示没有额外 scope 限制; 来源是 Pi 已解析的 session scope, 不自行重读 CLI/settings 猜测.

```ts type-equiv: ModelRoutingConfig from src/config/types.ts
export interface ModelRoutingConfig {
  /** OFF permits only the exact parent model. */
  enabled: boolean;
  /** Providers globally enabled for alternates; the current parent passes this gate dynamically. */
  enabledProviders: string[];
  /** Per-agent provider/model access rules. */
  agentAccess: Record<string, AgentModelAccess>;
}
```

provider grant 的空对象代表所有当前可用模型, 非空 models 数组代表精确 ID. 空/非法数组在 [配置入口](2026-09-10-configuration-ownership-and-persistence.md) 删除 grant, 不能变成全模型. 暂时失去 credentials/availability/scope 不删除规则. Clean unavailable 仅在 provider 存在、registry 可靠时依据完整 catalogue 清理精确缺失 ID, 不用 getAvailable 的临时缺失推断删除.

显式模型解析只做精确匹配. canonical provider/id 使用 registry.find; bare id 优先父 provider, 否则取 catalogue 中第一个精确匹配. 不做模糊匹配; 包含冒号的显式 model 被拒绝, thinking 是独立参数. 未找到或拒绝时工具抛明确错误, 不替换为父模型. bare-id 跨 provider 歧义是现有兼容语义, 不应被文档描述成全局唯一.

[thinking-resolver](../../../../src/models/thinking-resolver.ts) 的次序是工具参数 > agent frontmatter > scope pin > 全局 defaultThinking > 父 thinking. 前两项是显式意图, 不支持的 level 抛错, 非 reasoning 模型仅允许显式 off. 后三项按继承处理: 非 reasoning 返回 undefined, reasoning 模型保留受支持值, 否则采用 supported levels 的最后一项. 这不是一律钳制为 off, 也不是数值上最邻近的低等级. enum/模型能力来自 Pi, 接受时固定于 [执行快照](2026-09-10-isolated-child-resources-and-tool-gates.md).

## Alternatives considered

- **保留自动模型分配和 session override 优先链.** 用户可给不同 Agent 预设模型, 但省略 model 不再明确继承父模型, 授权和选择耦合. 当前要求备选由工具显式选择.
- **显式模型失败时回退父模型.** 提高完成概率, 但掩盖权限/配置错误并改变用户选定能力与成本. 当前保留失败.
- **对所有 thinking 请求统一 clamp.** 容易避免 API 不支持值, 但会改写调用者明确意图. 显式验证与继承适配分开.
- **provider 不可用就删除规则, 或空列表当 all.** 设置表面更少, 但临时离线可造成持久丢失, 编辑失误可扩大授权. 休眠与严格空列表语义保留两种不同事实.
- **每个 Agent 配置 Parent access 和 Thinking allowlist.** 未合入 `cd5b143` 提供更细的权限产品, 但改变父模型隐式授权和已有 thinking precedence. 这是独立行为决定, 不是对当前代码的无行为重构.

## Consequences

future calls 使用当前授权, running/queued 使用接受时快照. authorization 不是模型安装、认证刷新或 provider fallback. 主模型缺失时省略 model 失败, 显式授权备选仍可运行. 空白/纯 thinking 结果的重试属于 [runner 终态](../bug-fix/2026-09-10-assistant-outcomes-retries-and-turn-budgets.md), 不混入路由职责.

## Evidence

`c54b131` 记录精确显式模型拒绝及自由 thinking/model:thinking 的旧调用契约. `19a4e34`, `6d8dad1`, `62a6c96` 记录 Explore 父模型继承与从自建 scope 到 Pi 原生 snapshot 的演进. `02a536c`, `5b71727`, `aa5e867` 记录 assignment 与 access 分离. `b086a53`, `4b43733`, `6e6b1b5`, `fe27759` 记录 availability、休眠和精确备选引导. `e526f02` 确立显式/继承 thinking 的区别, 当前不保留自由字符串后缀. 未合入的 `cd5b143` 仅作为替代产品方案依据.

## Verification

[model access](../../../../test/unit/models/model-access.test.ts)、[scope](../../../../test/unit/models/model-scope.test.ts)、[thinking](../../../../test/unit/models/thinking-resolver.test.ts)、[tool execution](../../../../test/scenarios/runtime.test.ts)、[model routing menu](../../../../test/unit/ui/menu/menu-model-routing.test.ts) 和 [queued invocation](../../../../test/scenarios/runtime.test.ts) 验证授权、可用目录、显式拒绝和快照.
