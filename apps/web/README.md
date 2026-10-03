# Heveta Web

React Router、React 和 Astryx 构建的浏览器界面。对话页面使用 `/threads/:threadId`，首页发送第一条消息时由 StartTurn 同时创建对话。模型列表和每个模型的思考强度由服务端 ModelService 提供，二者在输入框旁的同一个选择器里选，本机记住上次的模型和每个模型的强度；界面提供文字和任意文件的发送、停止和重新生成，显示工具调用和折叠的思考摘要，回复中的公式用 KaTeX 排版。侧边栏分别提供“电脑”（`/computer`）、“终端”（`/computer/terminal`）、“文件”（`/computer/files`），共用同一台电脑，和对话、邮箱一样占据完整主区域；切换页面保留对话草稿、后台 Run、电脑目录和上传，离开屏幕或终端则断开查看连接。

## 状态与目录

| 路径                     | 职责                                                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/features/auth/`     | 验证码登录页、登录实例、会话确认、认证拦截和账号菜单                                                                                            |
| `app/features/threads/`  | Thread 页面、导航、查询、草稿、提交和消息组件                                                                                                   |
| `app/features/runs/`     | Run 命令 API、快照/变化投影、按 Run 应用事件、共享缓存                                                                                          |
| `app/features/events/`   | 事件通道：连接、心跳、断线重连                                                                                                                  |
| `app/features/turns/`    | StartTurn/RetryTurn 调用与确认校验                                                                                                              |
| `app/features/models/`   | 模型列表查询与本机的模型、思考强度偏好                                                                                                          |
| `app/features/files/`    | 附件：上传（`POST /upload`，XMLHttpRequest 显示进度）、种类判断、文件卡片                                                                       |
| `app/features/computer/` | 三个独立页面：电脑桌面（noVNC）、终端（xterm.js）、文件浏览，以及登录会话内的目录和上传状态                                                     |
| `app/features/settings/` | 设置：独立布局，替换整个应用（`/settings/:section`：通用、电脑、记忆、账号；账号里的头像在浏览器里裁成 256 px 正方形再上传，`avatar-image.ts`） |
| `app/lib/`               | RPC 客户端、共享 QueryClient 与应用 Provider                                                                                                    |
| `app/components/`        | 公共表单、外观、品牌与错误反馈                                                                                                                  |
| `app/routes/`            | 页面及 loader 的薄入口                                                                                                                          |
| `app/gen/heveta/v1/`     | 生成的协议类型                                                                                                                                  |

`ThreadDrafts` 持有按用户、登录实例版本和 Thread 归属的草稿；`ThreadSubmissions` 单独管理启动、取消、requestId 恢复和提交确认；`useRunObserver` 跟踪每个对话最新的 Run。`ThreadController` 组合这些状态与 UI 操作。StartTurn 的迟到响应只影响原提交。发送是乐观的：消息立即离开输入框、显示在对话里，服务端确认后换成已保存的消息。服务端明确拒绝时说明原因并把内容退回输入框；结果未知时按 requestId 查询，不直接创建第二个 Run。

登录会话是服务端设置的 HttpOnly cookie，页面脚本读不到；应用只在本机记住登录的是哪个账号，好让页面立即打开，服务端的回答（`GetCurrentUser`，以及任何被拒为未登录的请求）会纠正它。同一浏览器的标签页共用这个 cookie，一个标签页登录或退出，其他标签页立即跟随。

所有变化来自按用户的事件通道（`features/events/event-channel.ts`，WebSocket，见 [多端同步](../../docs/sync.md)），它在登录后由 `ThreadController` 打开：Run 的进度交给 `run-sync.ts` 按 Run 依次应用，对话记录、删除、记忆和用户资料直接更新对应的查询缓存。`run-state.ts` 原子应用一个 revision，缺少连续 revision 时用 GetRun 重新取快照；重复变化不再次追加文字；`run-cache.ts` 阻止缓存版本倒退。通道每次连上（包括断线重连）都让当前用户的查询重新读取一次，断线期间的变化不重放。Get/Start/Cancel 与事件共用 Run 投影缓存，旧 revision 不能覆盖新状态。QUEUED 和 RUNNING 均阻止该 Thread 再次发送。

切换 Thread、卸载页面或退出登录只结束本地观察。主动停止单独调用 CancelRun；在 Start 确认前点击停止按 requestId 停止：服务端已受理就停止回复，还没受理就撤回这次发送，消息退回输入框（重新生成则收回，原回复重新出现）。草稿只在当前页面生命周期内保存；已接受的 Run 由服务端原生 Durable Object 托管，消息、状态和 Checkpoint 保存在 PostgreSQL。浏览器通过 Connect API 读取和提交命令，通过 `/events` 的 WebSocket 接收变化，不直接调用 RunActor。

## 开发

在仓库根目录使用 mise 固定的工具版本：

```sh
mise run install
pnpm dev:web
```

Vite 默认地址为 `http://localhost:5173`，将 `/heveta.v1.*` 和 `/files/` 代理到 `http://localhost:8787`。前端无需 `.env`。启动完整环境用 `pnpm dev`，只启动 Worker 用 `pnpm dev:server`；后者包含静态资源和本地数据库准备。

