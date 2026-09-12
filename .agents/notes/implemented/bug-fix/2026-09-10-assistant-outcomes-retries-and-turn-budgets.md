# Agent Note: Assistant 终态、瞬态重试与回合预算

Status: implemented

## Problem

Pi 的 `session.prompt()` 可以正常 resolve, 同时最后一条 assistant message 带有 provider error. 网关也可能用正常 stop 结束空白或只有 thinking 的流. 仅检查 Promise 是否 reject, 或从整个历史寻找任意非空文字, 会把错误或中途片段报告为完成. 另一方面, 工具循环必须有终止边界, 并给模型留出写阶段性结论的机会.

## Decision

[HarnessDriver](../../../../src/drivers/harness-driver.ts) 在原生 after_response hook 检查最终 assistant 正文. 空完成及整段伪工具调用文本转为明确错误. Native OperationResultRecord 决定 terminal status; [NativeTaskStore](../../../../src/drivers/native-task-store.ts) 仅从对应 operation 的消息区间提取最后 assistant 文本, 不回退到其他运行的旧结果.

原生分支查询从 operation 的 tipId 向前遍历, 在 fromTipId 停止并排除该节点. 停止边界按遍历顺序生效, 从最旧节点开始会截取此前运行的历史, 使继续执行的正文与回合计数失真.

重试、退避、恢复和未知工具效果由原生 Harness 承担. Adapter 使用公开 hooks, 不包裹宿主私有重试方法. 瞬态失败是否再次执行取决于原生分类和已配置 retry policy; 认证、权限和内容拒绝不通过补发另一 Agent 绕过.

maxTurns 未设置或为 0 表示不限, 接受边界解析为正整数预算. 达到软上限后以原生 steer 提醒停止工具调用并汇总, grace 默认为 6, 0 或 1 仍留一个汇总回合. before_request 达到 maxTurns + max(1, grace) 时请求原生 abort. policy work 的失败与真实 drive 一起收敛, 不让事件回调产生未处理 rejection.

继续执行建立新 operation 并重新计算回合预算; maxTokens 通过 Driver 的模型请求视图与原生 stream options 生效, 不修改父模型. 显式 StopAgent 或用户停止保存 operation 的 stoppedBy, 与预算 abort 区分. [状态说明](../../../../src/status-note.ts) 将停止后的文本标为部分输出.

## Alternatives considered

- **保留 Promise 成功即完成, 或使用最近非空历史回答.** 最少适配 Pi 细节, 但 provider error 可以不 reject, 历史正文也可能只是任务中间阶段.
- **扩展自建重试循环或自动派发替代 Agent.** 可控制所有策略, 但需重复实现 Pi 的回滚、steering、退避和取消, 且可能重做已有工具副作用. 当前仅扩展分类, 不承诺工具副作用恰好一次.
- **接受 thinking 为结果, 或把所有空白 error 都重试.** 能隐藏部分异常, 但前者混淆推理和报告, 后者会反复请求永久拒绝. 最终错误仍必须可见.
- **达到 maxTurns 立即 abort.** 预算边界直接, 但不给模型汇总机会. 软提示加硬停止保留可读的部分成果, 代价是额外 grace 回合.

## Consequences

终态和最终正文由本次原生 operation 决定. 重试耗尽仍是错误, 不保证最终成功或外部工具恰好执行一次. 错误后的显式继续建立独立 operation, 正文和交付身份仍以该次运行的持久事实为准.

## Evidence

- `5fd169f`, `37fc553`: terminal assistant 元数据和伪工具调用正文守卫.
- `f87a115`, `9d03c06`, `4e5ac95`, `cef94ba`: Pi retry 扩展、传输错误及纯 thinking/空白分类.
- `bda06c2`, `bf4c335`, `68d72f2`, `1e75d1a`: grace、软硬停止和停止发起者说明.
- `cbbefae`, `65d1690`: output token 限制的 provider payload 方案与 Pi 原生模型参数方案.

## Verification

[原生执行场景](../../../../test/scenarios/agents/execution-adapters.test.ts)、[Runtime 场景](../../../../test/scenarios/runtime.test.ts) 与 [状态说明](../../../../test/unit/status-note.test.ts) 覆盖结果、预算、停止发起者、资源交接和独立执行.
