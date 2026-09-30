# Agent Note: 大工具结果观测打包与按页召回

Status: implemented

## Problem

超过数 KiB 的工具结果（文件读取、测试日志、命令输出）在此后每一次 Provider 请求中全量重发, 成本随历史长度线性增长. 直接改写已持久化的子会话历史则会破坏原生会话的 receipt 语义与 durable delivery 原文. 若引入占位符引用外部存档, 子代理还必须始终持有召回入口: 白名单策略（如 tools: [read]）不接受召回工具时, 占位符不可解引用, 模型反复尝试被门禁拒绝的工具形成死锁.

## Decision

[ObservationSink](../../../../src/drivers/observation-sink.ts) 拥有打包判定、内容寻址存档、请求级投影、按页召回与操作 ledger, 语义复刻自 SoL-Pi observation-pack（MIT, 保留 SPDX 头）, 仅裁掉其 TUI 上报. 该特性作为显式 opt-in 的实验性功能交付（experimental.observationPacking, 默认 false）, 并在 /agents 菜单新增独立的 Experimental features 菜单项供用户开启. [PiResources](../../../../src/drivers/pi-resources.ts) 仅在实验特性开启时注册 obs_recall 并在 attach 时从会话文件路径派生存档目录、在 transform_context 中接线投影; 恢复历史任务时, 若其会话文件旁存在 .observations 存档目录（打包期产物）则一并重启用, 保住既有占位符的召回能力. [PiToolHost](../../../../src/drivers/pi-tool-host.ts) 仅在工具已注册时将召回入口并入已接受策略与 active 集合; restoreActiveTools 对快照中残留的未注册 obs_recall 直接丢弃而非报错（存储历史恒为原文、投影为请求级, 无悬空引用）, 丢弃后的 active 集合随下次落盘自清洗. 默认未开启时, 保持 100% 原生纯净上下文与工具列表.

