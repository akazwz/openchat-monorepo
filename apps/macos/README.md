# Heveta for macOS

Swift 原生客户端，WKWebView 复用完整 Heveta Web。Mac 可作为 agent 的命令、文件和 computer use 执行设备；人工远程桌面使用原生 libwebrtc 与浏览器直连，Cloudflare TURN 兜底。关闭窗口保留执行端，菜单栏管理接入和系统权限。

模板迁自 [`hello-swift`](https://github.com/akazwz/hello-swift)，保留 [MIT 许可](LICENSE)。架构、协议、服务端配置及真实验证范围见 [macOS 接入文档](../../docs/macos.md)。

## 构建与运行

需要完整 Xcode 27 / Swift 6.4。Swift 6 语言模式，最低 macOS 14，唯一构建入口为 `Heveta.xcodeproj/project.xcproj`。原生 SDK 固定依赖 `stasel/WebRTC` 154.0.0，由 Xcode 解析；`Package.resolved` 随工程保存。

仓库根目录：

```sh
mise run build:macos
mise run release:macos
mise run test:macos
mise run dev:macos
```

本目录对应 `mise run build`、`release`、`test`、`dev`。Debug 构建当前架构，Release 构建 arm64/x86_64 通用应用。产物：`.build/app/Build/Products/<configuration>/Heveta.app`。重新构建前退出旧实例。

Debug 开发版与 Release 均默认打开线上 `https://app.heveta.com`，从 Finder 启动同样使用线上地址。本地联调时，先启动本地 PostgreSQL、Worker 和 Web，再显式指定本地地址：

```sh
mise run dev
HEVETA_APP_URL=http://localhost:5173 mise run dev:macos
```

在两个终端分别运行上述命令。`HEVETA_APP_URL` 可以覆盖默认地址，`dev:macos` 显式把地址传给 Launch Services 启动的应用。只允许 HTTPS 或 HTTP loopback；WKWebView 使用自身持久化网页存储，登录与 Safari、Ego Lite 的会话分开。2026-10-02 已发布对应服务端与 Web，生产库的设备迁移和线上 TURN secret 已配置；客户端可以直接使用线上账号绑定 Mac。真实桌面验收结果仍待用户自行测试。

登录 → 设置 → 设备 → 连接这台 Mac → 开启接入。重启后接入默认关闭；凭证仍在 Keychain。工作区在 `~/Library/Application Support/Heveta/Workspace`，任务日志在同一目录下的 `Jobs`。本机文件不受云电脑 30 天过期规则影响。

## 目录

```text
Heveta.xcodeproj/       targets、包依赖、构建配置、共享 scheme
Sources/Heveta/
  App/                 启动、配置、菜单栏、AppKit 窗口
  Features/WebApp/     WKWebView、原生桥接、文件面板、断网重试
  Features/Devices/    Keychain、开关、连接和权限状态
  Features/Execution/  命令、文件、传输、取消及调用日志
  Features/Desktop/    系统采集、输入、WebRTC、会话与操作权
Tests/HevetaTests/      原生自动化及可选本地端到端 fixture
Resources/             Heveta 图标与中英文原生文案
docs/                  图标资源工作流
```

## 测试

默认原生测试覆盖命令、取消、Unicode 文件、结果日志、隔离测试账户的 Keychain 更新/删除，以及未获系统权限时拒绝截图和输入。不会覆盖已有设备凭证或文件。

两组网络测试只在显式指定忽略的本地 fixture 时运行。JSON 包含 `device.id`、`userId`、`credential`、`origin`，其中凭证来自本地 `RegisterDevice`，不能使用生产账户。

```sh
TEST_RUNNER_HEVETA_APP_URL=http://localhost:8787 \
  TEST_RUNNER_HEVETA_TEST_DEVICE=/absolute/path/local-device.json mise run test
TEST_RUNNER_HEVETA_TEST_LIVE_DEVICE=/absolute/path/local-device.json mise run test
```

`TEST_RUNNER_` 前缀让 xcodebuild 把变量传到测试进程。第一组验证真实 Worker 握手、原生控制器重新绑定及账号切换；`HEVETA_APP_URL` 必须与 fixture 的 `origin` 相同。第二组提供 180 秒的真实原生执行端和生成的视频画面，供本地 agent 和浏览器验证；它必须收到执行请求，在 fixture 同目录 `Workspace/native-proof.txt` 写入测试文件，并收到 DataChannel 输入。生成的视频只验证传输，不读取真实桌面，不发送系统输入，不授予 TCC 权限。

用户明确同意并在系统中授予测试应用屏幕录制、辅助功能权限后，单独运行真实桌面测试：

```sh
TEST_RUNNER_HEVETA_APP_URL=http://localhost:8787 \
  TEST_RUNNER_HEVETA_TEST_REAL_DESKTOP=/absolute/path/local-device.json mise run test
```

此测试使用正式 `DeviceController`、ScreenCaptureKit 和 CGEvent，凭证存到独立测试 Keychain 项。它打开 “Heveta remote desktop QA” 窗口，并在 fixture 同目录的 `RealDesktop/ready.json` 写入就绪状态。浏览器进入对应设备远控，确认收到真实视频后开启控制，向该窗口输入 `Heveta 中文🙂`，在视频区域按左方向键，再用鼠标点击 “Verify pointer”；180 秒内完成这三项后结束测试并关闭连接。真实截图保存在忽略目录 `RealDesktop/desktop.png`，权限为 0600，不发送到模型或生产存储。测试不会申请权限，也不能同时运行其他网络 fixture。此测试入口已编译；用户已选择自行测试，尚未记录真实系统操作的验收结果。

## 权限与分发

命令/文件以当前 macOS 用户权限运行。截图和视频需要屏幕录制；键鼠需要辅助功能，均由用户在 macOS 授权。客户端不绕过锁屏或系统隐私权限；休眠和断网时不可达。

当前 bundle ID 为 `com.heveta.macos`，App Sandbox 未启用，走自行分发路线。默认 Debug/Release 构建使用 ad hoc 签名；Release 开启 Hardened Runtime，不注入调试权限。已用本机现有 Developer ID Application 证书生成通用签名包，生成时应用及 WebRTC 框架的可信时间戳、嵌套签名检查通过。归档 CRC、两种架构的代码页哈希与 CMS 密码学签名复核通过；当前受限命令环境中的 Apple 签名复验返回 `Authority=(unavailable)` 和签名错误，完整证书信任验证尚未闭环。构建目录与归档程序的哈希一致，未发现测试改动程序的证据；受限环境是待核实的原因，不能据此认定可发行。

本目录可复现签名和公证流程：

```sh
HEVETA_SIGNING_IDENTITY='Developer ID Application: <name> (<team>)' mise run distribute
HEVETA_NOTARY_PROFILE='<existing Keychain profile>' mise run notarize
```

`distribute` 输出 `.build/Heveta-macOS-DeveloperID.zip`。`notarize` 使用现有 notarytool Keychain profile，提交同一构建，确认 Apple 返回 Accepted 后装订票据、验证 Gatekeeper，再重打包。此项目尚未提供公证 profile 配置，公证未执行；签名包不能当作已公证公开发行包。证书私钥和公证凭证不进入仓库。WebRTC 包装库及上游许可证说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
