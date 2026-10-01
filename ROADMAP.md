# Architecture Roadmap

本文档定义 pi-subagents-lite 的架构演进方向。结论基于上游第一手规范与编译产物交叉验证（2026-10-01），真相源优先级：**编译产物（pi-agent-core 0.99.2 dist）> view-and-events.md / plugins.md > hardening-handoff.md > harness.md（v1）**。上游文档间取代关系以 hardening-handoff.md §1 的 supersession 清单为准。

---

## 1. 上游演进基线（真相源）

| 层 | 载体 | 状态 | 对本项目的关键语义 |
|---|---|---|---|
| Harness v1（车道架构） | `pi-agent-core/dist/harness/`（Session/Branch/AgentLane/AgentHarness） | 当前发布主干，本扩展的现行宿主 | Session 单 mutation line、`transform_context` 请求局部 hook、effect gate、`pi.result` 终态记录（harness.md） |
| Pico3 不可变内核 | `pi-agent-core/dist/harness/pico3/`，以 **`./experimental/pico3` 子路径导出** | **已编译发布于本项目依赖的 0.99.2**，experimental 标记 | Fixed Core（六个内置 kind：`pi.generation`/`pi.tool`/`pi.post_tools`/`pi.collapse`/`pi.job`/`pi.plugin`）、FIFO Session line、RYW overlay + `ReadAfterWrite` 毒化、四持久原语、`ConversationView` + `Envelope{revision, ops, events}` + `applyEnvelope`、owned conversations |
| Micro 原型 | `pi/packages/coding-agent/src/experimental/micro/` | 实验性参考实现 | 单进程独占 ModelRuntime + Pico Harness + JsonlStorage，无 server/worker/RPC；TUI 只消费只读 `MicroView` + 窄 `MicroController`，无事件旁路 |
| 虚拟模型 | `pi-coding-agent` ModelRuntime 层（`core/virtual-models.ts`） | 当前发布 | Selection/Dispatch 解耦、`route(request)`（reason: user/continuation/retry/direct）、router state 以 `pi.virtual-model-state` custom entry 挂载分支、黏性规则（continuation→previous，retry→failed） |
| 工具沙箱与分级暴露 | `pi-coding-agent` codemode + exposure 五级（direct/model-only/codemode/deferred/hidden） | 当前发布（extensions.md、mcp.md） | 工具曝光治理与嵌套调用（`ctx.executeTool`，`parentToolCallId`）的既有契约 |

**关键事实**：Pico3 已在项目自身依赖中可用，子会话执行底座迁移不依赖上游 coding-agent 的采用节奏——子会话完全归本扩展所有，可独立替换执行底座；父会话交互仍走 v1 扩展 API。

**dist 与提案文档的两处差异**（以 dist 为准）：`Harness.open` 保留 `plugins?: { [name]: PluginHandler }` 与 `pi.plugin` 便利 kind（非插件机制本体）；折叠函数导出名为 `applyEnvelope`（文档中称 `applyImmutable`）。

---

## 2. 当前项目基线（已交付，非本路线图范围）

- 子代理隔离会话（独立 JsonlSessionRepo .jsonl）+ 父会话持久交付（outbox + 落盘 receipt ACK）。
- 接受时策略（工具授权、模型路由、分层并发天花板）与隐形工具注册。
- ObservationPack：`transform_context` 请求局部投影、内容寻址归档、`obs_recall` 按页召回（与 harness.md 的 request-local hook 语义合规）。
- TUI 导航器（pi-tui 同步块差分渲染）。

---

## 3. 目标架构（Pico3 对齐）

### 3.1 子代理 = Owned Conversation
- 子代理运行 = pico3 内核内的普通 task kind（`defineTask`，phase-map 状态机：`initial` + 穷举 `phases` + `abort`；in-flight 相位在外部副作用前写入，仅由调度器 reopen 后进入）。
- 子会话 = 父任务经 `ToolApi.conversation(spec)` / `createOwnedConversation` 创建的 owned conversation；血统（owner/parent 图）由内核维护，reopen 后重建（`ownerTaskCache`）。
- 权限边界内生：任务只能触达自己的会话与其 owned 子树（`assertScope`）。
- **呈现边界**：父视图只见父工具 slot 的 `details`/`continuedBy`；渲染子代理的 UI 直接 watch 子会话（view-and-events.md §9.5）。
- **决策门（M1 前置）**：owned conversation（同一 Storage，血统内生）vs 独立 Storage（崩溃域隔离更强）。裁决标准：跨进程/跨崩溃交付语义与父会话存储体积的平衡。

### 3.2 交付 = Input 结算 + Memo 幂等
- 父→子指令 = `sendOwned`（Input 入队）；子→父结果 = 父侧 Input 经 `resolveInputs(ids, {status:"done", answer: entryId})` 结算——**answer entry id 即持久收据**，ACK 语义由内核落盘保证。
- 任务寿命内幂等 = `memoOnce`（tool slot）；跨任务/跨重启幂等键 = namespace slice（字符串持久，token 仅为运行时权限）。