\`\`\`ts type-equiv: Observation from src/drivers/observation-sink.ts
export interface Observation {
  readonly id: string;
  readonly contentHash: string;
  readonly filePath: string;
  readonly toolName: string;
  readonly text: string;
  readonly bytes: number;
  readonly lines: number;
  readonly tokens: number;
}
\`\`\`

超过 10 KiB 的纯文本成功工具结果在前 2 次 Provider 请求中全量发送, 第 3 次起投影为稳定占位符: 头尾各约 512 B 的整行摘录、原始字节/行数与召回指令. 已发送次数以结果消息之后的 assistant 消息数为恢复时的下界, 内存计数只增不减. 存档以 obs_ 加 sha256 截断 id 内容寻址, 写入拒绝符号链接, 命中既有对象时逐字节校验后才复用. 含 evidence-reducer receipt 行（sol_pi_evidence_receipt_v1 精确整行匹配）的结果豁免: receipt 是已验证的归约证据, 每条 quote 可逐字节对账, 打包会以摘录替换在场可验证的证据.

归档目录是子会话 .jsonl 的同级 <stem>.observations/, 生命周期跟随会话文件而非任务 settle: durable delivery 与 settled 后的 continuation 可能在任务结束很久之后引用占位符. resume 复用同一目录; 会话文件删除前召回始终可用.

投影位于 transform_context 钩子中 runner.emitContext 之后, 是 request-local 的一次性刻意违背 append-only 上下文不变量: 同一消息在后续请求中被替换为更短占位符. 成立前提是占位符对同一观测稳定且每条观测只替换一次, 与 compaction 同属以刻意缓存失效换取上下文收缩; 持久历史保留原始字节, 因此召回在原生 compaction 与 resume 之后仍然成立. 打包对单条消息失败开放, 只记录 console.error 并保留原文, 绝不让代理失去观测.

obs_recall 是内建工具（safe=true, 来源 builtin:obs_recall）: 按 id 模式校验后按字节 offset 分页, 响应含 header 在内硬上限 16 KiB / 400 行（预留 512 B / 2 行 header）, 页边界按整行与 UTF-8 字符截断, 以 next_offset 续页. 未知 id、ENOENT 与越界 offset 明确报错. recall 输出与任何大结果同等参与打包（SoL-Pi 对齐）: 页超过阈值即归档为独立观测并于第 3 次发送起投影为占位符; 页大小有 16 KiB 硬界, 占位符头摘录必含原 header 的 id 与 next_offset, 单跳可解且递归自限, 不会死循环.

操作 ledger 复刻 SoL-Pi 语义: 存档目录内 append-only 的 ledger.jsonl, full 按对象的每次全量发送记一条, placeholder 按每次投影各记一条, recall 按页各记一条, 字段与上游一致. 与上游的唯一偏差是写入顺序, 且为刻意修正: 事件在投影决定之后写入, 失败仅 console.error —— 遥测绝不能反噬打包或丢失召回页; 上游把 placeholder 事件的 ledger 写在替换之前, ledger 失败会触发 fail-open 使消息保持全量.

门禁三点联动仅限内存副本: safeBuiltin 接受 builtin:obs_recall 来源, accept() 把它并入 policy.tools 内存副本, setActiveTools() 把它并入 active（restoreActiveTools 委托同一入口, 旧 binding 不含它的持久 active 集合在恢复时自然获得）. 持久化 binding 与 freezePolicy 不变, 新任务的持久 tools 经注册目录自然包含它. register() 守卫阻止扩展同名注册覆盖内建实现, 冲突按来源路径经 ExtensionRuntime 持有的 warnedConflicts 集合在每个父会话告警一次.

## Alternatives considered

- **默认全量开启, 无独立开关（已否决）.** 用户零心智成本且默认获得收益. 但 SoL-Pi 论文与实测表明占位符会带来翻页往返开销, 对需要全局密集细节比对的复杂工程任务可能影响上限; 且无差别开启会让每个子代理（即使 tools: [read]）强制多出一个 obs_recall 工具声明. 遵循 Explicit Opt-in 原则将其设为默认关闭的实验特性, 由用户按需在菜单中开启.
- **维持现状, 全量重发.** 无任何新机制与违背点, 且短会话看不出成本. 但长任务的工具日志会让每个请求重复支付相同 token, 子代理的隔离会话放大了这一成本; 投影以一次刻意缓存失效换取后续请求的确定性收缩.
- **持久改写会话历史为占位符.** 投影最简单, 无需请求级钩子. 但 receipt 与 durable delivery 的原文会被替换, ACK 校验与人工选择交付看到不再是产出原貌, 且 resume 时无法区分真实历史与打包历史; request-local 投影保持存储原字节.
- **裁掉操作 ledger（v1 立场, 已否决）.** 少一份随会话增长的持久文件, 投影路径零磁盘 I/O. 但 ledger 是还原打包行为的唯一黑匣子——对账时全靠它读出 SoL-Pi 的事件语义（placeholder 按投影记、full 按对象的两次发送记、recall 按页记）; 与存档同目录同生命周期, 成本仅为每请求数条小追加. 对齐后复刻, 仅刻意修正写入顺序使遥测失败不反噬打包.
- **obs_recall 输出豁免再打包（v1 自创偏差, 已否决）.** 避免分页结果递归入档与召回链, 刚召回的内容保证可见, 实现更简. 但长程分页基准实测（10 次平均）: 顺序翻页至 eof 后所有页永驻上下文, 稳态 13,730 tok/req ≈ 从不打包的 105%（比 none 更差）, SoL-Pi 统一重打包自愈到 2,760（nopage 基线 589 的 4.7 倍）, 长尾 8 请求多付 87,760 token（407%）; 豁免只在每 1-2 个请求就重读同一页的病态模式下占优.
- **存档目录随任务 settle 清理.** 目录更整齐, 删除时机明确. 但 settled continuation 与未确认的 durable delivery 仍引用占位符, 清理会使召回失效; 目录跟随会话文件生命周期, 与既有“会话拥有持久交付”的所有权一致.
- **obs_recall 作为普通扩展工具注册, 由策略名单选择.** 不需要门禁特判. 但白名单代理（tools: [read]）会失去召回入口, 占位符成为死引用; 内建加上三点内存并集保证任何已接受策略下占位符都可解引用.

## Consequences

默认状态下实验特性关闭, 子代理保持原生上下文全量传输与纯净工具声明. 仅在开启 experimental.observationPacking 时, 白名单与 exclude 策略不再能移除召回入口, 模型能看到额外的 obs_recall 只读工具声明. 打包失败开放意味着存储不可用时上下文退化为原状重发, 不阻断任务. 召回页与原始结果同等归档, 其 id 掺入 toolCallId, 同一页每次召回都会重复存储; 页在第 3 次发送后塌缩为占位符, 模型若仍需其细节须重召回（输出 token 与延迟成本, 离线审计不可测）. ledger 随会话增长（placeholder 事件按投影计）, 与存档同生命周期, 写入失败仅 console.error, 不影响打包与召回. 分页与阈值常量（10 KiB、2 次、16 KiB/400 行）固定于实现, 调整属于新决策. 存档目录随会话文件累积, 其清理由会话文件的所有者决定, 扩展不主动删除.

## Verification

[单元检查](../../../../test/unit/drivers/observation-sink.test.ts) 覆盖参与判定、receipt 豁免、内容寻址复用与篡改校验、字节/行/UTF-8 边界分页、两次全量后稳定占位、resume 计数下界与失败开放, 以及 ledger 事件序列（full/full/placeholder/recall）与遥测失败不反噬打包. [打包场景](../../../../test/scenarios/drivers/observation-pack.test.ts) 用离线模型驱动真实子会话: 两次请求全量、第三次投影占位、白名单只读代理声明并调用 obs_recall 分页续读、存档字节与观测一致、父交付文本无 obs_ 泄漏, 并经两次 settled continuation 验证召回页自身在第 3 次发送起投影为占位符、归档含 big 与页两个对象. 这些检查不覆盖真实 Provider 的 KV cache 行为与符号链接攻击面.
