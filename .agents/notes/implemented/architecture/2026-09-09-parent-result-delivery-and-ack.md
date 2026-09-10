# Agent Note: 会话持久化先行与可靠 ACK 的后台结果交付机制

Status: implemented

## Problem

在多 Agent 异步协作体系中，后台运行的子代理任务（Background Agent）在执行完毕后必须将其输出或错误结果安全、准确地汇报回父会话。传统直接向父模型发送消息的“发后即忘（Fire-and-forget）”模式与早期的确认机制存在严重的工程隐患：

1. **结果易丢失**：子代理完成时若直接将内存中的结果推给父会话并标记为“已消费”，一旦父会话恰好遭遇网络中断、组织配额耗尽（Quota Error）或进程意外崩溃，该子代理耗费大量时间与 Token 计算出的成果将永久丢失；
2. **并发唤醒风暴**：当多个后台任务在相近时间内并发完成时，若每个结果都向父会话发送一条独立的消息请求，会导致父模型被频繁打断并触发多次重复推理轮次，在网络或凭证异常时演变为自发性重试风暴；
3. **上下文错乱与分支越界**：在用户通过 `/tree` 进行会话分支切换时，若不进行分支来源隔离，原本属于分支 A 的子代理结果会被错误注入到分支 B 的对话上下文中，造成严重的上下文污染；
4. **幽灵子代理（Ghost Subagent）与确认机制失步**：若将结果确认（ACK）强绑定于父模型后续推理轮次的成功完成（Model-gated Turn Outcome），一旦模型在生成回复时遭遇网络抖动、429 限流、安全审查拦截或用户手动中止（Ctrl+C），结果虽然已物理落入会话历史，却未能打上 ACK 标记。系统重启或开启新轮次时，未确认的旧记录被误判为未决任务再次唤醒主线程。主线程刚派发新任务或刚结束回合，突然收到早已淘汰的子代理完成报告（且 TUI 列表中无该代理），导致主模型产生严重的虚假完成幻觉。

## Decision

系统在 `src/spawn/spawn-coordinator.ts` 与 `src/spawn/result-inbox.ts` 中建立了一套持久化优先（Durable Persistence First）、信箱解耦、生命周期分期与树分支敏感的可靠交付机制：

1. **信箱解耦与会话日志落盘先行（Durable Mailbox Architecture）**：
   - 彻底将底层通信协议的可靠性与大模型认知的不确定性解耦；
   - 仍在当前 `AgentManager` 中、具有父会话交付目标且未被人工接管的后台任务, 其终态结果先作为 Custom Entry (`subagents-lite:pending-result`) 写入父会话 JSONL 日志, 再请求交付. 人工接管会话仅在用户显式选择消息时创建父信箱条目; 主动移除记录或管理器关闭后的完成回调不重新入队.
   - `AgentManager` 管理真实子会话、并发配额和取消资源; 父会话日志独立保存结果. 内存记录清理不删除已落盘结果, 恢复信箱不重建可执行会话, 结果保存不受 UI 保留计时器限制.
   - **持久交付凭据确认 (Ingestion-based ACK)**: ACK 表示交付凭据已写入父会话日志. 对账确认凭据后追加 `subagents-lite:result-ack`; 父模型后续成功、报错或中断不改变这一事实. ACK 追加失败时保留可供再次对账的结果和凭据.

2. **双向凭证核验与对账自愈（Receipt Reconciliation）**：
   - 在会话启动、恢复（`session_start`）或执行任意交付前，`reconcileDeliveryState()` 自动扫描父会话磁盘 JSONL 日志；
   - 系统核验日志中是否已存在带有该 `deliveryId` 的交付凭据（即隐藏自定义消息 `subagent-result`，或显式 `AgentStatus` 查询的 `toolResult`）。若证实信件早已进入历史上下文，代码自动补齐缺失的 `result-ack` 并在内存中销毁其 pending 态，**从根源上消灭会话中断引发的幽灵二次唤醒**。

3. **生命周期分期的四种交付路径（Four Delivery Paths）**：
   - **空闲立即拍醒（Idle Wake）**：当父会话处于空闲状态（`isIdle`）时，调用 `pi.sendMessage(message, { triggerTurn: true })` 新起推理回合通知模型；
   - **运行中排队 (Running Queue)**: 父会话运行中使用 `pi.sendMessage(message, { deliverAs: "followUp" })`, 消息消费时机由 Pi 调度. `preflight` 和 `settling` 阶段暂停新唤醒请求, 分别由预检注入和结算后的完成事件判定处理.
   - **预检顺带注入（Preflight Piggyback）**：针对断电或异常遗留的真正未消费孤儿结果，在用户下一次发起自然提问时，通过 `before_agent_start` 预检拦截并自然合并入当前提问上下文，消除突兀的单独唤醒；
   - **主动拉取消费（Explicit Lookup）**：模型或用户显式调用 `AgentStatus({ agent_id })` 时，工具直接返回落盘结果并附带 `deliveryIds` 凭据，落盘后同步完成 ACK 闭环。

4. **增量版本门禁（Completion Version Gating）**：
   - 维护单调递增的 `completionVersion` 与当前轮次快照 `parentWakeCompletionVersion`；
   - 仅当父轮次期间**确实有新的子代理完成事件到达**时，才允许在结算后触发唤醒。主线程在当前轮次仅调用 `Agent` 启动新子代理而无新完成时，全程保持绝对静默，避免工具调用期间的未邀打扰。

