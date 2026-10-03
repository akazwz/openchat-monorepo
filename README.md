# Heveta

[English](README.en.md)

Heveta 是一个通用 AI agent：可以只是聊天，也可以把一件事交给它完成。它会根据需要搜索和阅读网页、查找过去的对话、记住关于用户的长期信息，一次运行中可以连续调用工具，直到给出结果。运行在服务端完成，关掉浏览器也不会中断。

Heveta 的前身是 OpenChat，一个上一个时代的 AI 聊天机器人（React + Cloudflare Workers + Connect RPC，支持 Web、移动端和桌面端）。它已整体重写成现在的通用 agent，旧版代码保留在 [`openchat-final`](../../tree/openchat-final) 标签里。

## 现在能做什么

- **模型与思考**：模型清单由服务端配置（目前是 GPT-5.6 Luna、GPT-5.6 Terra、DeepSeek Flash）。每个模型有自己支持的思考强度，每条消息可以选；界面显示模型返回的思考摘要（DeepSeek 给的是思考原文）。
- **输入**：文字和任意类型的附件，一条消息最多 10 个、单个最大 100 MB。图片由模型直接读取，PDF 由能读 PDF 的模型直接读取（一条消息合计最多 20 MB）；其余文件，以及模型读不了的 PDF，按所选执行环境放进云电脑的 `/workspace/uploads` 或 Mac 工作区的 `uploads/`，agent 用电脑工具去读。
- **工具**：

  | 类别   | 工具                                                                       | 说明                                                                                                             |
  | ------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
  | 网页   | `web_search`、`web_fetch`                                                  | 搜索网页、把网页读成文本；TinyFish 为主，失败或超额时由 Jina 接手                                                |
  | 记忆   | `memory_search`、`memory_add`、`memory_update`、`memory_delete`            | 关于用户的长期信息，纯文本存于 PostgreSQL；最近的 100 条随每次请求提供，其余用搜索找回                           |
  | 对话   | `conversation_search`、`conversation_read`                                 | 检索和阅读过去的对话，包括当前对话中已滑出上下文的部分                                                           |
  | 电脑   | `shell`、`read_file`、`write_file`、`edit_file`、`send_file`、`view_image` | 在所选云电脑或原生 Mac 上执行命令、读写文件、发送和查看文件；云电脑预装 Python、Node.js、git，Mac 使用本机的软件 |
  | 浏览器 | `browser_navigate` 等 15 个                                                | 操作电脑屏幕上那个浏览器（Playwright MCP），用户能看到                                                           |
  | 邮件   | `email_list`、`email_read`、`email_save_attachments`、`email_send`         | agent 自己的邮箱：查看和阅读收到与发出的信、把附件放到电脑上、发信和回信（可附电脑上的文件）                     |

- **运行**：Agent 循环不设步数、token 或时长预算，模型不再调用工具时结束。上下文是滑动窗口：用到工作窗口的 80% 时清理旧的工具结果、从最早的内容整段滑出，降到 20%。可以随时停止，可以重新生成。
- **回复**：Markdown，公式用 KaTeX 排版。
- **一台电脑**：每个用户有自己的 Linux 电脑（“云端电脑”），同一用户的所有对话共用；侧边栏的“电脑”可以实时看到它的屏幕，也可以接管操作，agent 在上面用 Playwright 操作有界面的浏览器。`/workspace` 里的文件每次改动后都保存，电脑休眠或重启后原样恢复；`pip install --user`、`npm install -g` 装的软件也在其中。连续 30 天未使用电脑，电脑文件、安装的软件和浏览器数据会被清空；重要成果请下载或发送到对话里保存。对话、记忆和对话中的文件按各自规则保留。
- **本机 Mac**：原生客户端可绑定账号并开启接入，在对话中选择 Mac 执行命令和文件操作；agent 桌面操作按需截图，人工远控使用 WebRTC。Mac 文件与云电脑的 30 天过期规则独立。系统权限、真实验证与发布状态见 [macOS 接入](docs/macos.md)。
- **Electron 桌面客户端**：macOS 上承载完整的 Web 应用，窗口栏与界面同色；这台 Mac 可以作为账号下的设备交给 agent（命令、文件、截图、键鼠），也可以从别的设备查看和操作它的屏幕。见 [Electron 客户端](apps/electron/README.md)。
- **一个邮箱**：每个用户的 agent 有自己的邮箱地址（`agent.heveta.com` 子域，系统分配），任何人都能往里发信，来信存下但不触发运行，agent 在对话里用邮件工具去看；发信每 24 小时最多 5 位收件人。侧边栏的“邮箱”能看到收到和发出的每一封信。见[邮箱](docs/email.md)。
- **多端同步**：同一账号在几台设备或几个标签页上同时打开时，新消息、逐字输出、停止、改名、删除都会实时出现在每一台上；断线重连后自动补齐。
- **账号**：邮箱验证码登录，仅限受邀邮箱（`pnpm invite <邮箱>` 加入白名单，已有账号不受影响），首次登录即创建账号，不存储密码；可以设置头像，头像只有本人能看到。
- **语言**：界面默认英文，另有简体中文，跟随浏览器或在设置里选择；官网同样有英文和中文两版。

