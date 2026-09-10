# Agent Note: 静态工具注册与静默展示

Status: implemented

## Problem

工具集合可被模型模板序列化到 prompt 前缀, 中途注册/刷新会改变输入前缀. 冗长静态描述也不能反映当前模型授权和 Agent 目录. 每次后台派发都显示工具卡片、日志路径和重复状态会挤占主聊天视窗, 还可能把 UI 元数据泄漏到模型.

## Decision

[registerTools](../../../../src/registration.ts) 在本扩展初始化时一次性注册 Agent、StopAgent、AgentStatus. Agent 类型使用 string 参数, 动态目录由 [guidance](2026-09-09-dynamic-guidance-injection.md) 提供, 不反复修改 schema enum. 这只约束本扩展的注册行为, 不宣称其他扩展或整个 Pi 工具集不可改变.

工具省略顶层 description/promptSnippet/promptGuidelines, 对 Pi 的 required description 使用局部 ts-expect-error. 参数保留必要单句说明和类型, additionalProperties=false 拒绝未知参数, thinking 是独立 enum. 工具的新建/停止/精确查询职责不包含 resume、轮询等待或返回日志路径. 前台/后台策略拒绝通过抛错让 Pi 正确记录 tool error, forceBackground 开启时必须显式 run_in_background=true, 不静默改变执行模式.

三个工具使用 renderShell=self 和空 Container 的 call/result renderer, 阻止默认 tool card 的外壳残留. 结果仍进入模型上下文, 自动交付消息 display=false. [navigator](../bug-fix/2026-09-10-navigator-rendering-and-cache.md) 承载实时状态, 异常 pending 由 [inbox](2026-09-09-parent-result-delivery-and-ack.md) 提供. 用户获得的是执行/交付事实, 不是第二套输出日志.

## Retired output surfaces

当前没有独立 `/tmp/pi-agent-outputs/<id>.log`、tree widget、running-agent menu 或 child usage footer. 可复核的 log 实现在 `7cd9cd1^:src/agents/output-file.ts`: AgentOutputLog 按初始/继续消息索引订阅, finalize 先补 final stats、flush 再 unsubscribe. live thinking buffer 到阈值按句末切分, thinking_end 只写未流式输出的尾部; 缺 thinking_end 时 turn_end 仍记完成的 block, 避免历史 flush 重复. 写入是 best effort, 不是 durable delivery.

这些防御仅对该日志产品有效. 当前 source of display 是 Pi session transcript, source of saved result 是父 inbox. 若将来要求可 tail 的完整审计日志, 必须重新明确存储位置、跨平台权限、retention、thinking 可见性和流式去重, 不能直接把旧文件恢复后称为完成.

## Alternatives considered

- **保留平台默认工具卡片和详细 schema 文档.** 用户可直接查看调用, 模型也能就地看到说明, 但后台多任务会重复占据聊天/模型输入. 当前静默显示以 navigator 和简明动态 guidance 补足.
- **按需注册工具或 session briefing.** 无使用时工具列表可更少, 但中途工具变化改变前缀, briefing 还需处理刷新和 compaction. 历史否决理由见 [rejected Note](../../rejected/architecture/2026-09-09-lazy-tool-registration-and-session-briefing.md); 缓存收益依赖 provider, 不是可保证的速度倍数.
- **保留日志路径/统计为工具 details 的 UI 数据.** renderer 可方便展示 tail 命令, 但 details 不是纯 UI 秘密通道, 历史提交记录了暴露给模型的风险. 当前结果 metadata 仅承担交付协议.
- **保留并行的 tree widget、count badge、footer 和结果 viewer.** 每个表面各有信息, 但会复制状态和刷新逻辑. 统一的导航列表/子屏降低多处同步义务, 代价是失去独立外部 tail 接口.

## Consequences

schema 表面稳定、工具聊天行静默, 但这不验证模型已经理解所有指令, 也不保证 prompt cache 命中. 新能力需要显式修改公共 schema; 旧模型标识语法和旧配置不自动迁移. Windows 工具能力、终态检查分别由 [资源门禁](2026-09-10-isolated-child-resources-and-tool-gates.md) 和 [runner](../bug-fix/2026-09-10-assistant-outcomes-retries-and-turn-budgets.md) 负责.

## Evidence

`646f081`, `001c737`, `7cd9cd1`, `fb2affa`, `3ff89da` 记录 schema 精简、未知参数拒绝、静默卡片和显式后台策略. `45a4fd8`, `52ba247` 记录 outputFile/tail 元数据暴露问题. `6ca3abd`, `082ea0c`, `0dfb249`, `79358ea`, `d9198f2`, `72a13bf`, `48d9de2`, `f1027fb` 记录日志生命周期和 thinking 去重的具体演进. `ad49767`, `5cc7661`, `e8ed6ae`, `afe0724`, `74a1042` 记录多个状态表面的裁撤与职责归并.

## Verification

[index/schema tests](../../../../test/unit/index.test.ts) 验证静态注册、schema 和 silent render, [tool execution](../../../../test/unit/agents/tool-execution.test.ts) 验证 pre-spawn 拒绝, [navigator render](../../../../test/unit/ui/navigator/agent-navigator.render.test.ts) 验证当前展示. 已裁撤日志的历史测试不属于主线运行面, 本文不声称重新执行这些测试.