5. **人工介入静默与手动选择性交付（Human Takeover & Selective Delivery）**：
   - 用户向保留的子会话发送输入时, `AgentManager.interact` 标记 `takenOver = true`, 调用 `detach()` 释放前台等待, 并自动 pin 该记录以暂停自动清理. 打开视图本身不触发接管.
   - 接管后的 `onAgentComplete` 在创建父信箱条目前返回, 因而终态既不自动保存到父信箱, 也不请求唤醒 Main. 子会话使用 `SessionManager.inMemory`; 未显式交付的输出仅在当前运行时中保留, 不提供跨 `/reload` 或进程退出的恢复保证. 错误后的人工继续同样遵守这一规则.
   - 用户从聚焦的子代理列表打开 `Alt+S` 选择器. 选择器负责浏览和勾选既有消息; 标准编辑器负责指令和继续执行. 每次确认选择后, 协调器创建新的 `deliveryId`, 将 `### Delivered Output` 内容先写入信箱再请求交付, 保留先前条目.
   - 选择器以居中模态浮层 (`overlay: true`) 呈现, 主体锁定 `maxVisibleRows`, 预览超出截断、不足补齐, 避免消息切换引起渲染高度变化.

6. **树分支敏感交付（Branch-aware Local Delivery）**：
   - 每个 pending 结果均绑定派生时的入口条目 ID（`originEntryId`）；
   - 自动交付仅在当前父会话的活跃分支包含该入口条目时生效。当用户通过 `/tree` 切换到无关历史分支时，结果保持静默挂起；切回原分支后自动重新激活交付。

持久化条目核心数据结构定义如下：

```ts type-equiv: PendingResult from src/spawn/result-inbox.ts
export interface PendingResult {
  /** Unique completion identity. A continuation gets a new deliveryId. */
  deliveryId: string;
  /** Results never cross a new/forked parent session. */
  parentSessionId: string;
  /** Result is eligible only while this entry remains on the active branch. */
  originEntryId: string | null;
  agentId: string;
  type: string;
  status: AgentStatus;
  result: string;
  error: string | null;
  provider?: string;
  model?: string;
  createdAt: number;
}
```

## Alternatives considered

- **以父模型推理成功为条件的确认机制（Model-gated ACK）** — 该方案认为只有等父模型真正基于子代理结果生成了完整回复，才算被人类和系统“认知消费”，否则应允许重试。然而，这强行将充满偶发异常（网络断开、429 限流、安全过滤、Ctrl+C 中断）的 AI 推理层绑架为通信协议终结符，导致信件物理进入上下文却迟迟无法确认，是引发幽灵子代理与重复唤醒死循环的技术根源。通信协议必须在物理落盘层就地闭环。
- **维持现状：发后即忘的内存级投递（Fire-and-forget）** — 只要父模型在消费结果瞬间遭遇凭证失效、配额耗尽或断电崩溃，子代理所有成果直接永久蒸发，容错率为零。
- **独立外置数据库存储结果（SQLite / Redis）** — 虽具备成熟事务机制，但增加了原生二进制编译依赖与跨平台部署负担，且破坏了 Pi 原生会话单一 JSONL 文件的离线自包含设计。

## Consequences

- **收益**：
  - 成功落盘的结果可供恢复和回执对账, 不随内存执行记录清理而删除.
  - 并发完成共用一次父会话唤醒请求, 后续结果保留在信箱并合并交付; 运行中的父会话通过 Pi 的 Follow-up 队列接收消息.
  - 接入人工介入（Takeover）与手动选择性交付（Alt+S），实现人类对交付内容的降噪剪裁与多阶段回传；
  - 会话崩溃或断电重启具备确定性的双向凭证对账能力；多分支导航时上下文保持绝对隔离。
- **代价与已知上限**：
  - 会话日志为只追加文件, Preflight 对账需要异步读取和解析 JSONL; 成本随会话大小变化.
  - 状态机跨越 `before_agent_start`、`agent_start`、`agent_end`、`agent_settled` 与 `session_tree` 事件, 使用内存中的生命周期与完成版本计数防止过时回调请求交付.

## Verification

- 交付持久化、唤醒合并、幽灵消灭与 ACK 对账逻辑经集成测试全面覆盖：[test/scenarios/spawn/durable-inbox.test.ts](../../../../test/scenarios/spawn/durable-inbox.test.ts)、[test/scenarios/spawn/result-delivery.test.ts](../../../../test/scenarios/spawn/result-delivery.test.ts) 与 [test/unit/spawn/spawn-coordinator.test.ts](../../../../test/unit/spawn/spawn-coordinator.test.ts)。
- 选择器长短消息光标切换行数恒定与模态浮层边界经单测验证：[test/unit/ui/delivery-selector.test.ts](../../../../test/unit/ui/delivery-selector.test.ts)。
- 人工接管静默、显式选择持久化和独立交付 ID 由 [human-takeover-delivery.test.ts](../../../../test/scenarios/agents/human-takeover-delivery.test.ts) 覆盖.
- 契约结构体与源码 AST 100% 同步，由 `npm run verify-type-equiv` 自动门禁校验。
