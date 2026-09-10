# Agent Note: 选择器确认使用打开时的消息快照

Status: proposed

## Problem

[openDeliverySelector](../../../../src/ui/agent-navigator.ts) 打开时获取一份 DeliverableMessage 数组用于显示, confirm 只把索引交给 [deliverSelectedMessages](../../../../src/spawn/spawn-coordinator.ts), 后者再次从当前 session 提取数组. 子任务仍可运行或 compaction, 两份数组之间没有身份约束. 当消息被压缩/替换时, 用户看到的 index N 可以对应另一条消息, 或变成越界后静默丢掉.

选择后当前 UI 也不检查持久化失败的 undefined 返回, 直接关闭 modal. 这不丢弃 fallback payload, 但用户缺少确认是否已保存的反馈. [formatter](../../../../src/prompt/subagent-delivery.ts) 固定写 completed, 与支持选择 running/error 会话既有输出的 metadata 不一致.

基准 `4f7aab2` 的生产 coordinator 可复现: 预览数组 index 1 为 Previewed report, 将 session.messages 替换为另一组 user/assistant 后 confirm index 1, 保存结果含 Replacement report, 不含用户预览文本. append/send 在复现中使用内存接收器, 不发送真实父消息.

## Proposal

推荐让 confirm 在打开时的只读数组上解析索引, 将实际选中消息快照交给 coordinator. coordinator 验证当前目标仍有效并保存该快照, 不重新按 session index 查找. 用户主动重开 selector 才获取新消息. 这不要求完整 transcript 持久化或改造 AgentManager.

保存和请求交付返回明确结果, UI 区分成功保存与待重试失败; 不把 wake 成功当 ACK. 输出标题描述“selected messages”或实际 capture 状态, 不暗示整个任务完成. parentSessionId/originEntryId 仍服从 [现有交付](../../implemented/architecture/2026-09-09-parent-result-delivery-and-ack.md), 不因当前 Main 改变而重绑定原任务.

## Alternatives considered

- **保留索引并冻结整个子 session.** 能稳定数组, 但打开查看器就暂停执行会影响任务, 且与 compaction/streaming 协调复杂.
- **给全部 Pi 消息另造持久 ID 和版本协议.** 可支持长期跨会话编辑, 但当前只是一次 modal 选择, 复制已展示的文本快照足够.
- **confirm 总是采用最新内容.** 可获得最近输出, 但那不是用户刚勾选的文本. 需要显式刷新选择, 不能悄悄替换.

## Acceptance criteria

- 打开 selector 后 session append、compaction 或替换 messages, confirm 保存的内容仍等于当时所选文本和顺序.
- 目标移除/会话切换、保存失败与空选择有明确结果, 不制造错误 ACK 或把别的消息发给 Main.
- running/error 会话选择的部分输出不被标为任务已完成; 多次选择仍有独立 deliveryId, 旧记录保留.
- 增加一个 [takeover delivery scenario](../../../../test/scenarios/agents/human-takeover-delivery.test.ts) 控制消息替换时序, 并运行受影响 selector/formatter/coordinator 单测.

## Risks

打开期间保存的是用户实际看到的旧快照, 不是当前最新输出, 这是有意的选择语义. coordinator 参数从索引改成文本快照需要一起更新所有调用点, 不保留双签名兼容包装. 不把本修复扩张为全局结果抽屉或自动交付策略变更.
