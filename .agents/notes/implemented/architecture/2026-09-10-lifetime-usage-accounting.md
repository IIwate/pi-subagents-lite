# Agent Note: 跨压缩与继续执行的用量累计

Status: implemented

## Problem

从当前 session.messages 求和会在 compaction 后丢失历史用量, 而把 cacheRead 当新输入累加会把重复使用的长前缀反复计入. 人工继续或 late shutdown callback 又可能让 UI 统计与执行状态脱节.

## Decision

[usage](../../../../src/agents/usage.ts) 定义 record 生命周期内的累计量, [runner events](../../../../src/agents/agent-runner.ts) 从 assistant/toolResult 的 message_end 及成功、未 aborted 的 compaction_end 提取 usage. input/output/cacheWrite 累加, cost 使用宿主 usage.cost.total; 不用 token 数自行估算金额. callback 由每次 run/continue 订阅并在 finally 解除.

```ts type-equiv: LifetimeUsage from src/agents/usage.ts
export type LifetimeUsage = { input: number; output: number; cacheWrite: number; cost: number };
```

cacheRead 是此次请求重用前缀的量, 不进入这一“新处理 token”累计口径; cost 仍保留 provider 报告的全部费用. 这不是服务端总吞吐或每轮完整输入计数. 不报告 cache 的 provider 仍按其 input 字段累计, 不从相邻请求推断 delta.

Manager 的 record 在继续执行时保留 lifetimeUsage 和 toolUses, turnCount 累加本次回合数. contextPercent 从 Pi getSessionStats 获取并在进展事件中缓存, 取不到或 post-compaction 尚不可知时为 null, 不伪造 0%. 列表 render 读取缓存, 不重复扫描长历史.

当前没有跨已删除记录的父级总费用计数器. Clear/cleanup 释放记录后, 该记录统计不再出现在列表; 持久结果只保留交付元数据和正文. [展示设置](2026-09-10-configuration-ownership-and-persistence.md) 默认关闭费用显示, 不改变底层累计.

显示将 input/output 分列, 可按开关隐藏 tool/turn/token/context/cost/time. turn 接近预算的 80% 才显示上限, 达到上限使用错误色, 便于把稀缺预算与普通累计区分. 这些颜色不触发取消, 控制仍由 runner 负责.

## Alternatives considered

- **每次渲染从 session messages 或 getSessionStats 重算总量.** 无需持久 accumulator, 但 compaction 改写消息集合, 渲染成本也随历史增长. 当前用事件累计, 当前 context 与 lifetime 明确分开.
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

[usage tests](../../../../test/unit/agents/usage.test.ts)、[runner events](../../../../test/unit/agents/runner/agent-runner.events.test.ts)、[manager interaction](../../../../test/unit/agents/manager/agent-manager.interaction.test.ts) 和 [format tests](../../../../test/unit/ui/format.test.ts) 验证事件归属、累计与显示. Provider 实际账单不是这些离线测试的验证对象.