## 架构

```text
浏览器（React SPA）
  ├─ Connect RPC（heveta.v1，一问一答：读取与命令）──► Cloudflare Worker
  └─ WebSocket /events ◄── 所有变化（protobuf UserEvent）── UserHub

Cloudflare Worker
  ├─ PostgreSQL（Hyperdrive）：对话、运行、进度、Checkpoint、记忆
  ├─ R2：附件
  └─► RunActor（Durable Object，每个 Run 一个）
        ├─ agent loop ──► 模型：OpenAI SDK，经 AI binding 与 AI Gateway
        │            └──► 工具执行器（ToolExecutor）：Worker 本地；云电脑 Sandbox；原生 Mac（DeviceConnection WebSocket）
        └─ 每次提交后 ──► UserHub（Durable Object，每个用户一个）
```

- **领域层级**：`Thread → Turn → Run → Step`。一条用户输入是一个 Turn；一个 Turn 可以有多次 Run 尝试（重新生成）；每次模型调用和工具调用各是一个 Step。完整契约见[领域模型](docs/agent-model.md)。
- **同步**：RPC 只做一问一答（读取和命令）；所有变化提交后，由每个用户一个的 Durable Object（`UserHub`）通过 WebSocket 推给该用户的所有设备，帧是 protobuf 编码的 `UserEvent`。见[多端同步](docs/sync.md)。
- **执行**：Run 由 Durable Object 在后台驱动，每一步和 Checkpoint 都提交到 PostgreSQL。进程中断后按 Checkpoint 恢复，结果未知的模型请求不会自动重放。见[运行时说明](docs/agent-runtime.md)。
- **工具执行与 loop 分离**：loop 只认 `ToolExecutor` 接口，不知道工具在哪里、怎么执行。已有 Worker 本地执行器、云电脑沙箱执行器和原生 Mac 执行器，loop 不用改。见[工具执行](docs/tool-execution.md)。
- **设计取舍**（上下文、记忆、网页搜索）见 [Agent 设计](docs/agent-design.md)。

## 路线图

1. **多执行环境**：在同一个接口上接入更多执行位置，例如另一个 Durable Object、更多本机平台。同时补上执行很久的调用挂起与唤醒，以及有副作用操作的人工确认。
2. **其他**：编辑已发送的消息；记忆与对话的语义检索（embedding）；GitHub、Google 登录；画面里的操作权在用户与 agent 之间交接；后台进程与端口。

## 技术栈

| 范围       | 实现                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------- |
| 前端       | React、React Router、Astryx（官方 Neutral 主题）、Lucide、KaTeX                              |
| 前端状态   | TanStack Query、Zustand、React Hook Form、Zod                                                |
| API        | Connect RPC、Protocol Buffers（`heveta.v1`）                                                 |
| 后端       | Cloudflare Workers、Durable Objects（SQLite）                                                |
| 模型       | OpenAI SDK（Responses API）、Cloudflare AI binding 与 AI Gateway                             |
| 数据       | PostgreSQL、Drizzle ORM、Hyperdrive；附件存储于 R2；电脑使用原生快照，连续 30 天未使用后清空 |
| 电脑       | Cloudflare Sandbox SDK（Containers）                                                         |
| 登录与邮件 | 邀请制邮箱验证码、HttpOnly cookie 会话、Cloudflare Email Service（收发）                     |
| 工具链     | pnpm workspace、mise、Buf、Oxlint、Oxfmt、Vite、Wrangler                                     |

## 开发

`mise.toml` 固定 Node 26.9.0、pnpm 12.5.1 和 Buf 1.73.0，依赖版本以 `pnpm-lock.yaml` 为准。启动 Docker（本地数据库和电脑的容器都需要），在仓库根目录运行：

```sh
mise install
mise run install
mise run gen
mise run dev
```

`mise run dev` 与 `pnpm dev` 相同：先构建 Worker 的前端静态资源，启动本地 PostgreSQL 并应用迁移，再启动 Vite 和 Worker。浏览器地址是 `http://localhost:5173`，Worker 是 `http://localhost:8787`，PostgreSQL 是 `127.0.0.1:55437`，数据保存在 Docker volume 中。

