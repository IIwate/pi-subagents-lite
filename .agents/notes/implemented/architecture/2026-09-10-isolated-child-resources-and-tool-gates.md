# Agent Note: 独立子会话、接受时策略快照与工具能力门禁

Status: implemented

## Problem

后台排队期间修改 Agent 定义或父模型, 不应悄悄改变已接受任务. 复制父会话完整历史会带入父身份和已完成工作; 完全丢弃扩展状态又会让子会话失去用户当前偏好. Pi 在创建 session 时固定注册 allowlist, 但扩展可能直到 `session_start` 才注册工具, 因而“加载扩展”和“让模型看到工具”必须区分.

## Decision

[Agent 工具入口](../../../../src/agents/tool-execution.ts) 解析名称、授权和 thinking, 在异步准备前记录父来源锚点. [ExtensionRuntime](2026-09-12-explicit-runtime-and-native-task-ownership.md) 准备子 prompt、资源和工具, 然后把冻结的 TaskPolicy 交给原生 Driver. queued 任务不重新查找定义、scope 或授权.

[AcceptedRunPolicy](../../../../src/agents/types.ts) 保存 Catalogue 已解析的定义及资源选择, 供 PiResources 准备执行环境. 已准备好的执行值进入冻结的 TaskPolicy; 资源准备配置不参与任务状态转换或替代持久任务契约.

```ts type-equiv: AcceptedRunPolicy from src/agents/types.ts
export interface AcceptedRunPolicy {
  /** Deep-copied definition resolved when the Agent call is accepted. */
  definition: AgentConfig;
  registeredTools: string[];
  restrictToRegisteredTools: boolean;
  tools?: true | string[] | false;
  extensions: true | string[] | false;
  skills: true | string[] | false;
  systemPromptMode: SystemPromptMode;
  includeContextFiles: boolean;
  /** Canonical parent model identity used when this call was authorized. */
  parentModelKey: string;
}
```

[PiResources](../../../../src/drivers/pi-resources.ts) 为子任务加载独立的 ModelRuntime、ExtensionRunner 和官方 Pi 工具. 父当前分支中各 customType 的最后状态经过独立复制, 子侧每次 appendEntry 按序保存在原生 Session values, 投影重建保留 codemode-store 等增量记录. 父 conversation 不进入子模型请求; 扩展读取的同步 SessionManager 是原生消息及 custom state 的投影.

