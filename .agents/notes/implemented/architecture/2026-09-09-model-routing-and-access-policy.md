# Agent Note: 细粒度模型路由与访问权限策略体系

Status: implemented

## Problem

在早期子代理模型路由设计与推理模型接入过程中，系统面临四大架构与安全痛点：
1. **参数缺省语义模糊**：省略 `Agent` 工具的 `model` 参数时，无法明确是应该继承当前父模型，还是应该被自动分配的默认模型覆盖，造成执行不可预期；
2. **Provider 变更具有破坏性**：用户在配置中禁用或移除某个 Provider 时，可能直接破坏正在运行或排队中的子代理任务；
3. **缺少清晰的授权边界与静默降级陷阱**：无法在保证全局 Provider 安全准入的前提下，对不同 Agent 类型支持的特定模型进行细粒度白名单约束；早期曾尝试在备选模型调用失败时“静默降级为父模型”，导致低算力模型无感知接管复杂任务，引发质量事故；
4. **思考能力（Reasoning）与模型的耦合及空回复悬挂**：将思考等级与模型标识混写导致能力无法自适应匹配；在引入具备深度思考能力（Thinking/Reasoning）的模型后，偶发出现“模型流中断或仅吐出 thinking 内容，无实质回复”的伪成功现象，导致任务以空白结果交付。

## Decision

系统在 `src/config/types.ts`、`src/models/model-access.ts`、`src/models/thinking-resolver.ts` 及 `src/agents/agent-runner.ts` 中确立了一套严格的访问权限策略、自适应协商与重试防御体系：

1. **Routing 纯粹作为授权白名单，彻底废除默认分配**：
   - 彻底废除“子代理自动分配默认模型”机制；
   - 省略 `model` 参数，或者显式传入与当前父模型相同的 Key，有且仅有一个含义：**严格继承当前父模型**。父模型属于动态会话上下文，天然具有调用权，不受路由持久化策略限制。

2. **父 Provider 的动态特权与同源备选限制**：
   - 当前父模型所属的 Provider 动态绕过 `enabledProviders` 全局网关检查；
   - 但若要调用该 Provider 下的其他非父模型（同源备选），依然必须严格受到 Agent 规则、Model 白名单、注册表可用性与 Active Scope 的多重制约，不存在任何越权旁路。

3. **All Models 语义与交集契约**：
   - 规则中省略 `models` 字段代表授权“当前所有可用模型”（与 `modelRegistry.getAvailable()` 取交集），绝不包含目录全集（`getAll()`）里未配置密钥的死条目；
   - 非空数组代表严格的精确模型白名单；
   - 空数组 `[]` 视为非法并直接移除该 Provider 规则，绝不允许退化为通配符；
   - **绝对禁止静默回退（Fail-Closed Policy）**：调用被拒绝、不存在或越权的显式模型时，系统直接同步拒绝并抛出明确错误，绝不静默降级为父模型。

4. **Thinking 与 Model 解耦及能力自适应协商（Thinking Clamping）**：
   - 将 `thinking` 从模型标识符中彻底剥离，成为独立的显式枚举参数（`off` | `low` | `medium` | `high` 等）；
   - **能力感知自适应钳制（Capability-aware Clamping）**：解析阶段核验目标模型能力。若目标模型声明不支持推理（`model.reasoning === false`），无论调用方参数或全局配置设定为何，系统一律自动且安全地将思考等级钳制为 `"off"`（或 `undefined`），彻底杜绝由于参数非法导致的 API 400 报错。

5. **纯思考截断与空白回复的重试分类器（Blank & Thinking-only Retry）**：
   - 在 `agent-runner` 中接入重试分类器。当推理模型在回合结束时未产生任何有效 `text` 输出，或仅输出了 `thinking` 块而缺少正文内容时，不将其作为完成交付；
   - 将此类情况确立为**可恢复瞬态失败（Retryable Classification）**，自动触发会话回滚并重新请求，消灭空回复假死。

6. **被接受任务的深拷贝快照与加载配置规范化（Snapshots & Normalization）**：
   - 任务在派发（`spawn`）阶段被接受时，对其解析后的工具、策略、思维等级及模型配置进行深拷贝快照；
   - 任务在运行和排队过程中只依赖快照，用户后续对配置的任何修改、删除或 Provider 禁用，**绝不影响正在运行或排队中的任务**；
   - `config-store` 在从磁盘加载配置时执行自动规范化防御（Config Normalization on Load），清洗历史残存的不合法结构，确保规则集开机即纯净。

7. **休眠保护与不可用目录清理（Dormant Retention & Clean Unavailable）**：
   - 当 Provider 临时离线或凭据失效时，相关规则标记为休眠（Dormant），不破坏性抹除用户配置；
   - 仅当官方模型目录 `getAll()` 彻底移除某模型时，才在设置菜单提供经过确认的 Clean 操作。

核心权限配置契约定义如下：

```ts type-equiv: ModelRoutingConfig from src/config/types.ts
export interface ModelRoutingConfig {
  /** OFF permits only the exact parent model. */
  enabled: boolean;
  /** Providers globally enabled for alternates; the current parent passes this gate dynamically. */
  enabledProviders: string[];
  /** Per-agent provider/model access rules. */
  agentAccess: Record<string, AgentModelAccess>;
}
```

## Alternatives considered

- **在备选模型失败时自动回退为父模型（Silent Fallback）** — 表面看似提升了容错率，实则彻底摧毁了安全隔离与预期一致性。例如需要强推理模型执行关键审查的任务，在遭遇鉴权失败时会静默降级给轻量父模型，输出低质量代码却不报警。Fail-closed 报错是唯一负责任的方案。
- **自动模型分配系统（Assignment-based Routing）** — 曾尝试为每个 Agent 绑定默认模型，导致省略 `model` 时的语义模糊与意外行为，已被彻底废除。
- **将 Thinking 级别强编码在 Model 字符串中** — 导致模型命名格式爆炸，且无法跨 Provider 迁移通用配置，解耦为独立参数并基于能力自适应钳制是更清晰的正交设计。
- **允许空数组作为“所有模型”通配符** — 极易因配置编辑失误而意外向模型敞开全部权限，带来安全隐患；必须以字段省略作为明确意图。
- **Provider 暂时不可用时自动级联删除配置** — 临时断网或凭据刷新会导致用户精心配置的 Agent 模型白名单被不可逆抹除，采用休眠机制更为稳健。

## Consequences

- **收益**：模型参数缺省语义绝对确定（唯一继承父模型）；权限判定与模型能力多层防御，彻底杜绝越权与不支持参数报错；消除了推理模型空回复假死；配置具有容错休眠保护。
- **代价与已知上限**：任务派发时必须执行配置快照深拷贝（极微小的内存开销）；模型可用性计算需动态遍历 Provider/Model 的多重交集；自适应重试在持续网络中断下仍会在耗尽次数后报错。

## Verification

- 模型权限判定、父 Provider 特权与交集过滤由单元测试全面保证：`test/models/model-access.test.ts`。
- 思考能力解耦与自适应钳制经测试覆盖：`test/models/thinking-resolver.test.ts` 与 `test/agents/runner/agent-runner.setup.test.ts`。
- 纯思考与空白回复重试分类经真实会话集成测试验证：`test/agents/runner/agent-runner.pi.integration.test.ts`。
- 契约结构体与源码 AST 100% 同步，由 `npm run verify-type-equiv` 自动门禁校验。
