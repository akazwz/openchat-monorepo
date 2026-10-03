# Heveta Electron

Heveta 的 macOS 桌面客户端。它承载完整的 Web 应用（默认 `https://app.heveta.com`），并让这台 Mac 成为账号下的一台设备：agent 可以在上面执行命令、读写文件、看屏幕和操作键鼠，账号的主人可以从别的设备查看和操作它的屏幕。聊天、设置、远程桌面界面都是 Web 应用自己的，客户端不另做一套 UI。

设备协议、权限和服务端部分见 [docs/macos.md](../../docs/macos.md)；原生 Swift 客户端（`apps/macos`）实现同一套协议，二者互不依赖。

## 开发与安装

使用仓库锁定的 Node 和 pnpm，仅支持 macOS（最低 14）。在仓库根目录：

```sh
mise run install
mise run dev:electron                                          # 连线上服务
HEVETA_APP_URL=http://localhost:5173 mise run dev:electron     # 连本地 `pnpm dev`
```

`HEVETA_APP_URL` 必须是 HTTPS，或本机回环地址的 HTTP。

```sh
mise run build:electron     # 类型检查并构建到 build/
mise run package:electron   # 打包、签名：.build/packages/Heveta Electron-darwin-<arch>/
mise run install:electron   # 打包并安装到 ~/Applications/Heveta Electron.app
```

- 打包使用 `scripts/signing.mjs` 里固定的 Developer ID Application 身份，缺少该证书直接报错，不回退临时签名：macOS 的屏幕录制和辅助功能授权绑定签名身份，每版都换身份就要每版重新授权。未做公证和自动更新。
- 安装前先退出正在运行的应用。脚本在目标磁盘上暂存完整的应用、校验签名和 Bundle ID 后再替换，旧版留在 `.build/install`。
- Intel 包：`HEVETA_BUILD_ARCH=x64 node scripts/package.mjs x64`（在 `apps/electron` 下）。

**每种运行方式有自己的配置目录和 Keychain 条目**，互不影响（`appNameFor`，`src/config.ts`）：

| 运行方式                   | 应用名 / `~/Library/Application Support` 下的目录 |
| -------------------------- | ------------------------------------------------- |
| 安装版，线上服务           | `Heveta Electron`                                 |
| 安装版，`HEVETA_APP_URL`   | `Heveta Electron (<host>)`                        |
| 开发运行，线上服务         | `Heveta Electron Dev`                             |
| 开发运行，`HEVETA_APP_URL` | `Heveta Electron (<host>) Dev`                    |

所以本地联调不会动到安装版的登录和设备绑定。系统权限是按签名身份给的：开发运行用的是 Electron 自己的二进制，需要单独授权。

## 使用

- 窗口顶部的一条是窗口栏：放红绿灯，拖动它移动窗口，颜色取自主题，和侧边栏连成一体。全屏时它收起。
- 关闭窗口（`⌘W`）只是隐藏：草稿、上传、下载和设备连接都保留，点 Dock 图标回来。`⌘Q` 退出；有未发送的草稿、进行中的上传或下载时，退出和重新加载前会先问。
- `⌘N` 新对话，`⌘,` 设置，`⌘R` 重新加载，`⌘[` / `⌘]` 后退 / 前进，`⌘0` / `⌘+` / `⌘-` 缩放，`⌘⇧J` 打开下载文件夹。菜单走 Web 应用自己的路由，不会重载页面。
- 外观和语言在 Web 的设置里选，窗口栏、菜单、客户端自己的提示随之变化。
- 加载失败、页面崩溃时，窗口显示客户端自己的提示和“重试”；网络恢复或从睡眠唤醒后自动再试。
- 外部链接交给系统浏览器；下载弹系统保存面板，Dock 图标显示进度。

### 把这台 Mac 交给 agent

