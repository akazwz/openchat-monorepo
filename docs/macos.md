# macOS 客户端与本机执行环境

Heveta macOS 客户端以 SwiftUI / AppKit 管理原生窗口、菜单栏和本机执行端，以 WKWebView 复用完整 Web 应用。agent loop 留在服务端；选中的 Mac 执行命令、文件操作和 computer use。人工观看或接管才启动 WebRTC 视频。

## 目录与职责

| 位置                                           | 职责                                                      |
| ---------------------------------------------- | --------------------------------------------------------- |
| `apps/macos/Sources/Heveta/App`                | 启动、配置、菜单栏、窗口与退出                            |
| `apps/macos/Sources/Heveta/Features/WebApp`    | 持久化 WKWebView、可信主框架桥接、文件选择/下载、断网重试 |
| `apps/macos/Sources/Heveta/Features/Devices`   | Keychain 绑定、接入开关、连接与权限状态                   |
| `apps/macos/Sources/Heveta/Features/Execution` | zsh、UTF-8 文件、传输、调用日志与取消                     |
| `apps/macos/Sources/Heveta/Features/Desktop`   | ScreenCaptureKit、CGEvent、原生 libwebrtc                 |
| `apps/server/src/modules/devices`              | 设备归属、凭证、WebSocket broker、工具与信令              |
| `apps/web/app/features/devices`                | 绑定、设备列表、执行环境选择、浏览器远控                  |
| `proto/heveta/v1/device.proto`                 | 账号侧设备 RPC；Run/Turn 中保存执行目标                   |

Swift 模板迁自 `/Users/zwz/dev/swift/hello-swift`，原目录保持独立，MIT 许可保留在 `apps/macos/LICENSE`。

## 使用

1. 运行客户端，登录 Heveta，在设置 → 设备中点击“连接这台 Mac”。
2. 开启“允许访问这台 Mac”。Web 页面和菜单栏控制同一个原生状态。默认关闭，重启应用后需要重新开启。
3. 在对话输入框的执行环境选择器中选择在线 Mac。每个 Run 保存自己的目标；后续选择不改变已经提交的输入，重试沿用原目标。失联时不会自动改用云电脑。
4. 命令和文件工具无需屏幕权限，以当前 macOS 用户执行，默认工作区为 `~/Library/Application Support/Heveta/Workspace`，也支持用户有权限访问的绝对路径。
5. agent 需要 GUI 时按需截图和发送键鼠动作；人工从设备列表进入远程桌面，默认仅观看，可以切换控制、发送文字或结束会话。手机使用紧凑工具栏及文字输入框。

关闭网页窗口保留执行端和连接；菜单栏可以重新打开窗口。关闭本机接入、撤销设备或退出应用会结束远控并取消本产品启动的任务。命令使用独立进程组，调用结束、超时和取消时终止该进程组。

Mac 上的已有文件、软件和浏览器数据与云电脑的快照、重启、清空、恢复和 30 天过期规则独立。

两个客户端实现同一套设备协议：本文描述的原生 Swift 客户端，以及 Electron 客户端（`apps/electron`，见其 README；默认工作区是 `~/Heveta`，屏幕采集和 WebRTC 用 Chromium 自带的）。服务端和 Web 不区分它们。

## 身份与协议

Web 登录沿用 HttpOnly Cookie。登记设备签发独立随机凭证：服务器只存 SHA-256，原生端存 Keychain，状态消息不暴露凭证。再次绑定轮换凭证；撤销在数据库和 broker 中关闭访问。可信主框架必须与配置 App URL 的 scheme、host、port 一致，iframe 和外部页面不能调用原生桥接；外部链接交给系统浏览器。

原生端用 Bearer 凭证建立出站 `/device/connect` WebSocket。512 KiB 消息限制，协议版本 1；承载 `hello`、`status`、`execute`、`result`、`collect`、`cancel`、`disabled` 和远控信令。心跳每 20 秒；连接失败按 1–30 秒退避重连，401 清除失效绑定。主动关闭接入先停止本机任务，再通知 broker 结束未完成调用和远控；网络断开时继续沿用日志恢复。网页状态通过现有 `/events` 更新。

网页确认的账号与本机绑定不同或已退出时，关闭接入并禁止再次开启该绑定。重新绑定保留新凭证；旧连接的消息和旧解绑操作不能覆盖新绑定。

