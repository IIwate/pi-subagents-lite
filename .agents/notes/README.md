# Agent Notes

本目录存放代码库的架构决策记录与技术提案（RFC）。用于固化代码与常规文档无法承载的决策动机、被否决方案与验证基线。规范契约详见 [SKILL.md](../skills/write-notes/SKILL.md)。

## 目录布局与生命周期

路径格式严格遵循：`{lifecycle}/{class}/yyyy-mm-dd-topic.md`

- `proposed/`：仅用于跨轮次/需异步评审的方案与权衡，待评审确认后施工。模板见 [templates/proposed.md](templates/proposed.md)。
- `implemented/`：已落地的决策事实，与代码原子提交并就地同步。单轮闭环任务直接在此以现在时编写。模板见 [templates/implemented.md](templates/implemented.md)，纪律见 [implemented/AGENTS.md](implemented/AGENTS.md)。
- `rejected/`：经讨论否决的方案，永久保留作为防翻案依据。模板见 [templates/rejected.md](templates/rejected.md)。
- `archived/`：已被后续新决策完全取代的历史记录，永久冻结。约束见 [archived/AGENTS.md](archived/AGENTS.md)。

## 6 大分类

- `feature`：面向用户或调用方的新能力及非显式产品选择。
- `bug-fix`：缺陷修复，或复盘事故补上的架构缺口。
- `simplification`：只删不增。清理冗余代码、收敛暴露面及无行为变更的重构。
- `architecture`：交付源码的结构性决策、包间关系与模块边界。
- `process`：工具链、门禁、构建发布规范（非运行时行为）。
- `testing`：测试基建、测试分层与验收策略。

## 核心规则

1. 无中心索引：禁止添加集中的 INDEX.md，跨 Note 引用纯靠相对 Markdown 链接。
2. 反稻草人备选：每篇 Note 必须包含 ## Alternatives considered 章节。
3. 门禁验证：提交前必须通过 npm run verify-notes。
