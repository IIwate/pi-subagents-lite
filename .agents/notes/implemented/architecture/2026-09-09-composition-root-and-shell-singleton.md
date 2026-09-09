# Agent Note: 运行时 Shell 模块单例与 Composition Root 设计

Status: implemented

## Problem

在 Pi 扩展的运行时生命周期与依赖管理中，早期架构面临四大结构性缺陷：
1. **宿主回调签名固定**：Pi 运行时的工具执行（`execute`）及事件监听器（`before_agent_start`、`session_start` 等）以固定的函数签名调用，不允许传递自定义依赖上下文，依赖项必须能从模块级作用域中被触达；
2. **Jiti 动态加载与 ESM 可变导出（Live-binding）失效**：Pi 运行时通过 Jiti 加载扩展且禁用模块缓存。如果使用模块级可变 `let` 变量并重新导出（例如每次 `setConfig()` 时重新赋值 `let __config`），ESM 的实时绑定重新赋值机制无法在非缓存模块间可靠广播，极易引发不同文件读取到陈旧配置对象的致命指针陷阱；
3. **跨模块热重载的状态灭失与交接冲突**：用户在运行中执行 `/reload` 或修改配置触发 Jiti 重新编译时，所有普通模块级状态当场销毁。若此时恰有正在完成、尚未落盘的子代理结果，会导致数据交接中断；早期单槽位暂存又极易引发多会话间的数据踩踏；
4. **子代理递归分形派发的死锁风险**：若子代理在自己的独立会话中再次被赋予了 `Agent` 工具，缺乏调用栈防护的系统可能陷入递归生成孙代理的无休止资源爆炸。

## Decision

系统在 `src/shell.ts` 中建立模块级 Holder 单例模式与进程级状态容器，作为轻量级的 Composition Root：

1. **单例获取器与消除可变导出**：
   - 彻底废除散落的 `let` 重新导出，统一收敛至 `src/shell.ts`：通过 `getStore()`、`getManager()`、`getCoordinator()`、`getNavigator()` 及 `setSessionCtx()` 等明确的 Getter/Setter 访问当前活跃依赖；
   - 保证所有业务闭包在执行时永远读取到当前最新的有效实例。

2. **会话级生命周期精准对齐（Session Lifecycle Alignment）**：
   - Shell 本身极其轻量，不持有任何具体业务领域状态；
   - 所有会话级服务（`ConfigStore`、`AgentManager`、`SpawnCoordinator`、`AgentNavigator`）统一在 `session_start`（`src/events.ts`）时初始化构建并挂载到 Shell，并在 `session_shutdown` 时显式调用析构释放。

3. **跨 Jiti 重载的进程级状态容器（`process-state-v2`）**：
   - 通过 `globalThis[Symbol.for("@iiwate/pi-subagents-lite/process-state-v2")]` 锚定跨越 Jiti 重新执行周期的物理进程内存；
   - **会话级隔离交接桶（`fallbackResults`）**：结构采用 `Map<string, PendingResult[]>`，以 `parentSessionId` 严格隔离。当父会话文件因极端错误不可写或处于重载间隙时，未完成落盘的结果暂存在对应会话的桶中，由重载后的新协调器精准接管，彻底杜绝跨会话串扰，并平滑兼容历史单槽位快照。

4. **基于 `AsyncLocalStorage` 的调用链追踪与防递归死锁**：
   - 容器内置 `subagentSpawn: AsyncLocalStorage<boolean>`；
   - 子代理派发与执行被包裹在 `withSubagentSpawn` 作用域内。系统通过该异步上下文在调用链上实施安全门禁，物理阻止子代理再次调用 `Agent` 派发孙代理，根除递归分形派发的雪崩隐患。

```ts ignore-check
// src/shell.ts 中的进程级状态容器与单例范式
interface ProcessState {
  fallbackResults: Map<string, PendingResult[]>;
  subagentSpawn: AsyncLocalStorage<boolean>;
}

const processState = ((globalThis as any)[Symbol.for("@iiwate/pi-subagents-lite/process-state-v2")] ??= {
  fallbackResults: new Map<string, PendingResult[]>(),
  subagentSpawn: new AsyncLocalStorage<boolean>(),
}) as ProcessState;
```

## Alternatives considered

- **依赖标准 ESM 模块缓存跨重载共享状态** — 方案最纯粹，无需接触全局 `globalThis`。但 Pi 宿主环境基于 Jiti 动态加载并显式启用了无缓存模式，模块每次热重载都会被当成全新文件执行，普通模块级变量无法存活。
- **保留单槽位全局 Handoff（v1 设计）** — 早期使用单个变量暂存热重载中的 pending 结果，在用户快速切换或多会话并发交替时，后一个会话的结果会直接覆盖并抹除前一个会话的交接数据，必须使用按 `sessionId` 隔离的 Map。
- **基于请求上下文的纯依赖注入（Request-scoped DI）** — 理论最优雅，但 Pi 宿主环境的回调函数签名不支持传入自定义 Context，没有外部注入通道。
- **保留 `state.ts` 散落全局可变命名空间** — 存在 `let` 重新导出的陈旧指针 bug，单测需要 Mock 十几个模块，且读写约定完全缺乏硬性约束。

## Consequences

- **收益**：彻底消除了 ESM 可变导出的陈旧引用缺陷；服务生命周期边界清晰受控；跨 Jiti 重载时未落盘数据零丢失且按会话严格隔离；杜绝了子代理递归调用的死锁风险；单测可对 `shell.js` 进行单一模块替身置换。
- **代价与已知上限**：使用了 `Symbol.for` 在进程全局注册命名空间，需维护版本标识（`process-state-v2`）以防旧版加载冲突；极少数在 `session_start` 之前触发的偶发初始化逻辑无法访问服务。

## Verification

- 服务生命周期初始化由 [test/scenarios/events.test.ts](../../../../test/scenarios/events.test.ts) 验证, 管理器销毁边界由 [test/unit/agents/manager/agent-manager.shutdown.test.ts](../../../../test/unit/agents/manager/agent-manager.shutdown.test.ts) 验证.
- 跨重载交接与会话隔离由 [test/scenarios/shell-reload.test.ts](../../../../test/scenarios/shell-reload.test.ts) 和 [test/scenarios/spawn/session-fallback.test.ts](../../../../test/scenarios/spawn/session-fallback.test.ts) 验证.
- 单元测试通过 `shellMock`([test/support/fixtures.ts](../../../../test/support/fixtures.ts)) 提供局部依赖. 交付场景通过 [test/support/agent-scenario.ts](../../../../test/support/agent-scenario.ts) 装配真实 Shell 服务, 资源清理边界由 [test/scenarios/harness.test.ts](../../../../test/scenarios/harness.test.ts) 验证.
