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
   - 检查范围为扫描到的路径是否存在，不判断锚点唯一性、文字事实或架构合理性；
   - Note 被重命名、移动或删除后，残留的失效源码引用会报错。

4. **`verify-doc-typecheck`**（`scripts/verify-doc-typecheck.ts`）
   - 提取活跃 Note 与文档中的 ````ts```` / ````typescript```` 代码块，排除归档目录；
   - 载入宿主项目的 `tsconfig.json` 并调用真实 TypeScript 编译器进行类型检查；
   - 杜绝代码重构后文档中的 API 示例过时腐烂；
   - 适用场景：纯行为逻辑、调用示范、算法说明及无跨模块契约变更的代码块；
   - 豁免机制：纯伪代码、概念草稿可显式标注 ````ts ignore-check```` 跳过检查。

5. **`verify-type-equiv`**（`scripts/verify-type-equiv.ts`）
   - **按需启用（Opt-in）**：仅针对架构决策中定义的关键数据结构、持久化模型与跨模块协议契约；
   - 标记语法：
     ````markdown
     ```ts type-equiv: <SymbolName> from <SourceFilePath>
     export interface SessionConfig { ... }
     ```
     ````
   - 解析代码块与真实源文件的 TypeScript AST 抽象语法树，排除归档目录中的历史契约；
   - 规范化比对字段与结构，一旦源码改动而 Note 未同步，立刻在 CI 中报错，确保架构文档与代码契约绝对一致；
   - **防异味铁律**：若本次变更纯属算法、状态机时序或内部逻辑修复（无新增/修改核心数据结构），使用标准 ````ts```` 走真实类型编译检查即可，**严禁为凑 AST 门禁而凭空捏造无意义类型**（全库无 type-equiv 标记时门禁自动安全放行）。

## 辅助与运维工具

6. **`verify-archived-notes`**（`scripts/verify-archived-notes.ts`）
   - 校验 manifest 的格式、登记路径、文件存在性和 SHA-256 内容哈希；没有 manifest 时按零登记项通过。
   - 只保证登记文件的内容一致，不检查历史链接、旧 API 或文字事实；未登记的历史文件不自动补封印。

7. **`archive-agent-note`**（`scripts/archive-agent-note.ts`）
   - 支持 `--dry-run` 与 `--replacement`，在写入前解析路径、引用和已有 manifest。生成归档日期、替代关系，更新引用并写入封印。
   - 失败边界和具体命令见 [archiving.md](archiving.md)。

8. **`note-references`**（`scripts/note-references.ts`）
   - `npm run note-refs -- <note-or-source-path>` 输出 JSON 格式的 incoming/outgoing、文件、行号和目标是否存在。
   - 动态扫描 Markdown 内联链接、引用定义及源码中的 Note/docs 路径；跳过代码围栏、归档、模板、安装的 Skill 与常见构建/依赖目录，不创建索引。

## CI 接入建议

在项目 CI 流水线（如 GitHub Actions）中直接配置：

```bash
npm run verify-notes
```
依次执行 tree -> format -> doc-refs -> typecheck -> type-equiv -> archives。格式检查只检查约定的标题与章节，不证明自然语言时态或论证质量。旧项目使用 `write-notes update --scripts` 同步脚本及门禁命令；普通 update 保留项目已有脚本与命令。
