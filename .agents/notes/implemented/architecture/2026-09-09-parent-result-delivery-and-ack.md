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
   - 任何后台任务终态（无论是 `completed`、`aborted`、`turn_limited` 还是 `error`）均首先作为 Custom Entry（`subagents-lite:pending-result`）直接写入父会话持久化 JSONL 日志中，内存中的 `AgentManager` 记录仅作为瞬时 UI 缓存；
   - **物理送达即盖章（Ingestion-based ACK）**：ACK 仅代表“交付信件已物理落入父会话日志（Durable Ingestion）”。一旦交付凭据落盘，系统立即追加 `subagents-lite:result-ack`，后续父模型推理是成功、报错还是被中断，均不阻塞也不撤销 ACK。

2. **双向凭证核验与对账自愈（Receipt Reconciliation）**：
   - 在会话启动、恢复（`session_start`）或执行任意交付前，`reconcileDeliveryState()` 自动扫描父会话磁盘 JSONL 日志；
   - 系统核验日志中是否已存在带有该 `deliveryId` 的交付凭据（即隐藏自定义消息 `subagent-result`，或显式 `AgentStatus` 查询的 `toolResult`）。若证实信件早已进入历史上下文，代码自动补齐缺失的 `result-ack` 并在内存中销毁其 pending 态，**从根源上消灭会话中断引发的幽灵二次唤醒**。

3. **生命周期分期的四种交付路径（Four Delivery Paths）**：
   - **空闲立即拍醒（Idle Wake）**：当父会话处于空闲状态（`isIdle`）时，调用 `pi.sendMessage(message, { triggerTurn: true })` 新起推理回合通知模型；
   - **运行中静默排队（Running Queue）**：当父会话正处于推理中或结算中（`running`/`settling`）时，调用 `pi.sendMessage(message, { deliverAs: "followUp" })` 将信件排入后继队列，**绝不粗暴打断正在生成的模型**；
   - **预检顺带注入（Preflight Piggyback）**：针对断电或异常遗留的真正未消费孤儿结果，在用户下一次发起自然提问时，通过 `before_agent_start` 预检拦截并自然合并入当前提问上下文，消除突兀的单独唤醒；
   - **主动拉取消费（Explicit Lookup）**：模型或用户显式调用 `AgentStatus({ agent_id })` 时，工具直接返回落盘结果并附带 `deliveryIds` 凭据，落盘后同步完成 ACK 闭环。

4. **增量版本门禁（Completion Version Gating）**：
   - 维护单调递增的 `completionVersion` 与当前轮次快照 `parentWakeCompletionVersion`；
   - 仅当父轮次期间**确实有新的子代理完成事件到达**时，才允许在结算后触发唤醒。主线程在当前轮次仅调用 `Agent` 启动新子代理而无新完成时，全程保持绝对静默，避免工具调用期间的未邀打扰。

5. **人工介入静默与手动选择性交付（Human Takeover & Selective Delivery）**：
   - **介入切断自动唤醒**：用户在 TUI 中向子代理发送消息交互时，立即标记 `takenOver = true`，自动触发前台解绑（`detach()` 释放主会话等待）与自动置顶（`Auto-Pin`，免疫 15 分钟 TTL GC 淘汰）；
   - 接管后的子代理执行完毕时，`onAgentComplete` 识别其为接管状态，**彻底剥夺自动唤醒权（Silent Completion）**，保持完全静默以保护人类调试上下文；
   - **快捷键 Alt+S 手动剪裁交付**：用户在 TUI 列表中按下 `Alt+S` 打开 `DeliverySelector` 对话框，由人类手动勾选高价值消息。协调器生成**全新派生的 `deliveryId`**，将定制摘要以 `### Delivered Output` 格式写入信箱投递，支持多阶段按需交付。

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
  - 彻底杜绝了后台执行结果的丢失风险，消除了幽灵子代理完成导致的模型认知幻觉；
  - 将并发完成平滑收敛为有序单次唤醒，且在父会话忙碌时自动降级为 Follow-up 排队，不抢占正在生成的对话；
  - 接入人工介入（Takeover）与手动选择性交付（Alt+S），实现人类对交付内容的降噪剪裁与多阶段回传；
  - 会话崩溃或断电重启具备确定性的双向凭证对账能力；多分支导航时上下文保持绝对隔离。
- **代价与已知上限**：
  - 会话日志为只追加文件，需要在 Preflight 阶段异步解析最新 JSONL 条目（得益于操作系统页面缓存，开销处于微秒到毫秒级，远低于 LLM 启动时延）；
  - 状态机需横跨 `before_agent_start`、`agent_start`、`agent_end`、`agent_settled` 与 `session_tree` 多个生命周期事件，内部状态转换严密且需要持久化单调版本号防护。

## Verification

- 交付持久化、唤醒合并、幽灵消灭与 ACK 对账逻辑经集成测试全面覆盖：`test/spawn/durable-inbox.integration.test.ts`、`test/agents/result-delivery.integration.test.ts` 与 `test/spawn/spawn-coordinator.test.ts`。
- 契约结构体与源码 AST 100% 同步，由 `npm run verify-type-equiv` 自动门禁校验。
