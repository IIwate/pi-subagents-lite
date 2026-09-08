# Agent Note: 以参数命名编码约束契约的 worktree_path 与跨平台自愈校验设计

Status: implemented

## Problem

在 Agent 工具的极简隐形 Schema 设计中（见 [2026-09-09-stealth-tool-registration.md](2026-09-09-stealth-tool-registration.md)），为了最大化保护推理端 KV-cache 并节省每轮对话的上下文 Token，工具定义移除了冗长的 `description` 与 `promptGuidelines`。在此背景下，**参数本身的命名与校验器的错误回显，成为了大语言模型（LLM）在调用时刻感知边界并完成自愈的唯二通道**：

1. **命名泛化导致概念错配**：若采用常规的 `cwd` 作为参数名，LLM 仅凭字面含义会误以为可以传入任意系统工作目录。校验器在拦截时若只报笼统错误，将导致模型陷入“试错发现（discovery-by-error）”的昂贵死循环；
2. **Windows 平台 Git 路径歧义（Path Disparities）**：在真实 Windows 与 WSL 环境下，Git 原生 CLI（`git rev-parse --git-common-dir`）输出的路径格式与 Node.js 路径 API 经常产生冲突：
   - 正反斜杠混用（`\` 与 `/`）；
   - 盘符大小写不一致（`C:\repo` 与 `c:/repo`）；
   - 简单字符串相等性比对会导致同属一个仓库的合法 worktree 被误判为 `DIFFERENT_REPO`；
3. **软链接逃逸与悬空风险**：若模型传入包含 symlink 的路径，未经物理路径解析（`realpath`）的比对容易被伪造或因悬空软链导致运行时崩溃。

## Decision

系统在 `src/registration.ts` 与 `src/spawn/worktree-validator.ts` 中确立了参数命名契约、跨平台归一化与专供 LLM 自愈的校验体系：

1. **参数名即约束契约**：
   通过 `worktree_path` 的专有命名，直接向 LLM 传达“该参数专用于 Git 工作树（Worktree）”的强约束，从源头上消除了模型随意传入系统外部目录的倾向。

2. **跨平台 Git 路径规范化（Cross-platform Git Normalization）**：
   在 `src/spawn/worktree-validator.ts` 中实现专用的 `normalizeGitPath`：
   - 通过正则表达式 `/^[A-Za-z]:[\\/]/` 与 `/^\\\\/` 严格检测 Windows 风格盘符与 UNC 共享路径；
   - 命中 Windows 格式时强制切换为 `path.win32` API 进行绝对路径解析；
   - 将所有反斜杠统一替换为 POSIX 正斜杠 `/`；
   - 针对 Windows 文件系统的大小写不敏感特性，强制转换为小写（`toLowerCase()`）后再比对父会话与目标路径的 `git-common-dir`，彻底解决跨平台比对误判。

3. **符号链接物理穿透解析**：
   校验流程按严格顺序执行：空值兼容 -> 相对路径解析 -> 存在性校验 -> `statSync` 目录判定 -> **`realpathSync` 物理真实路径穿透** -> 提取并比对 `git-common-dir`。

4. **面向大模型的自愈性错误枚举体系（Self-correcting Error Classification）**：
   定义清晰语义化的 `WORKTREE_VALIDATION_ERRORS`，杜绝模糊异常：
   - `PATH_DOES_NOT_EXIST`：路径不存在；
   - `NOT_A_DIRECTORY`：目标不是目录；
   - `PARENT_NOT_IN_GIT_REPO`：父会话未处于 Git 仓库中；
   - `NOT_IN_GIT_REPO`：目标不是 Git 仓库；
   - `DIFFERENT_REPO`：目标不是当前父仓库派生出的 worktree；
   - `GIT_NOT_FOUND` / `GIT_TIMEOUT`：环境 Git 工具缺失或执行超时。
   错误信息直接作为 Tool Error 返回给模型，大模型读到明确分类后可在下一个 Token 迅速调整路径参数自我纠错，避免盲目重试。

```ts ignore-check
// Agent 工具参数定义中的单意图命名
parameters: Type.Object({
  prompt: Type.String(),
  // ...
  worktree_path: Type.Optional(Type.String({
    description: "Path to the parent repository's main checkout or a linked worktree; not an arbitrary cwd or another repository.",
  })),
}, { additionalProperties: false })
```

## Alternatives considered

- **采用通用参数名 `cwd`** — 遵循常规 CLI 习惯，但彻底破坏了 Stealth Tool“以命名作为唯一文档”的极简原则，每一次模型试错都会引发一次昂贵的失败轮次（a discovery turn per mistake）。
- **简单依赖 `path.resolve` 与原生字符串比对** — 表面代码最简洁。但在真实的 Windows 宿主与跨平台 CI 中，Git 输出路径与 Node 路径必定存在正反斜杠及大小写不一致，导致合法的同仓库 worktree 被频繁误杀。
- **返回通用的 "Invalid path" 统一错误** — 无法给予大模型任何自愈线索，模型无法分辨是路径输错、目录不存在还是未共享 git-common-dir，失去自修正能力。
- **`path_to_worktree` / `worktree_cwd`** — 前者词缀冗长浪费 Token，后者属于文件系统物理路径与进程运行时概念的名词混淆。

## Consequences

- **收益**：模型凭借参数命名即可精准理解工作树调用约束；通过归一化消除 Windows 平台的跨平台路径比对假阴性；自愈错误枚举让模型拥有单轮自纠错能力；物理符号链接解析保证了隔离边界。
- **代价与已知上限**：该参数具有单一意图性（Single-purpose）；校验过程依赖调用底层 `git rev-parse` 子进程（开销通常在 5~20ms，受 `GIT_EXEC_TIMEOUT_MS` 超时保护）。

## Verification

- 跨平台路径归一化与目录校验由单元测试全面保证：`src/spawn/worktree-validator.ts`。
- Windows 平台特定路径与正反斜杠比对经跨平台 CI 矩阵校验（Linux / Windows-latest）。
