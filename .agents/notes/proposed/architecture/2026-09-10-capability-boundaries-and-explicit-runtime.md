# Agent Note: 显式 Runtime 与扩展内部能力适配的 v3 架构

Status: proposed

## Problem

基线 `f8aa1ae` 的 src 包含 47 个 TypeScript 文件、11,524 行. AgentNavigator、AgentManager 和 runner 分别为 1,925、940 和 788 行; 15 个文件引用 Shell, catalogue 还拥有模块级 registry 和扫描目录状态. 展示代码读取活体 AgentSession, 执行与资源关闭混合, 交付从全局容器反查父上下文. 行数不是缺陷本身, 拆文件也不构成解耦证据.

官方 coding-agent 的父会话与原生 AgentHarness 具有不同接入表面. 扩展需要作为标准 npm 插件运行在未经修改的官方宿主中, 将执行、父交付和终端差异集中在内部 Adapter, 使任务策略与展示可以独立维护.

## Proposal

v3 的实现与修改范围限于 pi-subagents-lite 仓库. ExtensionRuntime 是激活级组合根, 通过构造器和注册闭包传入窄依赖. TaskEngine 与执行 Driver 管理后台工作, Navigation/View 管理前端交互, 两者使用只读状态和明确动作交流.

ExecutionDriver/LaneDriver 在扩展内部调度原生 `@earendil-works/pi-agent-core`. ParentDeliveryAdapter 接入官方父会话 API, UI Adapter 复用现有 Pi TUI 视图与键盘机制. catalogue、配置、任务和 UI 状态属于 Runtime 实例, 不使用全局服务定位器.

阶段 1 的 [Task/Policy/Quota 领域 API](../../implemented/architecture/2026-09-11-task-policy-and-quota-domain.md) 与阶段 2 的 [原生执行/父交付 Adapter](../../implemented/architecture/2026-09-11-native-execution-and-parent-delivery-adapters.md) 已建立独立模块和定向场景. TaskEngine 可从官方扩展工具入口运行子任务并验证父接收. 产品 UI 和 ExtensionRuntime 装配按后续阶段交付; 本提案在实际实现完成后以事实毕业至 implemented.

## Host adapters and facet boundaries

