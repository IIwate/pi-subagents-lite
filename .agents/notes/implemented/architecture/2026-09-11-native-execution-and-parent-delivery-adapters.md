# Agent Note: 原生执行驱动与父会话交付适配

Status: implemented

## Problem

pi-durable Harness 管理子任务的 Submission、工具任务和恢复, 官方 coding-agent 的父会话仍由 AgentSession 管理. 两个 Session 没有共同事务, 子 operation 完成不能证明父会话收到结果. 父分支导航、人工接管、观察取消和文件写入失败也不能由树拓扑自动处理.

[领域边界](2026-09-11-task-policy-and-quota-domain.md) 已区分任务、操作、控制权和准入. 执行与父交付需要可独立替换的能力接口, 并在未经修改的官方 Pi 上形成可运行闭环.

## Decision

[TaskEngine](../../../../src/engine/task-engine.ts) 通过 [ExecutionDriver / DeliveryChannel](../../../../src/engine/contracts.ts) 组合领域策略、原生执行和父接收. 模块通过构造器传参. 父会话使用 coding-agent 1.0 的公开入口, 子执行直接依赖 pi-durable 1.0; 依赖图由 Bun lockfile 固定.

```ts type-equiv: ExecutionDriver from src/engine/contracts.ts
export interface ExecutionDriver {
  readonly store: TaskStore;
  accept(input: TaskInput, requestId?: string): Promise<string>;
  drive(operationId: string): Promise<DriveResult>;
  requestAbort(operationId: string, stoppedBy?: "user" | "agent"): Promise<void>;
  queue(kind: "steer" | "followUp", input: TaskInput, requestId?: string): Promise<string>;
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

[ExtensionRuntime](2026-09-12-explicit-runtime-and-native-task-ownership.md) 将这些能力接入正式 Agent 工具、事件和设置入口. Navigator 通过 [只读 Source 与 Action](2026-09-11-declarative-navigation-and-input-actions.md) 接收 TaskEngine 的展示投影. SQLite 中的 task binding、接受请求、原生 Submission 与交付 document 是任务发现和恢复的来源.

Pi 1.0 的执行底座与格式选择由 [durable 执行层 Note](2026-10-02-pi-1-0-execution-layer-migration-to-pi-durable.md) 持有; 本文维护运行与父接收职责.

## Native execution ownership

[DurableDriver](../../../../src/drivers/durable-driver.ts) 为每个子代理拥有独立 Harness、SQLite Storage、root Conversation 与 NodeExecutionEnv. 父 Pi 会话不属于该 Harness. 独立调度器允许每个任务在获得 Model/Provider 租约后才启用执行, 不需要在共享调度器上建立逐会话暂停机制. root 就是工作会话, 不为单一工作会话添加没有额外职责的 Anchor.

模型身份、thinking、工具授权、system prompt、cwd 与预算来自接受时策略. Registry 的扩展包含原生工具声明和请求钩子; PiResources 将官方 Pi 工具和子扩展接到该实例. GenerationTask 与 ToolTask 拥有实际执行与恢复, 不另造执行循环. Models 局部视图检查模型身份、maxTokens、Provider headers/payload hooks 和请求闲置保护. UsageDoc 提供跨压缩保留的累计统计.

accept 在会话级 TaskDocument 中保存操作身份、输入与来源边界, 不启动调度. drive 在配额准入后调用 submit, 使用 operationId 作为 requestId. 执行前已接受的排队输入并入首个请求, 原生 passive write 记录其消费身份; 运行中的 steer/followUp 使用原生 inbox. 重开复用 requestId, 不因应用确认丢失重复提交. 驱动等待该会话真正 idle 后释放占用; 观察取消只结束观察, 不结束实际执行.

原生 Submission 结算与应用结果投影分开. NativeTaskStore 从本 operation 的原生 Entry 区间重建结果; 结果投影落盘失败时原生答案仍可在纯 Session 上读取, 不要求扩展或模型可用. 继续执行建立新的 operationId, 不借用前次正文. user stop 与自动交付撤销在同一次 document commit 中记录. 取消入口等待取消标记被接纳, 不等待不响应取消的工具返回; drive 继续拥有其资源与配额直到实际退出.

取消前将已观察到的模型 partial 保存到 LiveDoc, 由内核生成 aborted assistant entry, 避免节流窗口内的输出丢失. 接管持久改为 manual, 不触发 abort; 后续输出只能显式选择. 用户停止晚于原生完成时保留完成事实并更新 stopRequestedBy, 阻止自动交付.

Conversation.watch 提供原生快照与变更通知, TaskDocument watch 提供接受状态与交付变化. snapshot 将原生条目、LiveDoc、inbox 和 UsageDoc 映射成既有导航契约; UI 保持 displayText 和光标所有权规则.

关闭先封闭 Driver 效果入口并取消自有模型流, 关闭 PiResources 的工具与 shutdown 状态写入, 再关闭 Harness/Storage 并等待 drive 与排队工作结束, 最后释放环境. 共用关闭 Promise 在可重入操作前登记. 不响应取消的第三方工具仍会延长关闭, 不提前释放配额或伪造完成结果.

## Application data and delivery identity

[NativeTaskStore](../../../../src/drivers/native-task-store.ts) 使用 session-scoped TaskDocument 保存 task binding、接受请求、控制权和 outbox. 这些值不进入对话树. 持久读取校验当前结构、父会话身份与任务归属; 内部已建立类型的调用不执行全量 schema 克隆.

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

自动 deliveryId 由 taskId 和 terminal operationId 稳定构成. 重复保存使用原生 document commit 判重, 相同 ID 不允许覆盖不同正文. 人工选择具有新 UUID, 保存调用方选定的现有消息文本、entryId、operation、状态和时间, 不重新读取更新中的 transcript. 选择器可在尝试保存前保留该身份, 应对提交成功但响应丢失. 完整正文存入 outbox 和父消息, receipt 保存真实父 Entry ID. deliverSelection 返回表示 outbox 已保存, 后续父交付失败不抹掉该事实.

自动 outbox 要求后台模式、自主控制且该 operation 没有用户停止意图, 写入发生在发布 terminal 领域状态前. NativeTaskStore.saveDelivery 在原生 document commit 内检查持久 control、stop、后台模式和已结算 operation 身份, 不接收父端闭包. Takeover 的存储接受点是 manual 提交; 父 TaskEngine 在请求开始时即抑制最终父写入, 持久化失败明确报错并封闭交付. 用户 stop 与撤销同一 operation 尚未确认的自动 outbox 共用一次原生提交. 已确认 receipt 与子会话正文保留. stop 发起者中的 user 不被随后的 agent 停止覆盖; 选择性交付不受自动交付门禁影响.

恢复读取原有 stop values, 不改写控制模式或伪造运行终态. 用户停止的已结算 operation 可以通过 Alt+S 选择已有片段; 当前 operation 变更后, 旧停止事实不授予新运行选择资格或阻止其自动交付. 结果写入失败时, 原生 terminal record 仍可重开读取并按资格重建交付. 停止持久化失败明确报告并阻止该活体记录继续交付. 父接收后子侧 ACK 写入失败时, outbox 仍未确认, 重试查询既有父 receipt 而不再次发送正文. native Session 关闭重开后保留任务、队列、各 operation 的结果及独立交付身份.

## Parent write boundary

[PiDeliveryChannel](../../../../src/drivers/pi-delivery-channel.ts) 通过注入的 ExtensionAPI 与 ExtensionContext 接入父会话. 它捕获父 Session ID 和文件路径, 在最终写入前检查当前目标、自动交付的来源祖先及控制权. 来源使用官方 getBranch 查询, 没有长期 activeBranchIds 缓存.

Pi 1.0 的公开 API 不能按 deliveryId 撤回父自定义消息. 因此结果正文保持在子 outbox, 父忙碌时返回 pending. 父空闲时, Adapter 同步检查资格、检查重复、调用 sendMessage(triggerTurn=false) 立即追加正文, 再核验磁盘 receipt. 这段写边界没有 await, 不把结果正文交给无法撤回的父 followUp 队列. completion 和父生命周期事件驱动 flush, 没有对账 timer.

父 receipt 通过官方 parseSessionEntries 读取实际文件, 验证 header、完整记录、deliveryId、taskId、operationId 和正文. 文件检查属于当前父宿主的 Adapter, 不使用子 Session 的 single writer 宣称跨 Session 原子性. getEntries 中存在但磁盘缺失的 receipt 导致明确错误并保留 outbox; 在该活体父会话重发可能重复上下文, 因此需要父会话从实际文件重开后再重试. 当前 Pi append 没有额外 fsync 保证.

接收正文后发送独立、无结果正文的隐藏 wake. 已有持久 wake 标记阻止恢复后的重复唤醒. 父模型失败不撤销已落盘 receipt. wake 的实际异步失败由宿主报告, 不能据 sendMessage 返回推断父推理成功. 父 receipt 的确认含义仍是“上下文已持久接收”, 不是模型已完成处理. 跨进程并发运行两个父 Session 写入器不属于这个同进程 Adapter 的保证.

最终父写边界同时检查 operation 的即时停止资格, 覆盖 outbox 读取后才到达的用户停止. 已进入父会话同步写入的结果及其 wake 不能由后来的停止撤回; 原生 outbox 的撤销不是对父日志的修改.

AgentStatus 返回的正文与 delivery 元数据在父日志中匹配后也形成 receipt. 该路径不发送第二条结果消息或 wake. 人工选择的父消息标为 selected messages, 表示所选文本而非整项任务已经完成.

## Alternatives considered

- **继续只用 AgentSession runner 与父 inbox.** 已有丰富场景和扩展加载兼容, 改动面最小. 但原生 operation、队列和恢复仍无法成为独立执行事实来源, 不满足能力边界目标.
- **所有任务共享一个子 Harness.** 共享树和模型资源直观, 可降低实例数量. 但当前工具实现、hooks、资源和 cwd 的隔离需要再造动态分派与同名工具冲突规则. 任务级 Harness 使用上游真实作用域表达现有隔离.
- **忙碌时立即发送父 followUp.** 能在当前父轮次结束前提早交付. 但公开 API 没有按身份撤回已入队自定义消息的能力, 导航和 Takeover 无法再阻止正文消费. 保持 outbox 所有权直到空闲写边界.
- **仅按 stopped 终态或在发送 wake 时过滤.** 判断局部且容易复用终结结果, 但原生完成可能先于取消, 自动 outbox 也可能已开始写入. 持久 stop 事实、存储提交处的检查与最终父写入处的即时资格分别覆盖这些顺序.
- **仅凭原生完成或 sendMessage 返回确认交付.** 代码最少, 但实际父日志可写入失败, 或仅接受了延迟消息. 用可核验 receipt 确认, 执行成功与交付失败分开.
- **复制父会话或修改宿主获得原生父 Conversation.** 同树和单事务具有更强结构保证. 但扩展必须在未经修改的官方宿主中运行, 当前使用独立内部 Adapter 表达其真实边界.

## Consequences

执行、准入和父接收可单独替换并用真实离线 Provider 验证. 进程内后端直接调用驱动; [Worker 后端](2026-10-09-durable-worker-isolation.md) 经有请求身份与边界校验的 RPC 使用同一契约. 占用、取消、持久状态与显示状态具有不同责任.

每个任务具有独立 SQLite Session, Runtime 管理按父会话目录的发现、模型授权和资源准备. PiResources 把官方 Pi 工具和关键扩展 hook 接到durable Harness. 父文件 receipt 校验是交付边界上的同步读取, 成本随父日志增长. v3 配置和任务数据由激活实例管理.

## Verification

[Execution adapter scenarios](../../../../test/scenarios/drivers/durable-driver.test.ts) 覆盖 Quota 与观察取消、队列和预算映射、显式 Takeover、选择快照、文件重开、operation 结果边界、关闭时的活体工具和不安全重放.

[Parent delivery scenarios](../../../../test/scenarios/drivers/pi-delivery-channel.test.ts) 使用官方扩展工厂、AgentSession、ModelRuntime 和真实文件, 覆盖父工具派发、子执行、父空闲接收、父错误后的 ACK、丢失响应/确认、导航/接管竞争及父 append 只更新内存的失败边界. 这些场景不验证物理终端或在线 Provider.

[Runtime 场景](../../../../test/scenarios/runtime.test.ts) 通过子屏 Escape 路由停止运行中的工具, 验证控制模式、前台观察等待、stoppedBy=user、空 outbox、父消息零发送、父模型调用数与日志不变. 文件重开后保留片段并支持 Alt+S, 后续运行按原控制模式自动交付. Agent 发起的停止场景保留自动交付. 父交付场景覆盖用户停止先于和后于自动提交, 旧 outbox 读取延迟至新 operation 后仍不能发送, 重开存储也不能重建已停止运行的自动结果.
