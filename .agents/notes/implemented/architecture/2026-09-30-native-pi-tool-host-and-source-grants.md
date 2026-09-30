# Agent Note: 原生 Pi 工具宿主与接受时来源授权

Status: implemented

## Problem

Pi 0.99.1 的 MCP 在 session_start 返回后连接和发现工具. codemode 与 deferred 工具可以不向模型声明, 仍通过工具上下文调用. 启动瞬间的具体工具名不能同时表达授权范围、异步资源目录和模型声明. 只转发 execute 也不能保留嵌套工具的权限 hooks、结构化结果和错误标志.

## Decision

[PiResources](../../../../src/drivers/pi-resources.ts) 拥有任务级资源工厂、ExtensionRunner、原生会话投影与关闭. [PiToolHost](../../../../src/drivers/pi-tool-host.ts) 拥有来源门禁、工具目录、声明投影和嵌套调用. [领域策略](2026-09-11-task-policy-and-quota-domain.md) 保存初始精确工具及接受时来源规则, 不持有工具实现或连接.

本决定部分取代 [资源门禁](2026-09-10-isolated-child-resources-and-tool-gates.md) 中将初始化目录作为完整工具授权上界的选择. 该 Note 继续拥有定义接受、扩展隔离、父状态继承和资源生命周期的契约.

```ts type-equiv: ToolSourceGrant from src/domain/policy.ts
export interface ToolSourceGrant {
  readonly source: string;
  readonly tools: true | readonly string[];
  readonly exclude: readonly string[];
}
```

