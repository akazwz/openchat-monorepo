# Agent 领域模型

状态（2026-09-29）：下面的领域关系描述当前实现；“定义核对与命名约定”记录本次概念检查。DO 增量存储与 Step 生命周期调整已实现并在本地验证，详见[存储契约](run-storage.md)。按绿地开发只保留新存储入口，已于 2026-09-30 完成生产数据库迁移和 Cloudflare 部署。

## 层级与唯一归属

```text
Thread
└── Turn（一次用户输入）
    ├── 用户 Message（turnId，role=user，无 runId）
    └── Run[]（该输入的执行尝试，attempt 从 1 起）
        ├── Step[]（有序、持久化的执行步骤，服务端私有）
        └── 助手 Message（其 runId 指向该 Run）
```

- Thread 是对话容器；同一 Thread 同时最多一个活动 Run。每个用户有一个主对话（`main`，应用的首页，见 agent-form.md）：第一次读时创建，没有标题，不能改名或删除，不在对话列表里；其余 Thread 是旁支对话。两者的 Turn、Run、Message 没有区别。
- Turn 固定一次用户输入。它只存身份（id、thread、user、创建时间）：它的输入是 turnId 为它、role 为 user 的那条消息，它的尝试是 turnId 为它的 Run，显示的是 attempt 最大的那次。这些关系都由子表指向父表的外键表达，不在父表上另存一份指针。
- 新输入创建 Turn 和第一个 Run。重新生成针对最新 Turn 的最新一次尝试，创建同一 Turn 下 attempt 加一的 Run，原 Run 和输出保留（不再显示）。
- Run 是一次执行尝试，拥有 turnId、attempt、模型、推理强度、执行状态、时间、取消意图和 revision；失败的原因只记在服务端日志用的 `error` 里，不对外。Run 没有步数、token 或时长预算，也不存统计数：用量记在 Step 上。
- 实例重启、投递重试和 checkpoint 恢复沿用 Run/Step 身份，不增加 attempt。
- Step 是 Run 内一次模型请求（MODEL）或工具调用（TOOL，带工具名）的操作记录。工具请求可以先登记、稍后执行；PENDING 表示已登记但未发出，RUNNING 表示调用意图已可靠提交、外部操作可能已开始。每个 Step 有稳定 ID、从 1 开始连续的 index、状态、模型响应 ID、已知用量及记录时间，未知用量保持 null。Step 是服务端的执行记录（恢复与用量），不出现在对外接口里。
- Message 是内容载体，不承担执行生命周期。用户 Message 属于 Turn，runId 为空；助手 Message 同时属于 Turn 和产生它的 Run，按 runId 找到（每个 Run 恰好一条）。
- Checkpoint 是私有恢复数据；Event/revision 是公开状态的同步机制；RunActor 是托管设施。它们不构成额外的产品层级。

## 命令和查询

- TurnService.StartTurn(threadId, requestId, input)：接受新输入，原子创建 Turn/用户消息/Run/助手消息，返回 RunSnapshot。threadId 为空时在同一事务中创建以输入命名的新 Thread，并在响应里一并返回它（重放同样返回）；没有单独的 CreateThread。
- TurnService.RetryTurn(turnId, previousRunId, requestId)：previousRunId 必须是该 Thread 最新 Turn 的最新尝试（在 Thread 行锁下检查，两个重试不能从同一次尝试分叉），原子创建下一次尝试，返回 RunSnapshot。
- RunService.AnswerToolCall(runId, toolCallId, approved)：答复一次等待用户同意的工具调用（approvals.md）。等待期间 Run 仍是 RUNNING，那次调用的 Step 是 PENDING。
- RunService.GetRun/CancelRun：查询、停止具体执行尝试；不将这些动作隐式指向另一个尝试。进度不靠 RPC 观察，而是由事件通道推送（见 sync.md）。
- RunSnapshot 包含 run、inputMessage、outputMessage 和 revision；RunChange 带自己的 revision、Run 和输出片段的变化。
- 同一 requestId 只接受同一命令，重复的请求返回原来的 Run；结果未知的提交用同一个 requestId 重发即可。
- ThreadService.GetMainThread：返回用户的主对话，没有则创建（部分唯一索引保证并发时只有一个）。ListThreads 只列旁支对话；UpdateThread、DeleteThread 对主对话返回 FailedPrecondition。
- 只提供界面用到的接口：Turn、Run 的历史和 Step 列表没有单独的查询 RPC，对话里显示的内容由 ThreadService.ListMessages 和 RunSnapshot 给出。

