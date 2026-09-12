# Agent Note: 原生执行驱动与父会话交付适配

Status: implemented

## Problem

原生 Harness 管理子任务的 operation、队列和恢复, 官方 coding-agent 的父会话仍由 AgentSession 管理. 两个 Session 没有共同事务, 子 operation 完成不能证明父会话收到结果. 父分支导航、人工接管、观察取消和文件写入失败也不能由树拓扑自动处理.

[领域边界](2026-09-11-task-policy-and-quota-domain.md) 已区分任务、操作、控制权和准入. 执行与父交付需要可独立替换的能力接口, 并在未经修改的官方 Pi 上形成可运行闭环.

## Decision

[TaskEngine](../../../../src/engine/task-engine.ts) 通过 [ExecutionDriver / DeliveryChannel](../../../../src/engine/contracts.ts) 组合领域策略、原生执行和父接收. 模块通过构造器传参. 实现以 pi-agent-core 和 coding-agent 0.85.1 的公开入口为依据, core 是生产 peer dependency.

```ts type-equiv: ExecutionDriver from src/engine/contracts.ts
export interface ExecutionDriver {
  readonly store: TaskStore;
  accept(input: TaskInput): Promise<string>;
  drive(operationId: string): Promise<DriveResult>;
  requestAbort(operationId: string, stoppedBy?: "user" | "agent"): Promise<void>;
  queue(kind: "steer" | "followUp", input: TaskInput): Promise<string>;
  cancelQueued(entryId: string): Promise<"cancelled" | "already_consumed" | "not_found">;
  snapshot(): Promise<ExecutionSnapshot>;
  observe(listener: () => void): Promise<() => void>;
  close(): Promise<void>;
}
```

```ts type-equiv: DeliveryChannel from src/engine/contracts.ts
export interface DeliveryChannel {
  deliver(delivery: TaskDelivery, eligible: () => boolean): Promise<DeliveryAttempt>;
}
```

[ExtensionRuntime](2026-09-12-explicit-runtime-and-native-task-ownership.md) 将这些能力接入正式 Agent 工具、事件和设置入口. Navigator 通过 [只读 Source 与 Action](2026-09-11-declarative-navigation-and-input-actions.md) 接收 TaskEngine 的展示投影. 原生 task binding、operation 与 outbox 是任务发现和恢复的来源.

## Native execution ownership

[HarnessDriver](../../../../src/drivers/harness-driver.ts) 拥有传入的原生 Session、Harness、具名 Lane 和工作目录对应的 NodeExecutionEnv. 每个任务使用独立 Harness, 因工具实现、resources 和 hooks 在上游是 Harness 级配置. 这种作用域允许两个 Agent 使用同名但不同实现的工具或不同 cwd, 无需在共享工具注册表中反查当前任务. 父会话不归 Driver 所有.

模型身份、thinking、工具白名单、system prompt 与预算来自已接受策略. Driver 为模型建立一次局部请求视图, 固定 getModel 结果并传递 maxTokens; 其他 Models 方法绑定回原对象, 同时支持公开的 ModelRuntime 类实例. 宿主目录和模型对象不被修改. 默认原生 read/bash/edit/write 使用任务自己的 ExecutionEnv; 调用方可提供已解析的原生工具和资源. 任意 coding-agent 扩展工厂不自动获得 Harness hook 语义.

accept 只持久接受 prompt, drive 才执行. TaskEngine 在双层 Quota 准入后驱动, 同一次占用只释放一次. wait 的 signal 仅结束观察. 原生 drive 的真实 Promise 返回之后才释放占用, 包括已持久保存的 waiting; waiting 可由显式 resume 重新准入. restore 读取原生状态, 不自动启动模型请求. 已结算任务通过 continue 创建新 operation; 先预留配额, 无容量返回 QuotaUnavailable, 保留旧 operation 和结果.

requestAbort 先提交原生取消请求, 再更新领域投影. 未获准入的取消通过已封闭 effect gate 的原生 reconciliation 结算, 不占用 provider slot. close 在调用宿主关闭和工具取消回调前登记共享 Promise, 先封闭 Harness, 保留 Driver 所有的 Session writer 供子扩展 shutdown 保存状态, 等待已接纳的 drive/工具返回后关闭 Session 并释放环境; 它不伪造 terminal result. 不响应取消的第三方工具会延长关闭等待. 关闭后的未知工具效果由原生 replay 策略裁决, replay=never 不重放.

运行中 steer/followUp 与等待准入时的输入使用原生队列. 撤回直接返回 cancelled/already_consumed/not_found. 已结算 Lane 的未消费输入仍可查询, 不隐式发起下一次 operation. Takeover 独立持久保存 manual 控制模式并解除前台等待, 不执行 abort. 前台任务的普通 Steer 不建立后台交付.

turn_end 的预算计数是可从当前 operation 的 transcript 重建的投影. 软限制追加原生 Steer, 硬限制在下一次请求前提交 abort. 事件回调不等待另一条会产生事件的 Lane 写操作, 避免上游串行事件总线重入死锁. Driver 把原生 OperationResultRecord 的 fromTipId/tipId 范围内最终 assistant 正文投影成结果, 不从前一个 operation 借用输出, 不追加另一种完成标记.

## Application data and delivery identity

[NativeTaskStore](../../../../src/drivers/native-task-store.ts) 使用原生 Session values 的 subagents-lite.v3 namespace 保存 task binding、控制权和 outbox. 这些值不进入对话树. 持久读取校验当前结构、父会话身份与任务归属; 内部已建立类型的调用不执行全量 schema 克隆.

