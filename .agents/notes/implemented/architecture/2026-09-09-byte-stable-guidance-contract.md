# Agent Note: 字节级确定性的 Subagent 引导契约与缓存边界

Status: implemented

## Problem

在基于大模型（LLM）的编码工具中，支持 Prompt Caching（提示词前缀缓存）的模型推理服务（如 Claude Prompt Caching、OpenAI Prompt Caching、DeepSeek 缓存上下文等）对输入文本的字节级一致性有着极高要求。如果系统提示词（System Prompt）后缀中追加的内容因为 JavaScript 对象遍历乱序、集合迭代顺序不确定或标点空白波动而发生细微漂移，将直接击穿服务端的 Prompt Cache，导致每次调用的首字延迟与计费成本成倍增加。

另一方面，如果提示词向模型透露了未授权、被全局禁用、未连通注册表或超出 Scope 的模型，会导致模型产生幻觉，构造出非法的调用参数；而如果采用通配符（如模糊告知“可以使用所有模型”）替代明确的标识符，模型在填写参数时同样极易出错。

## Decision

系统在 `src/prompt/agent-guidance.ts` 中通过 `buildCurrentAgentGuidance` 统一生成结构高度紧凑、纯确定性的 Guidance 文本，并严格执行以下契约：

1. **字节级稳定性（Byte-stable Sorting）**：
   - 所有动态集合在渲染前强制进行稳定排序：Agent 类型按名称字母序排序；Provider 按字母序排序；计算得到的候选模型 Key 去重后按字典序排序。
   - 只要运行时状态（父模型、路由配置、可用模型集合、Scope 限制）未发生变化，生成的 Guidance 字符串保证在二进制层面上绝对稳定，最大化复用服务端 Prompt Cache。
2. **规范化块结构契约**：
   Guidance 固定输出四个核心段落：
   - `[Subagent access]` 标题与可用 Agent 类型列表（含工具集合与 `maxTurns` 约束）。
   - `Agent tool rules:` 固定硬性调用准则（包括新建独立会话、后台模式说明、`worktree_path` 路径约束、模型缺省规则等）。
   - `Model access:` 明确标明当前父模型缺省（`Default for every agent: - <key>`）。
   - 备选模型列表：仅当路由开启（`routing.enabled`）且存在有效备选时，逐个列出规范化 Canonical Key（`provider/model`）。若路由关闭，输出明确的关闭提示。
3. **严格权限交集计算与防静默替换**：
   - 候选模型必须同时通过：全局 Provider 网关校验、模型注册表 `getAvailable()` 可用校验、`scopedKeys` 作用域校验，且排除当前父模型本身。
   - 严禁通配符替代：即便是“允许所有模型（All models）”的宽松规则，也必须在运行时枚举当前可用交集，禁止向模型输出不具备可调用性的宽泛声明。
   - 严禁静默回退（No silent fallback）：若模型调用了被拒绝或无效的显式模型参数，执行器直接报错并如实汇报，绝不静默降级为父模型。

核心生成配置契约定义如下：

```ts type-equiv: AgentGuidanceOptions from src/prompt/agent-guidance.ts
export interface AgentGuidanceOptions {
  agents: readonly GuidanceAgent[];
  parentModelKey: string;
  routing: Readonly<ModelRoutingConfig>;
  availableKeys: ReadonlySet<string>;
  scopedKeys: ReadonlySet<string> | null;
}
```

## Alternatives considered

- **采用通配符概要（如输出 "You may use any anthropic model"）** — 提示词虽然更短，但 LLM 缺乏具体的模型 ID 字典，经常凭空编造不存在的模型后缀引发调用失败；必须输出精准的 Canonical Key。
- **依赖运行时的默认对象遍历顺序** — 极易因不同 Node.js/V8 版本的哈希打散差异或动态插入顺序导致提示词字符波动，彻底摧毁 Prompt Cache。
- **非法模型调用时静默降级为父模型** — 看似增加了系统容错，实则掩盖了模型的参数幻觉与路由策略配置错误，容易导致低推理能力的父模型静默执行需要强思考模型的关键任务。

## Consequences

- **收益**：状态不变时输出 100% 字节稳定，为下游提供了可靠的 Prompt Cache 命中保障；模型调用参数零歧义，彻底杜绝了模型 ID 幻觉。
- **代价与已知上限**：当有效状态（如父模型切换或配置文件改动）发生变化时，Prompt 后缀仍然会更新并引发前缀缓存失效；但此缓存失效边界真实反映了安全与授权状态的变更，是必要的设计代价。