## 数据和一致性

Turn、Run、Step、Message 均有真实数据模型和关系约束。threadId/userId 若为索引和鉴权保留在子表，必须与父记录一致（组合外键）。一个 Turn 只有一条用户消息、每个 Run 只有一条助手消息，由唯一约束保证；对话显示每个 Turn 的输入和最新尝试的输出（`threads/shown.ts` 的 `shownMessage`）。

活动 Step、公开 Run、消息片段版本和私有 Checkpoint 游标在同一个 DO SQLite 事务内提交；正文先分块暂存并确认可靠保存。定稿分页导入 PostgreSQL 后，由最终事务发布终态。开始模型请求前先持久化 RUNNING Step 和 model checkpoint。收到模型结果后记录已知用量、响应 ID 和结果状态。进程中断不会凭空创建下一步，也不会重放结果未知的模型请求。

StepStatus：PENDING、RUNNING、COMPLETED、FAILED、CANCELLED、INTERRUPTED。Run：QUEUED、RUNNING、COMPLETED、FAILED、CANCELLED。

## 定义核对与命名约定

### 不同框架的同名概念

核对日期：2026-09-29。下表是各框架公开文档的定义；与本项目的对应关系属于设计判断，不能当作跨框架接口兼容规则。

| 框架与资料                                                                                                      | 官方定义的粒度                                                                        | 本项目的对应关系                                                                             |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [OpenAI Agents SDK：Running agents](https://developers.openai.com/api/docs/guides/agents/running-agents)        | 一次 SDK run 是应用层的一轮；内部可多次调用模型、执行工具，直到最终输出               | 接近一次 Run；本项目另用 Turn 将同一输入的多次回复尝试归组                                   |
| [OpenAI Agents API：Sessions and turns](https://developers.openai.com/api/docs/guides/agents-api/sessions)      | Session 持有长期对话和工作；Turn 是其中一轮工作；运行中的输入可引导当前 Turn          | Session 的容器职责接近 Thread；本项目当前不支持运行中插话，一次 Turn 固定一次用户输入        |
| [Claude Agent SDK：Turns and messages](https://code.claude.com/docs/en/agent-sdk/agent-loop#turns-and-messages) | turn 指模型与工具的一次循环往返；一次 query 可以包含多个 turn；最后交付 ResultMessage | 其循环 turn 接近本项目一次 MODEL Step 及它请求的 TOOL Steps；query 接近一次 Run              |
| [Claude Agent SDK：Sessions](https://code.claude.com/docs/en/agent-sdk/sessions)                                | Session 保存 prompt、工具调用、结果和模型回复，可继续或恢复                           | 保存对话的职责接近 Thread；恢复机制的职责还涉及本项目 Run 与 LoopCheckpoint                  |
| [LangGraph Agent Server：Runs](https://docs.langchain.com/langsmith/runs)                                       | Thread 保存会话状态；Run 是使用指定 assistant 配置的一次执行                          | 接近本项目 Thread 和 Run；本项目额外显式保留 Turn 和 attempt                                 |
| [LangGraph：Checkpointers](https://docs.langchain.com/oss/python/langgraph/checkpointers)                       | checkpoint 保存图状态；super-step 是一次可含多个并发节点的调度阶段                    | 接近本项目恢复边界；节点和 super-step 都不能与本项目的单个 Step 一一对应                     |
| [OpenAI Agents API：Tracing](https://developers.openai.com/api/docs/guides/agents-api/tracing)                  | model response、tool call 等活动分别记录为 span                                       | 操作粒度与 generation/tool span 接近；本项目 Step 参与恢复，框架 span 不替代本项目的操作身份 |

结论：这些名称没有统一到能直接互换的行业定义。本项目的 Thread、Turn、Run、Message 关系与当前产品行为一致，可以保留；需要将“用户交互轮次”“模型循环”“执行尝试”“提交批次”分别写明。

### 本项目的确定定义

| 名称                        | 规范定义                                                                        | 身份与边界                                             | 命名结论                                                                       |
| --------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Thread／对话                | 长期保存用户输入及其回复的容器                                                  | `threadId`；改名、删除、权限和窗口切点属于它           | 保留 Thread；用户界面与工具继续叫“对话”／conversation                          |
| Turn／用户轮次              | 一次已受理的用户输入，以及针对这份输入的回复尝试集合                            | `turnId`；恰好一条用户 Message；没有独立执行状态       | 保留 Turn；代码和文档不得用它表示一次模型调用                                  |
| Run／回复尝试               | 针对某个 Turn 的一次执行尝试                                                    | `runId`、`attempt`；从 QUEUED 到终态；一条助手 Message | 保留 Run；同一输入重新生成会创建新 Run                                         |
| Step／运行步骤              | Run 内一次模型请求或工具调用的操作记录                                          | `(runId, index)`；独立结果、用量与生命周期             | 文档统一称“运行步骤”；持久记录类型为 `StepRecord`，边界变化类型为 `StepUpdate` |
| Message／产品消息           | 对话界面展示和应用历史读取的内容载体                                            | `messageId`；用户消息属于 Turn，助手消息属于 Run       | 保留 Message；一条助手 Message 可以包含多个模型回复和工具结果                  |
| MessagePart／消息片段       | 一条产品消息内的一段文字、摘要、调用、结果或文件引用                            | `(messageId, partId)`；顺序由消息内位置决定            | 保留 MessagePart；它不承担执行状态或操作去重                                   |
| LoopCheckpoint／循环检查点  | 当前 Run 可以恢复到的私有执行位置                                               | 阶段、上下文位置、待答调用与步骤位置                   | 使用现有 `LoopCheckpoint` 全名；不得与公开 `RunSnapshot` 混称                  |
| 原生模型项／ModelInput item | 供应商协议中的 message、reasoning、function_call、function_call_output 等       | 协议原有 ID 与顺序；只供模型继续上下文                 | 与产品 MessagePart 分开；原生 reasoning 不进入公开消息                         |
| 上下文段／context segment   | 工作窗口可以一起移出的原生项集合；本 Run 内通常是一次模型回复及其调用的工具结果 | 私有窗口分组，没有业务 ID；调用与结果一起保留或移出    | 不称 Step；滑出计数使用 `omitted.contextSegments`，不能推导 RunStep 数量       |
| RunSnapshot／运行快照       | 某一已提交公开版本的 Run、输入消息及输出消息                                    | `runId + revision`                                     | 只描述可见状态；它不保证足以恢复执行                                           |
| 提交批次／batch             | 将本次增量和状态变更一起可靠提交的存储单元                                      | `batchId`；可重放、可去重                              | 仅属于存储机制；一次 Step 可以经过多个批次                                     |

外部 Agent 框架的 Session 常指会话容器；本项目已有登录 Session，文档统一称 Auth Session。保留 Thread 可以避免把登录授权与对话状态混为一谈。

Turn 固定单份输入是当前产品的明确约束。以后若支持运行中插话，需要重新设计输入归属和 Turn 的唯一用户消息约束；本次存储设计不增加这项功能。

MessagePart 与 RunStep 不是一对一：一个 MODEL Step 可以产生文字、推理摘要和多个调用，一次 TOOL Step 可以产生结果及文件片段。私有片段元数据已将文字／摘要归于 MODEL Step，调用／结果／结果文件归于对应 TOOL Step；这只是内容与操作的关联，片段的正文状态不替代 Step 的执行状态。

### “重试”与重新生成必须分开

| 动作                                                   | Turn    | Run／attempt               | Step                                              |
| ------------------------------------------------------ | ------- | -------------------------- | ------------------------------------------------- |
| 请求结果未知，客户端用同一 requestId 重发 Start／Retry | 沿用    | 返回原 Run，不增加 attempt | 不因 RPC 重发而新增                               |
| actor 重启或投递重试，从检查点恢复                     | 沿用    | 沿用                       | 恢复已经登记的操作；原 index 不变                 |
| 服务商明确拒绝，稍后重新发起一次模型请求               | 沿用    | 沿用                       | 原 MODEL Step 失败；新实际请求使用新的 Step index |
| 用户点击重新生成，包括失败后的重新生成                 | 沿用    | 新 Run，attempt 加一       | 从新 Run 的 index 1 开始                          |
| 用户发送新的输入                                       | 新 Turn | 新 Run，attempt 1          | 从 index 1 开始                                   |

`RetryTurn` 当前覆盖已完成、失败和已停止回复的重新生成，含义是“为同一输入建立新尝试”。保留现有 RPC 名称，文档和实现说明统一使用“重新生成／创建下一次尝试”；不得把它作为 actor 恢复或工具自动重放入口。运行期间的模型循环可以称“循环迭代”，不用 Turn 为它计数。

### 一个例子

用户说“查资料并整理结果”：

```text
Thread A
└── Turn T1：一份用户输入
    ├── 用户 Message U1
    ├── Run R1，attempt=1
    │   ├── Step 1 MODEL：提出两个查询
    │   ├── Step 2 TOOL：查询甲
    │   ├── Step 3 TOOL：查询乙
    │   ├── Step 4 MODEL：生成最终回复
    │   └── 助手 Message A1：文字、两组调用与结果、最终正文
    └── Run R2，attempt=2：用户对同一输入重新生成
        ├── 自己的 Step 1、2……
        └── 自己的助手 Message A2
```

Step 2 和 3 可以并发，index 表示登记顺序，不代表完成顺序。R1 重启恢复仍叫 R1。对话展示 U1 与最新尝试 A2；A1 留在存储里。一次模型调用返回多个供应商消息，也仍汇入该 Run 的同一条助手 Message。

### 改造前的定义偏差与修复记录

| 项目                                         | 改造前的触发与代码证据                                                                                                             | 实际含义／影响                                                                        | 处理状态                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 工具尚未执行就登记 RUNNING                   | `runtime/loop.ts` 在保存 `tools` 阶段时为全部待答调用创建 running 步骤，随后按顺序执行                                             | 原 RUNNING 表示“操作未收尾”；不能据此认定工具已经发出，或统计正在执行的工具数         | 已实现 PENDING 登记、调用前 RUNNING 与 startedAt 边界                  |
| `startedAt` 包含等待执行时间                 | `runs/commit.ts` 的 `writeSteps` 创建所有待答工具行时统一填写 `now`                                                                | 连续工具排队时，该时间是登记时间；`finishedAt-startedAt` 不能当作纯工具执行耗时       | 已区分 createdAt 登记时间和可空的 startedAt 调用意图时间               |
| 文档曾声称 Part 关联 Step ID                 | `threads/types.ts` 的 MessagePart 没有 Step ID；`runs/output.ts` 用供应商文本位置或 callId 建立片段，工具事件另有 stepIndex        | 原产品内容到操作记录没有通用的直接关联；不能按原文档假设 join 关系存在                | 已在活动与归档片段元数据保存 stepIndex；沿用现有公开协议               |
| `StepCheckpoint` 名称像完整快照              | `runtime/checkpoint.ts` 的该数组是本次边界变化；`commitRun` 写入 steps 后从私有检查点剥离                                          | 它是步骤变更集合，不能独立重建所有步骤                                                | 已统一为 `StepUpdate`，不把变更集合视为完整步骤快照                    |
| 窗口中的 `omitted.steps` 与 RunStep 粒度不同 | `runtime/window.ts` 的 `units` 按模型项及其工具结果分组，`slideWindow` 每移出一个本 Run 的分组只加一，`windowNotice` 却称其为 step | 一次模型调用加两个工具调用可只有一个滑出分组；该计数不能解释为执行步骤数或 Step index | 已改为 `omitted.contextSegments` 和 context segment 提示；无旧字段解码 |

以上是定义和记录语义问题。工具恢复现在结合 started 意图与执行器的 resume 策略；尚未发出的调用首次执行，有副作用且结果未知的调用不重发。

### 存储与领域层级

同一个 Run 从 DO 归档到 PostgreSQL，runId、messageId、partId、Step 身份均保持不变。归档不会创建新的 Turn、Run 或 Message。“正在运行”“可恢复”“已归档”描述生命周期与保存职责，不增加“中间消息”“历史消息”两套业务实体。

内存、DO SQLite、PostgreSQL 和 R2 的分工以及提交／读取／取消／删除契约见 [Run 增量存储设计](run-storage.md)。DO SQLite 是活动输出与恢复状态的权威来源；PostgreSQL 是受理、取消意图、文件引用与最终历史的权威来源。
