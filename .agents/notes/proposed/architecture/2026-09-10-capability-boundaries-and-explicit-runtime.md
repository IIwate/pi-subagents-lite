# Agent Note: 能力模块边界与显式 Runtime 的独立重构提案

Status: proposed

## Problem

在主线基准 `4f7aab2`, src 共 47 个 TypeScript 文件、11,418 行, AgentNavigator/AgentManager/runner 分别为 1,911/930/780 行, 15 个文件引用 Shell. 行数本身不是缺陷, 具体耦合在于 navigator 同时处理输入、Pi 私有布局和 transcript cache, manager 同时拥有 scheduler 与 Pi teardown, coordinator 从 Shell 反查当前 context/UI. 更换一处 host 行为容易牵动策略、显示和测试替身.

未合入的 `origin/re`(末端 `5db0c90`) 包含能力模块、ports、TypeBox 边界、ExtensionRuntime 和分层配置的一整套实现. 它是可复核的设计实验, 不能直接视为当前最佳实践: 它也经历了 schema/host 投影、迟到 session、重绘成本和共享文档 writer 的多轮修复, 并包含与主线不同的产品行为.

## Proposal

推荐在获批后按能力逐段收敛, 最终以显式 runtime 组装策略和 host 适配. implemented Notes、源码锚点和具体缺陷修复可独立交付, 本提案不作为它们的前置.

目标职责如下, 目录数量由实际边界决定, 不为每个模块强制创建空 core/application/ports/contracts:

| 能力 | 拥有的事实 | Host 适配保留的资源 |
|---|---|---|
| Agent catalogue | 定义覆盖、名称解析、接受时定义 | 文件扫描、Pi trust/path 输入 |
| Model access | 授权、thinking、可调用集合 | Pi registry/model/scope |
| Execution | 生命周期、调度、保留和取消意图 | AgentSession、AbortController、shutdown |
| Result delivery | 保存/receipt/ACK、branch eligibility、wake phase | Pi JSONL 和 sendMessage |
| Navigation | 活动视图、候选、输入目标、局部反馈 | Editor、dock、ANSI、Pi layout |
| Prompt | 确定性的 guidance 和子 prompt 组装 | 文件加载与父 prompt 读取 |
| Configuration | 候选值校验、保存和发布 | 文件写入及资源根目录 |
| Settings | 选择/确认/返回流程 | Pi modal 和输入组件 |

ExtensionRuntime 在激活时创建, registerTools/setupEventListeners 通过闭包获取它. runtime 内当前 context 可以更新, 延迟回调保留 session/lifecycle 校验, 不捕获过期 context 副本. `globalThis` 仍仅持有 fallback inbox 和 child-spawn AsyncLocalStorage. fixed-signature Pi callback 不妨碍此注入方式.

同进程可信 TypeScript 调用直接使用 types/functions. 仅 JSON、持久文档、host 或可替换的不可信 port 边界运行时校验; 不机械要求所有值 JSON 化, 不在每次 UI tick 深拷贝/Check 整份 accepted policy. 必须跨边界复制的 model snapshot 在 host adapter 投影, 不能因 Pi 新增非业务字段就拒绝正常调用.

实施分段可为: 提取无副作用规则并保持现有入口; 集中 session setup/teardown 所有权; 从 navigator 分出 host screen adapter; 最后将入口切到显式 runtime. 每段直接替换其公共使用路径, 不保留双实现/长期兼容 facade. 若某边界只有一次直通且不能降低耦合, 保持普通函数, 不为目标目录凑接口.

## Product decisions kept separate

以下 origin/re 决策有独立价值, 但并非保持主线行为的重构:

- `cd5b143`: Parent access deny、逐模型 thinking allowlist/default、只允许 canonical model keys. 主线仍采用精确父模型隐式授权、bare ID 和显式/继承 thinking 区分. 改变这些必须单独批准.
- `ee7414d`, `5104ec3`, `3db2dfe`, `560aaad`, `943bdc1`: trusted project config、缺省继承/无 tombstone、provenance、共享 document revision 与 malformed read-only. 适用于项目限额覆盖需求, 当前 global-only 配置不因拆模块自动增加这一产品面. 项目模型授权若引入, 应只能收窄全局授权, 不是自动开启权限.
- `3f73968`, `f040a7f`: inherited prompt 缺失/剥离后为空即失败. 主线目前允许 warning + replace, 这项 persona 语义变化单独审查.
- `6e2b40c`: 静默快照抽屉、显式恢复等交付产品路线. 主线 September 的 durable receipt ACK 必须保留, 不能照搬 origin/re 较早的 model-settlement ACK.

