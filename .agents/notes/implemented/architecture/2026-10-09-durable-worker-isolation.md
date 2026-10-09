# Agent Note: Durable 工作进程与进程树监管

Status: implemented

## Problem

进程内独立 Harness 隔离会话事实, 但子扩展的事件循环阻塞、Native Crash 和 V8 致命错误仍与父 Pi 共享故障域. 移动模型循环不足以隔离工具与扩展. Worker 的退出也不能证明其启动的 detached shell 或后代进程已经停止, 提前释放配额或文件锁会允许外部效果重叠.

## Decision

[WorkerExecutionDriver](../../../../src/drivers/worker-driver.ts) 实现现有 ExecutionDriver/TaskStore 契约. 父 Runtime 保留准入、控制权、导航与 [父日志回执](2026-09-11-native-execution-and-parent-delivery-adapters.md), 工作进程拥有 PiResources、模型、子扩展、工具和 DurableDriver. 独立 supervisor 管理存储所有权与进程树, 不运行模型或工具.

`experimental.executionBackend` 选择新任务的 `in-process` 或 `worker`, 默认 `in-process`. 接受后的后端、模型描述、实验能力、retry/compaction 设置进入 TaskBinding.execution. 恢复使用这些接受事实; 配置变更不切换已有任务的后端. Worker 初始化失败明确返回, 不重试另一后端. 当前 Worker 监管支持 Linux 与 Windows; 其他平台选择 Worker 时明确失败.

```ts type-equiv: WorkerBootstrap from src/worker/protocol.ts
export interface WorkerBootstrap {
  path: string;
  parentSessionId: string;
  agentDir: string;
  extensionEntryPath: string;
  create?: TaskBootstrap;
}
```

新任务通过 [openTask](../../../../src/drivers/task-bootstrap.ts) 在资源发现完成后保存 TaskBinding. ResourceBootstrap 是纯数据, ResourceHost 承载当前进程的执行、告警与文件锁能力. Worker 从 agentDir 配置文件与已授权扩展重新建立 ModelRuntime. 父进程动态注册的 provider 必须由子侧重新注册; 只有同名内建模型不满足这个条件. 函数闭包不进入启动数据, 环境变量通过进程继承而不进入 SQLite.

## RPC and durable identities

[协议](../../../../src/worker/protocol.ts) 校验双向请求、响应及事件, 请求 ID 关联并发调用. supervisor 给 Worker 消息加独立外层封装, 父端只把 supervisor 自己发出的生命周期消息作为清理确认, 子进程不能通过同名消息提前触发存储移交. 接受与排队具有调用前确定的稳定请求身份. NativeTaskStore 事务保存原输入和队列消费身份, 重试返回原身份, 相同 ID 的不同输入明确失败. 队列撤回后保留身份事实, 不因丢回复而重新排队.

状态事件只标记变更. Worker 合并尚未读取的通知, 父端合并并发 snapshot 读取; 完整 transcript 作为按需快照返回, 不随每个 token 广播. 普通请求异常返回错误; 全局未捕获异常输出诊断并退出. 父端独立观察监管进程的终止确认, 不依赖 Worker 成功发送最后一条消息.

文件锁由父 Runtime 的 FileLockManager 统一分配. 请求属于具体驱动, 释放必须匹配该驱动持有的租约身份. 等待可以取消, 旧释放不能解除新持有者的锁. 关闭或故障期间的租约保留到进程树清理完成, 然后由父端回收.

## Supervision and storage handoff

[supervisor](../../../../src/worker/supervisor.ts) 在启动资源前建立 [原生监管](../../../../src/worker/process-tree.ts). Koffi 只在监管进程加载, 父 Pi 不加载它的原生绑定.

- Linux 使用 `PR_SET_CHILD_SUBREAPER`. Worker 退出后, detached 后代也会成为 supervisor 的子进程. supervisor 对已收养的直接子进程发送 SIGKILL 并 waitpid 回收, 重复处理新收养的下一层, 直到没有后代. 回收先于下一次枚举, 避免用历史 PID 列表终止复用该 PID 的其他进程.
- Windows 在 INIT 前把 Worker 绑定到 Job Object. Job 不允许 breakaway, 设置 KILL_ON_JOB_CLOSE; 后代由内核归属. 关闭时终止 Job, 查询 ActiveProcesses 为零后才确认清理. 显式进程组、Windows Job 和 WMI/外部服务启动不是同一概念; 经外部服务代为启动的进程不属于此树级保证.

