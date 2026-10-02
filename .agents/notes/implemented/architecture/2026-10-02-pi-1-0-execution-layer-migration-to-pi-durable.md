# Agent Note: Pi 1.0 durable 执行层与独立 SQLite 会话

Status: implemented

## Problem

Pi 1.0 移除 pi-agent-core 的 experimental Harness、Lane 与 JSONL Session 导出. 生产扩展需要在 Pi 1.0 上保留接受时策略、配额、隔离工具、人工接管、恢复与父交付. Pi 父 AgentSession 与子执行存储没有共同事务, 因而子任务完成不能证明父日志接收结果.

## Decision

[DurableDriver](../../../../src/drivers/durable-driver.ts) 直接依赖 exact pi-durable/chord 1.0.0, 每个子代理拥有独立 Harness、SQLite Storage、root Conversation、Registry 和 NodeExecutionEnv. GenerationTask/ToolTask 负责模型、工具与恢复. 单个工作会话不需要额外 Anchor 或自定义执行循环; 父 Pi 会话始终由宿主拥有.

[NativeTaskStore](../../../../src/drivers/native-task-store.ts) 的 session-scoped TaskDocument 保存接受请求、策略、控制权、结果投影、扩展状态和交付确认. [原生执行与父交付 Note](2026-09-11-native-execution-and-parent-delivery-adapters.md) 持有完整的运行/接收契约; 本 Note 持有 Pi 1.0 存储选择、格式和适配边界.

```ts type-equiv: Operation from src/drivers/native-task-store.ts
export interface Operation {
  id: string;
  input: TaskInput;
  startedAt: number;
  fromEntryId: number | null;
  stoppedBy?: "user" | "agent";
  cancelled?: boolean;
  result?: ExecutionResult;
}
```

accept 只提交接受请求. TaskEngine 取得 Model/Provider 租约后 drive 才调用 submit/wait; 两者都会启用原生调度, 因此恢复读取不调用它们. operationId 作为 requestId, 关闭重开复用原生 Submission. 执行前的排队输入并入首个请求, 各输入的消费身份由原生 passive write 保留; 运行中的输入进入原生 inbox. 消费确认丢失时按 requestId 找回既有记录. 实际执行结束后释放租约, 观察取消不释放占用.

原生答案与应用结果投影是两次提交. 应用结果写入失败时, Store 可仅靠 Session 扫描本 operation 的条目与 Submission 重建结果, 不加载模型或扩展. 待交付状态与父日志 receipt 仍有各自所有者, ACK 失败重试不重复父正文. 接管与用户停止保存为独立事实, 不由 background 或 ownership 隐式推导.

恢复时直接校验原生模型、thinking 与 cwd 是否符合接受策略, 不一致即拒绝附着. 普通流与 deferred 请求都检查接受的模型身份. 工具声明、执行前授权和嵌套调用由 PiToolHost 按接受策略约束. ownership 仅表达取消/idle 的归属, 不提供访问控制. 每次工具进入时更新其 invocation signal, 避免 MCP 发现使用上一轮已结束的生成信号. 子扩展状态在 Harness 关闭前落盘. 工具失败返回完整 content/details/usage/isError, 请求与响应钩子通过原生生成钩子及 Models 适配接入.

Conversation.watch 提供原生快照, TaskDocument watch 提供应用状态变化; 导航器消费既有 ExecutionSnapshot. ObservationPack 保持请求局部投影, Action Fusion 仍通过标准嵌套工具管线执行 then_run. 原生 GenerationHooks.afterTools 确实存在, 但整轮完成回调不等价于逐工具的参数融合与授权.

## Storage format and ownership

Runtime 使用 `subagents-lite-v3/durable/<encoded-parent-session-id>/<task-id>.sqlite`. 父目录限定发现范围, 打开文件后再次校验绑定的父身份与接受策略. ObservationPack 存在同级 `<task-id>.sqlite.observations` 目录. 0.99.x 的 JSONL 子会话不兼容, 不读取或迁移; 原文件保留. 父 Pi 日志与扩展配置由原有所有者管理.

SQLite 是当前迁移选择, 不代表已完成 JSONL 或共享存储的性能比较. 每实例独立调度使配额重新准入、工具/cwd 隔离与关闭顺序直接对应已有所有者. 同存储的全局任务图或实测数据库资源成本出现新需求时再评估共享拓扑. 独立 Storage 不提供进程/文件系统沙箱或多进程共享写入保证.

## Alternatives considered

- **维持 0.99.x.** 无执行层重写和 Experimental 漂移成本, 但不能满足 Pi 1.0 的已授权适配目标.
- **在 durable 上重建 Lane API.** 调用方变化较少, 但重复持有执行模型和恢复逻辑. 当前直接使用 Task/Submission, 应用 document 只表达接受策略与跨父日志职责.
- **所有子代理共享 Harness/Storage.** 全局任务图与文档可同提交更新, 数据库数量较少. 但启用调度会影响整实例, 需要额外的逐任务准入与工具隔离机制. 独立实例更直接地对应现有配额和资源所有者.
- **为独立工作会话添加 background Anchor.** 与上游多会话示例同形, 可利用共同根节点的取消遍历. 本项目父聊天在外部 AgentSession, 每实例只有一个工作会话, 额外根节点和 Anchor 没有需要承担的职责.
- **使用独立 JSONL.** 文本易读, 贴近既有排查习惯. SQLite 已经通过持久化故障与重开验证, 因此作为当前选择; 不据此断言 JSONL 性能或正确性不足.
- **把 answer EntryId 当作父 receipt.** 内部引用最简单, 但子完成后父写入仍可能失败. 父日志的匹配记录才证明接收, 单独保留 receipt ACK.

## Consequences

生产入口、资源加载、模型选择、工具授权、父交付和导航使用同一 durable 路径. 原生 Task 拥有执行事实, 会话 document 拥有应用生命周期数据. 存储格式断代明确, 无双执行层或旧格式兼容包装. M5 新增分相调度与长程自愈独立于现有能力迁移.

模型验证仅使用离线 provider, 配合真实 Pi 工具派发、SQLite、文件与本地 MCP 服务. Linux/Node 的离线通过不推导 Windows、物理终端或 SIGKILL 的行为; CI 继续承担跨平台与全量验证.

## Verification

[执行场景](../../../../test/scenarios/drivers/durable-driver.test.ts) 覆盖等待取消、排队、预算、请求闲置、重开、恢复模型篡改拒绝与原生答案恢复. [父交付场景](../../../../test/scenarios/drivers/pi-delivery-channel.test.ts) 覆盖父落盘/ACK 失败、接管/停止竞争和去重. [Runtime 场景](../../../../test/scenarios/runtime.test.ts) 覆盖正式 Agent 工具入口、实例隔离和恢复; [资源场景](../../../../test/scenarios/runtime-resources.test.ts) 覆盖扩展状态、权限、cwd 与融合命令. [MCP](../../../../test/scenarios/drivers/pi-mcp.test.ts)、[ObservationPack](../../../../test/scenarios/drivers/observation-pack.test.ts) 和[导航](../../../../test/scenarios/ui/task-navigation.test.ts)验证相应系统边界.

[独立 Spike](../../../../scripts/spikes/pi-durable-boundaries/run.ts) 保留最小 Pi 1.0 链路的可复现证据; 正式行为以生产场景为准. 验证命令与隔离 Spike 运行方式由[开发指南](../../../../docs/development.md)维护.
