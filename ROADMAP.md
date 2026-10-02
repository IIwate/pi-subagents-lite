# Architecture Roadmap

本文档定义 pi-subagents-lite 的架构演进方向。结论基于上游第一手规范与编译产物交叉验证（2026-10-01），2026-10-02 依据 pi v1.0.0 tag diff 复核。真相源优先级：**编译产物（pi-agent-core 1.0.0 dist + pi-durable 1.0.0 dist）> pi-durable `docs/spec.md` > view-and-events.md / plugins.md > hardening-handoff.md > harness.md（v1）**。pico3 提案文档（view-and-events/plugins/hardening-handoff）冻结于 0.99.2 事实；durable 语义以 pi-durable dist 与 spec 为准. Pi 1.0.0 最小完整链路已有[可复现验证](scripts/spikes/pi-durable-boundaries/run.ts), 结果与边界由[执行层决策](.agents/notes/implemented/architecture/2026-10-02-pi-1-0-execution-layer-migration-to-pi-durable.md#verification)持有.

---

## 1. 上游演进基线（真相源）

| 层 | 载体 | 状态 | 对本项目的关键语义 |
|---|---|---|---|
| Harness v1（车道架构） | `pi-agent-core/dist/harness/`（Session/Branch/AgentLane/AgentHarness） | **0.99.x 终版**；1.0.0 起整体从 pi-agent-core 移除（包仅剩 Agent/agent-loop/proxy/types）。本项目生产路径使用 pi-durable 1.0.0 | Session 单 mutation line、`transform_context` 请求局部 hook、effect gate、`pi.result` 终态记录（harness.md） |
| Durable harness（pico3 继任） | **`@earendil-works/pi-durable` 1.0.0 独立包**；`./experimental/pico3` 子路径随 pi-agent-core 1.0.0 删除 | Experimental（README 明示 API 随版本变化） | Harness/Conversation/Entry/Commit/Document/Task/Registry/Extension；`defineTask`（phase-map）+ `defineEntry` + `defineDoc`；内置 kind `GenerationTask`/`ToolTask`/`CompactionTask`；`watchEvents` + `ConversationView`；owned conversations（`ConversationOwnership`）；`ReadAfterWrite` 毒化语义保留；子路径 `./storage/jsonl`、`./storage/sqlite`、`./env/node`（`NodeExecutionEnv`）、`./tools`（`CodingTools`）；README 自带 Abort and Subagents / Child Tasks / Task Graph 章节 |
| Durable 参考实现 | `pi/packages/coding-agent/src/experimental/durable/`（1.0.0 新增；取代 0.99.2 的 micro/ 原型） | 实验性参考实现 | pi 官方 durable coding agent（单进程 Harness + SQLite + pi-tui）；**`subagent.ts` 官方子代理形态**——child conversation owned by call task（`tx.createConversation({ ownership: { kind: "task", taskId } })`）、`scanConversations({ ownerTaskId })` 幂等创建、`settled.answer`（EntryId）引用子答案, 父接收另行确认、child outlives call（`/agents` 切换、busy steer）、abort 传播、`replay: "safe"` 崩溃重放；`Harness.taskGraph()` 面板 |
| 虚拟模型 | `pi-coding-agent` ModelRuntime 层（`core/virtual-models.ts`） | 当前发布 | Selection/Dispatch 解耦、`route(request)`（reason: user/continuation/retry/direct）、router state 以 `pi.virtual-model-state` custom entry 挂载分支、黏性规则（continuation→previous，retry→failed） |
| 工具沙箱与分级暴露 | `pi-coding-agent` codemode + exposure 五级（direct/model-only/codemode/deferred/hidden） | 当前发布（extensions.md、mcp.md） | 工具曝光治理与嵌套调用（`ctx.executeTool`，`parentToolCallId`）的既有契约 |

**关键事实**：pico3 子路径已终止，但其继任 pi-durable 为独立 npm 包——子会话执行底座迁移仍不依赖上游 coding-agent 的采用节奏；本扩展可直接依赖 pi-durable，父会话交互仍走 v1 扩展 API。**依赖锁事实**：本扩展 Pi peer 为 `^1.0.0`, 开发依赖与子执行 pi-durable/chord 固定为 1.0.0; Bun lockfile 固定验收依赖图.coding-agent 1.0.0 CHANGELOG 未声明扩展 API breaking（实际适配仍需定向验证）；TUI 默认全屏（`tuiMode: "regular"` 可回退），宿主升级时需回归导航器渲染模型。

**pico3 → pi-durable 词汇对应物**（2026-10-02 以 v1.0.0 dist 核实）：`defineTask`/`defineEntry` 原名保留；`Envelope`/`applyEnvelope` 无同名导出，视图模型改为 `ConversationView` + `watchEvents`（快照 + `SnapshotEvent`/`MessageChange` 流）；`sendOwned`/`resolveInputs` 对应 `conversation.submit()` + `Submission.wait()`（`settled.answer` 为 `EntryId`，经 `tx.entry(AssistantEntry, id)` 提取）；任务内幂等值对应 `runtime.memo` / `ToolExecutionApi.memo`, 为跨 checkpoint 保留、终态清除的 first-writer-wins 值, 外部副作用仍需自身幂等键；pico3 的 kind 名称不能直接当作能力清单: pi-durable 已有 `GenerationHooks.afterTools`、`beforeRequest` 和 `ToolHooks.beforeTool`. Action Fusion 与 ObservationPack 按真实钩子语义适配, 见 §3.5.

---

## 2. 当前项目基线（已交付，非本路线图范围）

- 子代理隔离会话: 每任务独立 durable Harness + SQLite root Conversation; 父会话交付保留 outbox + 父日志 receipt ACK.
- 接受时策略（工具授权、模型路由、分层并发天花板）与隐形工具注册。
- ObservationPack: GenerationHooks.beforeRequest 请求局部投影、内容寻址归档、`obs_recall` 按页召回（与 harness.md 的 request-local hook 语义合规）。
- TUI 导航器（pi-tui 同步块差分渲染）。

---

## 3. 目标架构（pi-durable 对齐）

### 3.1 子代理 = Owned Conversation
- 执行与恢复使用内置 GenerationTask/ToolTask 和 Submission. 自定义 Task 只承担必要的生命周期归属或持久工作流; 生产每个 Harness 的 root 就是工作会话, 不另造执行循环或无职责的 Anchor.
- root 工作会话归独立 Driver 所有, 父 Pi AgentSession 在外部. 原生 owner 表达任务生命周期, parent 表达历史继承; 任务模式、接管与父交付资格由接受策略和会话 document 表达. 提交使用稳定 requestId.
- 权限边界由扩展落实: ownership 不构成访问控制, 同一 Storage 的 invocation-bound conversation handle 按 ID 解析目标. 接受策略约束工具声明及执行入口, 宿主操作校验父 Session 与任务绑定; 原始 Harness/Tx 仅交给可信代码. 详见[迁移边界验证](.agents/notes/implemented/architecture/2026-10-02-pi-1-0-execution-layer-migration-to-pi-durable.md#decision).
- **呈现边界**：父视图只见父工具 slot 的 `details`（上游实证：`details: { conversationId }`）；渲染子代理的 UI 直接 watch 子会话（概念沿用 view-and-events.md §9.5，pico3 提案冻结版）。
- **存储选择**: 生产采用每个子代理独立 Harness + SQLite, 接受策略、控制权和确认状态用 session-scoped document 保存. Linux/Node 24 的生产场景验证了单实例重开、配额重新准入与 cwd/工具隔离; 没有进行共享存储或 JSONL 性能比较. 两种拓扑都需要跨 Pi 父日志确认, 独立 Storage 不提供进程或文件系统沙箱隔离. 同提交任务图或实测资源成本出现新要求时再重评估共享方案.
- 恢复读取不隐式启动任务; `submit()` 和 `wait()` 会启用调度, 须在模型/工具效果前完成配额准入. 观察取消、人工接管、运行停止与 Harness.close 分别映射, 接管后的输出只供显式选择.

### 3.2 子结算、父接收与幂等
- 父→子指令使用 `submit` 与稳定 requestId; `Submission.wait()` 的 `done/input` 结果通过 answer EntryId 引用子答案, `unanswered` 单独处理. 子完成不证明 Pi 父日志已接收结果.
- 向 Pi 父会话交付仍需持久待交付状态与父 receipt ACK. 自动交付检查来源 Session/分支、用户停止和控制权; 人工选择保留独立快照与身份. 父落盘失败保留结果, 父已落盘而 ACK 失败时重试复用 receipt. 详细契约由[父交付 Note](.agents/notes/implemented/architecture/2026-09-11-native-execution-and-parent-delivery-adapters.md#parent-write-boundary)持有.
- 任务内 memo 跨 checkpoint 保留、终态清除; requestId 在 conversation 内判重. 跨任务的交付身份、确认状态和控制状态需独立持久寿命, 其 history/fork 策略不得令已交付事实因历史回退丢失. memo 不保证外部副作用只发生一次.

### 3.3 视图 = Watch（ConversationView + watchEvents）
- 每个子代理会话一个 watch（`ConversationWatch`/`watchEvents`）：首帧快照（`ConversationView`/`SnapshotEvent`）+ 连续变更流（`MessageChange` 等事件仅作语义注解），快照 ≡ 增量。
- 任务终态与 slot 清理在单次物理提交（commit）中同步到达，无撕裂。
- TUI 渲染以 watch 驱动，无轮询与事件旁路；上游参考实现以 `Conversation.viewState()` 为唯一渲染源。

### 3.4 工具 = ToolTask 持久化 + 分级暴露
- 工具持久化由内核接管：`ToolTask` checkpoint 保存恢复阶段, 外部副作用是否已完成仍需其自身证据；`replay: "safe"` 崩溃重放（上游 `subagent.ts` 实证）；unsafe 恢复合成 interrupted 错误结果；有界工具输出使用 `ToolExecutionApi.output()` 与 `ToolRegistration.outputLimits`（maxBytes/maxLines/retain）。
- 曝光治理对齐上游五级（direct/model-only/codemode/deferred/hidden）；接受时授权（ToolSourceGrant）以持久接受快照约束声明和执行, 配置变化不得扩张已接受任务的权限; document 的 history/fork 策略按该不变量选择。

### 3.5 项目本地保留层（不归源上游）
- **ObservationPack**：通过 GenerationHooks.beforeRequest 接入请求局部投影；归档落点为 custom entry kind（`defineEntry` 原名存活）或外部内容寻址存储，`obs_recall` 为 safe 工具。
- **Action Fusion**：edit/write 的 `then_run` 参数融合，纯执行期装饰、零持久足迹；命令经嵌套执行路由接受策略门控。PiResources 在注册前装饰官方 edit/write, PiToolHost 将其映射为原生 unsafe ToolTask. then_run 经过现有嵌套执行门, 保持命令授权、文件串行和结果合并.
- **并发天花板**: 复用应用层 Model/Provider Quota, 取得租约后才启用该子代理 Harness 调度, 实际执行退出后释放. 恢复时重新准入, 读取持久状态不启动模型. TaskOptions 没有 `after` 字段, 原生任务等待依赖不替代配额租约.
- **虚拟模型调度**：实现于 pi-durable `Models` 适配器（resolve/stream 拦截），router state 经 custom entry 持久，遵守黏性规则与 retry/failed 语义。

---

## 4. 里程碑

**当前阶段: Pi 1.0 生产执行层替换已落地.** 正式入口使用 DurableDriver、独立 SQLite、会话 document 和原生 Task/Submission. 模型验证仅使用离线 provider, 配合真实宿主、工具效果、持久化与故障注入. 每次依赖升级复核行为与导出面; 跨平台和全量验证由 CI 承担.

本次交付保持既有工具入口、接受策略、资源、配额、模型选择、父交付、ObservationPack、Action Fusion 与导航能力. M5 新增分相调度和长程自愈独立于这次迁移.

### M1: 子会话执行底座迁移至 pi-durable (已落地)
- DurableDriver 与 NativeTaskStore 接入正式 Runtime 和 Agent 工具. 每个任务独立 SQLite, 恢复发现不自动执行; 模型和工具效果在配额准入后开始.
- 原生 Task/Submission 管执行与恢复, 接受请求/控制/交付文档不随工具终态清除. 应用结果写入失败可仅凭原生 Session 重建答案.
- 0.99.x JSONL 子会话不兼容、不读取或迁移; 新格式路径与约束由执行层决策维护.

### M2: 交付与凭证语义收敛 (已落地)
- 子结算与父接收分别确认; session-scoped document 保存 outbox/receipt, 父日志是 ACK 依据.
- 生产场景覆盖父落盘/ACK 失败、重复重开、来源分支/Session、停止与接管的竞争.

### M3: 视图管道迁移 (已落地)
- Conversation.watch 与应用 document watch 驱动既有 ExecutionSnapshot, 导航继续消费统一 Source.
- 原生工具/模型文本经过已有终端过滤与光标所有权路径; 离线导航场景覆盖输入和选择, 物理终端表现仍需对应环境验证.

### M4: 工具持久化与分级暴露对齐 (已落地)
- 原生 ToolTask 管 replay 与结果持久化; PiToolHost 保留声明/执行双门、嵌套管线和结构化结果.
- 生产场景覆盖 cwd、来源授权、MCP 延迟发现与重开、ObservationPack, 以及 Action Fusion 的命令执行与拒绝.

### M5: 虚拟模型调度与长程自愈 (后续能力)
- 本次迁移只恢复既有模型选择、限额与 ObservationPack 行为, 不新增 router 自驱分相派发.
- 新增虚拟模型调度、持久 router state 与长程自愈另行定义目标和验收, 在生产迁移完成后评估.

---

## 5. 非目标与边界

- **不替换父会话宿主**：父会话由上游 coding-agent 的 AgentSession/SessionManager 拥有；本扩展只拥有子会话执行底座。上游 coding-agent 自身的 durable 迁移（`experimental/durable` 方向，Micro 已终止）发生后另行评估。
- **不发明跨进程锁**：单进程单 Session 拥有一个 Storage 路径（hardening-handoff.md §7）；多进程共享不在范围内。
- **可信代码边界**: 使用公开 Registry/Extension、Task/Document 和事务 API, 不把 ownership 或命名空间宣称为授权机制; 模型可触达的操作由本项目接受策略控制.
- **项目本地概念显式标注**：ToolSourceGrant、并发配额租约、跨 Pi 父会话交付、人工接管、ObservationPack、Action Fusion 为本扩展职责，文档与代码中不得归源于上游规范。