当前核心验证版本是 `@earendil-works/pi-agent-core@0.85.1`. 官方 coding-agent 的常规 [SDK](https://github.com/earendil-works/pi/blob/d12cd92e45e308d4af000554292165ef1984253b/packages/coding-agent/src/core/sdk.ts) 创建 Agent 与 AgentSession, 并不向插件提供父 Harness. 因此, 当前父会话由 Pi 持有, 子任务原生 Session/Harness 由扩展持有. 两者通过 ParentDeliveryAdapter 交付, 不描述为同一个物理 Session.

上游 [插件设计](https://github.com/earendil-works/pi/blob/d12cd92e45e308d4af000554292165ef1984253b/packages/agent/docs/plugins.md) 与 [experimental 服务边界](https://github.com/earendil-works/pi/blob/d12cd92e45e308d4af000554292165ef1984253b/packages/coding-agent/src/experimental/services/README.md) 将 Session Worker 和 Presentation 分开, 并按 src/session.ts、src/tui.ts 约定发现插件分面. 执行和展示的拆分与这个方向一致; 具体服务、RPC、加载及生命周期契约仍取决于届时的官方接口. 当前同进程内部调用直接使用 TypeScript 类型和函数, 不预建 RPC 层.

内部 Adapter 的职责如下:

- ExecutionDriver/LaneDriver 拥有子执行资源、原生队列、订阅、取消和关闭, 将原生事实投影给 TaskEngine.
- ParentDeliveryAdapter 拥有父会话来源检查、结果接收、持久 receipt 查询与父唤醒.
- UI Adapter 拥有宿主视图替换、键盘拦截、焦点与恢复; View 只消费展示状态并派发 Action.
- Runtime 释放自己持有的资源, 不关闭宿主父会话或其他 Runtime 的任务.

跨两个 Session 不具备一个原生事务. 父交付需要明确保存顺序、稳定身份、重试和实际消费边界; Adapter 本身不能代替这些证明. 这些边界在本仓库内实现和验证, 不以宿主修改或 experimental 扩展点为前置.

当前 HarnessDriver 为每个任务持有独立子 Session/Harness 和具名 Lane, 使 Harness 级工具实现、hooks 与 cwd 保持隔离. TaskStore 使用原生应用 values 保存任务和 outbox. PiDeliveryChannel 在父空闲时同步追加并核验正文, 忙碌期间不向不可撤回的父队列发送结果. 父日志校验通过官方 parser 收拢在 Adapter 内, 不宣称当前宿主可以免除磁盘 receipt 验证.

## State ownership

| 所有者 | 拥有的事实 |
|---|---|
| Child Harness | 子 operation、原生队列、transcript、执行结果和恢复状态 |
| TaskEngine | task 绑定、驱动责任、准入及自动/人工控制模式 |
| Quota | 实际执行占用及限额 |
| Result delivery | 来源资格、交付身份及持久接收事实 |
| Agent catalogue | 定义发现、覆盖、名称解析及接受时定义 |
| Model access | 精确模型授权、scope 和 thinking 解析 |
| Configuration | 当前格式校验、原子保存及保存后的发布 |
| Prompt | guidance、子 prompt 和上下文准备 |
| UI controller / Settings | 焦点、选择、临时输入及编辑流程 |
| View / UI adapter | 展示格式及宿主终端资源 |
| Pi host | 父会话和宿主生命周期 |

TaskEngine 读取 Driver 事实, 不复制原生 operation 的持久状态机. taskId、operationId 和 deliveryId 分别标识任务、一次运行及一次交付. 继续已有任务创建新 operation, 恢复未完成 operation 沿用原身份.

Queued、Running、Waiting、Cancelling 和 Settled 是领域投影. Settled 区分完成、失败、取消和 turn limit. 原生 accept 不代表已经获得 Quota 或开始执行. 调用方停止等待不代表真实执行停止; suspended/deferred 不视为终态, close 不代替取消. Quota 作用域为当前 Runtime/父 Session, 每次占用最多释放一次, 观察 Promise 的取消不提前释放活体占用.

## Accepted policy and validation

接受边界准备已解析的模型身份、thinking、工具名、工作目录、system prompt 正文和运行限额. Domain 为这些执行值建立独立、冻结的快照. Catalogue 定义、资源选择和模型授权由接受前的调用方完成; SDK 模型对象的无关字段、凭据与工具实现不进入领域策略.

同进程可信调用直接使用类型与函数. 工具 JSON、配置、持久应用数据和不可信宿主输入在入口校验. 不在内部调用或 UI tick 重复运行全量 DTO/schema 转换, 不复制整份模型目录. Quota 的限额更新在控制入口校验并整体发布, 实际准入路径只检查容量.

原生 model、thinking 和 active tool names 可以按 Lane 设置. Harness 级工具实现、资源与 hooks 的作用域通过 Driver 明确处理. Agent 定义发现、项目信任、worktree、prompt/skills、full-access 自治和递归 Agent 排除继续保持其产品含义.

父任务的因果归属与子 Provider 上下文准备分开. 接收父指令不意味着复制完整父 conversation, 子请求必须具有有效的 tool-call/tool-result 序列.

## Result delivery contract

原生 OperationResultRecord 是子执行完成的权威事实. 结果正文来自对应 operation 的消息范围, 人工选择保存打开时的文本快照. 当前父会话的接收事实由 ParentDeliveryAdapter 验证, 不从子 Harness 的完成或树节点存在推断.

每项任务保留父 Session 和接受时的来源锚点. ParentDeliveryAdapter 按实际宿主会话与分支验证自动交付资格. Tree 隔离保证分支读取范围, 不禁止应用把其他分支结果复制到当前分支; 单写入器也不消除两个不同 Entry ID 的业务重复.

一次自动 terminal completion 对应稳定 deliveryId, 同一次重试沿用它. 新的人工选择建立新 ID. 父消息包含正文快照, 来源 Entry ID 用于追踪, 不作为唯一内容来源.

跨会话交付先保存可恢复的结果与交付身份, 再请求父会话处理. 入队或 sendMessage 成功不表示父消息已经持久保存. 父日志中可核验的消息才形成 receipt, 父模型成功回答不是 ACK 条件. 保存、发送或确认失败时保留可重试数据.

ParentDeliveryAdapter 处理当前宿主下的分支切换、接管、消息延迟消费和迟到回调, 并用真实离线父会话场景验证. 不将原生子 Session 的事务保证扩展为跨父子 Session 的原子保证. 外部工具的未知效果遵守上游 replay 策略.

## Input and presentation

- 运行中的普通输入使用 Steer, 保持原 foreground/background 身份和自动交付模式.
- 已接受但等待 Quota 的任务使用所属执行队列; 显式 FollowUp 使用对应队列.
- Alt+T 请求明确目标的 Takeover. Takeover 改变控制和交付模式, 不等同于 abort; 前台等待可 detach, 后续成果显式选择.
- 已结算任务继续时创建新 operation 并重新申请 Quota.
- Alt+Up 撤回未消费内容, already_consumed 不作为成功撤回或重新提交.
- Alt+S 选择已有消息快照, 不派发新任务.

输入与终态竞争时, 已接受但未消费的内容保持可见, 不静默丢弃或隐式启动另一轮. 普通 Steer 不把前台任务转换为同时具有工具返回和后台自动交付的任务.

Navigation/View 仅读取展示状态. UI Adapter 复用当前 Pi TUI 组件及键盘拦截, 保留 CURSOR_MARKER、clearOnShrink、resize、footer/editor 恢复与 displayText 清洗. 焦点和选择是局部展示状态, 不进入执行状态机.

## Compatibility boundary

v3 作为标准 npm 插件运行于未经修改的官方 Pi. 只管理按 v3 契约创建的任务, 不自动恢复 v2 未完成任务或接管其未交付结果. 新交付闭环替换公共路径时删除被替代的旧协议实现, 不同时维护两套可选执行底座.

配置使用独立的 subagents-lite-v3.json, 不自动导入旧配置. 未配置时采用 v3 默认值, 已存在但格式错误时明确报错. 历史格式转换不进入新配置路径; 当前格式的校验及 validate/persist/publish 顺序仍然必要.

精确父模型继承、显式模型授权、Model/Provider 配额、foreground/background、Agent 定义发现、worktree、prompt/skills、自治执行及选择性交付继续验收. 能力差异由内部 Adapter 处理, 不以目录收敛静默裁撤功能.

## Verification evidence

[Domain unit tests](../../../../test/unit/domain/task-domain.test.ts) 验证所属策略快照、Task operation 隔离、控制模式、单次配额释放、限额更新和实例隔离. 当前领域 API 的事实由 [领域 Note](../../implemented/architecture/2026-09-11-task-policy-and-quota-domain.md) 维护.

[Native Harness scenarios](../../../../test/scenarios/agents/harness-lanes.test.ts) 使用公开入口、真实 Models 和离线 Provider, 通过 createTestHarness 管理资源. 它们覆盖真实并行与 Steer 消费、分支写入和重复交付反例, 以及官方 JSONL 后端关闭重开后继续原 operation 并保存结果.

[执行 Adapter 场景](../../../../test/scenarios/agents/execution-adapters.test.ts) 与 [父交付场景](../../../../test/scenarios/spawn/delivery-channel.test.ts) 覆盖原生 Driver、TaskEngine 和真实官方父会话. 当前产品注册仍使用 AgentManager/SpawnCoordinator; UI 与激活级 Runtime 切换在阶段 3、4 交付. 相应验证随各自公共路径完成, 不无故重复已通过且未受改动影响的检查.

origin/re@5db0c90 仅为局部设计参考. a8e9625 修复 UI tick 复制 accepted policy 的问题, 表明无关 SDK 数据的重复投影具有实际成本. 不整批迁入该分支的产品策略.

## Delivery stages

| 阶段 | 交付物 | 退出条件 |
|---|---|---|
| 0 | 官方原生核心的公开 API 与离线场景证据 | 实际执行、队列、文件后端及交付反例可复现 |
| 1 | Task、冻结 Policy 与 Quota 领域 API | 无宿主依赖, 身份、控制和占用约束由定向测试证明 |
| 2 | 扩展内部 ExecutionDriver/LaneDriver 与 ParentDeliveryAdapter | 标准官方宿主中完成执行、队列与持久父接收闭环 |
| 3 | 只读 View、输入路由、Selector 与现有 Pi TUI Adapter | 快照、Action、焦点及宿主恢复通过验证 |
| 4 | ExtensionRuntime 与 catalogue/config/model access 的实例装配 | Shell 与可变模块单例归零, 双 Runtime 与迟到回调隔离 |
| 5 | 质量门禁、文档及发布输入 | 定向验证、跨平台 CI、lint、verify-notes 和 npm 包内容通过 |

## Alternatives considered

- **保持当前 AgentManager/AgentSession 结构.** 标准宿主上已有完整行为和场景, 变更面最小. 但策略、执行资源与展示仍交织, 不解决显式 Runtime 与能力边界目标.
- **扩展管理原生子执行, 使用父交付及 TUI Adapter.** 可以在当前官方宿主中使用原生队列和 operation, 并把宿主差异集中在明确边界. 代价是父子会话独立, 交付必须继续验证来源与持久接收, 采用此路径.
- **让底层树隐式决定父交付.** 数据模型直观, 可以省去业务归属与交付状态. 但当前父子不在同一原生 Session, 即使同树也允许显式错投或重复追加, 已有反例覆盖.
- **当前就引入 Chord RPC 与双进程运行结构.** 能接近实验架构的装配形式. 但现有标准宿主提供同进程扩展入口, 并不需要这些部署和传输机制; 当前先明确执行与展示边界.
- **整批合入 origin/re 或给所有旧类套统一 interface.** 前者包含较多现成代码, 后者减少调用点变化. 但前者具有不同产品策略和重型 schema 投影, 后者保留原有职责混合; 仅复用符合当前契约的局部实现.

## Acceptance criteria

- 所有实现位于本仓库, npm 插件在未经修改的官方宿主运行; 核心与宿主的支持版本明确.
- Domain 不依赖宿主、文件和终端. 执行、父交付和 TUI 差异由内部 Adapter 承担.
- 扩展可变业务单例归零, 两个 Runtime 的配置、catalogue、任务、UI 和释放互不影响.
- TaskEngine 归约 Driver 事实而不复制底层 operation 日志; Quota 对应实际占用.
- 策略在接受时固定, 不可信入口校验完整, UI 热路径没有全量策略或 SDK 对象克隆.
- 跨会话来源判断、稳定 deliveryId、持久 receipt 和幂等重试在真实官方父会话场景中通过.
- Steer 保持自治和原交付模式, Takeover 与选择性交付具有明确的竞争顺序.
- UI 不操作 AgentSession 或原始 Lane, 保留快照、终端清洗、焦点与宿主恢复.
- 生产与测试类型检查通过; 最小 ESLint 以 --max-warnings 0 验收. 本地运行受影响定向测试, CI 承担 Linux/Windows 全套与打乱顺序验证.
- 本提案按实际落地事实毕业, 相关 implemented Notes 随代码维护, 唯一源码锚点和 npm run verify-notes 通过.
- 约 25 个文件和 5,000-6,000 行是包括所有生产适配代码的优化预算; 正确性和既定能力优先.

## Risks

原生子执行与官方父会话具有独立的持久化和生命周期. 跨会话交付失败、reload、分支切换和输入竞争不能用子 Harness 的事务或 Tree 拓扑代替处理.

共享 Harness 资源与独立 AgentSession 的扩展隔离语义不同. Driver 需要按 accepted policy 固定工具与上下文, 同时保持真正的资源关闭和取消边界. 结构调整不能使配置来源或模型授权回到热路径重新解析.

Chord 分面和服务接口仍在演进. 执行/展示边界为映射提供基础, 不构成未来 RPC、生命周期和官方插件形态的无条件兼容保证.
