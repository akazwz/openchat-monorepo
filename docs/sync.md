# 多端同步：RPC 读全量，事件通道推变化

状态（2026-09-27）：已实现。

2026-09-29：活动 Run 的公开版本由 DO SQLite 提交，定稿归档后由 PostgreSQL 读取；客户端版本合并与补读规则保持一致。持久化边界和本地验证见 [Run 存储契约](run-storage.md)，已于 2026-09-30 完成生产数据库迁移和 Cloudflare 部署。

## 问题

同一个用户可能同时开着几台设备或几个标签页：在电脑上发出一个要跑几分钟的任务，在手机上看结果；在一台设备上改名、删除对话，另一台应该马上看到。

改造前做不到：

- 进度只有 `RunService.WatchRun`，一次看一个 Run。服务端每 250ms 查一次 PostgreSQL 的 `run_events`，每个观察者各查各的。
- 别的变化没有任何通知。另一台设备不知道这边新建了对话、开始了新的 Run、改了标题；只在切回窗口、且缓存超过 5 分钟时才重新拉取。

## 做法

数据分两条路：

1. **全量读取和所有命令走 Connect RPC**，和现在一样：`ListThreads`、`ListMessages`、`GetRun`，以及 `StartTurn`、`CancelRun`、`UpdateThread` 等命令。
2. **所有变化走一条按用户的事件通道**，服务端推给这个用户所有在线的设备。逐字输出也走这条通道，替代 `WatchRun`。

客户端先用 RPC 拿到快照，之后靠事件保持同步；断线后重连，用 RPC 补读一次，再接着收事件。

原则：**服务端往客户端推送的一律走这条 WebSocket 通道；RPC 只做一问一答，项目里不再有流式 RPC，也不用 SSE。** 一问一答的 RPC 是短请求，不会让任何 Durable Object 长时间醒着；需要持续推送的地方都集中到按用户的 hub 上，由它休眠来控制成本。

### 事件

事件在 proto 里定义，和 RPC 的消息同属 `heveta.v1`：

```proto
// 服务端推给一个用户的所有设备。
message UserEvent {
  oneof event {
    RunEvent run = 1;          // 现有类型：快照或一次提交的变化，带 Run revision
    Thread thread = 2;         // 对话新建或改变后的完整记录
    string thread_deleted = 3; // 被删除对话的 ID
    MemoryChanged memory = 4;  // 记忆有增删改
    User user = 5;             // 当前用户资料变化
    ComputerChanged computer = 6; // 电脑的工作区或快照变了（存下或恢复了快照）
    ThreadActivity thread_activity = 7; // 对话有了新的运行
    MailChanged mail = 8;      // 邮件到达、发出或被删除（docs/email.md）
  }
}
```

- **Run 的变化**落在对话的消息列表上，列表是对话显示的唯一来源（正在生成的回复也从列表显示）。助手消息带着产生它的 Run 在这份拷贝时的状态、第几次尝试、是否已请求停止和 revision（`Message.run_*`，`ListMessages` 和快照都这样给）。快照放进列表（`showRun`）：输入消息缺了就补上，回复替换同一轮较早的尝试和它自己较旧的拷贝，已有的更晚尝试或更新拷贝保留，事件和响应乱序也不会倒退。变化应用到列表里的回复上，只接受 `revision = 上一个 + 1`；列表里没有这条回复或出现断档时，用 `GetRun` 取快照补上。没加载的对话不处理，打开时读取就是最新的。新 Run 开始时，第一条就是它的快照，另一台设备据此把它显示出来。
- **其他事件是完整记录或 ID**，客户端直接写进 TanStack Query 缓存，或让对应的查询重新拉取。不同 Worker 的提交顺序和通知抵达 hub 的顺序可能不同。`User.revision` 随用户名和头像的修改在数据库内递增；`Thread.revision` 随人工改名和自动标题的修改递增，与活动时间独立。RPC 响应和事件携带相同版本，客户端保留较新的资料/标题，再单独合并活动状态。删除是终态：对话 ID 不复用，客户端将已删除 ID 保留到账号缓存清空，迟到的记录、活动和读取结果不能将它重新列出。查询正在读取时到达的事件，会在响应回来后按上述规则再合并一遍（响应可能比事件旧），无需假定抵达顺序。丢失的通知仍由下次补读纠正。
- **发送的确认**：新 Run 的快照带着发起它的 `requestId`。客户端收到它（事件通道通常比 `StartTurn` 的响应先到），就确认了那次发送：乐观显示的消息在同一次渲染里让位给服务端的那条，响应丢失、结果未确认的发送也由它确认。
- 已有对话的每一轮只发布它的新活动时间（`ThreadActivity`：对话 ID 和时间），不发布整条对话记录：事务里读到的旧标题可能晚于一次等锁的改名到达，把改名盖回去。设备据此把对话移到它按活动时间该在的位置；列表里没有它时，读一次这条对话再放进去。只有新建的对话随第一轮发布完整记录。对话列表按最近活动排序（`threads.updated_at`，改名和生成标题不算活动；分页游标是“活动时间 + ID”，时间存到毫秒，和游标里的 JavaScript Date 一致）；客户端合并记录时保留较晚的活动时间，晚到的旧记录仅在标题版本更新时修改标题，不会把对话挪回去。
- **侧栏里“正在回复”的标记**（`Thread.running`）：对话最新的 Run 还没结束。每个 Run 开始时（新一轮或重新生成）都把对话的活动时间设成这个 Run 的创建时间，所以这个状态以活动时间为版本：对话记录（`ListThreads`、`GetThread`、改名和生成标题的返回、`thread` 事件）在读它的同一条语句里算出它（有没有未结束的 Run，走 `runs_active_thread_idx`）；`ThreadActivity` 表示一个 Run 开始了；每条 `RunEvent` 都带着它的 Run（创建时间和状态），包括没加载的对话的。客户端按时间合并（`latestActivity`）：时间晚的是更新的状态；时间相同说的是同一个 Run，而 Run 只会结束一次，所以看到它结束的一方为准。读取、记录和事件以任何顺序到达，结果都一样，不需要新的事件类型。Run 的事件随每次提交到达，合并后没有变化的不写缓存，侧栏不会跟着逐字重绘。
- **客户端不通过通道发命令**。通道只负责服务端往下推；发消息、停止、改名仍然是 RPC，类型检查和现在一样。