两侧均由 supervisor 持有 `<task-id>.worker.sqlite.lock` 的内核独占句柄, 从初始化一直保持到驱动关闭. Linux 使用 flock, Windows 使用无共享的文件句柄. 文件本身可以保留, 锁随句柄释放. Worker 存活时, 父端只经 RPC 访问存储. Worker 结束且后代回收后, 父端在同一 supervisor 租约内打开被动 Session, 不重新加载执行资源.

移交先读取原生结果. 已提交的完成结果保持 completed; 原生答案已提交但应用投影缺失时由 NativeTaskStore 重建. 真正未完成的 operation 保存 Worker 故障结果, 保留已记录的用户停止事实. TaskEngine 在 drive 返回后通过原有唯一所有者释放配额. 故障驱动拒绝新的执行输入, 文件重开后可重新附着.

正常关闭与父 IPC 断开先请求 Worker 关闭, 两秒宽限后终止 Worker, 再清理后代. 运行中的 drive 在清理完成前保持未结算. 宽限期不代表 WAL checkpoint 保证. supervisor 的清理错误不确认移交; supervisor 自身在活动任务期间异常消失同样不能证明后代已结束, 因而不释放执行占用. 这项故障隔离针对 Worker, 不覆盖 supervisor、操作系统或整机资源耗尽.

## Persistence and distribution

Worker 文件使用 `<task-id>.worker.sqlite`, Runtime 据此先取得监管所有权再读取 binding, 并核对 parent 与 backend. execution 缺失的 binding 表示进程内任务. TaskDocument 仍使用版本 1, 可选 execution 和输入身份表增加应用事实, 不改写原生 operation 或父 receipt 格式. 已有文件不因实验开关变化而迁移.

发布包包含 Bun 构建的 `dist/worker/main.mjs` 与 `supervisor.mjs`, 第三方依赖保持 external. Node fork 清空 execArgv 与 NODE_OPTIONS, 不继承父 Pi 的预加载器, 不依赖开发依赖 tsx. 其余环境变量照常继承. 开发命令与 CI 构建入口由 [development](../../../../docs/development.md) 持有.

## Alternatives considered

- **保持全部进程内执行.** 不需要额外进程、原生绑定或 RPC, 启动与内存成本最低. 但子任务的 Native Crash 和事件循环阻塞仍影响父 Pi, 不满足故障域隔离. 此后端仍是默认选项.
- **只移动 Harness, 在父进程执行工具与子扩展.** IPC 表面较小, provider 继承也更容易. 但高风险的插件代码仍在父进程, 隔离收益不足.
- **tmux 与原生 Pi CLI.** 可直接获得完整原生终端接管, 但需要另一套会话契约与终端生命周期. 本方案继续使用现有 SQLite、配额和父回执, 不承担原生 TUI 接管.
- **只终止 Worker 的进程组或退出后 taskkill.** 实现最短, 对同组后代有效. Pi shell 会创建独立进程组, 且 Worker 退出后进程树关系可能丢失; 该方法不能证明工具已经结束.
- **在父进程安装原生监管.** 少一个 supervisor, 但子树回收和 FFI 与父 Pi 共用故障域, 父进程退出后没有剩余所有者负责清理. 独立监管进程保留所有权直到确认结束.
- **IPC 断开立即标 aborted 并释放配额.** 界面响应快, 但 Worker 或工具可能仍在运行, 已落盘结果也可能被覆盖. 当前结算等待监管确认并首先核对持久事实.

## Consequences

父 UI 与其他任务能在 Worker 致命错误后继续工作, 保存结果与父 ACK 的职责保持独立. 每个活体 Worker 驱动增加一个执行进程和一个监管进程, 并依赖 Koffi 对当前平台的原生支持. 模型及子扩展各自加载, 内存成本高于进程内后端; 这里不提供 CPU、内存或网络沙箱.

## Verification

[Worker scenarios](../../../../test/scenarios/drivers/worker-driver.test.ts) 使用真实 Node fork、SQLite、离线 provider 和本机 HTTP 屏障, 覆盖请求丢回复后的身份保持、答案提交后丢通知、process.abort 与 detached 后代回收、伪造清理确认、清理之前的配额和文件锁占用、接管顺序以及真实父 Pi 回执后的 ACK 断连. 相同文件进入 Linux/Windows CI, 不依靠任意睡眠协调故障窗口. 本地 Linux 证据不代替 Windows CI 或物理终端实测.

监管语义依据 [Linux subreaper](https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html) 与 [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects); Koffi 调用形式依据其 [库加载与函数调用文档](https://koffi.dev/load).
