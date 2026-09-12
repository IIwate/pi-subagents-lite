# Agent Note: 声明式导航、输入动作与 Pi 终端适配

Status: implemented

## Problem

Navigator 同时读取活体会话、维护 transcript 订阅、处理键盘输入和替换 Pi 组件时, 展示代码就能绕过执行所有者改变任务. 将普通指令隐式解释成接管会改变前台等待与后台交付, 而异步撤回、续聊和选择器确认又可能发生在另一个 operation 或输入目标上.

[原生执行与交付](2026-09-11-native-execution-and-parent-delivery-adapters.md) 提供 TaskEngine 和可恢复操作, 展示需要消费值快照并派发具有任务身份的动作. 终端布局与焦点仍由当前官方 Pi TUI 的组件协议决定.

## Decision

[NavigatorView](../../../../src/ui/navigator-view.ts) 只将 NavigatorViewState 格式化成行. [TranscriptView](../../../../src/ui/transcript.ts) 接收只读消息并缓存折行. 两者没有执行句柄、文件持久化、Shell 或 Lane 操作.

[AgentNavigator](../../../../src/ui/agent-navigator.ts) 是交互 Controller, 拥有选择、高亮、焦点、临时草稿和 modal 状态. [PiScreen](../../../../src/ui/pi-screen.ts) 拥有 editor 委派、宿主组件替换、clearOnShrink 与恢复. 这组实现取代 Navigator 内部的会话读取和全局服务反查.

```ts type-equiv: NavigationAction from src/ui/navigation.ts
export type NavigationAction =
  | { readonly type: "steer" | "followUp" | "continue"; readonly taskId: string; readonly operationId: string; readonly input: TaskInput }
  | { readonly type: "takeover" | "abort" | "abortRetry" | "pin" | "remove"; readonly taskId: string; readonly operationId: string }
  | { readonly type: "dequeue"; readonly taskId: string; readonly operationId: string; readonly entryIds: readonly string[] }
  | { readonly type: "deliver"; readonly selection: DeliverySelection; readonly deliveryId?: string };
```

```ts type-equiv: NavigationSource from src/ui/navigation.ts
export interface NavigationSource {
  listAgents(): readonly NavigationAgent[];
  getRecord(taskId: string): NavigationAgent | undefined;
  transcript(taskId: string): TranscriptSnapshot;
  watchTranscript(taskId: string, listener: () => void): () => void;
  subscribe(listener: () => void): () => void;
  dispatch(action: NavigationAction): NavigationReply | Promise<NavigationReply>;
  dispose(): void;
}
```

[TaskNavigationSource](../../../../src/ui/task-source.ts) 将 TaskEngine 和 ExecutionSnapshot 投影为导航数据, 把动作交还 Engine. 它不持有原始 Lane, 不复制 operation 日志或执行状态机. [ExtensionRuntime](2026-09-12-explicit-runtime-and-native-task-ownership.md) 为正式入口创建 Source、Controller 与 PiScreen.

## Input and control ownership

普通 Enter 对 running/queued/waiting 任务派发 steer, 保持 foreground/background 和 autonomous/manual 身份. 对已经展示为 settled 的任务派发 continue. 若输入与结算竞争, 已接受的输入保留在原生队列中并显示等待继续, 不静默启动另一项 operation.

FollowUp 使用宿主 KeybindingsManager 的 app.message.followUp 动作. 在 0.85.1 的 Windows/WSL 默认键位中它是 Ctrl+Q, 其他环境为 Alt+Enter. 宿主 dequeue 动作同样被委派到当前子任务, 同时保留明确的 Alt+Up 别名. 按键路由发生在父 editor 入队之前, Main 继续使用宿主处理. slash 与 shell 输入交给 Pi.

Alt+T 是显式 takeover: 控制模式持久变为 manual, 前台观察可 detach, 执行本身继续. TaskEngine 保存控制模式, Source 管理 pin, 前台观察在控制模式改变后解除等待. [接管与选择交付](../feature/2026-09-10-human-takeover-and-selective-delivery.md) 记录父交付行为.

Alt+S 由聚焦列表的 Controller 处理, 只打开已接管任务的选择器. 它不是一个在 Main/editor 中无条件吞键的全局 shortcut. PiScreen 既转发宿主 actionHandlers, 也识别宿主提供的消息动作键位, 保留晚注册的 handler 和平台键位配置.

Native continue 在 accept 新 operation 前预留 Quota. 无容量返回 QuotaUnavailable, 保留旧结果和 operationId; 成功预留的额度随真实 drive 释放. Controller 将拒绝显示为局部提示, 仅在 editor 仍为空时恢复原输入, 不覆盖更新的草稿.

## Queued input and delayed callbacks

原生撤回使用 entryId 调用 cancelQueued, 只有 cancelled 的内容可以回到 editor. already_consumed/not_found 不被当成成功撤回并重发. Controller 绑定 requestId、taskId 和 operationId; 旧输入回复不覆盖新运行的提示或草稿.