source 使用已加载扩展的 SourceInfo.path, 包括 builtin:mcp、builtin:codemode 和 builtin:tool-search. 默认完整工具权限与 ext/* 固定到接受时选中的来源; 明确工具名单变成该来源的精确名字, 显式名单优先于 exclude. 通用代理的默认基础工具名单只决定初始选择, 已接受来源的 MCP 工具通过异步注册获得权限. restrictToRegisteredTools 继续限制未显式扩展工具范围的 Agent. Agent 从注册、声明、发现及嵌套执行中排除.

TaskPolicy.toolSources 是可选的附加授权: 缺少它的任务只有已保存的精确 tools 权限, 不推断全部扩展授权. 新任务保存选定来源及规则; 原生 task/outbox 的格式和地址保持可读, 该添加不要求迁移或丢弃既有结果. 持久输入检查来源字符串、名单形状和排除项, freezePolicy 复制并冻结规则. 没有匹配来源的扩展不能仅凭重用一个初始工具名获得权限.

## Declarations and execution

注册目录、授权规则、activeTools 和 callable tools 分别承担资源、权限、模型声明及编排入口. hidden 工具不能调用; direct 工具仅在 active 时可被编排; model-only 工具仅供模型直接调用; codemode/deferred 工具在授权且注册后即可被编排. prepareLoadout 接收已授权的目录, 描述替换和 hiddenDeclarations 只投影到 Provider 请求, 不改写原生保存的 activeTools.

registerTool 的 refreshTools 重建已授权实现, 由 PiResources 的串行配置队列发布到 Harness. 更新定义不重新启用已隐藏的同名工具. 新任务的工具按 exposure 和 defaultActive 决定默认声明. 恢复注册保留原生保存的声明集合, 不因重建定义重新激活已隐藏的工具. setActiveTools 与每次调用再次应用门禁, 已保存的越权声明在恢复入口拒绝. 资源未就绪不授予调用权, 权限存在不证明连接可用.

直接与嵌套执行都使用公开 runToolCall 和 ExtensionRunner.createToolContext, 应用参数校验、tool_call 和 tool_result. 嵌套调用携带 parentToolCallId, 使用父调用的取消信号, 发出子侧 tool_execution 事件, 不追加孤立的顶层 toolResult. 串行嵌套调用使用可重入队列, 普通嵌套调用可以并行. 保持模型与 Provider 配额的既有作用域, 不把它当作共享 MCP 后端的互斥锁.

Pi 0.99.1 的 Lane Harness 在 execute 返回时仍将结果视为成功. PiToolHost 保存标准管线的最终错误标志, 通过 after_tool 映射到原生结果, 而不是抛错丢弃结构化内容. tool_result 修改正文且未替换 structuredContent 时, 标准管线清除旧的结构化内容. MCP 的 CallToolResult、普通工具的 outputSchema 和程序化结果遵循官方语义.

嵌套调用正文只返回编排工具. 有界诊断位于顶层工具结果 details.nestedCalls, 不伪造原生引擎尚未提供的 nestedCalls 持久入口. 记录至多 256 项, 参数每项 8 KiB、累计 32 KiB, 超限标记 incomplete; usage 汇总到顶层结果且每层只计一次. 外层返回或资源关闭仍等待已接纳的嵌套效果退出. 编排和扩展工具采用 replay=never, 不把服务器 annotations 当作重放证明.

## Native resources and lifecycle

PiResources 通过公开工厂装配 MCP、codemode 和 tool-search, 使用官方 builtin/replaceable 规则和扩展配置. loadExtensionsImplicitly 关闭或 extensions=false 时, noExtensions 阻止普通扩展执行; DefaultPackageManager 按 Pi 的用户及可信项目配置解析启用的内建来源, 通过 additionalExtensionPaths 显式加载. 显式 extensions 名单和 excludeExtensions 继续过滤来源. 内建来源不因受限工具名单未选中其工具而产生未使用扩展警告.

原生 MCP 读取 Pi profile 的 mcp.json 与可信 cwd 的项目配置; 协议、凭据、HTTP/stdio、发现、重连和 shutdown 归官方工厂. codemode 的额外 models 入口关闭, 子模型执行仍由已接受的模型授权和配额路径负责. 恢复只使用已保存的扩展路径和来源授权, 不因当前隐式加载开关或 Pi 来源排除配置改变已接受任务.

父会话和各子任务各自拥有连接. 复用配置或官方凭据存储不等于复用活体客户端; 依赖父内存注册、独占后端或交互 UI 的扩展不具有透明跨会话保证. 父 ExtensionToolContext 不进入后台任务. 未来宿主提供独立工具服务时, 接入归工具 Adapter; [执行、父交付和展示边界](2026-09-10-capability-boundaries-and-explicit-runtime.md) 不因此合并.

session_start 在新建及恢复时各派发一次. before_agent_start 保留官方首次连接等待, turn_start 供官方 MCP 检查外部登录后的凭据. 恢复建立已保存的子视图和声明集合, 异步定义按来源授权重新绑定. 缺少扩展文件仍阻止恢复执行; 不可用 MCP 调用明确失败. NativeTaskStore 继续独立提供已保存结果, ACK 继续要求父日志 receipt.

父 custom state 按 customType 取最后值继承. 子 appendEntry 按顺序保存每次追加, 使用原有 pair-array 的原生 value 表示, 保留 codemode-store 多次增量写入及删除的含义. 同步 SessionManager 投影重建这些记录, 不运行另一套 AgentSession.

## Alternatives considered

- **保留初始化时的精确工具名单.** 权限与恢复最直观, 且没有新策略结构. 但官方 MCP 的异步发现使默认工具永远不进入该名单; 来源授权保留接受时边界, 同时表达目录的延迟完成.
- **让 noExtensions 同时控制原生服务和普通扩展.** 完全遵循 Pi CLI 的开关语义, 实现最少. 但要求使用 MCP 的子任务同时允许隐式普通扩展, 无法独立表达两者的资源选择. 当前复用 Pi 的来源配置解析, 只将启用的内建路径显式交给 Loader.
- **切回独立 AgentSession.** 可以直接使用官方工具执行与声明逻辑. 但会重新引入另一套运行、队列与恢复所有权, 与已经落地的原生 operation 和 outbox 分工冲突.
- **保存父工具 ctx 供子任务调用.** 可以复用父连接与已加载实现. 但该对象属于父工具调用及其 AgentSession, 缺少后台身份、持久恢复、独立声明和父分支切换保证.
- **为 MCP 实现专门客户端和发现工具.** 容易精确控制连接和启动等待. 但重复官方协议、OAuth、资源与 codemode 功能, 且无法适配普通 Pi 编排工具. 当前使用官方工厂与通用工具入口.

## Consequences

接受时配置与来源规则固定, 已授权来源的工具目录可以异步变化. 声明、隐藏或元数据刷新不产生新的来源授权. 项目仍使用标准官方宿主与独立子 Harness, 不依赖实验性 RPC、Pico 或父 Harness 暴露.

自定义工具不响应取消会延长关闭, 不提前释放真实执行占用. 未确认结果不会因连接或扩展不可用而删除. 连接实例数量随任务增加; 共享独占服务需要后端协调或未来的宿主工具服务.

## Verification

[原生 MCP 场景](../../../../test/scenarios/drivers/pi-mcp.test.ts) 使用真实官方工厂、本地 stdio/HTTP 服务和离线模型, 在隐式扩展关闭时覆盖 codemode、结构化错误、搜索激活、恢复、子状态增量和单调用取消, 并验证普通扩展不执行、Pi 内建来源排除、Explore 及明确名单的调用限制、第三方编排门禁与脱敏. 恢复场景改变当前 Pi 排除配置, 仍实际调用已接受的 MCP 工具. [资源场景](../../../../test/scenarios/runtime-resources.test.ts) 覆盖异步定义刷新、固定名单、扩展状态、cwd/trust 和不可用资源下的结果读取. [领域检查](../../../../test/unit/domain/task-domain.test.ts) 验证来源规则不随调用方后续修改漂移. 这些检查不证明远程 OAuth 或物理终端兼容性.
