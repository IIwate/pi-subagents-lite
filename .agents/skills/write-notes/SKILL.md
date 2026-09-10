---
name: write-notes
description: 编写与维护 Agent Notes 架构决策记录。在技术选型、重大重构、缺陷复盘、特性裁撤或架构收敛时记录决策理由、被否决方案并与代码原子提交。包含就地事实维护、源码反向锚点、文档代码块类型编译与 AST 符号等价门禁。
---

# Write Notes

Agent Notes 是面向 AI Agent 与工程团队的架构决策与防撞护栏体系。用于固化代码与常规文档无法承载的动机、被否决方案以及验证基线，与代码变更同一批提交。

## 核心工程纪律

1. 优先就地同步事实
修改既有模块、路径迁移、包重命名或参数默认值调整时，在同一个提交中直接更新持有该决定的既有 Note，保持其陈述与代码现状一致。严禁在文末追加流水账式的修改历史。详见 [when-to-write.md](references/when-to-write.md) 与 [implemented/AGENTS.md](../../notes/implemented/AGENTS.md)。

2. 决策反转需立新篇
就地修改仅限于事实落地形态的更新。若技术选型或架构原则发生反转，必须新建 Note 并建立双向交叉链接；被完全取代的旧 Note 依据 [archiving.md](references/archiving.md) 规则移入 `archived/`。

3. 源码入口反向锚点（单一主宿主规则）
凡涉及架构决策的核心代码入口，遵循“单一主宿主（Single Primary Host）”原则保留一行反向注释（原则上一篇 Note 仅对应源码中唯一一处锚点，严禁全库散弹式打标）：
- **首选核心类型**：有数据结构或 Schema 变更时，唯一锚定在核心接口、类型别名或类定义上方；
- **次选顶层门面**：无结构变更的纯流程、算法或状态机修复，唯一锚定在顶层门面入口方法或状态分发函数上方；
- **反模式**：禁止在辅助工具函数、中间层透传处重复打标。
```ts
// Note: 见 .agents/notes/implemented/<class>/<filename>.md
```
门禁脚本 `verify-doc-refs` 会静态扫描全库源码注释，杜绝死链与事实漂移。

4. 强制反稻草人备选
每篇 Note 必须包含 `## Alternatives considered` 章节。必须包含真实对比过的替代路径，必须包含维持现状或不做的选项，并陈述对手方案的最强论据后再予以否定。自检标准见 [quality-gate.md](references/quality-gate.md)。

5. 文档代码块防腐（代码块分级模型）
Note 中的代码块实行三级分层防护，严禁为迎合门禁而人为捏造无意义类型：
- **核心契约（AST 镜像）**：跨模块公开接口、持久化模型、共享 Schema 或核心状态联合类型，使用 ````ts type-equiv: <Symbol> from <Path>````，由门禁进行 AST 级镜像核对，防御破坏性重构；
- **逻辑示例（真实编译）**：纯行为、算法或调用时序变更，使用标准 ````ts```` 参与真实 TypeScript 编译器类型检查，确保 API 语法与入参不腐烂（无需 type-equiv）；
- **伪代码/草稿**：显式标注 ````ts ignore-check```` 跳过类型检查。详见 [verification.md](references/verification.md)。

6. 路径即状态与无中心索引
目录结构编码状态与类别，禁止使用集中的 `INDEX.md`，通过相对 Markdown 链接（例如 `[topic](../../implemented/architecture/yyyy-mm-dd-xxx.md)`）进行交叉引用，根除多分支并发合并冲突。

7. 严格时态隔离
`implemented/` 下严格使用现在时描述已落地的客观事实，严禁出现 `Proposal`、`Plan`、`Acceptance criteria` 等将来时口吻。行文规范见 [prose-checklist.md](references/prose-checklist.md)。

8. 尊重项目定制与受管围栏隔离
宿主项目根目录 `AGENTS.md` / `CLAUDE.md` 中的 `<!-- BEGIN WRITE-NOTES GUARDRAILS -->` 至 `<!-- END WRITE-NOTES GUARDRAILS -->` 属于脚手架受管区；围栏之外属于用户与项目的专属领地（如团队定制规则、包管理规范、部署流水线约束等）。Agent 与更新工具严禁改动围栏外的任何内容，严禁将用户定制规则视为“规范漂移”而自作主张抹除。

