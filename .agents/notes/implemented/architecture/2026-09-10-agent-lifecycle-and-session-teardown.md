# Agent Note: 执行记录保留与子会话销毁顺序

Status: implemented

## Problem

停止请求、模型停止输出、执行 Promise 结算和释放子会话不是同一事件. 若在流仍活动时销毁 Pi ExtensionRunner, 后续 provider/context hook 会访问失效运行时; 若只丢弃 AgentRecord, 子扩展的进程、连接和 watcher 又没有机会关闭. 排队、初始化和人工继续使这些时序都可能与 Clear 或父会话关闭相遇.

## Decision

[AgentManager](../../../../src/agents/agent-manager.ts) 拥有活体记录、取消控制器和子会话. `AgentRecord` 将生命周期、显示信息、执行资源和统计分开; `stopped` 可以早于 `execution.settled`, 因而继续执行还要求 Promise 已结算且 session 未 streaming. 外部停止状态不被迟到的成功或错误回调覆盖. [并发 Note](2026-09-09-hierarchical-concurrency-ceilings.md) 负责 slot 的释放时机.

记录自动清理每分钟检查一次, 仅适用于 terminal、未 pin 且 `resultPersisted` 或 `resultConsumed` 为真的记录. 到期时间是完成时间加 10 分钟及 pin 暂停累计时间. running/queued 不因任务耗时被清理; pin 不阻止显式 Clear. 人工输入自动 pin 的规则见 [接管](../feature/2026-09-10-human-takeover-and-selective-delivery.md). 保留的 session 是进程内资源, 不代表可跨进程恢复.

每个 session 通过 WeakMap 共享一次关闭 Promise, 在调用可重入 hook 前登记. 正常关闭先等待 `session.abort()`, 再向子扩展发送 `session_shutdown`, 最后调用 `session.dispose()`. 这一步不能由父会话的 shutdown 代替: 子扩展是另一组实例, 而 Pi 的 session dispose 不代发这个事件. abort 与 shutdown 合用 15 秒等待窗口, 超时仍执行 dispose. 超时限制等待时间, 不保证被挂起的外部操作已物理终止.

Manager dispose 先设关闭标记并中止初始化/执行, 结算 queued 前台等待, 清空队列, 关闭已有 session, 再有界等待初始化和已登记的关闭任务. 后到的 `onSessionCreated` 检查关闭标记、记录身份和停止状态, 关闭迟到 session. 重入 dispose 直接返回, 避免子 shutdown handler 递归等待自身. [组合根](2026-09-09-composition-root-and-shell-singleton.md) 在 UI 清理失败时仍继续 manager/coordinator 清理.

## Alternatives considered

- **保留记录删除加直接 dispose 的简单路径.** 同步释放最容易推理, 但活动 stream 仍可调用已失效的 ExtensionRunner, 且子扩展没有 shutdown 通知.
- **无限等待 abort 和扩展 shutdown.** 能尽量保全扩展自己的收尾, 但任一永不返回的 handler 都会卡死整个父进程退出. 有界等待保留退出能力, 接受超时后的收尾不完整.
- **为可继续的错误设置独立恢复倒计时.** `2caf2d2`, `3af1634`, `0e524c2`, `928ff05`, `5074073` 给出 30 分钟恢复窗口、数量限制、拒绝后保留 deadline 和活动视图暂停的实现依据. 这能回收失败 session, 但把“是否报告错误”绑到用户是否继续和额外时钟. 当前 terminal error 立即交付, 普通保留与 pin 管理可继续资源, 不以恢复倒计时压住父会话结果.

## Consequences

记录从 UI 消失不删除已保存的 [父信箱结果](2026-09-09-parent-result-delivery-and-ack.md). Clear 和 shutdown 后的迟到完成不重新建立记录或新交付. 已保存结果可恢复, 尚未入信箱的活动执行和人工输出没有进程退出保证.

15 秒是每个收尾阶段的边界, 不是整个应用退出的硬时限. [初始化资源交接](../bug-fix/2026-09-10-session-setup-resource-ownership.md) 使创建者在就绪前也通过本关闭操作释放 session, 并保留原始 setup 错误. 可交互的 session 在工具和扩展配置完成后才公开.

## Evidence

- `249ce9d`: 记录按 lifecycle/display/execution/stats 分解. `23adb75`, `42ce1c3`: reload 终止活体及 manager 生命周期.
- `a1a910b`, `6300778`, `19ed1dd`: 未消费记录保留、pin 暂停及 terminal error 即时报告.
- `9891b24`, `1dbcdc7`, `b1f8ad6`, `7d895cf`, `6b0ea12`: 子 shutdown、重入保护、15 秒窗口及 abort-before-dispose.
- `4e5ac95`: Clear 后迟到 session 的身份/状态检查.

## Verification

[manager lifecycle](../../../../test/unit/agents/manager/agent-manager.lifecycle.test.ts)、[shutdown](../../../../test/unit/agents/manager/agent-manager.shutdown.test.ts) 和 [retention scenarios](../../../../test/scenarios/agents/agent-retention.test.ts) 覆盖 queued 等待、中止后结算、迟到初始化、重入、超时、pin 和持久化前保留. 这些检查不证明第三方扩展的外部资源一定在超时前退出.
