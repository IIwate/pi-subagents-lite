# Agent Note: 每轮父模型 Guidance 的注入时机

Status: implemented

## Problem

静态 Agent schema 无法列出会话中变化的 Agent 类型、父模型、availability/scope 和授权. 仅启动时生成 guidance 会过期, 放入 conversation 则要处理重复消息和 compaction. 这份动态规则需要随正常父推理刷新, 不额外触发模型轮次.

## Decision

[setupEventListeners](../../../../src/events.ts) 在 before_agent_start 根据当前 context 和 ConfigStore 生成 guidance, 追加到 event.systemPrompt. 仅当 selectedTools 包含 Agent 时加入 Agent 规则. 构建使用当前已注册 Agent 目录、父模型、forceBackground、available keys 和 scope, 不在 hook 内执行磁盘发现.

[原生结果交付](2026-09-11-native-execution-and-parent-delivery-adapters.md) 由任务完成、Runtime 初始化及 agent_settled/session_tree 事件触发. 交付资格独立于 selectedTools, system guidance 与持久 custom result message 各有所有者.

model_select/thinking_level_select 更新所属 Runtime context, 下一轮重新计算. 配置和 availability 的变化同样进入下一轮 guidance; 已接受子调用仍使用 [快照](2026-09-10-isolated-child-resources-and-tool-gates.md). 文本构建的排序/授权内容归 [字节稳定契约](2026-09-09-byte-stable-guidance-contract.md).

## Alternatives considered

- **维持 session_start 一次性 briefing.** 注入次数少, 但模型/配置在会话内可变化, 规则会与执行器脱节.
- **把规则写成会话消息或手动刷新命令.** 可显示和回看, 但增加上下文消息及刷新责任, 还需定义 compaction 后的有效性. 当前使用宿主专用 system prompt hook, 历史路线见 [rejected Note](../../rejected/architecture/2026-09-09-lazy-tool-registration-and-session-briefing.md).
- **每次规则变化重新注册 schema.** 工具自描述最直接, 但改变工具前缀并与 [静态注册](2026-09-09-stealth-tool-registration.md) 冲突.

## Consequences

guidance 跟随下一次正常父请求更新, 没有独立 turn. 此同步 hook 仍可因第三方 context/registry 调用失败而丢弃返回. 主线没有 Pi 跨扩展排序 barrier; 本 Note 不保证其他扩展最终保留相同 system prompt.

## Evidence

`a33125c` 引入的 ADR 0001 记录静态 schema 与动态提示的选择; `aa5e867`, `fe27759`, `19ed1dd` 将访问规则、精确模型和后台错误说明纳入每轮 guidance. `a169de6` 将 ADR 事实迁入本 Note, 不改变运行契约.

## Verification

[Runtime scenarios](../../../../test/scenarios/runtime.test.ts) 检查配置切换后实际父请求的 guidance 与稳定性; [guidance tests](../../../../test/unit/prompt/agent-guidance.test.ts) 检查当前授权和确定性文本. [delivery scenarios](../../../../test/scenarios/spawn/delivery-channel.test.ts) 负责结果接收事实, 不用 guidance 测试替代.
