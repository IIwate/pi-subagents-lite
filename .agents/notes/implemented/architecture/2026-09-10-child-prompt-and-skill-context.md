# Agent Note: 子会话 Prompt 来源、共享前缀与 Skill 装配

Status: implemented

## Problem

独立子会话既要保留用户选定的系统指令来源, 又不能重复装入父会话的目录、日期、技能和项目上下文. 将 Agent 身份放在共享指令之前会提前分叉 prompt 前缀. 技能正文全部预加载则可能让一个小任务带入大量不相关文本, 自建技能扫描又容易偏离 Pi 的 ignore、symlink 和命名规则.

## Decision

[buildAgentPrompt](../../../../src/prompt/prompts.ts) 支持 replace、inherit、custom 三种来源. replace 使用通用子代理说明; inherit 在实际启动时向父 context 获取 system prompt; custom 读取扩展的 prompt 文件. Agent 自己的正文始终置于 agent_instructions. 配置快照固定模式和加载开关, 不固定父 prompt 或磁盘文件字节.

共享顺序为 header + 子工作目录环境 + project_context, 之后才放 active_agent、agent_instructions 和 skills. inherited/custom header 中 Pi 的 project_context、available_skills、Current date 和 Current working directory 段先剥离, 再由子环境重新组装. 该剥离依赖文本格式, 不是结构化 parser, 不保证识别未来 Pi 的所有 header 变化. 顺序有助于保持共享前缀, 不承诺任何 provider 的缓存命中率.

includeContextFiles 控制 Pi `loadProjectContextFiles` 的补充上下文. inherited prompt 读取失败、自定义文件缺失/空/不可读时回退通用 header 并缓冲 warning; context 文件读取失败为非致命. loader 关闭自身的 context、prompt template、theme 和 appendSystemPrompt, 避免重复装配. 这一回退是当前可用性选择, 不保证保持原 persona.

[skill-loader](../../../../src/prompt/skill-loader.ts) 复用 Pi `loadSkills`/`loadSkillsFromDir`, 按 cwd 到 Git root 的祖先 `.agents/skills`、用户 `.agents/skills`、Pi global/project defaults 顺序收集. 路径以 realpath 尝试去重, 失败时保留原路径; 名字首次出现获胜. `.agents/skills` 顶层散落 `.md` 被过滤, 因 Pi 的对应内部模式没有公开导出. 没有 Git root 时祖先遍历到文件系统根.

skills whitelist 加载名称、描述和路径供按需读取; preload 读取显式指定技能全文. 显式集合/预加载时关闭 loader 的自动 skills, 由本扩展装入一个 available_skills 块. 元数据格式交给 Pi 处理 XML escaping 和 disableModelInvocation; 显式预加载按用户配置保留全文, 不自动套用元数据隐藏规则. preload 名称限制阻止 path traversal, 不把任意名字拼接为文件路径. 缺失/不可读技能形成可见占位说明.

## Warning timing

setup 的互斥工具配置、缺失扩展和 prompt fallback warning 先进入数组, 在 child turn loop 和 outcome resolution 成功后才发给 UI/console. `9072477` 记录了 setup 即时通知插入 session tree、破坏 tool_use/tool_result 配对的故障依据. 当前测试证明通知延后, 不证明所有 Pi/provider 版本的父日志排序; setup 或 outcome 抛错时 warning 数组不会 flush. 不应把这一实现写成“任何失败都能显示 warning”.

## Alternatives considered

- **直接复用父完整 system prompt.** 保留用户 persona 最方便, 但会重复或错用父目录、技能和项目指令. 当前保留 header, 重建子环境; 父 conversation 本身不继承.
- **所有技能都塞入 prompt.** 无按需 I/O, 但扩大每次任务输入. whitelist 元数据与显式 preload 分开表达两种需要.
- **保留自建文件遍历和 YAML 解析.** 路径规则完全可控, 但需复制 Pi 的 ignore、symlink 和校验语义. 当前复用公开加载 API, 仅补其未公开的目录模式差异.
- **缺失 inherited prompt 直接失败.** 更严格地保留 persona 意图, 但会把 host 读取问题变成任务失败. 未合入分支 `165fbee` 一系选择此语义; 主线仍是 warning + replace, 不能在文档中无声切换该产品行为.

## Consequences

共享前缀与明确加载来源减少重复内容, 同时保留对 Pi 文本格式和扫描 API 的依赖. Prompt 内 XML-like 包装不是安全隔离格式; 当前自定义 escape 只处理尖括号, 不应宣称完整 XML 校验. 文件信任、路径一致性问题见 [资源发现](2026-09-10-agent-catalogue-and-project-trust.md). 父模型的动态 Agent guidance 另由 [before_agent_start](2026-09-09-dynamic-guidance-injection.md) 负责.

## Evidence

- `661c485`, `02331a5`, `93d2f30`, `0943e9e`, `feff084`: whitelist/preload 分离、Pi loader 复用及技能格式.
- `499897d`, `9969bd3`, `9a6ef06`, `8c0a1a2`, `a60b156`, `354cc8b`, `c8132df`, `9c0d79e`: prompt 来源、非法模式回退、去重与共享前缀顺序.
- `3054c4f`, `1ba6b71`, `9072477`, `f0a2039`: setup 分期、warning 缓冲及验证失败通知.

## Verification

[prompt tests](../../../../test/unit/prompt/prompts.test.ts)、[skill unit tests](../../../../test/unit/prompt/skill-loader.test.ts)、[filesystem skills](../../../../test/scenarios/prompt/skill-loader.test.ts) 和 [runner setup](../../../../test/unit/agents/runner/agent-runner.setup.test.ts) 覆盖正文顺序、技能去重、隐藏元数据、文件来源及 warning 时机.
