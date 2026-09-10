# Agent Note: 父会话结果信箱、持久回执与交付调度

Status: implemented

## Problem

子任务完成时父模型可能正在运行、重试或退出. 直接发送后就丢弃唯一结果会丢数据; 以父模型是否生成成功回复作为 ACK 条件, 又会重放已经写入父历史的结果. UI 活体记录清理与磁盘结果寿命不同, 必须分别记录执行、保存和接收事实.

## Decision

[result-inbox](../../../../src/spawn/result-inbox.ts) 使用父 Pi session 的 custom entries 保存 pending-result/result-ack, 不另建数据库. 未接管、仍属于当前 manager 且有父目标的后台 terminal completion 创建新 deliveryId. 先尝试 append pending, 再调度隐藏 subagent-result 消息. 人工会话只有显式选择才建立 inbox 条目, 见 [接管规则](../feature/2026-09-10-human-takeover-and-selective-delivery.md). 已 Clear 或 manager shutdown 删除的记录不会因迟到完成重新入队.

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

AgentManager 拥有 session/取消/并发资源, inbox 拥有结果 payload. 自动清理执行记录不删持久结果, inbox 恢复也不重建假 AgentRecord. 空的可交付状态文本存为 `(no output)`, 不改变 [runner 空完成守卫](../bug-fix/2026-09-10-assistant-outcomes-retries-and-turn-budgets.md). 持久格式保留全部正文, 自动注入每条最多 4000 字符加 AgentStatus 提示; metadata 保留 deliveryId, display=false.

## Receipt reconciliation

ACK 表示父日志中存在匹配的接收凭据, 不表示用户阅读、父模型理解或回复成功. 凭据是有非空内容、parentSessionId 和 deliveryIds 的隐藏 subagent-result, 或 Pi 落盘的成功 AgentStatus toolResult. 只有 saved 集合中存在的 deliveryId 可据此确认. 同一结果的 ACK 补写失败时保留 payload/receipt, 下次对账继续, 不要求重跑子任务.

对账直接读取 JSONL, 检查 session header、ID 和末尾换行. 文件不存在、读取失败、尾行未写完时返回无法对账, 不依据内存镜像补 ACK. getEntries 中存在而磁盘未见的 pending 移回 fallback, 避免 Pi 失败 append 留下的内存条目被当成 durable. 同步 append 返回只是 Pi 接受调用; 本扩展没有 fsync 保证.

message_end handler 用 setImmediate 延后对账, 因 Pi 在 extension handler 返回后才持久化消息. concurrent reconcile 共用 Promise 并记录再次扫描需要, pendingAtRead 区分读取前已有结果与期间新完成, lifecycleVersion/isActive 排除会话/分支切换后的迟到异步动作.

## Delivery opportunities

[SpawnCoordinator](../../../../src/spawn/spawn-coordinator.ts) 区分 idle、preflight、running、settling. idle 使用 triggerTurn; running 或 host 非 idle 使用 followUp, 消费时机由 Pi 决定. preflight/settling 不新发 wake. before_agent_start 对账后可携带 pending, agent_settled 后只有本轮发生新 completion 才安排后续 wake. completionVersion 及其快照是内存计数, 不是持久协议版本.

parentWakeActive 合并并发请求, inFlightDeliveryIds 避免同一轮重复派发. 发送失败不自建无限重试; 新完成、正常父输入或 restore/tree 提供后续机会. restorePending 仍会激活 eligible pending, 自然输入仍可夹带历史 pending. 当前没有通用“旧结果必须显式选择”门禁, 不能把 receipt 修复写成彻底禁止旧结果唤醒.

自动交付只接受原 parentSessionId 且 originEntryId 在当前 branch 的结果. spawn 在本轮及时加入新 leaf, 因 getBranch 的快照可能尚未包含刚发生的 Agent 调用. session_tree 刷新 ancestry 并重新对账. fork/new session 不因复制历史而接管其他父 ID 的结果.

AgentStatus 无参数只列活体记录; 精确 agent_id 可以查当前记录或最近保存结果, 是 session-wide 读取, 不限当前 branch. 查询/停止使用完整记录 ID, UI 的短 ID/类型名称不是另一种模糊查找协议. 只有正文匹配所引用 snapshot 时才附 receipt. 它没有按 deliveryId 浏览所有历史快照的公共参数. pending UI 只显示未 in-flight 且失败/fallback 的异常状态, 不代表全量 inbox 数量, 不从磁盘伪造执行列表.

## Alternatives considered

- **保留发后即忘.** 不需要磁盘对账, 但消息失败时可能丢掉唯一 payload. 先保存和可重试 ACK 将数据保存从父推理成功解耦.
- **父模型成功结算才 ACK.** 更接近“模型消费”的直觉, 但 provider error/用户中断会重放已经落入父日志的结果. ACK 只确认可验证的接收事实.
- **机械 TTL 删除 pending 或重建 AgentRecord.** 前者限制旧结果积压, 后者让 UI 看起来完整; 但前者可丢掉长任务结果, 后者伪造没有真实 session 的执行资源. 持久 payload 与活体 UI 必须分开.
- **每个完成独立 wake 或固定延时 debounce.** 低延迟或易实现, 但固定时间不能表达父生命周期, 多结果可造成重复父轮次. 当前由 in-flight 和 phase 合并.
- **独立数据库/全程静默快照抽屉.** 数据库适合索引和事务, 抽屉适合显式控制历史交付; 两者都改变产品/存储面. 当前复用 Pi JSONL, 未合入 `6e2b40c` 只能作为另一交互路线, 不混写为当前行为.

## Consequences

成功写入磁盘的结果不受 UI 保留 timer 影响. append 失败可用 [进程内 fallback](2026-09-09-composition-root-and-shell-singleton.md) 跨 reload 交接, 不能抵御进程退出. ACK 不代表完整长结果全部进入当前模型上下文, 因自动消息可截断且 parent 后续可压缩历史. 对账读全文件有 I/O 成本, 没有增量索引或跨进程恰好一次保证.

## Evidence

`2731650`, `7e584da`, `e5828bf`, `974f157`, `e85741a` 记录 foreground/background 通知、followUp 与失败反馈的早期路径. `3926adf`, `9f53ead`, `19ed1dd` 确立 inbox、调度收敛和 session-keyed fallback. `d7c2b05`, `2ecc093` 确立人工选择与独立 deliveryId. `4e5ac95` 保留全文并截断自动注入; `7d93c05` 加入新完成版本门禁; `4c6858a` 明确从模型结算 ACK 改为 durable receipt ACK.

`7005a8b`, `8caab79` 记录 AgentStatus 与 ID/类型展示区分; `f40fc66`, `ee2837b` 记录子结果来源标签和实际 lifecycle status, 防止被父模型误当用户输入或一律成功.

## Verification

[inbox unit tests](../../../../test/unit/spawn/result-inbox.test.ts)、[coordinator](../../../../test/unit/spawn/spawn-coordinator.test.ts)、[durable inbox scenarios](../../../../test/scenarios/spawn/durable-inbox.test.ts)、[result delivery](../../../../test/scenarios/spawn/result-delivery.test.ts)、[session fallback](../../../../test/scenarios/spawn/session-fallback.test.ts) 和 [AgentStatus](../../../../test/unit/agents/agent-status.test.ts) 覆盖尾行/磁盘失败、丢 ACK、并发完成、branch/session 隔离和全文查询. 离线真实 Pi 日志场景证明保存/receipt 边界, 不证明实时 provider 可用.
