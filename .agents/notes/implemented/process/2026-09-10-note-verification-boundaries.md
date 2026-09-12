# Agent Note: 架构 Note 的事实宿主与验证范围

Status: implemented

## Problem

仅靠 Markdown 中的路径和代码示例不能防止重构后的链接失效、类型漂移或提案被当成现行行为. 反向源码引用又可能因分散复制导致多个位置同时过期. 自动检查需要明确证明什么, 避免把格式通过误认为架构论证正确.

## Decision

[Note tree](../../README.md) 用 lifecycle/class 路径表达状态, 不建立集中 INDEX. implemented 维护当前决定, proposed 保存待审方案, rejected 保留否决理由. 历史提交是 Evidence, 不自动授权把旧实现恢复到主线. 同一决定的演进就地同步事实, 架构反转独立评审.

每篇运行时 Note 选择一个主要源码入口: 数据结构优先, 无独立结构则选顶层行为入口. 过程型 Note 可锚定脚本或 workflow. 其他模块由 Note 内链接连接, 不重复铺设同一 Note 的注释. 未实现提案只有文档链接, 不伪造运行时锚点.

[verify-notes workflow](../../../../.github/workflows/verify-notes.yml) 在 main/master 的 push/PR 用 Node 24 与 Bun lockfile 执行五个检查:

- tree 检查 active lifecycle/class/文件名和 Note 目录树内部相对链接目标存在, 保持对外部源码和测试路径的解耦.
- format 检查固定头部、必需章节和 implemented 的提案式标题.
- doc refs 检查扫描到的源码中 Note/docs 路径存在.
- doc typecheck 编译普通 ts/typescript code fences; ignore-check 明确排除草稿, type-equiv 交给专门检查.
- type-equiv 排除 Notes 的 archived 目录, 对照活跃记录显式声明的核心类型和真实源文件 AST, 不为了凑数量复制无意义类型或整段实现.

archive 命令移动 implemented 文档并写 SHA-256 manifest. 当前五项检查不读取该 manifest 校验归档内容, 也不验证标题锚点、Git 提交依据、Note 与源码的语义一致性或“一 Note 一锚点”唯一性. 上述要求仍需维护时核对, 不能宣称现有脚本已自动强制执行.

## Alternatives considered

- **扩大 tree 脚本强校验外部源码与测试路径.** 曾在 `c7d3c80` 尝试将树校验扩展到全仓, 最强论据是能静态捕获 Note 中引用的过时测试文件; 但该做法违背了单一职责原则, 造成文档门禁与日常测试重构的脆弱强耦合, 测试文件重构或改名即导致文档门禁意外失败. 现已全面收敛回归原版解耦模式, 仅校验 Note 树内部引用.
- **保持普通 ADR 和人工维护链接.** 工具成本最低, 但源码移动/类型改变后的死链更难及时暴露. 现有门禁提供可机械判断的底线.
- **每个提交都写 Note, 每个文件都加反向注释.** 看似覆盖充分, 但形成提交流水账和重复事实. 当前以非平凡决定为单位, 行为不变的 rename、依赖常规升级和纯文档编辑不另建决策.
- **只检查代码块的字符串或语法.** 快速, 但无法发现引用 API 的参数和类型已变化. 普通 code fences 用真实编译, 核心模型按需使用 AST 等价.
- **把所有质量规则自动化.** 可强制数量和标题, 却不能证明动机、最强备选论据或历史事实. 语义审查仍是必要人工判断, 不以机械指标代替.

## Consequences

门禁与 typed snippet 降低可自动检测的漂移风险, 每篇 Note 仍需指出行为边界、代价和可复核 Evidence. 当前 archive manifest 的自动验证缺口属于可独立改进的工具问题, 不阻塞已有 active Note 的事实落盘. [测试分层](../testing/2026-09-09-test-layers-and-scenario-harness.md) 负责验证资产布局, 这里仅定义文档脚本的实际证明范围.

## Evidence

`232e41f` 安装 Skill、模板、五项脚本与独立 CI workflow; `a169de6` 将 ADR 迁入 active Notes; `c7d3c80` 扩展 relative-link gate 对测试路径的校验并加入缺失目标场景. `4f7aab2` 将操作指南与常驻指令分开, 不构成运行时架构反转.

## Verification

`npm run verify-notes` 执行这些门禁. [note-links scenario](../../../../test/scenarios/notes/note-links.test.ts) 用临时仓库运行实际 tree 脚本, 验证 Note 内部死链拦截, 并确保对外部测试路径保持解耦放行. 同一场景运行 type-equiv, 验证归档中的已移除类型不参与当前接口校验, 同时活跃契约失配仍报错. 不宣称覆盖归档内容封印、语义审核或所有 Markdown 语法.
