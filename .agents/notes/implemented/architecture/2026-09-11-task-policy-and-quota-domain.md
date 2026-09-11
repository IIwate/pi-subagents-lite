# Agent Note: Task 状态、接受策略与执行配额的领域边界

Status: implemented

## Problem

宿主执行回调与用户控制操作有不同生命周期. 旧 operation 的迟到完成不能覆盖同一任务的新运行, 等待和取消不能等同执行结束, 一次重复释放也不能释放后续运行的额度. 模型与配置对象仍由宿主或设置界面持有, 直接保存其可变引用会让已接受策略漂移.

这些约束需要在不持有 Pi 会话、文件句柄、定时器或终端组件的情况下独立成立. [v3 能力边界](../../proposed/architecture/2026-09-10-capability-boundaries-and-explicit-runtime.md) 规定执行和父交付通过仓库内部 Adapter 接入官方宿主.

## Decision

[task](../../../../src/domain/task.ts)、[policy](../../../../src/domain/policy.ts) 和 [quota](../../../../src/domain/quota.ts) 构成内存中的领域 API. 它们仅依赖同目录的类型与函数, 不导入宿主 SDK. 当前公开 Agent 工具仍由 AgentManager 装配; 领域 API 的实现与验证不表示 v3 Driver 已接入该入口.

Task 的 taskId 在续聊期间稳定, operationId 标识一次运行. createTask 接受已解析的执行策略并建立所属快照. reduceTask 返回只读状态, 不执行 I/O 或控制 Driver.

```ts type-equiv: Task from src/domain/task.ts
export interface Task {
  readonly taskId: string;
  readonly operationId: string;
  readonly policy: TaskPolicy;
  readonly control: "autonomous" | "manual";
  readonly state: TaskState;
}
```

```ts type-equiv: TaskState from src/domain/task.ts
export type TaskState =
  | { readonly status: "queued" | "running" | "waiting" | "cancelling" }
  | { readonly status: "settled"; readonly outcome: TaskOutcome };
```

started、waiting、cancel_requested 和 settled 事件携带 operationId. 不匹配的事件及已结算 operation 的后续事件保留原对象. cancel_requested 表达 Driver 已接受的取消请求, UI 按键自身不证明取消成功. 取消期间的进度事件不恢复 running/waiting, 只有 Driver 的终态事实结束该运行. Task 不推断物理资源已经停止.

takeover 独立设置 manual, 不改变执行状态. continue 只接受 settled 状态和不同于当前值的新 operationId, 保留控制模式与同一份策略, 清除上一运行的终态. 全局唯一 operationId 由调用方/Driver 分配; Task 不保存永久的 ID 历史或原生 operation 日志.

## Accepted execution values

```ts type-equiv: TaskPolicy from src/domain/policy.ts
export interface TaskPolicy {
  readonly agent: string;
  readonly model: ModelIdentity;
  readonly thinkingLevel: TaskThinkingLevel;
  readonly tools: readonly string[];
  readonly cwd: string;
  readonly systemPrompt: string;
  readonly limits: {
    readonly maxTurns?: number;
    readonly graceTurns: number;
    readonly maxTokens?: number;
  };
}
```

TaskPolicy 保存已解析的模型身份、thinking、具体工具名、工作目录、system prompt 正文及运行限额. Catalogue、模型授权、资源加载和输入校验属于接受前的调用方. SDK 模型对象的其他字段、凭据、函数和会话句柄不进入策略.

freezePolicy 显式复制所需标量、model identity、工具数组和 limits, 并冻结自己拥有的结构. 它不克隆完整 SDK 对象或冻结调用方对象. 状态变化和续聊共享接受时的策略, 不重复复制它. 凭据和工具实现的生命周期仍属于 Adapter.

## Quota ownership

```ts type-equiv: QuotaLimits from src/domain/quota.ts
export interface QuotaLimits {
  readonly default: number;
  readonly providers?: Readonly<Record<string, number>>;
  readonly models?: Readonly<Record<string, number>>;
}
```

Quota 同时检查 canonical provider/model key 的模型上限和可选 provider 上限. 缺少模型特例时使用 default, 缺少 provider 特例时该层不设上限. 只有两层都允许才增加计数, 拒绝准入不消耗额度.

每次成功准入返回独立、幂等的 release 函数. 它捕获本次模型和 provider 身份, 不按 taskId 查找最新运行. 调用方对象改变或旧 release 再次调用, 都不会释放另一项占用. 计数属于 Quota 实例, 不跨 Runtime 或进程共享.

构造和 setLimits 在发布前检查正安全整数并复制配置条目. 无效更新不改变已有上限; 有效更新不重置运行计数, 调低上限不主动中断执行. 准入热路径不重复校验配置. Quota 不持有 Promise、执行队列或调度回调; 调用方在真实执行停止后释放, 再决定是否启动等待任务.

## Alternatives considered

- **只保留 AgentManager 内部实现.** 当前工具入口无需额外概念, 维护面最小. 但任务身份、策略所有权和配额责任继续依赖具体宿主生命周期, 无法独立验证 Adapter 接入所需的边界.
- **直接把 AgentRecord 移入领域层.** 可以复用全部显示和执行字段. 但它持有 AgentSession、AbortController 和 Promise, 无法形成无宿主依赖的 Task 契约.
- **按 taskId 统一释放配额.** 集中查表容易与 UI 列表对应. 但同一 taskId 的后续运行可能已经重新预留额度, 迟到释放必须继续额外辨别身份. 每次占用自己的 release 函数直接表达所有权.
- **通用递归克隆与深冻结所有入参.** 不需列举字段, 能覆盖任意嵌套配置. 但会遍历无关 SDK 数据, 可能遇到函数或活体资源, 并引入未定义的复制语义. 当前策略结构足以逐项建立所属值.
- **复制 Harness 的持久状态机.** 上层可以直接操作所有底层状态. 但两套执行真相需要同步与恢复, 超出领域职责. Task 仅归约 Driver 事实与业务控制.

## Consequences

任务状态与执行资源、模型 SDK 和终端展示解耦. 运行身份与配额占用的独立性可以通过纯单元测试验证. 所属策略快照不会因调用方继续编辑模型或配置而改变.

该边界不负责模型授权、Driver 事件排序、operation 持久化、消息队列消费、父交付或实际停止执行. 它也不让父 Pi 会话和扩展管理的子 Harness 自动成为同一物理 Session. 这些责任由组合根和对应 Adapter 承担. 只有新增执行能力确实需要策略字段或状态时才扩展契约.

## Verification

[Domain unit tests](../../../../test/unit/domain/task-domain.test.ts) 检查可变源对象与已接受策略隔离、人工控制与运行状态分离、迟到/重复终态、续聊身份约束、双层限额、旧 release 对新占用无效、配置更新原子性及实例隔离. 测试仅使用内存值, 不启动宿主、计时器或文件资源.