extensions=false 关闭普通扩展加载, 官方原生工具服务仍按 Pi 来源配置加载. extensions 的数组按扩展名过滤, 内建来源使用 builtin:mcp、builtin:codemode 和 builtin:tool-search. tools 数组支持 ext/*; tools=false 表达空工具集合, whitelist 优先于对应 blacklist. Agent 始终排除, 本扩展不参加子资源的 session_start, 因而没有递归 Runtime 初始化.

[原生工具宿主与来源授权](2026-09-30-native-pi-tool-host-and-source-grants.md) 部分取代初始化时冻结完整工具名的选择, 维护 TaskPolicy.tools 与 toolSources 的联合权限、exposure、声明投影、嵌套调用、错误标志及官方工厂接入. 本 Note 继续维护定义接受和资源隔离. 选定来源和过滤规则在接受时固定, 授权范围内的延迟发现不要求重新接受任务.

恢复先附着原生 Lane, 建立已保存消息与 custom state 的同步投影, 再派发一次 session_start(reason=resume). 已保存的声明子集与异步工具实现分别恢复. 重新注册同名实现不重新启用隐藏工具. 缺少扩展文件阻止恢复执行, 原生数据保留; 尚在连接的来源不能据此获得可调用实现, 不可用调用明确失败.

PiToolHost 按已接受的来源规则处理 registerTool 与 setActiveTools. 当前注册实现、activeTools 和 callable tools 分开, 原生 Lane 配置保存模型声明集合. refreshTools 在异步连接完成时更新描述、schema 与实现, hidden 撤回工具. before_agent_start 完成后 flush 配置, 然后原生 checkpoint 捕获工具集合; 调用前再次检查权限与可用性.

工具数组按当前已授权集合替换. Harness.setTools 与 Lane.setActiveTools 通过串行写入队列发布, 请求和调用边界的 flush 保留状态写入失败. 已经开始的工具使用选中的实现. 附着再次发布资源准备之后完成的注册, 不通过新增来源授权来修复缺失资源.

默认工具采用宿主 defaultTools 或内建默认集合. 内建 Explore 按 Windows Bash 可用性和宿主 PowerShell 偏好调整, 显式工具名单保留其含义. shell 工具本身具有文件写入能力, 提示中的只读职责不构成操作系统 sandbox.

before_agent_start、turn_start、context、Provider payload/headers/response、tool_call/tool_result 和 message_end 由 Adapter 接到原生 hook. 子扩展不能修改已接受的模型、thinking 或工具授权上界. 关闭时发送子 extension shutdown 并释放订阅. 选定扩展路径随 TaskBinding 保存, 恢复按这些路径加载; 资源不可用时保留数据并报告错误.

ExtensionRunner 报告的普通 hook 异常携带扩展路径和事件名进入 warning, 不写入 writeError. 工具调用 hook 的显式 block 或抛错仍通过标准 runToolCall 拒绝该次工具调用. 原生状态写入及快照同步失败继续保留在 writeError 中, flush 和工具执行不会把失败当作成功.

## Alternatives considered

- **出队重新读取当前定义和授权.** 可让撤销立即覆盖等待任务, 但改变已接受调用的模型、工具或 prompt 模式. 当前快照选择执行可预测性; 即时撤销需要独立产品决定.
- **复制父 conversation 或 fork 完整 session.** 能继承充分上下文, 但违背独立委派, 增加 token 并可能重复处理父任务. 当前只继承扩展 custom state.
- **始终固定 registry allowlist.** 能在 Pi 最底层限制工具, 但 wildcard 无法预知 `session_start` 新工具. 始终取消 gate 又会削弱明确受限 Agent; 当前按策略区分, bind 后再过滤.
- **工具校验完成后才派发恢复事件.** 能尽早拒绝缺失资源, 但直到 session_start 才注册的工具永远无法通过前置校验. 原生附着与执行准入分离, 允许在恢复事件结束后完成同样严格的工具检查.
- **拒绝任务接受后的全部工具选择变化.** 冻结实现简单, 可以阻止越权增加工具, 但也拒绝无 UI 时隐藏交互工具等常规扩展行为. 固定授权上界、原生可用子集和执行前检查分别承担权限与动态选择.
- **工具准备完成后拒绝 refreshTools.** 能防止注册集合漂移, 但官方 registerTool 的常规更新也经过该通知, 会把 MCP 异步元数据刷新变成初始化错误. 授权集合冻结不要求工具定义冻结.
- **将所有 hook 异常视为持久化失败.** 可以保守地停止后续工作, 但普通扩展异常并不证明状态写入失败, 共享故障标记会阻断其他正常工具. hook 诊断与原生写入失败各自遵循所属边界.
- **维护一套扩展名注册表或无条件切换 PowerShell.** 前者需同步 Pi 安装布局, 后者会改写显式工具选择及 shell 语法. 当前复用已加载扩展信息和宿主能力.

## Consequences

prompt 正文、技能和上下文在任务发布前准备, 原生队列保存输入而非资源加载指令. 工具 gate 不阻止资源工厂本身的加载副作用. 固定执行策略后的结构性会话操作没有自动映射, 子扩展不能借此操作父会话或其他 Runtime.

## Evidence

- `b3bb3aa`, `e039960`: 独立执行基础与 Agent 工具新建语义; 人工继续由独立交互入口承载.
- `3494a5e`, `47b4177`, `0b7325e`, `7ca5d0d`, `97b8e1e`, `ea4fcb3`, `616f8a8`, `59f5d17`: 工具 whitelist、扩展过滤及延迟注册边界.
- `b2afecd`: 按 customType 复制父扩展状态. `5b71727`, `19ed1dd`: 接受时模型与完整策略锁定.
- `3909432`, `e526f02`: defaultTools/PowerShell 适配及独立 thinking 参数.

## Verification

[policy resolver](../../../../test/unit/agents/agent-types-resolver.test.ts)、[PowerShell policy](../../../../test/unit/agents/powershell-policy.test.ts) 与 [资源场景](../../../../test/scenarios/runtime-resources.test.ts) 覆盖定义快照、平台工具选择、延迟注册、独立扩展状态、请求工具过滤、可用子集恢复、hook 异常隔离和缺资源时的数据读取. 延迟注册恢复场景从真实原生文件重开运行中的任务, 验证 resume 读取子侧状态与消息且只派发一次, 任务保持 Waiting, 显式输入后模型能调用恢复的工具. 状态写入失败场景验证工具副作用被阻止且关闭仍报告 flush 失败.

异步工具刷新场景通过官方扩展 registerTool 在工具准备完成后替换描述、schema 和执行函数, 验证首次运行和文件重开后的模型都实际调用更新实现. 隐藏的已授权工具保持隐藏, 新注册的未授权工具和 Agent 不进入模型请求. 该离线场景复现 MCP 的异步注册路径, 不验证远程 MCP 服务的连接状态.
