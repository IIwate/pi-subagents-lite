# Agent Note: 任务工作目录与执行环境归属

Status: implemented

## Problem

后台任务可能操作独立仓库、测试沙盒或普通目录. 工作目录决定相对工具路径和项目上下文, Git 仓库关系不能表达这些任务的执行位置. 多任务共享进程时修改进程 cwd 会使其他任务的路径解释发生变化.

## Decision

Agent 工具使用可选 cwd 参数. [resolveWorkingDirectory](../../../../src/spawn/working-directory.ts) 在资源准备之前解析路径: 省略时选择父会话目录, 相对路径以父 cwd 为基准, realpath 解析物理路径, stat 验证目录类型. 显式空白或非字符串、缺失路径、非目录和文件系统错误直接拒绝本次调用, 错误包含目标与原因. 执行路径采用宿主原生格式, 不折叠大小写或做 WSL/Windows 路径互转.

本决策取代 [同仓 worktree 参数契约](../../archived/architecture/2026-09-09-worktree-path-parameter-naming.md). v3 的公开参数为 cwd, 原生持久策略仍使用既有 TaskPolicy.cwd 字段. 目录有效性与 Git 无关, worktree 作为已有目录使用. full-access 工具能够访问其他位置; cwd 与 realpath 均不构成文件系统 sandbox 或目录权限边界.

## Execution and recovery

[Runtime](../../../../src/runtime.ts) 将确定的 cwd 传给 PiResources、原生 Session 和 TaskPolicy. [HarnessDriver](../../../../src/drivers/harness-driver.ts) 的 NodeExecutionEnv、Pi 内建工具、扩展 ctx.cwd 与默认 pi.exec 使用各自任务的目录. 路径解析和资源装配位于执行侧, Domain 只保存已经解析的值, UI 消费状态和派发动作. 进程 cwd 不随子任务切换.

queued、reload 和后续 operation 使用接受时保存的 cwd 与 prompt. 恢复验证已保存目录仍可使用, 不重新解释原始相对路径或符号链接入口. 目录不可用时报告恢复失败, 原生数据保留, AgentStatus 仍可读取保存结果. realpath 不保证目录 inode 在校验后保持不变.

父会话身份与接受时的因果锚点决定任务归属和交付. 工作目录不参与父会话发现、来源判断或 receipt 身份计算. 执行资源、取消、配额和关闭遵守 [既有 Adapter 所有权](2026-09-11-native-execution-and-parent-delivery-adapters.md).

## Project resources

相同物理 cwd 使用父 ExtensionContext 的最终项目信任结果. 其他目录消费 Pi 公开 ProjectTrustStore 的最近路径决定; 无保存决定且 Pi hasTrustRequiringProjectResources 判断没有待授权资源时直接使用目录上下文, 否则使用全局 defaultProjectTrust. always 允许项目资源, never 和没有交互决策的 ask 使用未可信加载. 该路径不额外发起交互询问、写入授权或重演宿主 project_trust hooks, 不将父目录的临时信任扩散到其他目录.

同一个资源决定用于目标目录的 Agent 发现、SettingsManager、DefaultResourceLoader、扩展 context、补充项目指令与显式 skills/preload. 用户全局资源保持各自来源. TaskBinding.resources 保存该决定与选定扩展路径, 恢复使用接受值. 项目资源未加载不阻止基础工具访问目标文件.

[Catalogue](2026-09-10-agent-catalogue-and-project-trust.md) 保持会话级缺名补充规则, 目标目录不覆盖已注册同名定义. cwd 选择执行位置, 不创建另一套名称或授权目录. [Prompt](2026-09-10-child-prompt-and-skill-context.md) 使用目标目录环境和按配置加载的上下文, 不承诺擦除用户指令或显式继承文本中提及的其他路径.

Git 检测只补充环境信息, 每条命令保留原有超时. 已确认非仓库时说明该事实; Git 缺失或检测失败时省略未知信息, 不阻断有效目录中的任务. 资源准备期间的取消继续传播.

## Alternatives considered

- **保持同仓 worktree 校验.** 能明确表达仓库内并行开发的预期, 避免把任意目录误当作 linked worktree. 但独立目录任务也需要正确的工具锚点, 且同仓关系不提供 full-access 下的访问隔离.
- **同时提供 cwd 和 worktree_path.** 可保留显式同仓断言和已有调用方式, 但两个目录参数需要定义冲突与优先级. 一个 cwd 足以表达当前执行能力, 参数切换属于 v3 的公开变更.
- **目录白名单或敏感路径黑名单.** 可以限制可选的启动位置, 但 bash 和绝对路径仍能访问其他目录, 无法形成真正的访问隔离. 路径权限体系不属于工作目录选择的职责.
- **切换进程 cwd.** 依赖 process.cwd 的代码能自然看到目标位置, 但并行任务与父会话会共享同一个可变目录. 官方工具和扩展 API 已支持任务级 cwd.
- **重新建立每目录 Catalogue 或完整信任服务.** 可以提供新的名称作用域与授权交互, 但会扩大任务目录选择的产品范围. 现有 Catalogue 契约和 Pi 的公开持久规则足以承担本次接入.

## Consequences

执行目录可以独立于 Git 和父任务的因果归属, 已接受策略与 Driver 边界保持一致. 依赖 process.cwd 或自行固定目录的第三方扩展仍受其自身实现影响, 官方 ctx.cwd 与 pi.exec 提供任务目录入口.

Pi 的完整交互式信任解析还包含会话 override 与 project_trust hooks. 这些结果在父目录通过父 context 复用; 跨目录使用公开保存规则与全局默认, 不声称复制完整交互式宿主决策流程. 未来宿主提供目标目录最终决定时, 该接入属于执行侧资源 Adapter.

## Verification

[目录场景](../../../../test/scenarios/spawn/working-directory.test.ts) 覆盖省略、绝对与相对路径、目录别名及无效输入. [Runtime 场景](../../../../test/scenarios/runtime.test.ts) 使用官方资源工厂、真实文件和离线模型, 验证不同仓库及普通目录的并发相对读写、shell/扩展 cwd、技能和项目指令、Pi 保存信任与默认值、排队与原生文件重开、别名改指向、Git 缺失及目标目录失效后的持久结果读取. Windows junction 与工具分支由 Windows CI 执行.
