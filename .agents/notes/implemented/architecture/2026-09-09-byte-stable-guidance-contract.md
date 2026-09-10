# Agent Note: 确定性 Guidance 与可调用模型集合

Status: implemented

## Problem

同一有效授权集合因插入顺序不同而输出不同文本, 会造成不必要的 prompt 前缀变化. 用 provider 通配符替代实际 model id, 又让调用方缺少可用的精确参数. 目录、availability 和权限必须由同一规则计算.

## Decision

[buildCurrentAgentGuidance](../../../../src/prompt/agent-guidance.ts) 对 Agent canonical names 使用 code-unit 顺序, 对工具名和可用 alternate keys 排序, 模型 key 去重. 输入按约定具有唯一 Agent 名; 相同有效数据的顺序变化不应改变输出, 不把 JavaScript 对象遍历描述成随机行为.

```ts type-equiv: AgentGuidanceOptions from src/prompt/agent-guidance.ts
export interface AgentGuidanceOptions {
  agents: readonly GuidanceAgent[];
  parentModelKey: string;
  routing: Readonly<ModelRoutingConfig>;
  availableKeys: ReadonlySet<string>;
  scopedKeys: ReadonlySet<string> | null;
}
```

固定规则说明 fresh conversation、后台结果自动报告和不轮询、error 后不擅自派发替代任务、worktree_path 约束、精确父模型默认值和显式拒绝. alternate keys 使用 [model access](2026-09-09-model-routing-and-access-policy.md) 的同一交集计算, 排除精确父模型、不可用/未授权/超 scope 项. all-model grant 仍展开实际 provider/model keys, 不输出 wildcard.

Agent 无规则时只展示父模型默认能力. 无父模型时明确省略 model 无法启动, 授权的显式备选仍可列出. routing OFF 时不列 alternate. 这份 guidance 只使用内存输入, 不承担 registry discovery、文件读取或 tool schema 注册.

## Alternatives considered

- **保持 Map/Object 的构造顺序.** JavaScript 顺序本身有定义, 但语义等价的输入可按不同顺序构造. 显式排序表达“集合相同则文本相同”的需求.
- **输出 provider wildcard.** 文本更短, 但无法告诉模型实际 ID, 也不能准确传达当前 availability/scope 交集.
- **独立实现一套用于展示的权限规则.** UI 文本容易定制, 但显示和执行可能分歧. 共享 effectiveAlternateModelKeys 避免这种重复政策.

## Consequences

保持有效状态不变时, guidance 文本稳定. 状态变化仍会改变后缀, provider 缓存策略及命中率不由扩展保证. 具体模型/Agent 描述仍是输入数据, 字节稳定不等同内容可信或模型不会构造错误参数. [动态注入](2026-09-09-dynamic-guidance-injection.md) 负责时机.

## Evidence

`aa5e867`, `fe27759` 记录 access 规则和精确候选枚举; `19ed1dd` 加入错误终态/禁止自行替代的说明. `a169de6` 给此稳定输出契约独立事实宿主. 未合入的 `06152cf`, `ca6d77d` 进一步抽出 prompt capability, 但无需依赖那次全量重构来维护当前排序和共享授权.

## Verification

[guidance tests](../../../../test/unit/prompt/agent-guidance.test.ts) 检查 Agent 顺序、稳定输出、精确模型、scope 和父 provider gate; [model access tests](../../../../test/unit/models/model-access.test.ts) 检查真实授权交集. type-equiv 对照当前公开 options, 不人为镜像整个字符串实现.
