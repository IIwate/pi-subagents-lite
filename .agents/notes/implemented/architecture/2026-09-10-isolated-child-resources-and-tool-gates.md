# Agent Note: 独立子会话、接受时策略快照与工具能力门禁

Status: implemented

## Problem

后台排队期间修改 Agent 定义或父模型, 不应悄悄改变已接受任务. 复制父会话完整历史会带入父身份和已完成工作; 完全丢弃扩展状态又会让子会话失去用户当前偏好. Pi 在创建 session 时固定注册 allowlist, 但扩展可能直到 `session_start` 才注册工具, 因而“加载扩展”和“让模型看到工具”必须区分.

## Decision

[Agent 工具入口](../../../../src/agents/tool-execution.ts) 解析名称、授权和 thinking, 在异步准备前记录父来源锚点. [ExtensionRuntime](2026-09-12-explicit-runtime-and-native-task-ownership.md) 准备子 prompt、资源和工具, 然后把冻结的 TaskPolicy 交给原生 Driver. queued 任务不重新查找定义、scope 或授权.

```ts type-equiv: AcceptedRunPolicy from src/types.ts
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

[PiResources](../../../../src/drivers/pi-resources.ts) 为子任务加载独立的 ModelRuntime、ExtensionRunner 和官方 Pi 工具. 父当前分支中各 customType 的最后状态经过独立复制, 子侧修改保存在原生 Session values. 父 conversation 不进入子模型请求; 扩展读取的同步 SessionManager 是原生消息及 custom state 的投影.

extensions 的数组按扩展名过滤, tools 的数组支持 ext/* 展开; false 表达空集合, whitelist 优先于对应 blacklist. session_start 后收集延迟注册工具, 最终允许集合既是 Harness 的注册集合也是 activeToolNames. Agent 始终排除, 本扩展不参加子资源的 session_start, 因而没有递归 Runtime 初始化.

默认工具采用宿主 defaultTools 或内建默认集合. 内建 Explore 按 Windows Bash 可用性和宿主 PowerShell 偏好调整, 显式工具名单保留其含义. shell 工具本身具有文件写入能力, 提示中的只读职责不构成操作系统 sandbox.

before_agent_start、context、Provider payload/headers/response、tool_call/tool_result 和 message_end 由 Adapter 接到原生 hook. 子扩展不能修改已接受的模型、thinking 或工具集合. 关闭时发送子 extension shutdown 并释放订阅. 选定扩展路径随 TaskBinding 保存, 恢复按这些路径加载; 资源不可用时保留数据并报告错误.

## Alternatives considered

- **出队重新读取当前定义和授权.** 可让撤销立即覆盖等待任务, 但改变已接受调用的模型、工具或 prompt 模式. 当前快照选择执行可预测性; 即时撤销需要独立产品决定.
- **复制父 conversation 或 fork 完整 session.** 能继承充分上下文, 但违背独立委派, 增加 token 并可能重复处理父任务. 当前只继承扩展 custom state.
- **始终固定 registry allowlist.** 能在 Pi 最底层限制工具, 但 wildcard 无法预知 `session_start` 新工具. 始终取消 gate 又会削弱明确受限 Agent; 当前按策略区分, bind 后再过滤.
- **维护一套扩展名注册表或无条件切换 PowerShell.** 前者需同步 Pi 安装布局, 后者会改写显式工具选择及 shell 语法. 当前复用已加载扩展信息和宿主能力.

## Consequences

prompt 正文、技能和上下文在任务发布前准备, 原生队列保存输入而非资源加载指令. 工具 gate 不阻止资源工厂本身的加载副作用. 固定执行策略后的结构性会话操作没有自动映射, 子扩展不能借此操作父会话或其他 Runtime.

## Evidence

- `b3bb3aa`, `e039960`: 独立执行基础与 Agent 工具新建语义; 人工继续由独立交互入口承载.
- `3494a5e`, `47b4177`, `0b7325e`, `7ca5d0d`, `97b8e1e`, `ea4fcb3`, `616f8a8`, `59f5d17`: 工具 whitelist、扩展过滤及延迟注册边界.
- `b2afecd`: 按 customType 复制父扩展状态. `5b71727`, `19ed1dd`: 接受时模型与完整策略锁定.
- `3909432`, `e526f02`: defaultTools/PowerShell 适配及独立 thinking 参数.

## Verification

[policy resolver](../../../../test/unit/agents/agent-types-resolver.test.ts)、[PowerShell policy](../../../../test/unit/agents/powershell-policy.test.ts) 与 [Runtime 场景](../../../../test/scenarios/runtime.test.ts) 覆盖定义快照、平台工具选择、延迟注册、独立扩展状态、请求 hook 和缺资源时的数据读取.
