# Agent Note: Worktree 参数语义与跨平台仓库校验

Status: implemented

## Problem

通用 cwd 容易让调用方传入任意目录, 而当前能力只允许父仓库的 checkout/worktree. Git 的 common-dir 输出可能是相对路径, Windows 还有盘符大小写和斜杠差异. 直接比较字符串会拒绝合法工作树或误认另一仓库.

## Decision

Agent schema 使用 worktree_path 并给出同仓库说明, 不承诺仅靠名字就能避免模型错误. [validateWorktreePath](../../../../src/spawn/worktree-validator.ts) 把省略/空白视为父 cwd, 相对路径按父 cwd 解析, 检查存在和目录类型, 用 realpath 跟随目标 symlink, 然后比较父/目标 `git rev-parse --git-common-dir` 的规范化结果.

normalizeGitPath 根据 Git 输出或 cwd 的盘符/UNC 形态选择 path.win32 或本机 path, 解析相对输出、规范分隔符, Windows 风格比较转小写. 返回实际目录使用正斜杠, 不把大小写折叠后的比较 key 当执行路径. POSIX 路径保持大小写. 该步骤不是 WSL/Windows 路径互转器.

每个 Git 命令使用 5 秒 timeout. 缺目录、非目录、父/目标不在 Git、不同 common-dir、Git 缺失或超时有不同错误, 其他异常保留具体原因并可发 warning. Agent 工具在解析 Agent 类型之前校验 worktree, 以便后续从该目录发现定义. 验证失败时不启动 session.

## Alternatives considered

- **保留 cwd 或仅检查目录存在.** API 通用且实现短, 但无法表达当前同仓库约束. 如需要任意工作目录, 应独立决定新能力和授权边界.
- **直接比较原始 Git 输出, 或总用本机 path.resolve.** 不需要额外归一化, 但 Windows Git 相对路径、大小写和混合斜杠会形成假阴性.
- **只比较 git worktree list 的显示路径.** 便于列出候选, 但列表可能包含 detached/缺失工作树, 还需处理主 checkout 和别名. common-dir 表达实际仓库共享关系.
- **把 realpath 当完整 sandbox.** 物理路径解析有助于别名处理, 但不阻止校验后的文件变化, 也不限制 shell 访问其他位置. 不赋予它不存在的隔离保证.

## Consequences

同 common-dir 的仓库子目录也可通过, 不要求目标恰好是 worktree root. Git 两次调用有 I/O 成本, 但没有可引用的固定毫秒性能保证. 网络文件系统、symlink 变化和 Windows 大小写敏感目录仍受宿主行为影响. Git 校验不等同 [project trust](2026-09-10-agent-catalogue-and-project-trust.md), 不负责创建、删除或迁移 worktree.

## Evidence

`58cd1a7`, `71a0a41`, `12912db` 确立 worktree 参数、错误边界与 plumbing; `8888ff7` 记录 worktree-local Agent 发现; `44a54e6` 记录旧 worktree picker 的 detached HEAD 格式教训. `c01ed11` 明确 Windows Git 路径归一化, `f0a2039` 保留验证失败的 warning.

## Verification

[worktree validator scenarios](../../../../test/scenarios/spawn/worktree-validator.test.ts) 覆盖目录、symlink、Git 错误和 Windows 路径格式. [Agent tool tests](../../../../test/unit/agents/tool-execution.test.ts) 验证失败不派发. Mock Windows 路径检查与 Linux 文件系统场景不能代替原生 Windows 文件系统保证; CI 的 Windows matrix 是对应平台入口.
