# Agent Note: Shell 服务所有权与跨 reload 交接

Status: implemented

## Problem

Pi 通过 Jiti 加载扩展, 子 session 还会再次加载同一扩展. 导出可重新赋值的模块变量会让调用方持有陈旧引用; 子扩展重新初始化又可能覆盖父服务. reload 期间未成功保存的结果需要交接, 但不能让一个父会话覆盖另一个的结果.

## Decision

[src/shell.ts](../../../../src/shell.ts) 用一个稳定的 holder 保存 Pi API、当前 context、ConfigStore 和 manager/coordinator/navigator 引用. 工具/事件通过 getter 在调用时读取当前值; 不把可变服务重新导出为 let. ConfigStore 在模块构造时建立, session_start reload; 其余服务按需构造, session_shutdown 释放. Shell 不是业务状态的第二份副本, 也不提供并行多个独立 activation 的隔离保证.

跨 Jiti 重载的状态仅放在 `globalThis[Symbol.for("@iiwate/pi-subagents-lite/process-state-v2")]`: 按 parentSessionId 分桶的 fallbackResults 和 `AsyncLocalStorage<boolean>` child-spawn 标记. fallback 仅保存父日志 append 失败的 payload, 新 coordinator 取走本会话桶, 不恢复 AgentSession. 当前保留已运行进程中单槽位 handoff 的一次转换; 不据此承诺跨版本持久格式迁移.

`withSubagentSpawn` 包住 child setup/run 异步链. index 在该作用域中直接返回, 使子实例不注册本扩展服务, 同时不阻止无关父会话 reload. 工具层还排除 Agent, 详见 [子资源门禁](2026-09-10-isolated-child-resources-and-tool-gates.md). 标记是同进程递归防线, 不是跨进程全局并发控制.

shutdown 逐项尝试通知、navigator、manager、coordinator、store 清理, 保留第一个错误供 Pi 记录. UI 失败不阻断真实 session 的关闭; manager 先于 coordinator 关闭, 让后者有机会处理已暂存结果的最终 flush/handoff. 关闭细节由 [session teardown](2026-09-10-agent-lifecycle-and-session-teardown.md) 负责.

## Alternatives considered

- **普通可变 ESM 导出或父子共享初始化.** 依赖标准模块缓存时直接简洁, 但当前 Jiti/child load 边界不提供所需稳定性, 可覆盖父上下文或保留旧 API.
- **单槽位全局 fallback.** 数据结构最小, 但多个 session reload 可以覆盖彼此结果. session-keyed Map 保留来源, 代价是进程存活期间持有尚未取走的桶.
- **显式闭包捕获 ExtensionRuntime.** 固定的 Pi 回调签名并不阻止注册时闭包注入; 这是可行替代, 不是“宿主不支持 DI”. 未合入 `165fbee` 提供实现证据, 有利于隔离多个 runtime 和减少 Shell mocks. 迁移需同时处理所有入口, 因而 [模块边界提案](../../proposed/architecture/2026-09-10-capability-boundaries-and-explicit-runtime.md) 独立评审, 不影响当前事实维护.
- **把活体 session 和全部配置也放入 globalThis.** reload 后表面上可继续访问, 但句柄可能绑定失效 ExtensionRunner, 所有权和销毁边界不明确. 仅有真实跨 reload 需求的两类状态进入 process container.

## Consequences

同一 runtime 内可读取最新服务, fallback 按 session 隔离. process-local handoff 无法抵御进程崩溃, 必须与 [durable inbox](2026-09-09-parent-result-delivery-and-ack.md) 区分, 不宣称零丢失. Shell 依赖也会隐藏模块间耦合, 当前测试既有 Shell stub 的单元层, 也有真实装配场景.

## Evidence

`5b3de8d`, `8aed07b`, `4681a36`, `c143c34` 记录共享状态/holder 的问题与尝试; `cc82391`, `e3636fa`, `4678b95` 确立组合根、注册/事件拆分和 coordinator. `fb02e28`, `7de96d1`, `7bc6759`, `2791388` 记录 stale Pi API 回调问题. `19ed1dd` 确立分桶交接; `2ce56bc`, `6b0ea12` 记录清理顺序. `165fbee`, `95bcc64` 是 origin/re 的替代设计, 不是主线实现.

## Verification

[shell](../../../../test/unit/shell.test.ts)、[index](../../../../test/unit/index.test.ts)、[events scenarios](../../../../test/scenarios/events.test.ts)、[reload](../../../../test/scenarios/shell-reload.test.ts) 和 [fallback scenarios](../../../../test/scenarios/spawn/session-fallback.test.ts) 检查当前服务、递归隔离及本会话 handoff. [manager shutdown](../../../../test/unit/agents/manager/agent-manager.shutdown.test.ts) 检查真实执行资源的清理边界.
