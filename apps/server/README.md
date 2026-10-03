# Heveta Server

Cloudflare Worker 托管 `heveta.v1` Connect API、前端静态资源与附件读取入口。项目自定义的 `RunActor` 直接继承原生 `DurableObject<Env>`，一个实例托管一个 Run；PostgreSQL 保存业务状态。所有 RPC 都是一问一答；变化提交后，由每个用户一个的 `UserHub`（Durable Object）通过 WebSocket 推给该用户的所有设备（[多端同步](../../docs/sync.md)）。

## 目录

| 路径                     | 职责                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/modules/auth/`      | 账号、验证码、Session（HttpOnly cookie，`session.ts`）和 Email Sending                                                                                                                                                                                                                                                                                                  |
| `src/modules/threads/`   | Thread CRUD、产品消息、消息存储、标题生成、对话检索工具及 RPC 转换                                                                                                                                                                                                                                                                                                      |
| `src/modules/turns/`     | StartTurn/RetryTurn 的受理（在提交前先让 RunActor 就位，再派发执行）                                                                                                                                                                                                                                                                                                    |
| `src/modules/runs/`      | Get/Cancel、尝试查询、执行调度（`driver.ts`）、工具组装、投递与原子提交                                                                                                                                                                                                                                                                                                 |
| `src/modules/memories/`  | 长期记忆的存储、记忆工具与设置页 RPC                                                                                                                                                                                                                                                                                                                                    |
| `src/modules/web/`       | 网页搜索与读取工具：TinyFish、Jina 及两者之间的切换、缓存                                                                                                                                                                                                                                                                                                               |
| `src/modules/models/`    | 模型清单 RPC 与思考强度的协议转换                                                                                                                                                                                                                                                                                                                                       |
| `src/modules/sandbox/`   | 用户的电脑：电脑的 Durable Object（`computer-object.ts`，继承原生 `DurableObject`，`native-machine.ts` 接原生容器 API 和 SDK 1.0 的文件工具）和它管理的工作区——恢复、保存、快照、租约（`workspace.ts`）、沙箱工具与执行器（`tools.ts`）、附件放进电脑（`uploads.ts`）、屏幕与终端连接（`connections.ts`）、设置页的电脑管理（`manage.ts`）；镜像与屏幕脚本在 `sandbox/` |
| `src/modules/events/`    | 事件通道：`UserHub`、`/events` 入口与发布（`publish.ts`）                                                                                                                                                                                                                                                                                                               |
| `src/modules/steps/`     | 持久执行步骤的领域类型                                                                                                                                                                                                                                                                                                                                                  |
| `src/modules/files/`     | 上传、附件引用、R2 读取、删除与清理                                                                                                                                                                                                                                                                                                                                     |
| `src/runtime/`           | 模型与工具的循环、滑动窗口、工具执行器接口、私有执行检查点和运行时输出事件                                                                                                                                                                                                                                                                                              |
| `src/runtime/responses/` | OpenAI SDK 的 Responses 流式请求、原生模型上下文                                                                                                                                                                                                                                                                                                                        |
| `src/runtime/adapters/`  | 产品消息到模型输入的转换                                                                                                                                                                                                                                                                                                                                                |
| `src/db/schema/`         | PostgreSQL 表及关系                                                                                                                                                                                                                                                                                                                                                     |
| `src/rpc/`               | Connect 路由、认证、错误映射和请求资源生命周期                                                                                                                                                                                                                                                                                                                          |

领域层级是 `Thread → Turn → Run → Step`。Turn 固定输入，显示的是它最新的一次尝试（attempt 最大的 Run）；执行状态只属于 Run。用户 Message 属于 Turn、无 runId；助手 Message 属于 Turn 和 Run，输出 Part 的 stepId 指向产生内容的步骤。Step 有两种：MODEL（一次模型调用）和 TOOL（一次工具调用）；未知 token 用量保持 null。

公开 `Run` 类型与数据库 `RunRecord` 分开。Checkpoint 位于独立的 `run_checkpoints` 表，不放入公开 Run、Message 或推送的事件。协议定义在根目录 `proto/heveta/v1/`。

## 本地启动

使用根目录 mise 固定的工具版本并启动 Docker：

```sh
mise run install
mise run gen
pnpm dev:server
```

该入口先准备 Worker 所需的静态资源和本地数据库，再启动 Wrangler。完整前后端开发用 `pnpm dev`。本地 PostgreSQL 地址是 `127.0.0.1:55437`，数据库名和用户名均为 `heveta`；连接设置位于 `drizzle.local.config.ts` 与 Wrangler 的 Hyperdrive `localConnectionString`。

`pnpm db:setup` 只迁移指定的本地库，忽略 `DATABASE_URL`。显式 `mise run db:migrate` 使用 `DATABASE_URL`，未设置时使用开发配置的本地地址。`pnpm db:down` 停止容器但保留 volume。

`TINYFISH_API_KEY`、`JINA_API_KEY` 需要手动填入 `.env`（`.dev.vars` 存在时用它），分别在 tinyfish.ai、jina.ai 获取。登录会话是数据库里的随机令牌，不需要签名密钥。

## 配置

| 配置                              | 用途                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TINYFISH_API_KEY`                | 必需 secret；网页搜索与读取的首选服务商（TinyFish，免费但按 key 限额），本地放在 `.env`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `JINA_API_KEY`                    | 必需 secret；TinyFish 失败或超额时接手（Jina，按 token 付费），本地放在 `.env`                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `HYPERDRIVE`                      | PostgreSQL 连接。Hyperdrive 配置要关闭查询缓存（`wrangler hyperdrive create … --caching-disabled`）：它默认把非事务查询缓存 60 秒，而这里每次读取都要看到已提交的最新状态（停止、终态、刚写的记忆）。数据库需 PostgreSQL 17 及以上（受理事务用 `transaction_timeout`）驱动是 node-postgres（`pg`，Hyperdrive 推荐的那个，`src/db/client.ts`）：一条带参数的查询一次往返；Postgres.js 对每条在当前连接上没见过的语句先问一次参数类型，而每个请求的连接都是新的，所以每条查询两次往返（本地加 10 ms 单程延迟实测：同样 9 条语句加建连 480 ms 对 316 ms）。 |
| `BUCKET`                          | 附件的 R2 存储桶（`heveta-files`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `AI`                              | Cloudflare AI binding，配置 `remote: true`；OpenAI SDK 经它发送模型请求                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `EMAIL`、`EMAIL_FROM`             | Email Sending binding 与已配置发件地址                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `AGENT_MAIL`、`AGENT_MAIL_DOMAIN` | agent 邮箱（[邮箱](../../docs/email.md)）：不限发件人的 Email Sending binding，发件地址是每个用户在 `AGENT_MAIL_DOMAIN` 下的地址；该子域要在 Email Sending 里开通，并作为子域加入 Email Routing。收信由 `triggers.email({ addresses: ["*@heveta.com"] })` 把主域 catch-all 交给本 Worker 的 `email()`，只收该子域的信                                                                                                                                                                                                                                    |
| `exports.RunActor`                | `RunActor` Durable Object namespace                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `exports.Computer`                | 用户电脑的 Durable Object namespace（`Computer`，继承原生 `DurableObject`），每个用户一台（`user-<userId>`），由 `containers` 配置的镜像运行；它管理工作区的快照，也转发屏幕和终端连接                                                                                                                                                                                                                                                                                                                                                                   |
| `exports.UserHub`                 | `UserHub` Durable Object namespace：每个用户一个，持有该用户所有设备的事件通道                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `AUTH_ADDRESS_LIMITER`            | 公开认证接口按客户端地址的每分钟限流                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ASSETS`                          | `apps/web/build/client` 静态资源                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

生产资源需在 Cloudflare 中配置，Wrangler 中的账号资源 ID、bucket 和发件地址应对应目标环境。AI Gateway ID、模型清单（`modelCatalog`）和提示词位于 `src/config.ts`。浏览器通过 `ModelService.ListModels` 读取清单，只能从中选择；更新清单只需发布后端。工具由 `src/modules/runs/tools.ts` 组装：网页搜索与读取、记忆、历史对话检索在 Worker 里执行；命令与文件工具在用户的电脑上执行（见 [Agent 沙箱](../../docs/sandbox.md)）。

清单中每个模型必须接受 Responses 请求格式：要么在 Cloudflare 模型目录里标注支持（GPT-5.6 Luna（默认）、GPT-5.6 Terra），要么服务商自己的 API 支持、经 AI Gateway 透传过去（DeepSeek Flash：模型目录里的 DeepSeek 只有 Chat Completions，DeepSeek 自己的 `/responses` 支持，配置里的 `gateway` 字段）。每个模型配置自己支持的推理强度数组（`reasoningEfforts`，经 AI Gateway 实测）和默认值，用户每条消息可选；界面显示模型返回的思考摘要，DeepSeek 不给摘要，显示的是思考原文。每个模型声明自己能读哪些类型的附件（`reads`，如 `["image", "pdf"]`；接口里是 `Model.reads`）：读不了 PDF 的模型（DeepSeek 的 API 不收文件，会不声不响地忽略），PDF 和其他文件一样放进电脑，由模型用电脑工具去读。两者都没有的模型（Gemini、Grok、Kimi 只有 Chat Completions，Claude 只有 Anthropic Messages）需要另写运行时适配。模型调用使用 OpenAI SDK（`src/lib/openai.ts`），SDK 的 `fetch` 换成 AI binding：Worker 内的 binding 已按账号认证，请求经 AI Gateway（名为 `heveta`）发出，目录里的模型费用从账号的 Unified Billing 额度扣除，不需要 API token；透传给 DeepSeek 的请求由网关带上它保存的 DeepSeek 密钥（BYOK），Worker 里同样不存密钥。SDK 负责请求参数、流式事件解析、结构化输出和错误类型。Agent 回复用 `responses.create({ stream: true })`；对话标题用 `responses.parse` 与 `zodTextFormat` 取得结构化输出。Run 没有步数、token 或时长预算，模型不再调用工具时结束。上下文用滑动窗口：每个模型有工作窗口（`contextWindow`，现为 27.2 万 token），用到 80% 时清掉最近 3 次以外的工具结果并从最早的内容整段滑出，降到 20%；切点记在 Thread 的 `context_window` 上，滑出的内容用 `conversation_search` 找回（设计见 `docs/agent-design.md` 第 3 节）。一条消息最多 10 个附件，单个最大 100 MB（`modules/files/types.ts` 的 `maxFileBytes`）；图片和 PDF 由模型直接读取，合计最多 20 MiB（`agentConfig.limits.modelFileBytes`），其余文件只放进电脑，模型用电脑工具去读。配置以 `src/config.ts` 为准。

## API 与运行

- `AuthService`：邮件验证码登录（设置会话 cookie）、查询当前账号、改名、设置或移除头像、退出登录。只有验证码登录，不存储密码；某个邮箱第一次登录成功时创建账号，用户名取邮箱 @ 前的部分，之后可改；用户名只用于显示，不要求唯一。对任何合法邮箱都发码、给出相同响应；验证码错 5 次作废。每个邮箱每天从同一来源地址最多收 10 个码（存地址的哈希，别处的请求用不掉本人的额度），所有来源合计最多 50 个；邮件发送失败的码直接删除，不占额度也不挡重发。以后的第三方登录（GitHub、Google）以按邮箱关联的身份表加入。拒绝时附带 `ErrorDetail.reason`（`proto/heveta/v1/error.proto`），客户端按原因而不是按消息文字判断。
- `ModelService`：`ListModels` 返回模型清单与默认模型。
- `ThreadService`：Thread 查询、分页、重命名、删除与消息列表。没有单独的创建接口。
- `TurnService`：`StartTurn(threadId, requestId, input)` 接受新输入；`threadId` 为空时在同一事务中创建新 Thread（标题取输入文字去除首尾空白后的前 40 个字符，无文字时为空，界面按用户的语言显示“未命名对话”或 “Untitled”），新 Thread 由响应的 `thread` 返回，相同 requestId 重放返回同一 Thread 与 Run；`RetryTurn(turnId, previousRunId, requestId)` 为同一 Turn 创建下一次尝试（`previousRunId` 必须是最新 Turn 的最新尝试），对话显示 attempt 最大的那次。首个 Turn 的第一次尝试一开始执行，就在后台用默认模型生成一个更贴切的标题，与回复并行、不等回复结束；生成好时若标题还是这个从输入截取的初始值（没有被改名），就替换它，并通过事件通道推送给用户的所有设备（`modules/threads/title.ts`，`runs/driver.ts` 的 `titleFirstTurn`）；纯附件、没有文字的输入没有可用于生成的文字，标题保持为空。
- `RunService`：`GetRun` 读取快照，`CancelRun` 保存取消意图。GetRun 按 `run_id` 读取；CancelRun 的 lookup 是 `run_id` 或 `request_id` 的 oneof（还不知道 Run 的发送按 requestId 停止）。服务端还没受理时按 requestId 停止，就是撤回这次发送：在同一把请求锁下记下撤回（`withdrawn_requests`，保留一天），答复 NOT_FOUND 加 `REQUEST_WITHDRAWN`，之后这个 requestId 的任何副本都被拒绝；已受理时则照常停止它的回复。所以结果未知的发送，停止后一定有确定的结局。
- 事件通道：浏览器用会话 cookie 连接 `/events?user=…` 的 WebSocket，Worker 确认是本站页面打开、Session 有效且属于该账号后，交给该用户的 `UserHub`（[多端同步](../../docs/sync.md)）。每个二进制帧是一条 `UserEvent`：Run 的快照或一次提交的变化、对话记录、对话的新活动（只含 ID 和时间，已有对话每一轮发布一次，列表按它排序）、被删除的对话 ID、记忆变化、用户资料、电脑的工作区变化（由电脑的 Durable Object 在存下或恢复快照后发出）。Session 结束（退出登录、过期）时关闭它的连接。
- `ComputerService`：都指用户自己的那台电脑。屏幕和终端是会话 cookie 下的 WebSocket（`/screen?user=…`、`/terminal?user=…`，准入同事件通道），Worker 把它们交给用户的电脑，由它唤醒自己并转发（`sandbox/connections.ts`）。`GET /computer-file?path=…` 下载工作区里的文件，由 Worker 直接流式返回；`POST /computer-file?path=…&name=…` 上传，同名文件自动编号，不覆盖。`ListComputerFiles` 列出工作区某一层目录。`GetWorkspaceUsage`、`RestartComputer`、`ListWorkspaceSnapshots`、`RestoreWorkspaceSnapshot`、`ClearWorkspace` 是设置页的电脑管理接口（快照保留 30 天，列表提供到期时间，过期不可恢复；电脑不再有 R2 长期备份，旧保存点按 [迁移步骤](../../docs/sandbox.md#从-r2-双层备份迁移) 处理）：有回复正在用这台电脑（持有它的租约）时，重启、恢复快照和清空都会被拒绝。
- `FileService`：删除文件；上传不经 RPC，走 `POST /upload`（RPC 只收发文字和 ID，文件太大）。任意类型都能存；声明为 PNG、JPEG、WebP、GIF 或 PDF 的文件要文件头相符，其余类型按声明的类型存。R2 key 为 `files/<uuid>`，文件名放在 `Content-Disposition`。删除对话时其附件重新进入过期清理。
- `MemoryService`：`ListMemories`、`DeleteMemory`、`DeleteAllMemories`。写入和修改只经模型的记忆工具（`memory_add`/`memory_update`），这里只能查看和删除。
- `MailService`：agent 邮箱的 `GetMailbox`（地址与过去 24 小时已发的收件人数）、`ListEmails`（收件箱或已发送，分页）、`GetEmail`、`DeleteEmail`（只能删收到的信）。收信走 Worker 的 `email()` 处理器，发信只经模型的 `email_send`；来信不触发运行。见[邮箱](../../docs/email.md)。

StartTurn/RetryTurn 返回 RunSnapshot（StartTurn 开始新对话时还返回那个 Thread）；Run Get/Cancel 返回 RunSnapshot。快照包含 Run、输入/输出 Message 和 Run revision；事件通道上的 Run 事件只有完整 `snapshot` 或一次提交的 `change`（带自己的 revision）。每次提交在事务成功后发布；`RunActor` 在 Run 结束后再发布一次终态快照，发布失败就保留闹钟重试，所以终态一定送达。状态和消息片段在同一个 revision 中提交；Step（含用量）是服务端私有记录，和私有 Checkpoint 一样不增加公开 revision。相同 requestId 只接受同一命令，重复的请求返回原来的 Run，所以结果未知的提交直接重发。

一个 Thread 同时最多一个 QUEUED/RUNNING Run。刷新、切页和退出登录只影响浏览器这一端，不取消已接受的运行。`CancelRun` 的确认表示取消意图已经落库；Run 到达终态后才算停止完成。重新生成保留同一 Turn 和用户输入，以 attempt 加一创建新的 Run 和输出消息，对话随之显示这次尝试。DO 重启和投递重试保持 Run/Step 身份。

受理前先让新 Run 的 actor 安排一个延后的 alarm，提交后再把它提前到现在，所以已提交的 Run 总有 actor 会执行，不需要扫描数据库的定时任务（见 [Agent 运行时](../../docs/agent-runtime.md)）；唯一的 cron 是每小时的清理（过期的临时上传、会话和验证码）。`ensure` 在事务中持久安排 alarm 后返回；已有执行时不另开 alarm。Run 在 DO 后台执行，alarm 在执行期间是每 30 秒一次的心跳（防止驱逐，实例重启后由它重新开始执行）；取消通知通过该执行的 AbortController 生效，实例空闲时可提前唤醒正在退避的任务。DO 只保存 runId、连续失败次数和原生 alarm；业务状态和 Checkpoint 始终从 PostgreSQL 读取。项目不依赖 Agents SDK。

模型请求发出前的数据库或 R2 异常（非 AppError）不结束 Run，由 actor 退避重试；连续失败达到上限（`maxConsecutiveFailures`，5 次）且没有新进展才由 actor 结束，每有一次进展就重新计数。一次执行没有时长上限，被实例重启打断的执行由下一次心跳续上；正在跑的 shell 命令继续跑，下一次执行去收它的结果，停止则直接杀掉。异常或进程中断后的恢复取决于 Checkpoint：`ready` 可继续，`model` 表示外部调用结果未知，保存失败和已有部分输出。持久 alarm 可重复触发，恢复入口不会据此重放未知结果的模型请求；也不承诺连接回中断的模型 token 流。完整契约见 [架构说明](../../docs/agent-runtime.md)。

## 本机设备

`DeviceService` 提供 `RegisterDevice`、`ListDevices`、`RevokeDevice`、`StartRemoteDesktop`。设备和 Web 登录会话分别认证；本机凭证的 SHA-256 存于 `devices`，原文只保存到原生 Keychain。`Run.device_id` 固定执行目标，重试继承原目标；本机离线不自动转用云电脑。`ComputerService` 的快照、清空和过期管理只针对云电脑。

原生 `/device/connect` WebSocket 使用设备 Bearer 凭证；浏览器 `/device/remote` 使用账号 Cookie 和短期远控会话；`/device/file` 继续检查所属设备、有效工具调用和附件所有权。`DeviceConnection` 持久化调用、取消意图与远控控制者，承担工具调度和 WebRTC 信令。

远控需要 `TURN_KEY_ID`、`TURN_API_TOKEN` secret，本地填写 `.env`；服务端向 Cloudflare TURN 申请短期 ICE 凭证，API 密钥不发送到客户端。上线前先应用 `20261001194705_native_devices` 迁移，再发布含 `DeviceConnection` 的 Worker 和 Web。协议、原生接入及验证限制见 [macOS 接入](../../docs/macos.md)。

## 登录与附件

邮箱输入先规范化再查询。邮件通过 `EMAIL.send` 发送登录验证码。

登录会话是一个 HttpOnly cookie（`__Host-heveta_session`，`Secure`、`SameSite=Strict`，`modules/auth/session.ts`），里面是随机令牌，数据库只存它的 SHA-256。页面脚本读不到它，注入的脚本也就偷不走；浏览器只在本站自己发起的请求上带它，别的网站发起的不带。会话 30 天有效，使用中每天续期一次（响应里带回新的 cookie），没有签名密钥，也没有刷新令牌。退出登录先写入会话的 `revoked_at`，使 cookie 立即失效，再关闭事件通道和电脑连接并清除 cookie。事件通道关闭成功才删除会话记录；关闭失败或 Worker 中断时保留已撤销记录，每小时清理时重试。Hub 接入时会在事件门内重新验证会话，避免准入与退出交错留下连接。

每个请求还要写明页面以哪个账号的身份操作（RPC 和上传下载用 `X-Heveta-User` 头，WebSocket 用 `?user=`），服务端发现会话属于别的账号就拒绝：cookie 被所有标签页共用，另一个标签页换了账号后，还显示着旧账号的页面不能不知不觉地替新账号操作。这个头别的网站也发不出来（需要预检，而本站不允许），再加上 Connect 要求的 `Connect-Protocol-Version` 头，请求都没法伪造。被拒绝时，页面问服务端现在登录的是谁（`GetCurrentUser`），据此回到登录页或换成那个账号。

`/files/<文件 ID>` 只给文件的主人看：图片由 `<img>` 直接加载，带不了自定义头，所以这里只看 cookie 的会话，再核对文件属于它、没有在删除中。

头像是私密的，和文件一样只给本人的会话：`/avatars/<用户 ID>/<版本>`，会话不属于这个用户就是 404（`modules/auth/avatar.ts`）。`SetAvatar` 收一张 JPEG、PNG 或 WebP（按文件头判断，最大 512 KB；客户端先裁成居中正方形、缩到 256 px），存成 R2 对象 `avatars/<用户 ID>/<版本>`，再在锁住用户行的事务里把 `users.avatar_version` 指向新版本，并递增 `users.revision`。被替换对象的清理记录在同一事务写入 `avatar_garbage`；提交后通知客户端并尝试清理，失败只记日志，不把成功的修改变成 RPC 错误，每小时定时任务重试。上传前先登记一天后清理，成功指向时在事务内移除新对象的清理记录，因此上传或指向中断也可被回收。每次换头像都是新对象、新地址，所以账号永远不会指向写了一半的对象，并发的两次更换也各自只删自己替换掉的那个。`User.avatar_url` 为空表示没有头像，界面显示用户名首字母。

文件的状态是明确的：`uploading`（对象在写入）、`stored`、`deleting`（谁也不能再用，清理删掉对象和记录）。哪些消息引用了哪些文件记在 `message_files` 里（附件、回复发出的文件、工具结果里的图），被引用的文件不能删除。发送消息和提交回复时，在同一事务里锁定这些文件并记下引用：只有已存好、并且已被引用或 24 小时内上传的文件可以被引用，更旧的无人引用的文件是垃圾，清理可能正在删它，所以发送和清理从不冲突。每小时第 17 分钟的清理删除标记为 `deleting` 的，以及上传满一天仍无人引用的文件。删除对话时，只被它引用的文件在同一事务里标记为 `deleting`：`/files/<uuid>` 直接从 R2 读取，不能等到一天之后。模型只通过所属用户的 fileId 和明确的 storageKey 读取 R2。历史与 Checkpoint 只保存图片和 PDF 的文件引用，发送模型请求前才读取为 data URL（图片放进 `image_url`，PDF 放进 `file_data`）。

`/files/*` 和 `/avatars/*` 只给本人的会话。常见栅格图片可内联，其余内容按下载提供，并设置 `no-store`（同一浏览器换了账号也不会从缓存里看到）、`nosniff` 与 sandbox。RPC 请求体读取上限为 1 MiB（`rpcConfig.readMaxBytes`，文件走 `POST /upload`，RPC 里最大的是 512 KB 的头像）；文件业务上限为 100 MB（`maxFileBytes`，Worker 请求体的上限）。

## 部署与生成

```sh
mise run gen
mise run gen:env
# 设置目标 DATABASE_URL 后执行：
mise run db:migrate
pnpm run deploy
```

迁移位于 `apps/server/drizzle/migrations/`，都由 drizzle-kit 根据 `src/db/schema/` 生成；所有关系都是子表指向父表的外键，没有循环引用，不需要手写 SQL。`threads.user_id` 与 `files.user_id` 均引用 `users`。具体结构见 [架构说明](../../docs/agent-runtime.md)。

写查询时的三个坑：

- 部分索引（如 `runs_active_thread_idx`，只含未结束的 Run）要让查询条件和索引条件字面一致，状态写进 SQL 而不是绑定参数（`unfinishedRun` in `src/db/schema/runs.ts`）。绑定参数时，缓存的预处理语句会用通用计划，而通用计划证明不了部分索引的条件，会扫整张表的索引。
- 单表查询里，Drizzle 渲染原始 `sql` 片段中的列不带表名。关联子查询写成 `sql` 片段时，`${runs.threadId} = ${threads.id}` 渲染成 `"thread_id" = "id"`，比较的是 runs 自己的两列，而且能通过类型检查。子查询用 `exists(new QueryBuilder().select(…).from(…).where(…))` 构建（`threadColumns` in `src/modules/threads/service.ts`），列会带上表名。
- 不要在 UPDATE 的 `RETURNING` 里读别的表来描述这一行。UPDATE 等到别的事务放开这一行的锁后，拿到的是这一行的新版本，但子查询仍然用语句开始时的快照：改名撞上一个 Run 的开始时，返回的记录有这个 Run 的活动时间，却看不到这个 Run，说"没在回复"。改完再用一条新语句读（`updateThread` 和生成标题都这样做）。

`pnpm run deploy` / `mise run deploy` 构建并发布 Worker，不代为迁移数据库。

`cloudflare.config.ts` 的 `worker.exports` 声明四个原生 DO 类：`RunActor`、`UserHub`、`Computer`、`DeviceConnection`，均使用 SQLite 存储，`Computer` 关联原生容器。调用通过 `cloudflare:workers` 的 `exports`／`ctx.exports` 获取本 Worker 的命名空间，沿用原有类名和实例 ID。`wrangler.config.ts` 配置静态资源构建与类型生成；环境类型由 `cf workers types` 写入 `.cloudflare/types/index.d.ts`。开发与部署使用 `cf dev`、`cf deploy`，项目不依赖 Agents SDK。

`mise run check`、`mise run test:integration`、`pnpm build` 是自行验证的入口。
