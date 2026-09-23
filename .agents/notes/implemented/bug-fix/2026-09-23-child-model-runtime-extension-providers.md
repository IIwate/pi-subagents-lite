# Agent Note: 子会话模型运行时与扩展 Provider 复制

Status: implemented

## Problem

Pi 的 createAgentSession 在未传入 modelRuntime 时, 会从 auth.json 和 models.json 新建 ModelRuntime. 这个运行时只包含内置 Provider 和文件配置. cliproxyapi 等扩展 Provider 只在扩展加载时通过 pi.registerProvider 注册进父会话运行时. 子代理在 extensions: false 时不加载扩展, 路由校验通过父注册表接受模型, 首次请求却以 "No API key found for cliproxyapi" 失败. 扩展 allowlist 不含该 Provider 的扩展时也会同样失败.

## Decision

[runner](../../../../src/agents/agent-runner.ts) 为每个子会话创建私有 ModelRuntime, 其鉴权和模型文件路径与 Pi 默认一致. 创建后按父注册表的公开 API 复制每个扩展 Provider: getRegisteredProviderConfig 返回的配置用 registerProvider 注册, getRegisteredNativeProvider 返回的原生 Provider 用 registerNativeProvider 注册. 该运行时显式传给 createAgentSession.

复制在子会话创建时发生一次. 子会话加载的扩展会在自己的运行时中执行 unregisterProvider 和 registerProvider, 覆盖复制来的同名注册, 不影响父会话. 扩展是否加载只决定工具和钩子, 不再决定子代理能否使用已被路由接受的扩展 Provider.

## Alternatives considered

- **共享父运行时 ((ctx.modelRegistry as any).runtime).** 改动一行, 父会话后续刷新的模型列表和凭据状态会即时可见. 否决原因: runtime 是 ModelRegistry 的私有字段; ModelRuntime.unregisterProvider 不校验注册者. cliproxyapi 注册时会先 unregister 再 register, 子会话一旦加载该扩展, 就会用绑定子扩展 pi 的 OAuth 和 stream 闭包替换父会话的注册. 子会话 dispose 后这些 pi 在 assertActive 处抛错, 父会话随之失效.
- **仅在 extensions: false 时共享父运行时.** 避开了子扩展覆盖父注册的问题. 否决原因: 仍依赖私有字段; 扩展 allowlist 不含 Provider 扩展时仍会失败.
- **维持现状, 要求用户开启扩展加载.** 不改代码. 否决原因: 工具隔离与模型访问被耦合, 路由接受的模型在运行时不可用, 违反模型路由授予访问权的约束.

## Consequences

- **收益**: 父会话已注册的扩展 Provider 对所有子代理可用, 与扩展加载策略无关; 父运行时不被子会话修改; 只使用公开 API.
- **代价与已知上限**: 复制是创建时快照, 子会话运行期间父会话对 Provider 的重新注册或模型刷新不会同步. 复制来的配置闭包仍属于父扩展实例; 若父会话在子会话运行期间 reload, 这些闭包可能因父 pi 失效而抛错. 如果 Pi 提供按注册者隔离的运行时共享机制, 需重新评估本决定.

## Verification

[runner setup](../../../../test/unit/agents/runner/agent-runner.setup.test.ts) 用真实父 ModelRuntime 和 ModelRegistry 注册一个配置式 Provider 和一个原生 Provider, 断言子会话收到的运行时不是父实例, 且包含两者的模型和配置式 Provider 的鉴权状态.
