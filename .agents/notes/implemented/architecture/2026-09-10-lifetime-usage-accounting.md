# Agent Note: 跨压缩与继续执行的用量累计

Status: implemented

## Problem

从当前 session.messages 求和会在 compaction 后丢失历史用量, 而把 cacheRead 当新输入累加会把重复使用的长前缀反复计入. 人工继续或 late shutdown callback 又可能让 UI 统计与执行状态脱节.

## Decision

[HarnessDriver](../../../../src/drivers/harness-driver.ts) 从原生 Session 的 usage 读取累计 input、output 和 cost, 原生统计在 compaction 与继续执行后保留. 不用 token 数估算金额, 也不重复累计已写入的原生 usage. Provider 的 cacheRead 不计入新增输入, cacheWrite 仍保存在原生 usage 中.

```ts type-equiv: LifetimeUsage from src/agents/usage.ts
export type LifetimeUsage = { input: number; output: number; cacheWrite: number; cost: number };
```

toolUses 按原生分支中的工具结果计数, turnCount 表示当前 operation 的有效 assistant 回合, compactionCount 来自 compaction entries. contextPercent 使用最近一次压缩之后的原生 assistant usage 与该 Lane 模型的 contextWindow; 尚无有效 usage 时为 null. [TaskNavigationSource](../../../../src/ui/task-source.ts) 投影这些值, View 仅读取缓存并按设置显示.

统计与任务一起持久保留, UI 隐藏不清除原生 usage. 当前没有跨所有子任务的父级总费用计数器. 显示开关、预算颜色和折行仅影响展示, 不改变 TaskEngine 或 Driver 的执行预算.

## Alternatives considered

- **每次渲染从 session messages 或 getSessionStats 重算总量.** 无需持久 accumulator, 但 compaction 改写消息集合, 渲染成本也随历史增长. 原生 Session 负责累计, 当前 context 与 lifetime 明确分开.
- **把 cacheRead 也算作新输入.** 适合衡量服务端 token 吞吐, 但不是本 UI 的累计口径, 反复前缀容易被理解为反复新增工作.
- **为不报告 cache 的 provider 计算相邻 input delta.** `0bfa330`, `1dbdc64`, `6194481` 给出该历史选择, 对逐渐增长的 vLLM 上下文有意义; compaction、重试和 provider 定义差异使 delta 不等同真实计费输入. 当前保留 provider 原始 input.
- **保留父会话 lifetime cost archive.** 删除子记录后仍能看总成本, 但需正确处理 clear 后迟到 usage, 否则重复计算. 当前单一列表不提供这个已裁撤的统计面.

## Consequences

统计跨 compaction 和人工继续保留, 但只覆盖宿主实际报告的事件; 缺 usage 时不会补算. 记录删除后的财务审计不在此 accumulator 的保证内. 若新增跨记录费用汇总, 必须重新明确 late usage 归属和 provider 输入口径.

## Evidence

- `66256e5`, `8a0ce8d`, `b1f8ad6`: 父级 cost archive 的旧实现及 Clear 后去重/迟到费用教训.
- `81c1973`, `62a6c96`: cacheRead 与新输入的区别、tool/compaction 原生用量事件.
- `5cc7661`, `afe0724`, `74a1042`: 重复 UI/统计表面的收敛.
- `20b1a8e`, `aa69dca`, `4e5ac95`: context 缓存与人工继续的统计刷新.
- `1a822fb`, `47f93e1`, `79ba997`, `f19e461`, `2ec7160`, `b2132af`, `5a041e0`, `3502169`: 费用开关、各项显示开关、输入/输出分列和回合预算提示.

## Verification

[usage tests](../../../../test/unit/agents/usage.test.ts)、[Runtime 场景](../../../../test/scenarios/runtime.test.ts)、[原生执行](../../../../test/scenarios/agents/execution-adapters.test.ts) 和 [format tests](../../../../test/unit/ui/format.test.ts) 覆盖累计来源与显示边界. 离线测试不代表 Provider 实际账单.
