# Agent Note: Action Fusion —— then_run 参数融合变更与验证命令

Status: implemented

## Problem

编码轨迹中存在一个高概率死板模式：模型调用 edit/write 改完文件后，下一轮几乎必然调用 bash/powershell 跑构建、测试或校验。两轮之间的模型决策是纯机械重复，却要多支付一次完整的模型思考与输出轮次（往返延迟与账单）和一次上下文重放。SoL-Pi 主会话轨迹测得该模式出现率超过 80%；本扩展的子代理以"实现并验证"型任务为主，同样命中，但短程任务上单次往返节省的占比此前无实测。

## Decision

[action-fusion.ts](../../../../src/drivers/action-fusion.ts) 装饰内建 edit/write 工具（语义复刻自 SoL-Pi action-fusion，MIT，保留 SPDX 头），在参数模式末尾追加可选 `then_run` 对象：变更成功则同轮以嵌套调用执行命令并合并为单次工具输出返回；变更失败立即抛错并标记 `[then_run:skipped]`，坚决不在脏状态下跑命令。该特性是显式 opt-in 的实验功能（`experimental.actionFusion`，默认 false），经 /agents 菜单 Experimental features 第二项开关。[PiResources](../../../../src/drivers/pi-resources.ts) 仅在开关开启时包装构造点（cwd 在构造闭包中锚定为任务解析后的工作目录），[ExtensionRuntime](../../../../src/runtime.ts) 持有跨全部子会话共享的 `FusedFileQueue` 并经 ResourceOptions 注入。

```ts type-equiv: ThenRunInput from src/drivers/action-fusion.ts
export interface ThenRunInput {
  command: string;
  /** Seconds; no default timeout when omitted. */
  timeout?: number;
}
```

```ts type-equiv: ActionFusionShell from src/drivers/action-fusion.ts
export interface ActionFusionShell {
  /** Permitted and currently active shell tool name, or undefined when the policy grants none. */
  available(): string | undefined;
  /** Execute the command as a nested call of the mutation tool call. */
  run(toolCallId: string, name: string, input: ThenRunInput, signal: AbortSignal | undefined): Promise<AgentToolCallOutcome>;
}
```

与 SoL-Pi 原版的三处子代理适配：

1. **命令经工具宿主嵌套执行（executeNested）路由，不直调 shell 工具。** 接受时策略（permits）与 active 集合双检查、嵌套调用记录、usage 记账与扩展钩子全部复用模型发起调用的同一闸门代码路径。接受策略未授予任何 shell 工具的代理（如 tools: [read, edit, write]）得到 `[then_run:rejected]` 显式失败而非静默提权；shell 选择按可用性驱动（bash 优先，powershell 回退），天然适配 Windows 下 powershell 替换 bash 的既有的接受集逻辑。
2. **文件队列为运行时级共享。** SoL-Pi 的进程内 per-path 队列在单会话下足够；本扩展的分层并发允许多个子代理并发共享工作区，队列由 ExtensionRuntime 持有、按规范化绝对路径（含符号链接解析与 Windows shell 路径换算）全局键控。队列只串行化融合操作，不闸普通（未融合）变更——对普通变更的干扰由变更后、命令前的 sha256 复核兜底（检出即 skipped）。
3. **零持久足迹。** 与 ObservationPack（存档 + ledger + 新内建工具）不同，融合不引入任何 custom entry、存储格式或收据；崩溃语义不劣化——命令执行中途崩溃 ≡ 现状下"edit 成功、下一轮未发出"的崩溃，变更已落盘而命令未跑。

错误语义（与上游一致）：变更抛错且带 then_run → 抛出 skipped；命令结果 isError（含非零退出码）→ 抛出含 `[then_run:failed]` 与命令输出的错误，变更保留（"非零退出被报告但保留 edit"）；输出合并为 `[then_run:succeeded]\n<output>` 追加在变更文本之后。融合输出是普通工具结果，开启 ObservationPack 时自然流经同一投影管道参与打包。

## Alternatives considered

- **维持现状（变更与验证分两轮，不做）.** 无任何新机制、无第四个本地概念，ROADMAP §5 的封闭集不被触动. 但死板双轮模式是编码轨迹中最高频的确定性浪费，审计 08 在本扩展自有工作负载上实测：4 轮 write+verify，请求数 9→5（-44%）、请求 token -54%，且每次往返的延迟与输出 token 节省随真实模型放大；放弃即永久支付该税.
- **直调 shell 工具 execute（SoL-Pi 原版路径）.** 实现最简，与上游代码逐行对齐，无需 ActionFusionShell 抽象. 但 SoL-Pi 是单代理全权限宿主，从未面对按代理接受策略；直调绕过 beforeToolCall 的 permits+active 双门，白名单无 shell 的代理将经后门获得命令执行能力，违反"接受时策略不可绕"的运行时不变量；嵌套路由还免费获得调用记录与 usage 记账.
- **等 M4 后以 pi.post_tools 原生形态实现.** pico3 内核的 post_tools 是回合结算任务（决定 successor/terminate），带 afterTools 钩子，是内核内生的"工具后"扩展点，届时无需本地装饰. 但该钩子解决的是回合级决策而非 per-tool 命令串联——融合的全部价值恰在消除下一个模型回合，内核并未提供 schema 级融合机制；且 M1 启动本身为信号门控、无时间表，等待期放弃的是当下的确定性节省. 现实现零持久足迹，pico3 迁移成本 ≈ 在新工具构造点重新包装；M4 时应重评估是否改以 afterTools 形态落地.
- **默认全开启，无实验开关（已否决）.** 用户零心智成本. 但 then_run 是模型需要学习的本地词汇，合规率未经真实模型验证；且融合把两次独立可审计的工具调用合并为一次，出错时排障面变大. 遵循与 ObservationPack 一致的 Explicit Opt-in 原则默认关闭.

## Consequences

- **收益**：每个"变更+验证"对消除一次模型回合（审计 08：请求数 -44%、请求 token -54%，4 轮工作负载）；策略门零信任缺口——融合命令与模型发起的 shell 调用走完全相同的 permits+active 闸门；跨子会话同文件融合操作串行化，篡改经 sha256 复核显式检出；与 ObservationPack 叠加时融合的长输出自动参与打包。
- **代价与已知上限**：`then_run` 是第四个项目本地概念（ROADMAP §3.5/§5 已登记），是模型要学习的本地 schema 词汇，真实模型的合规率未经验证——这是默认开启的前置条件。融合调用把命令输出并入变更结果，工具卡片渲染的是包装后的文本（渲染层无 SoL-Pi 的 TUI 上报，为刻意裁剪）。队列只覆盖融合操作，普通 write/bash 对同一文件的并发干扰仅靠哈希复核检出（检出即 skipped，不阻止）。pico3 迁移时 `pi.tool` 的 replay 声明须标 unsafe，且应重评估 afterTools 原生形态（见 Alternatives）。

## Verification

[单元检查](../../../../test/unit/drivers/action-fusion.test.ts) 覆盖：then_run 模式注入与无参透传、变更失败 skipped 熔断、同轮合并输出、命令失败保留变更但显式报错、无 shell 策略 rejected、篡改检出、共享队列串行化原子对。[审计 08](../../../../scripts/audit/08-action-fusion.ts)（`bun scripts/audit/08-action-fusion.ts`）以 faux provider 在真实会话层量化：融合 5 请求 vs 现状 9 请求、token -54%，并验证合并观测每轮一次、fixture 文件落盘正确。未覆盖：真实模型对 then_run 的合规率、Windows powershell 路径（shell 选择逻辑依赖接受集，平台 CI 覆盖）。