生产产物在 `build/client`，通过 Worker Assets binding 提供。Worker 的 `assets.run_worker_first` 覆盖 Connect 服务及 `/files/*`，使 API 请求进入 Worker 路由。

## Astryx 接入

界面只用 Astryx 组件和它的官方主题机制，不写 StyleX 或自定义 CSS。主题是 `packages/brand/src/theme/heveta.ts`（App 和官网共用）：在官方 Neutral 主题上去掉阴影和边框，另有少量组件规则（对话列宽、侧边栏账号行等）。它用 `astryx theme build` 预先编译成样式表（`pnpm theme`，产物随源码提交，`pnpm check` 校验是否过期），`app/app.css` 引入这份样式表，`<Theme>` 不在运行时注入。每个页面从最接近的 Astryx 模板出发（登录、AI Chat Landing、AI Chat Conversation），使用对应的现成组件：`AppShell`/`SideNav` 管理导航，`ChatLayout`、`ChatMessageList`、`ChatComposer`、`ChatToolCalls` 组成对话页，助手回复由带 `isStreaming` 的 `Markdown` 渲染。外观默认跟随系统，可在设置里切换并保存本机偏好。官方简体中文语言包由 `InternationalizationProvider` 提供，图标来自 `lucide-react`。品牌名只定义在 `app/components/brand.tsx` 的 `brandName`。

按官方文档的简单接入方式：`app.css` 导入 `@astryxdesign/core/reset.css` 和预编译的 `@astryxdesign/core/astryx.css`，Vite 只用 React Router 插件。HTML head 预先声明 `reset, astryx-base, astryx-theme` 层顺序，因为开发模式下 Vite 用脚本注入 `app.css`，可能晚于 `<Theme>` 注入的样式。

## 多语言

界面默认英文，另有简体中文。语言默认跟随浏览器（`navigator.languages` 里第一个英文或中文），也可以在“设置 → 通用 → 语言”里固定一种，只记在本机。文案用 Astryx 的 `InternationalizationProvider` 和 ICU 消息：每个功能目录的 `messages.ts` 用 `defineMessages` 同时写英文和中文（类型要求两种都有），`app/i18n/messages.ts` 合并它们和 Astryx 自带的中文目录，组件用 `useT()` 取文案。每个 RPC 请求带 `Accept-Language`，服务端据此返回模型说明、发送验证码邮件。

界面实现约定见 [AGENTS.md](AGENTS.md)。

## 自行验证

```sh
pnpm --filter @heveta/web typecheck
pnpm --filter @heveta/web test
pnpm build:web
```

`test`（vitest，独立的 `vitest.config.ts`）跑 `test/` 里状态逻辑的单元测试（Run revision 合并、事件驱动的列表更新等）；改这部分逻辑要跟着改测试。

后端部署与执行恢复边界见 [架构说明](../../docs/agent-runtime.md)。

电脑、终端、文件和邮箱共用单行顶栏：标题在左，状态及操作在最右侧，下面直接是完整内容区域。文件页支持常见图片与 UTF-8 文本预览，使用 Astryx Lightbox 和全屏 Dialog；文本限 1 MiB、图片限 20 MiB，不支持的格式保留下载。
