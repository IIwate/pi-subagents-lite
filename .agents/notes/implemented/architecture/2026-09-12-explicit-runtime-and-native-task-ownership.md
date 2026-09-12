# Agent Note: 显式 Runtime 与原生任务资源所有权

Status: implemented

## Problem

扩展回调、配置与后台任务若依赖模块级服务容器, 同进程中的另一个父会话或 reload 就可能改变其目标. 初始化可能在关闭请求之后才返回, 而持久结果的读取不应依赖模型或扩展仍然可执行.

## Decision

[ExtensionRuntime](../../../../src/runtime.ts) 是每次扩展激活的组合根. [注册](../../../../src/registration.ts) 与 [事件](../../../../src/events.ts) 的闭包捕获所属实例, catalogue、ConfigStore、TaskEngine、Native Session 仓库、导航 Source 和 PiScreen 由该实例管理. 父会话 ID 与文件身份在 session_start 绑定, 工具回调在入口及异步资源交接处核对所属会话.

原生 Session/Harness 由扩展拥有, 官方 Pi 的父会话仍由宿主拥有. [执行与交付 Adapter](2026-09-11-native-execution-and-parent-delivery-adapters.md) 是正式 Agent 工具入口; [NavigationSource](2026-09-11-declarative-navigation-and-input-actions.md) 只提供展示值与动作. 模型授权在资源准备前完成, 已接受的 prompt、模型身份、thinking、工具集合和运行预算保持固定.

## Persistence and discovery

任务使用 getAgentDir 下 subagents-lite-v3/sessions 的官方 JsonlSessionRepo. TaskBinding 与 outbox 位于原生应用 values, operation、队列和执行结果由 Harness 持久化. Runtime 按 parentSessionId 发现属于当前父会话的任务; 没有接受 operation 的准备记录不进入执行列表.

```ts type-equiv: TaskBinding from src/engine/contracts.ts
export interface TaskBinding {
  readonly taskId: string;
  readonly policy: TaskPolicy;
  readonly parent: ParentOrigin;
  readonly mode: "foreground" | "background";
  readonly control: "autonomous" | "manual";
  readonly display?: { readonly name: string; readonly description: string };
  readonly resources?: { readonly extensions: readonly string[]; readonly trusted: boolean };
}
```

恢复只附着原生事实. 未结束 operation 显示 Waiting, 用户输入通过原生队列与显式 resume 继续同一 operation; 已结束任务的继续建立新 operation. 当前模型授权的改变不重新解释已接受策略. 扩展或模型不可用时显示恢复错误, 已保存结果仍可由 AgentStatus 通过 NativeTaskStore 读取, 不据此制造可执行记录.

配置由实例 ConfigStore 持有, 使用 subagents-lite-v3.json. 文件缺失采用默认值; 已存在文件的 JSON、字段、路由或配额错误明确抛出. 保存保持 validate/persist/publish 顺序, 关闭后的设置回调不能写文件或发布新状态. AgentCatalogue 的定义、扫描目录及默认 Agent 开关各自属于实例.

## Resource preparation and teardown

[PiResources](../../../../src/drivers/pi-resources.ts) 加载当前官方 Pi 的资源与工具, 为每个子任务建立独立 ModelRuntime 和 ExtensionRunner. 它把扩展工具和关键请求 hook 接到原生 Harness, 并将 custom state 保存到原生应用 values. 给扩展的同步 SessionManager 是原生消息及扩展状态的读取投影, 不运行模型, 也不是子任务的持久化后端.

资源准备在原生任务发布之前完成. Runtime 跟踪未完成的接受操作, 每个异步边界核对生命周期. HarnessDriver 接过 Native Session 与 PiResources 后承担其失败关闭责任. 迟到返回的资源被关闭, 不进入已关闭 Runtime 的 TaskEngine.

关闭先封闭 Runtime、配置写入和迟到 UI 回调, 解除导航订阅并恢复宿主组件, 再关闭 TaskEngine、仍在准备的资源、仓库和执行环境. 每一项清理单独尝试, 失败聚合返回. Harness 的 Session 能力借自 Driver, 关闭 Harness 先封闭执行, Session writer 仍由 Driver 保留给子扩展 shutdown 保存应用状态. Driver 随后等待已进入的执行, 关闭原生 Session 并释放环境; 同一关闭 Promise 在可重入操作之前登记.

UI 的十分钟保留窗口只隐藏已结算的展示项, pin 暂停剩余窗口, 显式移除仍可隐藏已 pin 的任务. 原生任务数据与 outbox 不被该计时器删除. 任务和扩展资源的最终释放归 Runtime, 父会话不由它关闭.

## Receipt and control boundaries

AgentStatus 的正文和 delivery 身份只有落入真实父日志后才可成为 receipt. 读取结果或返回工具结果本身不能 ACK, 也不因一次显式读取再次唤醒父模型. 人工选择在父消息中标为 selected messages, 不把选中的部分输出描述为完整任务完成.

Steer 和 FollowUp 保持控制模式. Takeover 持久改为 manual 并解除前台观察, 原生执行继续; 后续输出显式选择交付. StopAgent 与用户停止的发起者保存为当前 operation 的应用事实, 与预算耗尽产生的 abort 区分. 旧 operation 的迟到事件不能改变新 operation.

## Alternatives considered

- **维持共享 Shell 与内存 handoff.** 单父会话路径已有丰富验证, 修改面小. 但服务目标和生命周期仍可被另一激活覆盖, 进程退出也无法保留内存交接. [原组合根](../../archived/architecture/2026-09-09-composition-root-and-shell-singleton.md) 记录该方案的边界.
- **给原 AgentSession 路径增加统一 Runtime 外壳.** 可以快速消除全局 getter, 但执行、队列与恢复仍由另一套生命周期承担. 正式入口使用已验证的原生 Driver 和 TaskEngine.
- **恢复时自动启动所有未完成操作.** 后台恢复更方便, 但重新取得外部执行权限和处理未知工具效果需要明确动作. 当前发现与执行准入分开, replay 安全由原生引擎裁决.
- **结果读取时重新构造完整执行环境.** 可复用全部展示方法, 但一个不可用扩展或模型就会遮蔽持久结果. 数据读取直接使用原生 Session values 和结果记录.
- **先删除引用再等待清理.** UI 能更快消失, 但无法证明迟到准备或已进入工具的资源归属. 关闭封闭入口并等待各自所有者完成释放.

## Consequences

同进程可以建立多个独立 Runtime. 配额、目录、配置更新、任务结果和关闭仅影响所属实例. 文件与真实执行各自有所有者, reload 不依赖可变业务单例.

PiResources 仍受当前官方 Pi 的工具与 hook API 约束; 固定策略后的模型、工具集合和结构性 session 操作不能由子扩展改写. 不响应关闭的第三方工具或 shutdown handler 会延长释放等待, 不用提前释放配额伪装资源已退出. 未确认 outbox 继续保留, 原生与父会话之间没有跨文件原子事务.

## Verification

[Runtime 场景](../../../../test/scenarios/runtime.test.ts) 使用官方父 AgentSession、离线 Provider 和真实原生文件, 覆盖正式工具入口、两实例交错、排队策略、关闭期间资源准备、UI 清理失败、reload、显式控制与扩展不可用时的结果读取. [父交付场景](../../../../test/scenarios/spawn/delivery-channel.test.ts) 覆盖 durable AgentStatus receipt, [展示保留](../../../../test/unit/ui/task-source.test.ts) 覆盖 pin 暂停和结果所有权. 这些证据不代表在线 Provider 或任意外部扩展的可用性.
