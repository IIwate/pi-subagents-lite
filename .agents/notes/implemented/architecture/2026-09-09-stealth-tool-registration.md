# Agent Note: 插件初始化静态隐形注册与极简 Schema

Status: implemented

## Problem

在基于大语言模型（LLM）的编码智能体环境中，中途向运行时动态增删工具存在严重的性能与缓存惩罚。例如，llama.cpp、vLLM 以及部分端侧推理引擎通过 Jinja2 等模板将当前可用工具集合序列化为 Prompt 前缀文本。如果在会话进行中动态调用工具注册接口，将彻底破坏既有的 KV-cache 前缀，导致整个上下文发生昂贵的重新计算。

此外，若为工具编写冗长的 `description`、`promptSnippet` 以及详尽的参数描述，这些静态文字会在每一次与 LLM 的交互中无差别地占据上下文窗口，极大浪费宝贵的输入 Token，且无法适应会话中动态变化的权限规则。

在更深层的工具执行与多平台运行时中，还存在以下关键工程隐患：
1. **伪工具调用文本误判（Tool Call Text Ambiguity）**：部分端侧或轻量模型在未能原生触发 Function Calling 时，会在 assistant 纯文本中打印工具调用文本（如 `call:tool_name{...}`）。若执行器直接将其作为最终答案交付给父会话，会导致未执行的调用文本被误当成计算成果；
2. **跨平台工具集断裂（Windows Bash vs PowerShell）**：子代理继承父会话工具集时，Linux 默认依赖的 `bash` 在 Windows 原生环境下通常不可用。若缺乏平台感知的工具代偿与继承逻辑，子代理在 Windows 上将瞬间失去终端执行能力；
3. **思考等级与模型的强耦合**：早期将思考等级（Thinking Level）拼接在模型标识符中，导致 Schema 无法对思考等级做合法的静态枚举约束。

## Decision

系统在插件初始化阶段一次性完成所有工具的静态注册，并在运行时冻结工具集结构，同时建立严格的执行验证与跨平台适配机制：

1. **生命周期内一次性静态注册（One-time Lifetime Registration）**：
   在 `registerTools`（`src/registration.ts`）中一次性注册 `Agent`、`StopAgent` 与 `AgentStatus`，运行期间绝不触发 `refreshTools()` 或调用 `setActiveToolsByName()`，彻底保障推理端 KV-cache 前缀的稳定。

2. **极简隐形 Schema（Stealth Schema）**：
   - 工具定义完全省略顶层 `description`（通过 TypeScript 忽略注释抑制校验），彻底移除 `promptSnippet` 与 `promptGuidelines`；
   - 参数仅保留强类型校验与极致紧凑的单句说明（限制在 40~60 字符以内）；
   - 具体使用指引、可用 Agent 类型列表与动态模型白名单完全剥离至动态提示词注入机制（见 [2026-09-09-dynamic-guidance-injection.md](2026-09-09-dynamic-guidance-injection.md)）。

3. **Thinking 参数解耦与严格枚举校验**：
   - 在 `Agent` 工具中将 `thinking` 提升为独立显式参数：
     ```ts ignore-check
     thinking: Type.Optional(Type.Union(VALID_THINKING_LEVELS.map(level => Type.Literal(level)), {
       description: "Thinking level supported by the selected model.",
     }))
     ```
   - 依赖 TypeBox 原生校验在调用进入核心前拦截非法枚举值，杜绝非法参数穿透至底层模型 API。

4. **拒绝伪工具调用文本（Reject Tool Call Text as Completion）**：
   在 `src/agents/agent-runner.ts` 中实施终态结果守卫：严格识别子代理输出内容。若输出仅包含未执行的工具调用文本（如包含 `call:` 前缀而未产生实质结果），执行器坚决拒绝将其作为有效完成交付，防止虚假成果污染主会话。

