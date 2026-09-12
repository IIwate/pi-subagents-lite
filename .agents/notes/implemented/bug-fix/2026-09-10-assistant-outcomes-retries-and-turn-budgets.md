# Agent Note: Assistant 终态、瞬态重试与回合预算

Status: implemented

## Problem

Pi 的 `session.prompt()` 可以正常 resolve, 同时最后一条 assistant message 带有 provider error. 网关也可能用正常 stop 结束空白或只有 thinking 的流. 仅检查 Promise 是否 reject, 或从整个历史寻找任意非空文字, 会把错误或中途片段报告为完成. 另一方面, 工具循环必须有终止边界, 并给模型留出写阶段性结论的机会.

模型传输可以保持连接却永久没有下一个事件. 等待中的流既没有 terminal message 也没有 rejection, 原生重试分类无法运行, drive 和并发占用因而无法结算. 推理模型又允许较长的静默计算, 单一短时限无法同时表达思考等待和输出中途停滞.

## Decision

[HarnessDriver](../../../../src/drivers/harness-driver.ts) 在原生 after_response hook 检查最终 assistant 正文. 空完成及整段伪工具调用文本转为明确错误. Native OperationResultRecord 决定 terminal status; [NativeTaskStore](../../../../src/drivers/native-task-store.ts) 仅从对应 operation 的消息区间提取最后 assistant 文本, 不回退到其他运行的旧结果.

原生分支查询从 operation 的 tipId 向前遍历, 在 fromTipId 停止并排除该节点. 停止边界按遍历顺序生效, 从最旧节点开始会截取此前运行的历史, 使继续执行的正文与回合计数失真.

重试、退避、恢复和未知工具效果由原生 Harness 承担. Adapter 使用公开 hooks, 不包裹宿主私有重试方法. 瞬态失败是否再次执行取决于原生分类和已配置 retry policy; 认证、权限和内容拒绝不通过补发另一 Agent 绕过.

### Request inactivity

[withStreamWatchdog](../../../../src/drivers/stream-watchdog.ts) 位于 Driver 的局部 Models 视图, 包含 assistant 流、压缩摘要的 completeSimple 和 deferred 结果读取. 每次请求具有独立的 AbortController 和计时器. 请求建立时启动 600 秒静默预算; 正文前的非空 thinking delta、thinking 完成事件和 redacted thinking 块刷新该预算. 首个非空正文或工具调用事件将预算切换为 120 秒, 之后任何有效思考、正文或工具调用进展都刷新同一个窗口, 阶段不回退. start、空正文起始和空 delta 不延长等待. 计时针对 Pi 的模型事件, 不是 TCP 状态、HTTP headers 或 SSE 心跳字节.

超时先固定当前 partial message 的快照, 以包含 timed out 的 error 终结输出流, 再 abort 当前请求并结束独占的 source reader. 该快照保留已收集的正文和 usage, 不受 Provider 在取消过程中的后续原地修改影响. 这条路径不取消 Lane 的 durable control, 因而原生 assistant 和摘要分类可以按已配置的 retry policy 重试. 每次重试重新取得完整请求预算, 最大次数和指数退避继续由原生 Harness 决定; deferred 的错误处置也保持原生语义. 缺少 terminal event 的提前结束明确报告传输错误.

用户停止和资源关闭转发原有取消原因并产生 aborted, 不伪装成超时. done、error、取消与同步 setup 失败都清理计时器和信号监听. 请求已经终止后, 迟到的 Provider 事件不能覆盖最终结果. 模型流终止后不继续计时工具执行或原生退避. 任务配额仍由真实 drive 的结算释放, 不因一个请求超时而提前释放或重复释放.

maxTurns 未设置或为 0 表示不限, 接受边界解析为正整数预算. 达到软上限后以原生 steer 提醒停止工具调用并汇总, grace 默认为 6, 0 或 1 仍留一个汇总回合. before_request 达到 maxTurns + max(1, grace) 时请求原生 abort. policy work 的失败与真实 drive 一起收敛, 不让事件回调产生未处理 rejection.