### 扇出：每个用户一个 Durable Object

新增 `UserHub`，按用户 ID 寻址（`idFromName(userId)`），持有这个用户所有设备的连接。

- **谁发布**：写操作在数据库提交之后通知 hub。
  - `RunActor` 每提交一个 revision，就发布这次的 `RunEvent`。
  - 对话的新建、改名、删除由对应 RPC 在提交后发布。
  - 记忆工具和记忆 RPC 在提交后发布。
- **发布失败不影响数据**：活动 Run 以 DO SQLite 为准，定稿与其他业务记录以 PostgreSQL 为准；事件只是通知。Run 的中间变化丢了，下一条会暴露断档，客户端据此重取快照。唯一不能丢的是 Run 的最后一条（终态），否则别的设备会一直显示“运行中”；`RunActor` 对终态的发布失败时重试，沿用它现有的 alarm 退避机制。
- **hub 不存事件**：它不做重放，只转发。补读由 RPC 负责。

### 传输：WebSocket，消息用 protobuf 编码

浏览器和 `UserHub` 之间用 WebSocket，hub 用 Durable Object 的 WebSocket Hibernation API 接收连接（`acceptWebSocket`）。

**为什么不用 Connect 的服务端流**（原来的 `WatchRun` 就是）：Cloudflare 按 Durable Object 在内存中的时长计费。一个开着的 HTTP 流（包括 Connect 服务端流和 SSE）会让 DO 一直在内存里、一直计费，而这条通道只要页面开着就一直连着。只有 DO 作为 WebSocket 服务端、用 `acceptWebSocket` 接收时才能休眠：空闲时不计时长，客户端的连接保持不断，有事件时再唤醒。（[Cloudflare 文档](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)）

**类型安全**：每个 WebSocket 帧是一条 `UserEvent` 的 protobuf 二进制编码。服务端用 protobuf-es 的 `toBinary(UserEventSchema, …)` 编码，客户端用同一份生成代码的 `fromBinary` 解码，两边拿到的都是生成的 TypeScript 类型。WebSocket 只搬运字节，和 Connect 在 HTTP 上搬运字节一样。

**连接与鉴权**：登录会话是 HttpOnly cookie，浏览器打开 WebSocket 时自己带上，不需要另发票据。

1. 客户端连接 `wss://…/events?user=<它显示的账号>`。Worker 先确认这是本站自己的页面打开的（`Origin` 和 `Host` 一致：浏览器允许任何网站向任何地址开 WebSocket，相关的子域名还会带上我们的 cookie），再按 cookie 找到活的 Session，并核对它属于 `user` 这个账号（另一个标签页可能已换了账号），然后把升级请求转给该用户的 `UserHub`（`modules/auth/session.ts` 的 `admitWebSocket`）。
2. hub 用 Durable Object 的 tag 机制记住每个连接属于哪个 Session（`acceptWebSocket(socket, [sessionId])`，休眠后仍在，`getWebSockets(sessionId)` 按标签取回）。Session 被撤销（退出登录）或过期被定时任务清理时，先写 `sessions.revoked_at`，立刻拒绝后续鉴权，再关闭这个 Session 标签下的所有连接（关闭码 4401）。关闭成功后才删除 session 行；失败或 Worker 中断时保留已撤销记录，由每小时清理任务重试。Hub 接入时，在 `blockConcurrencyWhile` 内重新查询 session 并注册连接；关闭调用不能穿过这段准入过程，避免“Worker 已验证、退出已完成、升级请求才到 Hub”的遗漏。数据库不可用时拒绝新连接，不重置其他连接。
3. 连接没能打开（页面分不清是被拒还是断网）或以 4401 关闭时，客户端问服务端现在登录的是哪个账号（`GetCurrentUser`），据此回到登录页或换成那个账号。