5. **Windows 平台默认终端工具自适应代偿（PowerShell Substitution）**：
   子代理在构建执行环境时执行平台嗅探：
   - 若运行在 Windows 平台且宿主 `bashAvailable === false`，系统自动将 `powershell` 注入进可用工具集代偿 `bash`；
   - 严格遵守 `excludeTools` 策略：若 Agent 配置显式排除了 `powershell`，则代偿逻辑遵从排除规则，杜绝越权执行。

6. **静默渲染配置（Silent Tool Rendering）**：
   所有子代理相关工具均配置 `SILENT_TOOL_RENDERING`（`renderShell: "self"`，且 `renderCall` / `renderResult` 返回空容器），彻底阻止宿主环境默认的 Tool Card 侵入主会话视图，子代理状态完全收敛于专用的下方面板。

```ts ignore-check
// 极简工具注册范式示意
pi.registerTool({
  name: "Agent",
  label: "Agent",
  parameters: Type.Object({
    prompt: Type.String(),
    description: Type.Optional(Type.String({ description: "Short action phrase (max 40 chars)." })),
    agent: Type.Optional(Type.String()),
    model: Type.Optional(Type.String({ description: "Exact model ID or provider/model ID." })),
    thinking: Type.Optional(Type.Union(VALID_THINKING_LEVELS.map(level => Type.Literal(level)))),
    run_in_background: Type.Optional(Type.Boolean()),
    worktree_path: Type.Optional(Type.String({ description: "Path to main checkout or linked worktree." })),
  }, { additionalProperties: false }),
  execute: executeAgentTool,
  ...SILENT_TOOL_RENDERING,
});
```

## Alternatives considered

- **在工具定义中书写详尽文档与规则** — 能够让工具本身自解释，但每轮对话白白耗费数百 Token，且无法反映当前生效的父模型和动态路由权限。
- **允许子代理直接交付未执行的工具调用文本** — 容忍了模型的文本格式缺陷，但导致父模型收到未经执行的代码或参数片段并误以为任务完成，破坏了调用因果链。
- **Windows 下无条件报错缺失 Bash** — 简单粗暴，但彻底摧毁了 Windows 开发者的开箱即用体验；基于环境嗅探自动代偿 PowerShell 是更实用的工程解。
- **运行时按需延迟注册（Lazy Registration）** — 仅在开启子代理时才注册工具，其最强论据是保持未使用时的工具列表纯净。但因其在调用 `refreshTools` 时导致推理端 KV-cache 完全失效并引发严重卡顿，该方案已被明确否决，详见 [2026-09-09-lazy-tool-registration-and-session-briefing.md](../../rejected/architecture/2026-09-09-lazy-tool-registration-and-session-briefing.md)。
- **使用平台默认的工具卡片渲染** — 无需额外维护渲染器，但会导致主对话流被频繁、冗长的子代理调用卡片淹没，破坏交互体验。

## Consequences

- **收益**：全生命周期工具集合完全冻结，从根本上保证了 KV-cache 前缀的一致性；每轮交互节省大量基准 Prompt Token；跨平台终端工具自适应代偿提升了可用性；严格的结果校验阻止了伪工具文本造成的幻觉。
- **代价与已知上限**：工具 Schema 缺乏自描述能力，调用方 LLM 必须完全依赖外部注入的系统提示词（System Prompt Guidance）来获知参数含义与可用模型；Windows 平台代偿 PowerShell 时需防范语法不兼容导致的命令执行差异。

## Verification

- 静态 Schema 结构与参数校验经单测验证：[test/unit/index.test.ts](../../../../test/unit/index.test.ts)（使用 TypeBox `Value.Check` 验证）。
- 伪工具调用文本拒绝逻辑经单测覆盖：[test/unit/agents/runner/agent-runner.limits.test.ts](../../../../test/unit/agents/runner/agent-runner.limits.test.ts)。
- Windows 平台 PowerShell 工具注入与排除边界经集成测试保证：[test/scenarios/agents/powershell-execution.test.ts](../../../../test/scenarios/agents/powershell-execution.test.ts) 与 [test/unit/agents/powershell-policy.test.ts](../../../../test/unit/agents/powershell-policy.test.ts)。
