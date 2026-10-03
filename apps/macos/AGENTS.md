# macOS 客户端约定

仓库根目录的 review 与修复约定同样适用。

## 工程与构建

- 原生 SwiftUI + AppKit 应用，唯一构建入口是 `Heveta.xcodeproj/project.xcproj`；使用 Xcode 或 `xcodebuild` 生成 `.app`。Swift 包依赖添加到此工程，不另建 `swift run` 或根目录 `Package.swift` 入口。
- 完整 Xcode 27、Swift 6.4 编译器，Swift 6 语言模式，默认 `MainActor` 隔离；最低运行版本保持 macOS 14。新系统 API 使用可用性检查和合适的回退。
- 语言、部署版本、并发和签名配置统一在 Xcode 工程中。`mise.toml` 只组织构建与资源任务。
- 在此目录运行 `mise run build`、`mise run release`、`mise run dev`。仓库根目录对应 `build:macos`、`release:macos`、`dev:macos`。产物位于本目录 `.build/`。
- 修改后先退出旧实例，再重新运行 `dev`；不会自动重启或监听文件。

## 能力与状态边界

- `App/` 管启动、菜单栏和窗口生命周期；`Features/WebApp/` 管系统 WebView 与可信来源的桥接；设备连接、任务执行和桌面操作各自管理自己的状态。
- 完整业务界面复用 `apps/web`。原生界面只承载菜单栏、接入开关、权限和系统操作；使用 SwiftUI、AppKit 和 Apple 官方 API。
- 网页窗口关闭不退出客户端；明确退出才结束进程。接入开关属于原生执行端，网页刷新、路由变化、窗口关闭不改变它。
- 默认关闭本机接入。设备授权和凭证与 Web 的 HttpOnly 会话分开，凭证保存在 Keychain。仅可信 App 来源的主框架可以调用原生桥接；外部链接交给系统浏览器。
- 本机数据和进程不套用云电脑的快照、重启、清空和 30 天过期规则。原生执行端以当前用户权限运行，系统隐私权限按需申请。
- UI 使用 `MainActor`；文件、命令、媒体处理放入独立执行器。保留调用 ID 和执行结果，连接恢复不得盲目重放产生副作用的操作。
- 工具消息和信令走设备 WebSocket；截图按需获取；人工查看桌面时建立原生 WebRTC 会话，关闭后释放媒体资源。
- 本机接入关闭或账号绑定被撤销时，拒绝新任务、结束远控并取消本产品启动的任务。

## 资源与验证

- 图标由一个 1024 PNG 母图经 `mise run icon` 导出；见 `docs/app-icon.md`。保留模板的 MIT 许可与来源。
- 修改 Swift 或工程配置后，依次验证 Debug 和 Release 构建。窗口、启动、接入状态和权限流程还需运行实际 `.app`。
- 验证命令、文件、取消、断线恢复与远控时使用测试工作目录，避免操作用户已有文件。
- 区分编译、协议测试、真实设备操作和兼容性测试；本机运行不代表 macOS 14 或 Intel 已验证。