## Historical implementation evidence

- `3f2dea6`, `0f6d247`, `9d93536`, `9d23eca`, `7f8b9c1`: catalogue tracer、accepted policy、文件适配与工作树发现.
- `44f0a6a`, `391ed92`, `c411cb4`, `06152cf`, `98b7dc9`, `d21b3da`: model/prompt public 边界和配置写入口.
- `1268def`, `39c3feb`, `7171974`, `35b5c5c`, `5255777`: scheduler/session-driver/delivery 分工及迟到关闭/reload fallback.
- `1fc260a`, `f8284b5`, `28bc9bc`, `be463b8`, `1380b21`, `74fe9a1`, `476454b`: renderer-independent navigation/settings, 保留 custom footer 与 Pi document/dock ownership.
- `e5443f0`, `e8bee67`, `22d9f3c`, `4b7cb33`, `fe86d58`: fragment transaction、operational precedence、host 路径/信任和配置层修复. 主线的 [配置提交](../../implemented/bug-fix/2026-09-10-configuration-commit-and-validation.md) 和 [资源目录](../../implemented/bug-fix/2026-09-10-canonical-agent-resources-and-discovery.md) 在现有模块内独立实现.
- `95bcc64`, `165fbee`, `2c942b6`: process-state 与闭包 root, 删除并存 facade.
- `3f73968`, `b98947a`, `f040a7f`, `3f21f3d`, `a8e9625`, `5db0c90`: 边界漏检、Pi 数据投影、刷新热路径与 snapshot copy 的反例. 这些提交说明全序列化/全校验并非没有代价.
- `148c846`, `e96fb65`, `1c60f98`, `6f3363b`, `0cd6164`, `65a9ea8`: import guards、公用 seams 和 mock 改造. 当前 [unit/scenario 分层](../../implemented/testing/2026-09-09-test-layers-and-scenario-harness.md) 可保留, 不机械照搬全库禁止所有 internal mock、行数阈值或以测试标题含 REQ ID 证明覆盖的规则.

## Alternatives considered

- **维持当前结构, 只补 Note 和修具体 bug.** 改动最小, 对单 host 项目很合理, 也是当前可立即交付的路线. 若具体变更没有跨模块波及证据, 不启动全量重构.
- **整批合入 origin/re.** 已有完整垂直模块与历史测试, 可复用大量工作. 但与主线交付 ACK、人工接管、Pi 依赖和测试布局有差异, 且严格 schema 引入额外投影负担. 不推荐直接把分支历史当作通过审查的成品.
- **推荐的分段能力收敛.** 每次减少一个真实耦合点, 用现有行为场景对照, 接受多个小步骤而非一次目录大迁移. 产品变更仍可独立排期.
- **给现有类统一套 service interface.** 调用点变化少, 但职责仍混合, 新 wrapper 无法证明可替换性, 只是增加跳转层.

## Acceptance criteria

- 每段保存主线授权、快照、durable ACK、foreground/background、takeover 和 TUI focus/恢复行为, 不因迁移复活旧策略.
- 两个 runtime 在同进程拥有独立 session/context; fallback 仍按父 ID 交接, 子 spawn 不污染另一父 runtime.
- session-driver 收尾、配置落盘、父交付和 UI adapter 各自有一个真实所有者. 新边界无需同步修改不相关策略.
- 通过受影响 typecheck、unit 和现有 offline scenarios; Pi 适配变化增加最小真实 host 契约检查. CI 负责跨平台全量验证, 不复制旧的内部实现断言.
- 不引入仅为未来存在的目录、配置或抽象, 不把结构变化伪称为性能提升. 相关 implemented Note 随每段真实代码更新.

## Risks

大范围搬迁易丢失当前小而关键的防线, 如 pendingAtRead、in-flight receipt、CURSOR_MARKER、late setup 和 clearOnShrink restoration. 模块化还可能把少量函数调用变成过量 DTO/schema 转换. 若某段不能证明职责简化或使主线行为漂移, 应缩回该段, 而不是要求所有后续工作迁入新架构.