用户在撤回期间切到 Main 时, 已成功撤回的文本保留在原任务的临时 UI 草稿中, 返回后由 Alt+Up 显式恢复. 撤回不会把旧任务输入塞进 Main. 当前 editor 没有恢复图片附件的接口时, 含图片的 queued input 保持排队, 不先取消再丢掉附件.

Source.dispose 释放展示订阅、保留计时器与缓存. TaskEngine 仍拥有任务和原生执行资源. Native source 的 pin/隐藏列表状态属于展示会话; remove 请求人工控制和取消后隐藏投影, 不删除原生持久数据. 十分钟保留窗口仅隐藏已结算投影, pin 暂停剩余时间; 原生数据保持完整.

## Transcript and selection snapshots

[message projection](../../../../src/drivers/message-projection.ts) 在 Adapter 边界提取 text、thinking、工具展示与图片标记, 保留原始正文. HarnessDriver 按不可变 Entry ID 复用消息投影, Source 持有原生观察订阅, View 对消息、theme 和 width 缓存折行.

TaskNavigationSource 合并脏任务的刷新, 一次读取完成后即可返回, 后到更新进入下一次刷新. 连续输出不要求调用者等待全局静默. View 按只读消息对象、theme 和 width 缓存折行, 键盘重绘不重新读取宿主历史或克隆模型目录. Native streaming 与统计也通过 ExecutionSnapshot 提供.

选择器打开时捕获 taskId、operationId、正文、来源 Entry ID、状态和时间. 每次新选择具有独立 deliveryId, 保存重试沿用同一 ID 和快照. 即使第一次保存已提交但回复丢失, 随后又运行了新 operation, 重试也不会读取新正文、改写旧状态或创建第二条交付.

View 的 displayText 清洗发生在终端排版之前, 原生结果与选择快照保留原文. selector 仅读取有文本的 user/assistant 消息, 不把工具调用、thinking 或图片伪装成正文.

## Host terminal boundary

PiScreen 保留已验证的 document/dock 结构检查和引用相等恢复, 不覆盖其他扩展后来安装的组件或 editor. regular/fullscreen 使用相同的 dock 容器, 子屏只替换 chat 槽与相关 render 方法. [屏幕所有权](2026-09-10-navigator-screen-and-input-ownership.md) 维护详细协议.

列表聚焦时移除 editor 输出中的 CURSOR_MARKER; typing/paste 返回 editor 焦点, Enter 仍只确认候选切换. child transcript、pending/status 和 footer 随 resize 使用当前尺寸. clearOnShrink 在拥有 UI 时启用, 释放时恢复原值. dispose 请求宿主重绘而不直接写清屏控制序列, 并逐项尝试订阅、组件和 editor 的释放.

## Alternatives considered

- **继续由 Navigator 读取 AgentSession.** 现有功能与渲染缓存都可直接复用, 变更面最小. 但展示仍能反查执行状态和操纵队列, 无法接入原生 Driver 或独立展示进程.
- **只把大类拆成多个持有 session 的 UI 类.** 能降低单文件长度并保留所有调用方式. 但依赖和所有权不改变, 不能满足只读展示边界.
- **每次刷新克隆完整 session/model DTO.** 隔离简单, 但长历史和模型目录会进入按键/streaming 热路径. 只投影实际展示字段, 复用不可变消息与已接受策略.
- **继续把所有输入视为 takeover.** 能立即释放前台等待并停止自动汇报. 但轻量纠偏也会改变自治交付模式. 显式控制动作保持输入和交付意图独立.
- **撤回后无条件写回当前 editor.** 实现最少, 但异步完成可能落在 Main 或新选中的任务. 保留原目标身份与临时草稿, 由用户明确恢复.
- **选择器重试按最新 transcript 重新计算.** 可以取得最新输出, 但保存成功回复丢失后会造成重复或内容漂移. 稳定 ID 和已选快照直接表达用户确认.

## Consequences

纯 View 与终端 Adapter 消费同一组只读 TaskEngine 投影, UI 不参与执行或持久化. 输入、控制模式、选择快照和终端组件分别有明确所有者.

终端恢复仍依赖 Pi 0.85.1 的已检查布局, 不构成对未来任意 TUI 的兼容承诺. Native task source 保持任务数据供执行所有者管理, UI 关闭本身不销毁后台任务.

## Verification

[Navigator unit tests](../../../../test/unit/ui/navigator/) 维护焦点、输入目标、原文恢复、可见宽度、缓存及宿主组件恢复的断言. [Action ownership](../../../../test/unit/ui/navigation-actions.test.ts) 覆盖已消费输入不重发和跨目标撤回. [Native navigation scenarios](../../../../test/scenarios/ui/task-navigation.test.ts) 从 editor 输入驱动真实 Lane, 检查 Steer/FollowUp、显式接管、原文与预览分离及跨 operation 保存重试.

官方 Pi CLI 0.85.1 的离线 PTY 验证使用独立配置目录和原生 TaskEngine, 覆盖 regular/fullscreen 下的子屏切换、Steer、宿主 FollowUp、Alt+Up 撤回、接管、selector、窗口缩窄、返回 Main 和退出. 验证使用离线 Provider; 不代表在线模型可用性或全部终端/IME 组合.
