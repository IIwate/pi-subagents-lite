# Agent Note: 人工接管、前台脱离与选择性交付

Status: implemented

## Problem

用户进入子会话调试时可能连续输入多个指令. 每个阶段都自动汇报会干扰 Main, 但前台 Agent 工具若继续等待人工会话结束, 又会占住父回合. 指令输入和已有成果回传需要分别表达, 不能用一个“继续并发送”动作绑定两种意图.

## Decision

[AgentManager.interact](../../../../src/agents/agent-manager.ts) 对存在的记录设置 takenOver, 首次交互自动 pin, 并调用前台 detach. 打开视图本身不触发接管. 这些标记先于 queued/concurrency/unavailable 检查, 所以交互被拒绝的记录也可能已经被接管和 pin. 前台 [coordinator](../../../../src/spawn/spawn-coordinator.ts) 以执行 Promise 与 detach Promise 竞争, detach 使工具立即返回人工接管说明; 子任务继续使用原记录.

running 输入走 steer; session 尚未就绪时暂存 pendingSteers. settled 且不 streaming 的 session 可用新的 prompt 继续, 沿用其工具/模型会话; 并发不足同步拒绝, 不形成隐藏继续队列. 标准 editor 和 interactive input hook 负责输入, slash/`!` 命令保留宿主处理. [子屏焦点](../architecture/2026-09-10-navigator-screen-and-input-ownership.md) 负责避免输入落入 Main.

接管后的 onAgentComplete 在创建父 inbox 条目前返回, 只更新 navigator. 这意味着终态不会自动落盘到父信箱, 也不会自动 wake Main. 未交付输出依赖 in-memory child session; pin 仅暂停清理, 不提供 reload/退出恢复. 未接管后台任务仍走 [自动交付](../architecture/2026-09-09-parent-result-delivery-and-ack.md).

```ts type-equiv: DeliverableMessage from src/prompt/subagent-delivery.ts
export interface DeliverableMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}
```

[交付选择器](../../../../src/ui/delivery-selector.ts) 展示 session 中有非空 text 的 user/assistant 消息, 不选择 thinking、toolCall、toolResult 或图片. 缺 transcript 时可回退到 record.result. 最新 assistant 默认勾选, 上下移动、Space 多选、Enter 按原序交付、Esc 取消. 选择器不发送新任务或硬编码继续指令.

当前 Alt+S 仅在列表聚焦时响应, 目标是 highlighted taken-over record. confirm 不切换活动子屏或 Main, 关闭后列表保持聚焦. selector 的居中 overlay 固定本次视口的 body 行数, preview 截断/补齐以免光标移动改变整体高度; 终端 resize 可重新计算高度. 该入口不是全局持久结果抽屉.

每次新选择生成独立 deliveryId, 将打开时的消息快照格式化为 Delivered Output 或含角色的 Delivered Transcript, 先保存再请求 wake. 保存失败保留同一 ID 重试, 旧自动交付或更早的显式交付不被删除或覆盖. 格式化正文标注 selected messages; inbox metadata 保存确认时 record 的实际 status, 允许对 running/error 会话选择已有消息. [快照与重试身份](../bug-fix/2026-09-10-delivery-selection-snapshot-identity.md) 负责确认结果和失效目标. 对账 ACK 只证明父日志收到这次交付.

## Alternatives considered

- **保持人工继续后自动汇报.** 错误恢复后主模型能自然接棒, 但用户多轮调试会不断触发父回合. 当前选择显式回传, 接受多一步交付操作.
- **在选择器内放 Continue/模型重试.** 一处完成恢复和发送, 但把任务派发混入既有消息选择, 且预订自动交付无法代表后续每轮人工意图. editor 负责任意指令, selector 只处理已存在内容及其保存重试.
- **选择交付替换旧 inbox 条目.** 看起来可避免重复输出, 但旧结果可能已经形成独立 receipt, 覆盖后失去可追溯性. 每次确认有自己的 deliveryId.
- **自动保存所有人工终态但保持静默.** 可防止 reload 丢掉未选择成果, 同时不打扰 Main; 需要明确快照保留、发现和交付身份的新产品契约. 未合入 `6e2b40c` 具有相关设计, 当前实现不能被描述为已满足该保证.

## Consequences

人工调试和父会话执行解耦, 代价是用户需要主动交付, 且未选择内容不持久. 单纯打开 selector 不改变工作目标, 但当前 finally 固定列表焦点, 不是任意入口下的通用光标原位保证. 消息筛选只表达文本选择, 不提供内容安全过滤或完整 Markdown/XML 封装. [预览显示](../bug-fix/2026-09-10-terminal-preview-and-queue-sanitization.md) 清洗终端控制字符, 原始交付快照保留源文本.

## Evidence

- `e039960`, `36d300f`, `a366c88`: Agent 新建与人类继续入口、前台继续和中断行为.
- `d7c2b05`, `2ecc093`: takeover/detach/pin 及每次显式选择保留独立交付.
- `c3317bf`: selector overlay 与稳定 body 高度. `19ede8c`, `c4e6441`: retry 期间的输入可见性和 queued message 编辑, 详见 [retry UI](../bug-fix/2026-09-09-subagent-screen-retry-and-steering-visibility.md).

## Verification

[takeover delivery](../../../../test/scenarios/agents/human-takeover-delivery.test.ts)、[takeover lifecycle](../../../../test/scenarios/agents/human-takeover-lifecycle.test.ts)、[selector](../../../../test/unit/ui/delivery-selector.test.ts)、[selection formatting](../../../../test/unit/prompt/subagent-delivery.test.ts) 和 [navigator interaction](../../../../test/unit/ui/navigator/agent-navigator.interaction.test.ts) 验证前台解锁、静默完成、多次交付及关闭后的活动视图.