9. 绝对免除边界（严禁为文档建 Note）
Note 的定位是固化**代码与常规文档无法承载的架构动机与防撞护栏**。纯文档变更（README、用户指南、API 文档润色、错别字修正与排版）、注释微调、单测补充、常规依赖升级及非架构性日常缺陷修复，属于免除范围，直接提交产物即可，**绝对严禁为此新建 Note**（文档本身已能自圆其说，绝不为文档再造元文档）。

## 目录结构

路径格式：`.agents/notes/{lifecycle}/{class}/yyyy-mm-dd-topic.md`

- `proposed/`：仅用于**跨轮次/需异步评审**的方案与权衡（如等待人类审阅、分期工程立项、探索性 PoC），经评审确认后施工。模板见 [templates/proposed.md](../../notes/templates/proposed.md)。
- `implemented/`：已落地的决策事实，与代码原子提交。**单轮闭环交付（随代码同批交付）直接在此以现在时编写**，免除写 proposed 再移动的摩擦。模板见 [templates/implemented.md](../../notes/templates/implemented.md)，纪律见 [implemented/AGENTS.md](../../notes/implemented/AGENTS.md)。
- `rejected/`：被否决的方案，冻结在此并注明原因，防止后续反复提议已被证伪的路线。模板见 [templates/rejected.md](../../notes/templates/rejected.md)。
- `archived/`：完全被后续决策取代的历史记录，永久冻结。约束见 [archived/AGENTS.md](../../notes/archived/AGENTS.md)。

### 6 大分类

分类判定规则详见 [classification.md](references/classification.md)：
- `feature`：面向用户或调用方的新能力及非显式产品选择。
- `bug-fix`：缺陷修复，或复盘暴露出的架构缺口填补。
- `simplification`：只删不增。清理冗余逻辑、收敛对外暴露面及无行为变化的重构。
- `architecture`：交付源码的结构性决策、模块边界与包依赖关系。
- `process`：工具链、门禁、构建发布规范（非运行时行为）。
- `testing`：测试基建、测试分层与验收策略。

## 文件格式

前三行固定：

```markdown
# Agent Note: <标题>

Status: <状态>
```

- `proposed` 对应 `Status: proposed`
- `implemented` 对应 `Status: implemented`
- `rejected` 对应 `Status: rejected — <一句话原因>`

展开规范见 [note-format.md](references/note-format.md)。

### 正文结构

`proposed/` 结构：
- `## Problem`
- `## Proposal`
- 自定义技术章节
- `## Alternatives considered`
- `## Acceptance criteria`
- `## Risks`

`implemented/` 结构：
- `## Problem`
- `## Decision`（现在时）
- 自定义架构章节
- `## Alternatives considered`
- `## Consequences`（代价与收益）

`rejected/` 结构：
- 冻结当时的提案正文，结论注明于状态行。

## 自动化门禁

在项目根目录下通过脚本执行：

```bash
# 全量门禁（目录树、格式与时态、源码反向死链、文档代码编译检查、AST 契约等价校验）
npm run verify-notes

# 单项校验
npm run verify-tree         # 目录树规范与相对链接
npm run verify-format       # 头块格式、必选章节与时态禁令
npm run verify-doc-refs     # 源码注释反向死链扫描
npm run verify-typecheck    # Markdown 代码块真实编译检查
npm run verify-type-equiv   # 架构核心符号 AST 等价性镜像校验

# 归档操作
npm run archive-note .agents/notes/implemented/<class>/<filename>.md

# 无损升级规范与白盒门禁（更新 Skill/模板/脚本，绝不触碰已有 Note 资产）
npx write-notes update
```

技术实现说明见 [verification.md](references/verification.md)。

## 资产参考

- 模板目录：[templates/](../../notes/templates/)（`proposed.md`, `implemented.md`, `rejected.md`）
- 语义自检：[quality-gate.md](references/quality-gate.md)
- 行文去思维链：[prose-checklist.md](references/prose-checklist.md)
- 归档机制：[archiving.md](references/archiving.md)
- 分类界限：[classification.md](references/classification.md)
- 触发时机与就地更新：[when-to-write.md](references/when-to-write.md)
- 校验脚本详解：[verification.md](references/verification.md)
