# Agent Note: 分层 Provider 与 Model 并发硬上限及双轨调度控制

Status: implemented

## Problem

在子代理（Subagent）执行系统中，不同大模型在资源消耗与调用配额上存在本质差异：
1. **显存消耗悬殊**：在本地端侧推理引擎（如 llama.cpp、Ollama、vLLM）中，轻量模型（如 4B）可同时运行多个实例，而重型模型（如 27B+）仅能容纳单实例并发；
2. **Provider 级别的硬件/API 硬边界**：无论是本地单卡的总体可用显存，还是商用云端 Provider 的组织级 API 速率限制（Rate Limits），都存在超越单模型的全局共享上限；
3. **排队期间的配置漂移（Configuration Drift in Queue）**：当子代理因并发达到上限而进入排队（`queued`）状态时，排队时长不可预测。若在等待期间用户修改了模型路由规则、禁用了某个 Provider、或切换了父模型与全局思考等级，如果在出队时动态重算执行策略，会导致原本合法的任务在出队时意外崩溃、被静默降级或使用了非预期模型；
4. **前台任务排队与中断时的配额泄漏风险**：前台发起的子代理同样可能命中并发限制。在等待出队期间，用户随时可能按下 `Escape` 或终止父回合，若缺乏确定性的取消清理与配额释放机制，极易引发前台等待死锁或并发配额（Concurrency slot）永久泄漏。

## Decision

系统在 `AgentManager`（`src/agents/agent-manager.ts`）中建立分层的并发配额管理、入队快照锁死与双轨调度控制机制：

1. **分层双重独立硬上限**：
   每次任务启动必须**同时满足** Model 上限与 Provider 上限：
   - **Model 层级**：优先读取显式配置的 `provider/modelId` 上限；未显式配置时读取全局默认缺省值（`default: 4`）；
   - **Provider 层级**：针对该 Provider 下所有模型的共享硬上限（可选）；
   - 各 Model 上限之和允许大于 Provider 上限，以支持空闲配额借调（例如 Provider 限额 4，Model A 限额 4，Model B 限额 4，两者并发总和不超过 4）。

2. **原子化预留与单次释放保证（Atomic Reserve & Single-release Safety）**：
   - `reserveConcurrency`：只有当两个层级均具备余量时，才原子性递增 `modelRunning` 与 `providerRunning` 计数；
   - `releaseConcurrency`：任务结束、中止或显式移除时同步递减计数，并在归零时移除对应 Key，杜绝内存泄漏；
   - 针对取消、中断和重试分支提供**单次释放防御保证（Single-release Guarantee）**，防止同一 slot 被重复扣减导致计数器破零穿透。

3. **入队不可变快照锁死（Immutable Invocation Snapshot at Enqueue）**：
   - 当任务命中上限被设为 `queued` 并压入队列时，系统将其解析后的 `model`、`thinkingLevel`、`registeredTools`、系统提示词模式及资源加载器配置执行深拷贝固化在 `record.display.invocation` 中；
   - 出队启动时严格沿用入队时刻的快照凭证，完全免疫排队期间外部路由配置的修改、Provider 的禁用或父会话模型的切换，保证执行因果的一致性。

4. **前台排队调度与父轮次中断联动（Foreground Queuing & Abort Handling）**：
   - 前台任务（`run_in_background: false`）命中并发上限时进入队列，返回给主会话的 Promise 保持阻塞等待直到真正执行完毕；
   - 若在排队期间父轮次被中断（如用户按 Escape），系统同步触发取消，干净地将该任务从排队队列中弹出，并立即释放关联的并发与调度资源，释放主会话。

5. **双轨调度控制契约**：
   - **新建 Agent（`spawn`）**：命中任一上限时，状态设为 `queued`，压入 FIFO 队列，等待前序任务结束或配额放宽后自动启动；
   - **已结束会话继续交互（`interact` continuation）**：**严禁排队**。命中上限时立即返回同步拒绝 `{ accepted: false, reason: "concurrency", modelKey }`，前端编辑器完整保留用户输入，并在状态栏提示 `Blocked: <key> concurrency limit reached`，确保用户拥有重试的主动控制权。

6. **计数与配置解耦及热更新清空（Drain on Reconfig）**：
   - 实时运行计数（`modelRunning`、`providerRunning`）与可变上限字典完全解耦；
   - 当通过 `setConcurrency` 热更新上限时，完整保留正在运行的任务计数，并立即触发 `drainQueue()`，自动启动因上限放宽而具备容量的排队任务。

7. **活跃库存过滤与休眠保留（Active Inventory & Dormant Retention）**：
   - 菜单界面（`src/ui/menu/menu-concurrency.ts`）仅展示当前活跃项（父模型 + 当前授权备选模型 + 既有子会话所用模型）；
   - 不相关的历史限额配置安全归入 **Saved inactive limits** 休眠，绝不破坏性清空，当对应模型重新上线或被新会话引用时自动重新激活。

核心配置契约定义如下：

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

## Alternatives considered

- **出队时动态重算权限与模型配置（Re-resolve on Dequeue）** — 该方案的最强论据是能够确保任务始终按“最新”的管理规则运行。但排队时长不可控，若排队期间管理员调整了路由或禁用了 Provider，会导致已排队数分钟的任务在出队瞬间突然报错，或者模型行为发生意想不到的漂移，严重违背调用因果律。入队锁定快照是唯一的确定性解。
- **全局单一 `maxConcurrent` 线程池** — 实现最简单，但无法区分大模型与小模型的显存差异，极易造成小模型被大模型挤占或大模型并发引发硬件 OOM。
- **优先级覆盖链（Model 上限覆盖 Provider 上限）** — 虽然能够为特定重点模型开绿灯，但彻底瓦解了 Provider 共享硬件与 API 速率的保护屏障，使系统面临硬件崩溃风险。
- **对继续交互（Continuation）同样实施异步入队排队** — 形式上实现了调度的统一，但会导致用户在界面上发送消息后毫无动静，形成不可见的隐式等待死锁，严重损害人机交互的即时反馈。

## Consequences

- **收益**：彻底杜绝了本地多模型并发造成的 GPU 显存 OOM 与云端 Provider API 超频；通过入队快照锁死消除了排队期间配置漂移的隐患；前台排队与中断处理杜绝了死锁与配额泄漏；休眠机制避免了配置意外丢失。
- **代价与已知上限**：排队中的任务仍需持有轻量级的深拷贝快照数据；基于 FIFO 的出队调度在共享 Provider 配额极紧时可能导致轻量任务在队尾等待重型任务执行结束。

## Verification

- 并发双上限判定、排队流转与锁死快照逻辑经单测与集成测试持续覆盖：`test/agents/manager/agent-manager.queue.test.ts` 与 `test/agents/queued-model-permission.integration.test.ts`。
- 活跃模型库存计算与休眠配额隔离逻辑经单测持续覆盖：`test/ui/menu/menu-concurrency.test.ts`。
- 契约结构体与源码 AST 100% 同步，由 `npm run verify-type-equiv` 自动门禁校验。
