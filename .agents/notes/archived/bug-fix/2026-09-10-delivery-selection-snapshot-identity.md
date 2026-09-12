# Agent Note: 消息选择快照与保存重试身份

Status: implemented

Archived: 2026-09-12

## Problem

选择器显示的消息数组与确认时的实时 session 可以因追加、替换或 compaction 而不同. 再次按索引取值会交付用户没有选择的文本. 保存失败后的重试还需要区别于一次新的选择, 防止暂存条目后续补存时重复交付.

## Decision

[navigator](../../../../src/ui/agent-navigator.ts) 从 NavigationSource 在打开选择器时取得只读文本快照. confirm 在该数组上按原顺序解析选中索引, 派发 deliver Action. 当前 Manager 的 AgentPresentation 将实际 DeliverableMessage 交给 [coordinator](../../../../src/spawn/spawn-coordinator.ts), 不按实时 transcript 索引查找. 原生 TaskNavigationSource 同时保留 operation、状态和时间, 见 [声明式导航](../architecture/2026-09-11-declarative-navigation-and-input-actions.md). 重新打开选择器才刷新消息集合.

```ts type-equiv: SelectionDeliveryResult from src/spawn/spawn-coordinator.ts
import type { PendingResult } from "../../../../src/spawn/result-inbox.js";

export type SelectionDeliveryResult =
  | { status: "saved"; delivery: PendingResult }
  | { status: "pending"; delivery: PendingResult }
  | { status: "rejected"; reason: "unavailable" | "empty" };
```

保存前验证记录仍存在、coordinator 仍属于活动父会话及 session file, 并检查已有 resultSessionId 与本 coordinator 一致. 空选择直接拒绝, 不绑定父上下文. 原始 parentSessionId/originEntryId 继续控制 [交付归属](../architecture/2026-09-09-parent-result-delivery-and-ack.md); 同一父会话的分支切换不重绑定原任务.

一次新选择建立一个 deliveryId. append 成功返回 saved 并请求父 wake; append 失败返回 pending, payload 留在现有 fallback inbox. UI 展示保存失败, 保留该 deliveryId, 锁定本次选择并允许 Enter 重试和 Esc 关闭. 重试查找并保存同一条目, 即使其已由其他 reconciliation 保存也不新建 ID. Esc 关闭保留已确认的暂存结果.

rejected 和 pending 不作为成功确认关闭 modal. saved 表示父 inbox append 成功, 不代表模型已处理或 durable ACK. ACK 仍由父日志 receipt 建立. [formatter](../../../../src/prompt/subagent-delivery.ts) 标注 selected messages, metadata 保留确认时实际状态, 不把 running/error 的部分输出描述成任务完成.

## Alternatives considered

- **维持确认时读取最新数组.** 能获得最新输出, 但不再代表用户刚勾选的消息. 刷新选择应通过重新打开明确表达.
- **打开选择器时冻结整个子会话.** 可以稳定索引, 但查看输出会暂停任务并增加 compaction/streaming 协调. 文本快照已足够表达本次选择.
- **为全部 Pi 消息增加持久 ID 与版本协议.** 能支持跨会话编辑, 但当前 modal 只需要打开时的 role/content 快照.
- **保存重试生成新 deliveryId.** 调用方式简单, 但原 fallback 条目仍可能补存. 新选择与同一选择的重试必须有不同身份语义.

## Consequences

打开期间产生的新文本不属于本次选择, 这是用户看到的快照语义. 原始 payload 与 [终端显示转换](2026-09-10-terminal-preview-and-queue-sanitization.md) 分离. 不保存未选择的完整 transcript, 不改变人工接管后的自动交付策略.

## Verification

[takeover delivery 场景](../../../../test/scenarios/agents/human-takeover-delivery.test.ts) 控制消息 append、替换、compaction 和保存失败, 检查快照内容、一次保存、稳定重试 ID、目标失效及未生成 ACK. [coordinator](../../../../test/unit/spawn/spawn-coordinator.test.ts)、[selector](../../../../test/unit/ui/delivery-selector.test.ts) 和 [formatter](../../../../test/unit/prompt/subagent-delivery.test.ts) 检查调用契约和部分输出标注.
