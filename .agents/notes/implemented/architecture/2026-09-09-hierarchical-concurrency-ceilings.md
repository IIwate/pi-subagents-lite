# Agent Note: Provider/Model 双重上限与继续执行调度

Status: implemented

## Problem

不同模型的本地显存占用不同, 同 provider 的模型又共享硬件或 API 配额. 单个全局任务数不能表达两层限制. Clear、父中断、queued 前台等待和人工继续在不同时间释放资源, 计数必须有明确所有者.

## Decision

[Quota](../../../../src/domain/quota.ts) 对每次执行同时检查 model ceiling 和可选 provider ceiling. model 未单独配置时采用配置默认值 4. 两层计数与可变上限分开, 一次成功预留返回一个至多释放一次的函数; [TaskEngine](../../../../src/engine/task-engine.ts) 在真实 drive 退出之后调用它.

```ts type-equiv: QuotaLimits from src/domain/quota.ts
export interface QuotaLimits {
  readonly default: number;
  readonly providers?: Readonly<Record<string, number>>;
  readonly models?: Readonly<Record<string, number>>;
}
```

新任务无容量保持 queued. drain 按接受顺序遍历, 允许跳过暂时受限的 model/provider, 启动其他有容量的任务. 取消观察、请求停止、隐藏 UI 或关闭 Runtime 都不会提前释放尚在实际执行的占用. 已取消且尚未开始执行的 operation 可进行原生收敛, 不取得新的 provider 配额.

已结算任务继续前预留 Quota, 容量不足返回局部 concurrency 拒绝, 不创建 operation 或改变已有结果. 成功的预留随实际 drive 释放. setLimits 保留活跃计数并重新 drain; 调低上限不终止已进入执行的任务. 模型、thinking、prompt、工具和运行预算由接受时策略固定, 并发上限是独立的热更新控制.

[并发菜单](../../../../src/ui/menu/menu-concurrency.ts) 的 active inventory 包括父模型、有效授权备选和已接受任务的模型. 其他限额保留为 Saved inactive limits. 配置修改仅发布到所属 Runtime 的 TaskEngine.

## Alternatives considered

- **保留单一全局 maxConcurrent.** 调度简单, 但无法同时表达模型差异和 provider 共享硬边界.
- **让 model 配置覆盖 provider 上限.** 便于为重点模型开例外, 但会绕过 provider 共享容量. 两层独立限制更符合当前资源模型.
- **继续执行也入 queue.** 可复用新任务排队, 但用户输入会进入看不见的等待状态. 当前同步拒绝, editor 保留可重试控制.
- **所有取消都立即释放 slot.** 提高后续吞吐, 但普通 abort 的底层 run 尚未停下时会越过有效并发. 因此停止与释放保持不同边界, 只有真实 drive 退出才释放占用.
- **出队重新授权.** 能立刻贯彻新规则, 却会改变等待任务的已接受策略. 当前使用快照, 即时撤销需另立产品契约.

## Consequences

配额是 Runtime 内的执行准入, 不代表 GPU 显存测量或跨进程限流. 持久化配置要求正安全整数, 菜单修改和保存失败边界由 [配置提交](../bug-fix/2026-09-10-configuration-commit-and-validation.md) 管理.

## Verification

[Domain checks](../../../../test/unit/domain/task-domain.test.ts)、[原生执行场景](../../../../test/scenarios/agents/execution-adapters.test.ts)、[Runtime 场景](../../../../test/scenarios/runtime.test.ts) 和 [菜单](../../../../test/unit/ui/menu/menu-concurrency.test.ts) 覆盖双层上限、真实占用、继续拒绝、接受时快照及实例隔离.
