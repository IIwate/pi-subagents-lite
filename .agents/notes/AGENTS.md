# AGENTS.md — Agent Notes 治理契约

Agent Notes 是由 Agent 编写并维护的持久化架构决策记录（RFC）。总述见 [README.md](README.md)，工作流契约见 [SKILL.md](../skills/write-notes/SKILL.md)。

## 核心工作流与取代审计

1. 新增 Note 时的取代审计
每当新建一篇 Note 时，必须检索活跃树中是否已存在覆盖相同机制或决策的老 Note：
- 若完全取代老方案：将旧 Note 的有效价值吸收进新 Note，老 Note 依据 [archived/AGENTS.md](archived/AGENTS.md) 规则移入 `archived/` 并在同一提交中修复所有入站相对链接。
- 若部分取代老方案：保持两篇 Note 处于活跃状态并在正文中添加双向相对链接。

2. 现行法律与事实同步
对既有决策的维护严格遵循 [implemented/AGENTS.md](implemented/AGENTS.md) 的就地更新纪律。

3. 严禁改动归档文件
`archived/` 下的文件属于永久冻结的历史快照，绝对不要编辑它们，也不要将其视为当前系统的权威真理。