```ts type-equiv: TaskDelivery from src/engine/contracts.ts
export interface TaskDelivery {
  readonly deliveryId: string;
  readonly taskId: string;
  readonly operationId: string;
  readonly parent: ParentOrigin;
  readonly kind: "automatic" | "selection";
  readonly status: TaskOutcome["status"];
  readonly text: string;
  readonly sourceEntryIds: readonly string[];
  readonly createdAt: number;
}
```

自动 deliveryId 由 taskId 和 terminal operationId 稳定构成. 重复保存使用原生 mutation barrier 判重, 相同 ID 不允许覆盖不同正文. 人工选择具有新 UUID, 保存调用方选定的现有消息文本、entryId、operation、状态和时间, 不重新读取更新中的 transcript. 选择器可在尝试保存前保留该身份, 应对提交成功但响应丢失. 完整正文存入 outbox 和父消息, receipt 保存真实父 Entry ID. deliverSelection 返回表示 outbox 已保存, 后续父交付失败不抹掉该事实.

TaskEngine 在发布 terminal 领域状态前保存自动 outbox. 结果写入失败时, 原生 terminal record 仍可重开读取并重建交付. 父接收后子侧 ACK 写入失败时, outbox 仍未确认, 重试查询既有父 receipt 而不再次发送正文. native Session 关闭重开后保留任务、队列、各 operation 的结果及独立交付身份.

## Parent write boundary

[PiDeliveryChannel](../../../../src/drivers/pi-delivery-channel.ts) 通过注入的 ExtensionAPI 与 ExtensionContext 接入父会话. 它捕获父 Session ID 和文件路径, 在最终写入前检查当前目标、自动交付的来源祖先及控制权. 来源使用官方 getBranch 查询, 没有长期 activeBranchIds 缓存.

0.85.1 的公开 API 不能按 deliveryId 撤回父自定义消息. 因此结果正文保持在子 outbox, 父忙碌时返回 pending. 父空闲时, Adapter 同步检查资格、检查重复、调用 sendMessage(triggerTurn=false) 立即追加正文, 再核验磁盘 receipt. 这段写边界没有 await, 不把结果正文交给无法撤回的父 followUp 队列. completion 和父生命周期事件驱动 flush, 没有对账 timer.

父 receipt 通过官方 parseSessionEntries 读取实际文件, 验证 header、完整记录、deliveryId、taskId、operationId 和正文. 文件检查属于当前父宿主的 Adapter, 不使用子 Session 的 single writer 宣称跨 Session 原子性. getEntries 中存在但磁盘缺失的 receipt 导致明确错误并保留 outbox; 在该活体父会话重发可能重复上下文, 因此需要父会话从实际文件重开后再重试. 当前 Pi append 没有额外 fsync 保证.

接收正文后发送独立、无结果正文的隐藏 wake. 已有持久 wake 标记阻止恢复后的重复唤醒. 父模型失败不撤销已落盘 receipt. wake 的实际异步失败由宿主报告, 不能据 sendMessage 返回推断父推理成功. 父 receipt 的确认含义仍是“上下文已持久接收”, 不是模型已完成处理. 跨进程并发运行两个父 Session 写入器不属于这个同进程 Adapter 的保证.

AgentStatus 返回的正文与 delivery 元数据在父日志中匹配后也形成 receipt. 该路径不发送第二条结果消息或 wake. 人工选择的父消息标为 selected messages, 表示所选文本而非整项任务已经完成.

## Alternatives considered

- **继续只用 AgentSession runner 与父 inbox.** 已有丰富场景和扩展加载兼容, 改动面最小. 但原生 operation、队列和恢复仍无法成为独立执行事实来源, 不满足能力边界目标.
- **所有任务共享一个子 Harness.** 共享树和模型资源直观, 可降低实例数量. 但当前工具实现、hooks、资源和 cwd 的隔离需要再造动态分派与同名工具冲突规则. 任务级 Harness 使用上游真实作用域表达现有隔离.
- **忙碌时立即发送父 followUp.** 能在当前父轮次结束前提早交付. 但公开 API 没有按身份撤回已入队自定义消息的能力, 导航和 Takeover 无法再阻止正文消费. 保持 outbox 所有权直到空闲写边界.
- **仅凭原生完成或 sendMessage 返回确认交付.** 代码最少, 但实际父日志可写入失败, 或仅接受了延迟消息. 用可核验 receipt 确认, 执行成功与交付失败分开.
- **复制父会话或修改宿主获得原生父 Lane.** 同树和单事务具有更强结构保证. 但扩展必须在未经修改的官方宿主中运行, 当前使用独立内部 Adapter 表达其真实边界.

## Consequences

执行、准入和父接收可单独替换并用真实离线 Provider 验证. 源码不需要同进程 DTO 深克隆或 RPC 层. 占用、取消、持久状态与显示状态具有不同责任.

每个任务具有独立原生 Session, Runtime 管理仓库发现、模型授权和资源准备. PiResources 把官方 Pi 工具和关键扩展 hook 接到原生 Harness. 父文件 receipt 校验是交付边界上的同步读取, 成本随父日志增长. v3 配置和任务数据由激活实例管理.

## Verification

[Execution adapter scenarios](../../../../test/scenarios/agents/execution-adapters.test.ts) 覆盖 Quota 与观察取消、队列和预算映射、显式 Takeover、选择快照、文件重开、operation 结果边界、关闭时的活体工具和不安全重放.

[Parent delivery scenarios](../../../../test/scenarios/spawn/delivery-channel.test.ts) 使用官方扩展工厂、AgentSession、ModelRuntime 和真实文件, 覆盖父工具派发、子执行、父空闲接收、父错误后的 ACK、丢失响应/确认、导航/接管竞争及父 append 只更新内存的失败边界. 这些场景不验证物理终端或在线 Provider.
