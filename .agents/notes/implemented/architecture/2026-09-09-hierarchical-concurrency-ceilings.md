# Agent Note: Provider/Model 双重上限与继续执行调度

Status: implemented

## Problem

不同模型的本地显存占用不同, 同 provider 的模型又共享硬件或 API 配额. 单个全局任务数不能表达两层限制. Clear、父中断、queued 前台等待和人工继续在不同时间释放资源, 计数必须有明确所有者.

## Decision

[AgentManager](../../../../src/agents/agent-manager.ts) 对每次有 modelKey 的执行同时检查 model ceiling 和可选 provider ceiling. model 未单独配置时使用 default=4; 各 model 上限可以超过 provider 上限之和, 但每次 reserve 必须两层都有容量. 内部调用无 modelKey 时不参与计数; 正常 Agent 工具在进入 manager 前解析 modelKey.

```ts type-equiv: ConcurrencyConfig from src/agents/agent-manager.ts
export interface ConcurrencyConfig {
  /** Per-model ceiling used when no explicit model override exists. */
  default: number;
  /** Shared hard ceilings keyed by provider name (e.g. "llamacpp"). */
  providers?: Record<string, number>;
  /** Per-model hard ceilings keyed by "provider/modelId". */
  models?: Record<string, number>;
}
```

modelRunning/providerRunning 与可变 limits 分开. reservedModelKeys 以 agentId 记录一次 reservation, release 先删除所有权再递减两层, Clear 与迟到 finally 只能释放一次. 普通 abort 保留 slot 直到执行 Promise 结算, 防止旧 run 尚在停机就启动新 run. 显式 Clear 则立即删除记录、释放逻辑 slot 并 drain; 物理 session 关闭是异步的, 不应将该路径描述成硬件资源已同步释放.

新 Agent 无容量进入 queue. drain 按接受顺序遍历, 可跳过某 model/provider 下暂时阻塞的项, 启动其他有容量的项, 因而不是整个系统严格 head-of-line FIFO. queued foreground Promise 在开始和结算后返回, queued stop/dispose 也必须结算等待. 终态 session 的继续不排队: 无容量返回 `concurrency` 拒绝, 不改变其原执行结果; 接管/pin 由 [显式人工接管](../feature/2026-09-10-human-takeover-and-selective-delivery.md) 独立决定. [TaskEngine](2026-09-11-native-execution-and-parent-delivery-adapters.md) 在接受原生 continuation 前同样预留 Quota, 拒绝时不创建新 operation.

setConcurrency 保留运行计数并 drain, 上限调小不杀已有任务. 已接受任务的模型、thinking 和资源策略由 [调用快照](2026-09-10-isolated-child-resources-and-tool-gates.md) 固定, 不随排队期间设置改变. 上限本身仍热更新, 不是快照的一部分.

[Concurrency menu](../../../../src/ui/menu/menu-concurrency.ts) 将父模型、有效授权备选和现有 session 所用模型作为 active inventory, 不活跃的限额保留在 Saved inactive limits, 不因模型暂时不可用而删除.

## Alternatives considered

- **保留单一全局 maxConcurrent.** 调度简单, 但无法同时表达模型差异和 provider 共享硬边界.
- **让 model 配置覆盖 provider 上限.** 便于为重点模型开例外, 但会绕过 provider 共享容量. 两层独立限制更符合当前资源模型.
- **继续执行也入 queue.** 可复用新任务排队, 但用户输入会进入看不见的等待状态. 当前同步拒绝, editor 保留可重试控制.
- **所有取消都立即释放 slot.** 提高后续吞吐, 但普通 abort 的底层 run 尚未停下时会越过有效并发. 当前仅显式 Clear 使用逻辑释放, 它保留物理关闭重叠的已知代价.
- **出队重新授权.** 能立刻贯彻新规则, 却会改变等待任务的已接受策略. 当前使用快照, 即时撤销需另立产品契约.

## Consequences

计数表示 manager 接受的活跃执行, 不等同 GPU 显存监控或跨进程 API 限流. 变更上限和 Clear 需保留单次释放不变式. hand-edited 配置由 [数值入口](../bug-fix/2026-09-10-configuration-commit-and-validation.md) 归一化, 非法显式限额保留有限的保守容量; 保存成功后才同步新的上限.

## Evidence

`5411cec`, `7045b19`, `5b71727`, `87499bf` 记录前台并发、queued 模型锁定和父中断. `afe0724` 引入两层上限/继续拒绝/休眠限额. `19ed1dd` 扩展接受时策略快照; `4e5ac95` 加入 Clear 的 reservation 所有权. `5104ec3`, `3db2dfe`, `560aaad` 是未合入分支的 global/project layering 方案, 不代表主线已支持项目限额文档.

## Verification

[manager queue](../../../../test/unit/agents/manager/agent-manager.queue.test.ts)、[lifecycle](../../../../test/unit/agents/manager/agent-manager.lifecycle.test.ts)、[interaction](../../../../test/unit/agents/manager/agent-manager.interaction.test.ts)、[queued invocation scenarios](../../../../test/scenarios/agents/queued-invocation.test.ts) 和 [concurrency menu](../../../../test/unit/ui/menu/menu-concurrency.test.ts) 检查计数、单次释放、快照及活跃/休眠设置.
