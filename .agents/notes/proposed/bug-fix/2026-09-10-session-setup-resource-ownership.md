# Agent Note: Session 初始化失败前的资源接管

Status: proposed

## Problem

[createAndConfigureSession](../../../../src/agents/agent-runner.ts) 在 initSession 返回真实 session 后继续 setSessionName、bindExtensions、工具过滤, 最后才调用 manager 的 onSessionCreated. 当前仅 signal abort 路径 dispose; 普通 bindExtensions 或后续配置抛错时, Manager 还没有这个 session, 不能走自己的 closeSession. 因而“已创建但未被接管”的资源没有失败关闭者.

已安装 Pi 的 AgentSession.dispose 会清除 event listeners, 因而丢弃 lifecycle subscribe 的返回值本身不构成另一个已证实泄漏. 缺口是这些失败路径没有到达 dispose, 不是需要重复实现 Pi 已有的监听器清理.

## Proposal

推荐显式划分创建者持有和 Manager 接管: 从 createAgentSession 成功开始, 创建者负责所有 setup 失败路径; only after 完成配置并成功交接才释放这份关闭责任. setup error、abort、clear 和迟到接管共用一次关闭所有权, 复用 [既有有界 teardown](../../implemented/architecture/2026-09-10-agent-lifecycle-and-session-teardown.md), 不复制一套无 shutdown 的裸 dispose.

不能简单把正常 session 提前公开给 UI: 用户 steer/continue 可能进入尚未配置工具权限的实例. 可先登记关闭责任, 再把“可交互就绪”作为明确时点. setup cleanup 保留原错误, 收尾失败作附加诊断, 不盖掉最初的 provider/extension error.

这可在现有 runner/manager 内完成, 不依赖全量 session-driver 重构.

## Alternatives considered

- **依赖 Pi 或 GC 自动回收.** 无扩展代码变化, 但本地 timers、子进程或 socket 不由 JS 对象失去引用自动可靠关闭; 当前没有自动 shutdown 证据.
- **session 一创建就 onSessionCreated.** Manager 立即能关闭它, 但现有 callback 还会 flush pending steers, 可能在 bind/工具过滤前暴露实例. 资源接管与交互就绪应区别.
- **每个 catch 单独 session.dispose.** diff 小, 但容易重复关闭且绕过子扩展 shutdown/有界 abort 的既有契约. 推荐统一关闭责任.

## Acceptance criteria

- bindExtensions、setSessionName、工具过滤、onSessionCreated 抛错均不泄漏已创建 session, 各自恰好一次关闭且保留原错误.
- abort 与 setup reject/late success 竞争时, 不 prompt、不 flush steer 到未就绪 session, 不重复 shutdown/dispose.
- 正常成功交接和人工继续仍使用原 session, 不因失败清理保护而过早关闭.
- 扩展 [runner setup/tools tests](../../../../test/unit/agents/runner/agent-runner.tools.test.ts) 和 [manager shutdown](../../../../test/unit/agents/manager/agent-manager.shutdown.test.ts), 以事件 gate 控制时序, 不使用任意 sleep.

## Risks

Pi 对未完全 bind 的 ExtensionRunner 是否允许 shutdown emit 需要实际 host 契约验证; 不能在 catch 中调用尚未可用的对象. 提前公开 session 会改变输入时机, 所以实施必须保留 readiness 区别和已接受工具边界.
