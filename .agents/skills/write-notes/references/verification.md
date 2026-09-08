# 按需阅读：校验与辅助脚本

> SKILL 门禁部分的展开。接入 CI 时对照；本地轻量使用时跳过。第一指导源自 DeepSeek Harness 原生门禁。

## 核心自动化门禁体系

1. **`verify-agent-note-tree`**（`scripts/verify-agent-note-tree.ts`）
   - 校验 lifecycle 封闭集（`proposed`, `implemented`, `rejected`, `archived`）；
   - 校验 6 大封闭类别（`feature`, `bug-fix`, `simplification`, `architecture`, `process`, `testing`）；
   - 路径深度严格为 `{lifecycle}/{class}/yyyy-mm-dd-topic.md`；
   - **严禁集中式 `INDEX.md`**；
   - 校验 Note 间相对 Markdown 链接（`[topic](../../implemented/...)`）的有效性。

2. **`verify-agent-note-format`**（`scripts/verify-agent-note-format.ts`）
   - 校验头三行严格为 `# Agent Note: <标题>`、空行、`Status: <状态>`；
   - `## Problem` 必须为首个章节；
   - `implemented/` 下**绝对禁止**出现 `Proposal`、`Plan`、`Acceptance criteria` 等将来时口吻；
   - 强制必须包含 `## Alternatives considered`。

3. **`verify-doc-refs`**（`scripts/verify-doc-refs.ts`）
   - 静态扫描全库源码（`.ts`, `.py`, `.go`, `.rs`, `.java` 等）中的注释与字符串引用；
   - 确保 `// Note: ... 见 .agents/notes/...` 形式的反向追溯注释全部指向真实存在的 Note；
   - 一旦 Note 被重命名、移动或删除而代码注释未同步更新，CI 强行拦截报错，从物理机制上终结事实漂移。

4. **`verify-doc-typecheck`**（`scripts/verify-doc-typecheck.ts`）
   - 提取全库 Note 与文档中的所有 ````ts```` / ````typescript```` 代码块；
   - 载入宿主项目的 `tsconfig.json` 并调用真实 TypeScript 编译器进行类型检查；
   - 杜绝代码重构后文档中的 API 示例过时腐烂；
   - 豁免机制：纯伪代码、概念草稿可显式标注 ````ts ignore-check```` 跳过检查。

5. **`verify-type-equiv`**（`scripts/verify-type-equiv.ts`）
   - 针对架构决策中定义的关键数据结构与协议契约；
   - 标记语法：
     ````markdown
     ```ts type-equiv: <SymbolName> from <SourceFilePath>
     export interface SessionConfig { ... }
     ```
     ````
   - 解析代码块与真实源文件的 TypeScript AST 抽象语法树；
   - 规范化比对字段与结构，一旦源码改动而 Note 未同步，立刻在 CI 中报错，确保架构文档与代码契约绝对一致。

## 辅助与运维工具

6. **`archive-agent-note`**（`scripts/archive-agent-note.ts`）
   - 方案被新决策完全取代时的一键归档命令：插入归档日期行、移动到 `archived/<class>/`、写入 `manifest.json` SHA-256 校验和并提示修复活跃 Note 中的入站相对引用。

## CI 接入建议

在项目 CI 流水线（如 GitHub Actions）中直接配置：

```bash
npm run verify-notes
```
（依次执行 tree -> format -> doc-refs -> typecheck -> type-equiv 五重门禁，任何一项失败即红灯阻断）。
