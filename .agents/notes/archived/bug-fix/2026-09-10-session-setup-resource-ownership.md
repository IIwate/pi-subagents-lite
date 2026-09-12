# Agent Note: Session 初始化与关闭责任交接

Status: implemented

Archived: 2026-09-12

## Problem

创建真实 session 和完成工具、扩展配置不是同一时点. 在 Manager 尚未接管时, setup 失败也必须释放资源; 过早公开实例则允许用户向工具边界尚未配置完成的会话输入.

## Decision

[runner](../../../../src/agents/agent-runner.ts) 在 createAgentSession 返回后立即持有失败关闭责任, 覆盖重试配置、setSessionName、bindExtensions、工具过滤及 onSessionCreated. 创建后的配置全部位于同一个异常保护内. 只有完成配置且接管回调成功返回才交接资源; 正常完成后的保留 session 继续由 Manager 管理.

RunOptions 显式接收 Manager 的 closeSession 操作. setup error 和 abort 共用本次初始化的关闭 Promise, Manager 再按 session identity 共享同一关闭 Promise. Manager 在调用任何可重入 hook 前登记关闭操作, Clear、dispose 和迟到回调不会重复 shutdown/dispose. [既有 teardown](../architecture/2026-09-10-agent-lifecycle-and-session-teardown.md) 负责有界 abort、session_shutdown 和最终 dispose.

每个异步配置边界及就绪交接前后检查取消. 取消后的迟到成功不进入 prompt 或 pending steer flush. onSessionCreated 先校验 Manager/记录状态, 再绑定生命周期监听器、公开可交互实例和发送暂存 steer. 失败关闭撤下相同 session 的执行引用, 并丢弃未交付的 pending steers.

setup 的原始异常向调用者保留. 关闭失败只增加诊断, 不替换 provider/extension 错误. Pi session.dispose 清理生命周期监听器, 因此不重复管理 Pi 已拥有的 unsubscribe. Pi 的 session 构造阶段建立 ExtensionRunner, 关闭操作使用 session 的现有 runner 发送 shutdown.

## Alternatives considered

- **维持成功接管后才负责关闭.** 正常路径最简短, 但已经创建的实例可能在接管前失败, GC 无法代替扩展连接或进程的关闭协议.
- **创建后立即公开 session.** Manager 能尽早清理, 但现有公开点同时允许 steer, 会暴露尚未配置完成的工具权限.
- **每个 catch 裸调用 dispose.** 局部 diff 小, 但绕过扩展 shutdown 和有界 abort, 多个竞争路径还会重复关闭.

## Consequences

初始化失败不保留可继续的半配置实例; 成功交接后的 provider error 和人工继续保留原 session. 15 秒窗口限制等待, 不保证第三方扩展挂起的操作物理退出. createAgentSession 返回之前的内部失败仍由 Pi 的创建过程负责.

## Verification

[runner setup/tools](../../../../test/unit/agents/runner/agent-runner.tools.test.ts) 用事件 gate 覆盖命名、绑定、工具过滤、接管失败、清理失败和取消后迟到创建. [Manager shutdown](../../../../test/unit/agents/manager/agent-manager.shutdown.test.ts) 检查未就绪实例的共享关闭 Promise、有界关闭、Clear 和重入. 正常保留和继续由 [Pi session 场景](../../../../test/scenarios/agents/pi-session.test.ts) 及既有 interaction checks 覆盖.
