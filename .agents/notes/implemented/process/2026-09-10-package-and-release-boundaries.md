# Agent Note: Pi 扩展包装、依赖边界与标签发布

Status: implemented

## Problem

Pi 扩展由宿主动态加载 TypeScript, 不适合另外打包一份宿主运行时. 私有 Pi/TUI 契约升级也可能改变工具注册、model limits 和容器布局. 从开发机直接发布则很难保证版本、测试和实际 npm 内容对应同一提交.

## Decision

[package.json](../../../../package.json) 通过 pi.extensions 指向 src/index.ts, npm 包白名单包含 src、README、LICENSE. Pi AI/coding-agent/TUI 与 TypeBox 是 peer dependencies, 同时为本仓库开发验证固定 Pi dev versions. Bun lockfile 固定依赖图, 本地不构建一个与宿主竞争的 Pi runtime 副本.

兼容范围由 package peer range 表达, 开发测试针对 lockfile 实际版本. 核心升级点使用原生 Pi scopedModels、model.maxTokens、document/dock 和 TypeBox API; 私有 retry classifier/layout 仍有专门契约测试. 通过当前版本检查不能推导整个 semver 范围都兼容.

[Publish workflow](../../../../.github/workflows/publish.yml) 只对 v* tag 运行, 校验 tag 与 package version 一致, 使用 frozen lockfile, 检查类型/全量测试/pack dry-run, 再通过 GitHub OIDC 和 npm Trusted Publishing 发布. Node 24 与固定 npm CLI 用于发布环境, 不依赖开发机长寿命 NPM_TOKEN. 标签不可变及发布前条件由 [release procedure](../../../../docs/releasing.md) 统一维护, 本文不复制操作步骤.

## Alternatives considered

- **保留开发机 npm publish.** 紧急操作方便, 但容易发布未检验工作树和暴露长期凭据, 版本与 CI 证据不自然绑定.
- **把 Pi runtime 打进 bundle.** 安装包自带依赖, 但宿主扩展 API/session 对象可能来自不同副本, 并增加升级同步成本. peer 与宿主共享 runtime 身份.
- **同时保留每代私有 Pi adapter.** 减少用户升级压力, 但每个 private hook/layout 都要维护多条路径. 当前在明确的 peer range 下验证实际依赖, 大版本/契约变更显式决定支持范围.

## Consequences

tag/version/lockfile/发布检查集中到 workflow, 但 npm publisher 设置和 GitHub 可用性仍是外部前提. TypeScript 源码和注释进入 npm 包, 仓库 Notes 不随包发布, 反向锚点服务仓库维护而非运行期加载. 仅整理 Notes 无需发布或创建 tag.

## Evidence

`b3bb3aa`, `6f6ac4b` 确立独立扩展 package/source 入口; `f729a4a`, `3bc415f` 记录 scoped 包准备; `388dd9f` 引入标签与 Trusted Publishing. `6a4bfb2`, `e68d5dc`, `62a6c96`, `65d1690` 记录 Pi API/导出/原生能力演进; `7cd9cd1` 移除不再使用的直接 pi-agent-core 依赖; `c7d3c80` 将测试类型和两层 suite 纳入发布验证.

## Verification

生产和测试 typecheck 检查当前依赖 API, [Pi retry compatibility](../../../../test/scenarios/runtime.test.ts)、[real Pi session scenarios](../../../../test/scenarios/runtime.test.ts) 与 [navigator lifecycle](../../../../test/unit/ui/navigator/agent-navigator.lifecycle.test.ts) 检查重要适配点. 实际 publish/pack 属于发布流程, 文档验证不假装完成 npm 外部发布验证.