继续执行建立新 operation 并重新计算回合预算; maxTokens 通过 Driver 的模型请求视图与原生 stream options 生效, 不修改父模型. 显式 StopAgent 或用户停止保存 operation 的 stoppedBy, 与预算 abort 区分. [状态说明](../../../../src/agents/status-note.ts) 将停止后的文本标为部分输出.

## Alternatives considered

- **保留 Promise 成功即完成, 或使用最近非空历史回答.** 最少适配 Pi 细节, 但 provider error 可以不 reject, 历史正文也可能只是任务中间阶段.
- **扩展自建重试循环或自动派发替代 Agent.** 可控制所有策略, 但需重复实现 Pi 的回滚、steering、退避和取消, 且可能重做已有工具副作用. 当前仅扩展分类, 不承诺工具副作用恰好一次.
- **仅使用 Provider 的 timeoutMs 或保持无限等待.** 复用 SDK 能减少适配, 无限等待也允许任意长的静默推理. 但 timeoutMs 在各 Provider 中覆盖建连、总时长或闲置的语义不同, 且有实现不使用它; 没有 terminal event 时无限等待无法激活重试. 请求级模型事件看门狗表达统一的进展边界.
- **首个 thinking token 后立即使用 120 秒, 或给整个响应固定 600 秒.** 两者都容易实现. 前者会截断正文前较长的分段推理, 后者会截断持续有进展的长响应. 分阶段滑动窗口保留持续思考和持续输出的时间, 同时给完全静默留下有限边界.
- **超时调用 Lane abort, 或仅拒绝一个 Promise.race.** 前者复用完整停止流程, 后者能迅速结束调用方等待. 但 Lane abort 表达任务取消并阻止原生重试, 仅结束等待又可能留下活跃传输. 独立请求取消与 error 流终结共同负责传输和读取等待.
- **接受 thinking 为结果, 或把所有空白 error 都重试.** 能隐藏部分异常, 但前者混淆推理和报告, 后者会反复请求永久拒绝. 最终错误仍必须可见.
- **达到 maxTurns 立即 abort.** 预算边界直接, 但不给模型汇总机会. 软提示加硬停止保留可读的部分成果, 代价是额外 grace 回合.

## Consequences

终态和最终正文由本次原生 operation 决定. 重试耗尽仍是错误, 不保证最终成功或外部工具恰好执行一次. 错误后的显式继续建立独立 operation, 正文和交付身份仍以该次运行的持久事实为准.

600 秒和 120 秒是静默预算, 不是对连接健康的证明. Provider 自身更短的超时仍可先触发; 超过预算而没有可见进展的合法计算也会被取消. 标准 HTTP/WebSocket 传输通过请求 signal 释放资源; 忽略 signal 的自定义 Provider 无法由扩展强制关闭其私有 Socket, 但不会继续阻塞本地流和 Lane. 有效事件持续到达时没有整次响应总时限.

## Evidence

- `5fd169f`, `37fc553`: terminal assistant 元数据和伪工具调用正文守卫.
- `f87a115`, `9d03c06`, `4e5ac95`, `cef94ba`: Pi retry 扩展、传输错误及纯 thinking/空白分类.
- `bda06c2`, `bf4c335`, `68d72f2`, `1e75d1a`: grace、软硬停止和停止发起者说明.
- `cbbefae`, `65d1690`: output token 限制的 provider payload 方案与 Pi 原生模型参数方案.

## Verification

[原生执行场景](../../../../test/scenarios/drivers/harness-driver.test.ts)、[Runtime 场景](../../../../test/scenarios/runtime.test.ts) 与 [状态说明](../../../../test/unit/agents/status-note.test.ts) 覆盖结果、预算、停止发起者、资源交接和独立执行. 流场景使用可控的离线 Provider 和虚拟时钟, 验证首字前长等待、思考保活、120 秒闲置取消、原生退避后恢复交付、重试耗尽后释放配额以及用户停止静默.

[看门狗单测](../../../../test/unit/drivers/stream-watchdog.test.ts) 覆盖空事件、工具调用、思考与正文切换、取消后不再发终止事件的 Provider、迟到修改隔离和定时器清理. 这些检查不连接在线模型或模拟实际代理的 TCP 行为.