**心跳**：用 hub 的 `setWebSocketAutoResponse` 自动回应 ping，回应心跳时 DO 不会被唤醒。

**电脑的屏幕和终端不经过 hub**：看屏幕（`/screen?user=…`）、用终端（`/terminal?user=…`）也是 WebSocket，准入方式和事件通道一样，但由用户的电脑（`Computer` Durable Object）接收和转发：SDK 本来就在那里代理容器的 WebSocket，经 hub 再转一次既多绕一段，又让 hub 在连接期间不能休眠。Worker 交出的请求只带握手头和它自己设的头（连接类型、Session），设备伪造不了。Session 结束时，事件通道和电脑连接一起关闭（`auth/service.ts` 的 `endSession`）。详见 [Agent 沙箱](sandbox.md)。

**重连与补读**：断线后客户端按退避重连。顺序是先连上，再补读，避免中间漏掉：

1. 重新连接事件通道；
2. 让当前页面用到的查询重新拉取（对话列表、当前对话的消息，回复和它的 Run 状态都在消息里）。已经在读取的查询先取消再重读：TanStack 对还没有数据的查询不会重发，而是沿用那次读取，它可能早于断线期间的变化；
3. 结果未知的发送立刻用同一个 `requestId` 重发：服务端同一个请求只受理一次，重复的请求拿到的是原来那个 Run，没受理过的这次受理。重复请求与 `GetRun` 在 PG 鉴权后读取 DO 固定 commitSeq 的版本头与正文，随后复查删除或归档状态；不持 PG 行锁等待 DO。平时结果未知的发送也按 1、2、4…30 秒退避自动重发，服务端拒绝才放回输入框；
4. 之后按 revision 应用新事件。

手机切到后台时浏览器通常会断开连接，回到前台时重连并补读，处理方式相同；连接还开着的，回到前台时立刻发一次心跳，死掉的连接不必等到下一次心跳才发现。第一次连接失败后（而不是只在连上又断开之后），界面就显示“连接中断，正在重新连接…”：连不上时活动 Run 的进度到不了。

## 去掉的东西

- `RunService.WatchRun` 和服务端每 250ms 查一次 `run_events` 的轮询：进度由 `RunActor` 直接推给 hub。`WatchRun` 是项目里唯一的流式 RPC，去掉后所有 RPC 都是一问一答。
- `run_events` 表：补读一律取快照，不按 revision 重放，所以这张表已删除。

## 放弃的方案

- **Connect 服务端流（按用户一条）**：接口最简单，类型直接由 Connect 生成；但 DO 不能休眠，每台在线设备都让一个 DO 一直计费。
- **SSE**：同样是开着的 HTTP 流，同样不能休眠。
- **定时轮询**：延迟高，请求量随在线设备数增长。
- **按对话一条通道**：设备要为侧栏和当前对话各开连接，切换对话就要换连接；按用户一条更简单。

## 待定

- 同一浏览器的多个标签页各开一条连接，还是用 `BroadcastChannel` 共享一条。先各开一条，简单；有需要再合并。
- 事件的粒度：目前一次 Run 提交对应一条事件，逐字输出的频率等于提交频率。实现时量一下提交频率，看是否需要合并。

## 相关实现与验证

Hub 准入使用 Cloudflare 的 [blockConcurrencyWhile](https://developers.cloudflare.com/durable-objects/api/state/#blockconcurrencywhile) 将外部数据库检查与连接注册放在同一个事件门内。回归测试覆盖延迟升级、鉴权读取失败、撤销通知失败后的清理重试、PostgreSQL 中重放快照与 Run 写入的锁交错，以及资料/对话乱序和删除后迟到的读取。真实 Cloudflare 多实例行为仍需部署环境验证。

## 客户端操作与缓存边界

- 异步操作使用发起时的 `SessionOwner`（账号 + 登录实例）。头像在选择文件时绑定归属，在预处理后、发 RPC 前核对；会话确认按登录实例合并，迟到响应和旧会话的鉴权失败不改变新会话；退出响应也只完成原实例的退出。
- 资源记录继续按服务端 revision 合并。尚未完成的改名只是显示层：先选择同一资源最新一次意图，再判断它是否 pending。新的改名已完成时，较早 pending 操作不能重新覆盖显示。
- 记忆和电脑的变更事件、删除命令完成和重连补读统一经过 `refreshQueries`：取消旧读取，再标记失效并读取活跃查询。未挂载的查询留为 stale。删除命令的空响应不代表当前列表为空，不直接写空缓存。读取会唤醒用户电脑的查询（文件、占用，`meta.wakesComputer`）在页面不在屏幕上时只标记失效，页面回到屏幕上再读（它们的 `refetchOnWindowFocus` 只对失效的查询生效），否则一个后台标签页就能让电脑无法休眠。
- 分页失败与首次/后台读取失败分别恢复：失败的下一页由 `fetchNextPage` 重试，已有页由 `refetch` 重试。失败期间关闭顶部自动触发，保留历史内容，等待用户重试。