1. 登录后打开“设置 → 设备”，点“连接”。绑定凭证用 Keychain 加密后存在配置目录里。
2. 打开“允许访问”。每次退出应用后它都会关上，绑定保留。
3. 命令和文件不需要额外的系统权限；看屏幕需要“屏幕录制”，操作键鼠需要“辅助功能”，在同一页点“去允许…”。
4. 在对话的输入框里把运行位置选成这台 Mac。默认工作文件夹是 `~/Heveta`，也可以用绝对路径和 `~`。
5. 在别的设备上打开“设置 → 设备 → 查看屏幕”，可以看这台 Mac 的屏幕，或切到“操作”。有人在操作时，agent 的键鼠操作会被拒绝。

连接了账号的 Mac 在菜单栏有一个图标：是否可达、有几个人在看屏幕，以及“允许访问”的开关。

## 结构

```text
src/main.ts              启动、单实例、退出流程
src/config.ts            服务地址、来源判断、运行方式对应的应用名
src/messages.ts          客户端自己的中英文文案
src/preferences.ts       窗口位置、缩放、外观、语言
src/shell/               窗口：window.ts（窗口栏 + Web 应用视图 + 状态）、菜单、下载、右键菜单、自有页面的协议
src/preload/             三个页面的预加载脚本：Web 应用、窗口自有页面、屏幕共享页面
src/pages/               客户端自己的页面：shell（窗口栏和加载/失败面板）、media（屏幕共享）
src/device/              设备端
  host.ts                绑定、开关访问、把各部分接起来
  link.ts                到服务端设备 broker 的 WebSocket：握手、心跳、重连
  protocol.ts            协议消息的类型与解析
  execution.ts           命令进程的监管
  executor/              命令进程：shell、文件、文件传输、任务日志
  remote.ts              屏幕共享会话；截图
  input.ts               键鼠事件的校验；native/input.mm 负责注入
  permissions.ts, storage.ts, tray.ts
native/input.mm          Node-API 模块：用 Core Graphics 发送键鼠事件
scripts/                 build（esbuild + clang）、package（打包签名）、install、signing
```

几点设计：

- **窗口**是一个 `BrowserWindow`，自己的页面只有窗口栏和状态面板；Web 应用在它下面的 `WebContentsView` 里，加载成功才显示。这样窗口栏在每个页面、每种状态下都一样，也不依赖 Web 应用配合。
- **客户端自己的页面**从 `heveta-shell://` 提供（`shell/pages.ts`），而不是 `file://`：标准的安全来源，只能读到列出的几个文件。颜色、字体取自 `packages/brand` 的主题（`scripts/build.mjs` 生成 `theme.css`），标志也是同一份路径。
- **Web 应用拿到的只有两个窄接口**（`preload/app.ts`）：`hevetaDesktop`（菜单导航、外观同步、是否有未保存的工作）和 `hevetaNative`（设备）。主进程只接受来自 Web 应用顶层文档、且来源正确的调用。页面启用 Chromium 沙箱和上下文隔离，没有 Node。
- **命令在单独的进程里执行**（`utilityProcess`）。每个命令是自己的进程组，结束、超时、取消时整组终止；命令进程意外退出时主进程清掉它启动的进程组。
- **任务日志**（`executor/journal.ts`）：命令动手之前先落盘，结束后写入结果。服务端重连后再问，只会得到结果或“结果未知”，不会重跑。日志按“服务地址 + 账号 + 设备”分目录，七天后清理（与服务端保留期一致）。
- **屏幕共享**：一个不显示的页面用 `getDisplayMedia` 采集主显示器，为每个观看者建一条 WebRTC 连接；主进程通过 `setDisplayMediaRequestHandler` 指定显示器，不弹选择器。画面浏览器直连，服务端只转发协商。输入从数据通道回到主进程，由原生模块执行。会话结束的原因以代码告诉观看者（`RemoteError`），Web 给出对应的说明。
- 打包启用 ASAR 完整性校验和 cookie 加密，关闭 RunAsNode、`NODE_OPTIONS` 和 Node 调试参数；`input.node` 放在 ASAR 之外。

## 验证与限制

验证记录和遗留问题见 [review.md](review.md)。尚未做的：公证和自动更新、多显示器选择、系统音频、多窗口、退出后保留草稿。
