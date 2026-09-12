# Agent Note: 人工接管、前台脱离与选择性交付

Status: implemented

## Problem

用户进入子会话调试时可能连续输入多个指令. 每个阶段都自动汇报会干扰 Main, 但前台 Agent 工具若继续等待人工会话结束, 又会占住父回合. 指令输入和已有成果回传需要分别表达, 不能用一个“继续并发送”动作绑定两种意图.

## Decision

[TaskEngine.takeOver](../../../../src/engine/task-engine.ts) 立即封闭自动交付资格并持久保存 manual 控制模式, 前台 wait 随之返回. [NavigationSource](../architecture/2026-09-11-declarative-navigation-and-input-actions.md) 处理 Alt+T 与 pin; 打开视图、普通 Steer 和 FollowUp 不改变控制模式.

运行中或 queued 的输入进入原生队列. 恢复的 Waiting operation 在明确输入后继续其原身份; settled 任务通过重新准入创建新 operation. 并发不足返回局部拒绝并保留草稿. slash 和 shell 输入交还官方宿主.

人工控制下的 operation 与 transcript 仍由原生 Session 持久化, 完成本身不创建自动 outbox 或唤醒 Main. 父交付由显式选择建立独立 deliveryId. 未接管后台任务继续采用 [自动交付](../architecture/2026-09-11-native-execution-and-parent-delivery-adapters.md).

```ts type-equiv: DeliverableMessage from src/prompt/subagent-delivery.ts
export interface DeliverableMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}
```

[选择器](../../../../src/ui/delivery-selector.ts) 从打开时快照选择非空 user/assistant 正文. thinking、工具调用、工具结果与图片不属于可选正文. 每次确认保留快照的 task、operation、来源 Entry、时间和独立 deliveryId; 同次失败重试沿用该身份, 不读取新 operation 的文本.

Alt+S 只在列表聚焦时针对已接管任务打开 modal. 确认不切换活动任务; 同一交互代次关闭后恢复列表焦点. Parent 消息明确标注 selected messages, 不把运行中的部分输出描述成任务完成. 原始正文与终端清洗分离.

## Alternatives considered

- **保持人工继续后自动汇报.** 错误恢复后主模型能自然接棒, 但用户多轮调试会不断触发父回合. 当前选择显式回传, 接受多一步交付操作.
- **在选择器内放 Continue/模型重试.** 一处完成恢复和发送, 但把任务派发混入既有消息选择, 且预订自动交付无法代表后续每轮人工意图. editor 负责任意指令, selector 只处理已存在内容及其保存重试.
- **选择交付替换旧 inbox 条目.** 看起来可避免重复输出, 但旧结果可能已经形成独立 receipt, 覆盖后失去可追溯性. 每次确认有自己的 deliveryId.
- **仅在内存保留人工输出.** 资源结构最少, 但 reload 会丢掉未选择正文. 原生 Session 持久保存执行事实, 是否向父会话交付由显式选择决定.

## Consequences

人工调试和父会话执行分离, 需要用户明确选择回传. 原生数据可在 reload 后发现, 未确认 outbox 保持可重试; 父日志 receipt 才确认这次接收. 文本选择不提供内容过滤或图片转录. [终端预览](../bug-fix/2026-09-10-terminal-preview-and-queue-sanitization.md) 负责显示字符清洗.

## Evidence

- `e039960`, `36d300f`, `a366c88`: Agent 新建与人类继续入口、前台继续和中断行为.
- `d7c2b05`, `2ecc093`: takeover/detach/pin 及每次显式选择保留独立交付.
- `c3317bf`: selector overlay 与稳定 body 高度. `19ede8c`, `c4e6441`: retry 期间的输入可见性和 queued message 编辑, 详见 [retry UI](../bug-fix/2026-09-09-subagent-screen-retry-and-steering-visibility.md).

## Verification

[Runtime 场景](../../../../test/scenarios/runtime.test.ts)、[原生导航](../../../../test/scenarios/ui/task-navigation.test.ts)、[selector](../../../../test/unit/ui/delivery-selector.test.ts) 和 [navigator interaction](../../../../test/unit/ui/navigator/agent-navigator.interaction.test.ts) 验证前台解除等待、静默完成、快照重试及 modal 焦点.