前端不需要 `.env`。AI binding 使用远程资源；网页工具需要在 `apps/server/.env` 填入 `TINYFISH_API_KEY` 和 `JINA_API_KEY`。其余配置见 [Server 文档](apps/server/README.md)。

| 命令                        | 用途                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| `pnpm dev:web`              | 只启动 Vite                                                                                         |
| `mise run dev:electron`     | 启动 Electron macOS 桌面版，默认连接线上服务                                                        |
| `mise run install:electron` | 构建并安装 Electron 开发版到 `~/Applications`                                                       |
| `pnpm dev:server`           | 准备静态资源与数据库，再启动 Worker                                                                 |
| `pnpm db:setup`             | 启动本地数据库并应用迁移                                                                            |
| `pnpm db:down`              | 停止本地数据库，保留数据                                                                            |
| `pnpm gen`                  | 从协议生成前后端 TypeScript                                                                         |
| `mise run gen:env`          | 生成 Worker binding 类型                                                                            |
| `pnpm format`               | 用 Oxfmt 格式化代码、配置和文档（`pnpm check` 报告未格式化的文件时运行）                            |
| `mise run check`            | lint、协议检查、迁移检查（schema 改了但没生成迁移时失败）、类型检查、单元测试和 PostgreSQL 集成测试 |
| `mise run test:integration` | 单独跑集成测试：起一个一次性的 PostgreSQL 容器（需要 Docker）                                       |
| `pnpm build`                | 构建前端并生成 Worker dry-run 产物                                                                  |

## 部署

配置 `apps/server/cloudflare.config.ts` 中的 Hyperdrive、R2、Email Sending、限流、容器与 Durable Object binding，并为生产环境设置 `TINYFISH_API_KEY`、`JINA_API_KEY`；电脑使用原生文件系统快照恢复环境，电脑数据不再备份到 R2，连续 30 天未使用后清空；已有保存点上线前需按迁移说明处理（见 [Agent 沙箱](docs/sandbox.md)）。AI Gateway ID、模型清单和提示词在 `apps/server/src/config.ts`。Hyperdrive 必须关闭查询缓存（`wrangler hyperdrive update <id> --caching-disabled`），运行状态依赖读到最新数据。前端静态资源和 API 由同一个 Worker 提供。应用 Worker 的开发、预构建和部署使用 `cf`；`wrangler.config.ts` 仅配置构建器与类型生成。`pnpm build` 执行 dry-run，不发布。

为目标 PostgreSQL 设置 `DATABASE_URL`，先迁移，再发布：

```sh
mise run db:migrate
pnpm run deploy
```

官网单独部署：`pnpm deploy:site`（`apps/site/cloudflare.config.ts`，Worker `heveta-site`，静态文件，无需配置）。官网先用 React Router 生成静态页面，再由 Wrangler 构建器生成标准 Build Output，最后由 `cf deploy --prebuilt` 发布；开发与静态预渲染保持原来的命令。

部署命令不会自动迁移数据库。迁移位于 `apps/server/drizzle/migrations/`：一份基线迁移加 drizzle-kit 生成的增量迁移。基线里手工追加了三个 Drizzle 无法声明的可延迟循环外键，修改相关列时需要手工维护，详见 [Server 文档](apps/server/README.md)。

## 代码结构

```text
apps/web/          Web 应用，app.heveta.com（界面约定见 apps/web/AGENTS.md）
apps/macos/        原生 macOS 客户端：Swift、系统 WebView 与本机执行能力
apps/electron/     Electron macOS 桌面客户端：承载 Web 应用，并把这台 Mac 作为设备接入
apps/server/       Worker、Run 执行、工具与数据库
apps/site/         官网 heveta.com：构建时预渲染的静态页面，入口都跳到 App
packages/brand/    品牌名、标志和 Heveta 主题，App 与官网共用
proto/heveta/v1/   Auth、Model、Thread、Turn、Run、File、Memory、Computer、Mail、Device 十个服务
docs/              领域模型、运行时、Agent 设计、工具执行
scripts/           仓库任务入口
```

[前端文档](apps/web/README.md)说明组件与状态归属，[Server 文档](apps/server/README.md)说明模块、配置和 API。

macOS 客户端使用完整 Xcode 27 和 Swift 6.4，最低运行系统 macOS 14；从仓库根目录运行 `mise run dev:macos`、`mise run build:macos` 或 `mise run release:macos`。见[客户端文档](apps/macos/README.md)与[本机接入设计和实施状态](docs/macos.md)。