调用 ID 由 Run 和 tool call ID 组成。broker 先持久化意图，原生端在副作用前记录本地任务日志，结果持久化后才回传。重连收集日志中的结果；收到过但未完成的调用在进程重启后返回“结果未知”，不能盲目重放。broker 对并发重复提交使用同一持久化边界。取消先保存再发送，断线恢复后仍生效。原生最多同时执行 8 个任务；命令最大 30 分钟，broker 在 31 分钟后结束未确认调用。

文件和截图通过 `/device/file` 流式 HTTPS 上传/下载，须持有设备凭证及对应未结束调用；继续检查附件所有权、方法和 100 MB 上限。当前 Run 的附件投影到本机 `uploads/<file ID>/<安全文件名>`，不使用云电脑文件的全局路径。邮件附件也走所选执行环境。

## 桌面与 WebRTC

ScreenCaptureKit 获取主显示器；截图保存 PNG，实时采集最高 1920 × 1080、30 fps，保持比例。鼠标位置使用主显示器 0–1 的归一化坐标，键盘使用 DOM 物理键码，文字输入支持 Unicode。

浏览器通过 `StartRemoteDesktop` 登记短期会话，再建立账号 Cookie 认证的 `/device/remote` WebSocket。现有原生设备连接转发 offer/answer 和 trickle ICE。视频轨道与可靠、顺序 DataChannel 在浏览器和原生 libwebrtc 之间传输。ICE 默认允许直连，Cloudflare TURN 兜底；7200 秒凭证只由服务端生成，两端不持有 TURN API 密钥。单次远控最长约 116 分钟，之后重新连接。

会话建立不了或中途结束时，观看者得到原因而不是一句笼统的失败：`StartRemoteDesktop` 被拒带 `ErrorReason`（设备离线、未允许屏幕录制、未允许辅助功能、已有人在操作）；设备端结束会话时在 `remote_error` 里带 `code`（`screen_permission`、`input_permission`、`controlled`、`busy`、`capture`、`connection`、`ended`；Electron 客户端会带，Swift 客户端目前只有文字，Web 按“未能共享屏幕”处理）；连接被服务端关闭按关闭码区分“会话已结束”和“连接中断”。

最多 8 个观看者，同一台 Mac 只有一个人工控制会话。人工接管时释放 agent 的输入，agent GUI 操作等待人工释放。窗口失焦、结束会话、连接关闭、权限变化和任务结束均释放相应输入状态；命令、文件操作仍可独立执行。

Swift 通过 Objective-C 接口使用 libwebrtc；二进制依赖 `stasel/WebRTC` 固定为 154.0.0，revision 和校验由 Xcode package resolution 管理。这是社区打包的 WebRTC SDK，不是官方纯 Swift SDK。

## 系统权限与分发

- 屏幕录制：截图和实时视频；未授予时不能查看桌面。
- 辅助功能：键鼠；未授予时仍可观看已获许可的屏幕。
- 桌面、文稿等文件的隐私访问仍由 macOS 管理；当前用户无法访问的文件会返回错误。
- GUI 需要可用的登录桌面。应用不会唤醒休眠的 Mac、绕过登录/锁屏、提升为 root 或修改系统权限。
- 采用自行分发路线，App Sandbox 未启用。默认构建为 ad hoc 签名；已另外使用本机现有 Developer ID Application 证书生成通用 Release 签名包，启用 Hardened Runtime，应用与框架均有可信时间戳。公开下载还需要公证和更新分发；本项目尚未提供公证 profile 配置，公证未执行；当前受限环境的签名复验问题也需要在正常系统环境核实。调试构建改动后系统可能要求重新授予权限。

本次没有自动授予屏幕录制或辅助功能权限。2026-10-02 用户已确认允许，并选择自行测试真实桌面；助手未确认系统权限当前状态，也未继续运行真实桌面测试。生成测试画面不能替代系统采集/输入验证。

## 配置与部署

构建与联调见 [客户端 README](../apps/macos/README.md)。Debug 开发版与 Release 均默认使用线上 `https://app.heveta.com`；只有显式设置 `HEVETA_APP_URL=http://localhost:5173` 时才使用本地联调地址。

服务端使用 `TURN_KEY_ID`、`TURN_API_TOKEN` 秘密绑定；凭证 API 为 Cloudflare Realtime TURN。已创建专用 Heveta TURN key，并在本次部署中配置为线上 Worker secret。本地 `.env` 和 CLI 输出保存在忽略文件中，不能提交这些值。