### 3.3 视图 = Watch + applyEnvelope
- 每个子代理会话一个 watch；首帧快照 + 连续 `Envelope{revision, ops, events}`，纯函数折叠，快照 ≡ 增量。
- 事件（`task.*`/`tool.*`/`generation.*`/`plugin.*`）仅作语义注解，ops 完全决定副本——任务终态与 slot 清理在单次物理提交中同步到达，无撕裂。
- TUI 渲染以 envelope 驱动，无轮询与事件旁路。

### 3.4 工具 = pi.tool 持久化 + 分级暴露
- 工具持久化由内核接管：`pi.tool` 的 `started{call}` checkpoint 即副作用证据；`replay: "safe"` 崩溃重放；unsafe 恢复合成 `interrupted` 错误结果；内核拥有有界流式（`api.stream`，字节/行数双界）。
- 曝光治理对齐上游五级（direct/model-only/codemode/deferred/hidden）；接受时授权（ToolSourceGrant）实现为 rewindable `selectedTools` + namespace slice 策略切片。

### 3.5 项目本地保留层（不归源上游）
- **ObservationPack**：实现为 pico3 请求局部 hook（request-local 语义）；归档落点为 custom entry kind（`defineEntry`）或外部内容寻址存储，`obs_recall` 为 safe 工具。
- **并发天花板**：准入策略层，实现于 task kind 的 `after` 依赖 + 准入时 `busy`/配额检查，一个 commit 内 check-and-record。
- **虚拟模型调度**：实现于 pico3 `Models` 适配器（resolve/stream 拦截），router state 经 custom entry 持久，遵守黏性规则与 retry/failed 语义。

---

## 4. 里程碑

**当前阶段定位：承上启下。** 在 v1 harness 上固化既有架构，交付、幂等与视图边界的概念模型向 §3 对齐，不新增偏离 Pico3 模型的私有抽象；版本升级时跟踪 `./experimental/pico3` 导出面变化，保持本文档与上游 dist 同步。

**M1 启动为信号门控，非时间计划**，满足任一即启动：
1. Pico3 脱离 experimental（导出进入包根或上游声明稳定）；
2. 上游 coding-agent 主干开始采用 Pico3（Micro 毕业或官方迁移指南出现）。

### M1：子会话执行底座 Pico3 化
- 以 `./experimental/pico3`（pi-agent-core 0.99.2 已发布）构建子会话执行底座：子代理运行 = 自定义 task kind，子会话 = pico3 conversation。
- 完成 §3.1 决策门（owned conversation vs 独立 Storage）的 spike 验证并留痕。
- 私有持久化格式（引擎执行记录）全量映射至四原语；崩溃恢复由 phase-map + checkpoint 接管。

### M2：交付与凭证语义收敛
- owned 模型下：交付迁移至 `sendOwned`/`resolveInputs`，outbox + receipt 机制退役；跨存储模型下：保留 receipt ACK 但对账语义对齐 Input 结算模型。
- 幂等凭证分层落地：slot memo（任务寿命）/ namespace slice（跨任务）。

### M3：视图管道迁移
- 导航器与子代理渲染迁移至 watch + `applyEnvelope`；终态与流式清场原子发布。
- 渲染侧边界对齐 Micro 的 MicroView/MicroController 纪律。

### M4：工具持久化与分级暴露对齐
- 工具执行迁移至 `pi.tool` 契约（replay 声明、有界流式、memo）。
- 曝光治理对齐上游五级词汇；ToolSourceGrant 落点为 rewindable 配置 + namespace slice。

### M5：虚拟模型调度与长程自愈
- 在 `Models` 适配器接入 Selection/Dispatch 解耦路由，state 经 custom entry 持久；分相派发由 router state 自驱。
- ObservationPack 完成 pico3 hook 化迁移；并发天花板与准入策略在单 line 上原子化。

---

## 5. 非目标与边界

- **不替换父会话宿主**：父会话始终由上游 coding-agent（v1 harness）拥有；本扩展只拥有子会话执行底座。上游 coding-agent 自身的 pico3 迁移（Micro 方向）发生后另行评估。
- **不发明跨进程锁**：单进程单 Session 拥有一个 Storage 路径（hardening-handoff.md §7）；多进程共享不在范围内。
- **不扩展核心权限**：`pi.*` kind、`boundary`/`resolveInputs`/核心 entry 追加为内核保留；扩展只用 ordinary kind + 注册能力（plugins.md §1 原则 4）。
- **项目本地概念显式标注**：ToolSourceGrant、并发配额租约、ObservationPack 为本扩展差异化能力，文档与代码中不得归源于上游规范。