数据库新增迁移 `20261001194705_native_devices`：建立 `devices`，新增 `runs.device_id`。先迁移目标数据库，再部署 Worker/Web；保持已有 cloud computer 绑定与数据规则。新增 `DeviceConnection` 是 SQLite Durable Object，导出和部署配置已接入。

2026-10-02 已完成生产 PostgreSQL 的 `20261001194705_native_devices` 迁移，并发布 Worker 与 Web 到 `https://app.heveta.com`。Cloudflare 创建了 `DeviceConnection`，远控 TURN secret 随部署上传，版本为 `d372e3f3-f5c5-42df-95af-1c501cae03ba`。迁移临时账号已撤销、其凭证文件和临时 secret 上传文件已删除。迁移回执位于忽略目录 `apps/server/.cloudflare/production-native-migration.json`，部署日志位于 `apps/server/.cloudflare/production-native-deploy.log`。这是生产发布记录，不代表真实桌面功能已经完成验收。

2026-10-02 本机安装：会话恢复 Applications 写入权限后，已直接安装 Debug 开发版到 `~/Applications/Heveta.app`（bundle ID `com.heveta.macos`）。按用户最新要求，已将 Debug 默认地址改为线上 `https://app.heveta.com`，重新构建、安装，并在生产发布后打开；从 Finder 启动也默认使用线上。原有客户端（bundle ID `com.heveta.desktop`）保留在 `apps/macos/.build/install/Previous-Heveta-20261002-052505.app`，此前默认本地地址的开发版保留在 `Previous-Local-Heveta-20261002-053227.app`。本地联调仍可通过 `HEVETA_APP_URL` 显式启用。本次只构建、安装、迁移和部署，按用户要求没有继续运行功能测试，桌面功能由用户在线上验收；此前本地登录验证码不适用于线上登录。

## 验证记录与限制

已验证：

- Debug 当前架构与 Release arm64/x86_64 通用构建，6 项默认原生测试（执行、Keychain、未授权时拒绝桌面操作）。Developer ID 构建及生成时的 Hardened Runtime、应用/框架可信时间戳与签名检查通过；ZIP CRC、两种架构的代码页哈希和 CMS 密码学签名复核通过。当前受限命令环境的 Apple 签名复验失败，证书信任验证与公证尚未闭环。
- zsh 工作目录、Unicode 文件写入/编辑/有界读取、子进程取消、本地日志重建与重复调用不重放。
- 真实 URLSession WebSocket → 本地 Worker 认证、协议 hello/status/心跳，以及两项连接与账号状态回归：新绑定保留、账号切换后禁止开启旧设备。
- 隔离本地账号的实际 agent loop → Mac：`uname -s` 返回 Darwin，写入测试文件，`send_file` 经真实设备文件接口回到对话。
- 浏览器 → 原生 SDK 的视频及输入 DataChannel；生成测试画面 640 × 360。强制 `iceTransportPolicy: relay` 时连接成功，选中 TURN/TCP relay，浏览器解码视频帧，原生收到输入消息。
- broker 的重复提交、重连收集、离线取消、超时、凭证撤销和单控制者边界；目标归属/重试/幂等及附件路径投影。
- 47 项 Web 单元测试、97 项服务端单元测试、58 项 PostgreSQL 集成测试、TS/lint、Web 生产构建与 Worker dry-run。
- 浏览器设备设置、执行目标选择及 390 px 手机布局；原生进程启动后存在可见主窗口。

仍待验证：真实 ScreenCaptureKit 采集、真实鼠标键盘、原生窗口和绑定权限流程的完整交互、多网络/跨地区性能、macOS 14 与 Intel 真机。当前机器为 Apple Silicon / macOS 27。原生 UI 操作工具无法定位本次构建的窗口，已区分窗口存在与交互验证。

已准备可选 `RealDesktopTests`：通过正式设备控制器连接本地 Worker，保存系统截图，并以测试专用窗口验证真实视频、Unicode 输入、物理键码与鼠标点击。它检查已有授权，不发起权限请求；执行方法和证据位置见客户端 README。该入口已编译，不能把入口存在作为真实桌面已验证的证据。

这些检查覆盖本次接入链路，不代表不存在其他遗漏，也不闭环 `docs/system-review.md` 中的历史问题。
