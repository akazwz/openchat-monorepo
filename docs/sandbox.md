# Agent 沙箱：给 agent 一台电脑

状态（2026-09-30）：Sandbox 1.0 原生容器、原生文件系统快照与 `cloudflare.config.ts` 配置已上线；Cloudflare 实际根快照保存／恢复、浏览器重启和 R2 过期回退验证通过。发布与验证记录见 [系统检查](system-review.md)。

## 目标

给每个用户的 agent 一台完整的 Linux 电脑，而不是只能跑一段代码的沙盒：能执行命令、安装软件、读写文件、运行较长的程序，工作区下次还在。agent 能做的事因此扩大到写代码并运行、处理数据和文件、生成图表和文档、跑脚本抓取和整理资料。

它作为 `ToolExecutor` 的一种实现接入（见 [工具执行](tool-execution.md)），agent loop 不改。

## 选型：Cloudflare Sandbox

Cloudflare 提供两层：

- **Containers**：由 Durable Object 管理的 Linux 容器，运行我们自己的 Docker 镜像。
- **Sandbox SDK 1.0（`@cloudflare/sandbox`）**：只使用 `Files` 等文件工具。自己的 `Computer` 继承原生 `DurableObject`，通过 `ctx.container` 启动容器、执行命令和访问端口；后台进程、终端、原生文件系统快照与保存后休眠由项目管理。

我们本来就在 Cloudflare 上，Sandbox 和现有的 Worker、Durable Object、R2 同一套部署和计费，所以选它。浏览器另有一个产品 Browser Run（原 Browser Rendering），见下面“浏览器”。

来源：[Sandbox 文档](https://developers.cloudflare.com/sandbox/)、[Containers 文档](https://developers.cloudflare.com/containers/)。

## 设计

### 一个用户一台电脑

- 每个用户一个沙箱，ID 为 `user-<userId>`。同一个 ID 总是路由到同一个实例。
- 不用容器里的 shell、tmux 会话或目录隔离不同用户；它们共享文件系统和进程空间。用户边界是独立的 Computer Durable Object 与容器。
- 同一用户的多个对话共用这台电脑，就像同一个人的电脑。每个对话同时最多一个运行中的 Run，但不同对话可以同时运行，所以同一台电脑可能同时被几个 Run 使用；工具说明里要让模型知道这一点。

### 电脑数据保留 30 天

容器停止后进程全部结束，原实例磁盘不再可用。原生调度下，部署重启 DO 时仍运行的容器保留，普通部署不会替换其镜像；休眠、显式重启与机器故障需要恢复保存点。电脑空闲 30 分钟后保存再停止，不能只靠延长运行时间代替持久化。

用户主要在 `/workspace` 工作。**连续 30 天未使用电脑，电脑里的文件、安装的软件和浏览器数据会被清空。**重要成果应下载，或用 `send_file` 发送到对话里保存。对话、记忆、对话附件和已发送到对话的文件不属于电脑文件系统，继续按各自的保留规则管理。

**工作区归电脑自己管**：保存、恢复、快照列表和“哪些运行在用这台电脑”都放在电脑的 Durable Object 里（`Computer`，继承原生 `DurableObject`，`sandbox/computer-object.ts`；逻辑在 `sandbox/workspace.ts` 的 `Workspace`）。它是唯一知道容器何时启动、何时停止的地方，所有恢复、保存、重启、恢复快照、清空都在它里面排队，一次一个。所以不需要数据库锁、序号或表：快照列表和租约存在它自己的存储里。Worker 调它的方法（`ready`、`save`、`release` 等），DO 的 RPC 传不了自定义错误类，这些方法以结果值回答（`ready` 返回容器的代次，`save` 要带上它，回答 `"saved" | "lost"`；设置页的操作回答 `"done" | "busy" | "not found" | "unsaved"`）。

**保存的时间点先于 Step 提交**：一次可能改动文件的工具调用（`shell` 无论成败；`write_file`、`edit_file` 成功时）结束后，执行器先让电脑保存，再把结果交回 loop 提交 TOOL Step。每次保存拍摄一个不可变的完整根文件系统快照，原生句柄、来源镜像、到期时间及列表存在电脑 DO 内；不再将 `/workspace` 打包到 R2。快照和 DO 元数据保存成功才提交当前保存点。失败时结果明确说明尚未保存，电脑保持运行。快照成功而 Step 尚未提交时，改动已保存，调用仍可能显示“结果未知”；不会重放已开始的命令。

**人断开时、休眠前也保存**：用户在终端或屏幕上做的改动不经过工具调用，所以每条屏幕或终端连接关闭时保存一次；电脑空闲到期、项目自己的空闲 alarm 到期时、容器停止之前也保存一次，覆盖没有调用也没有连接时的改动（比如 agent 留在后台运行的程序写的文件）。容器已经停了就不保存：停掉的容器磁盘已空，去问它反而会启动一台新的。休眠前那次保存失败时不停机（停了改动就没了），电脑保持运行，到期后再试；保存期间有请求排在后面要用电脑（一次调用、一条连接）时也不停机。

**保存失败**：原生快照 API 或 DO 元数据写入失败不算保存成功。调用结果告诉模型改动还在电脑上，等待下一次成功保存；电脑记下从什么时候起有改动没保存（`workspace-unsaved-since`），设置页显示提示。保存成功前电脑不休眠，重启、恢复、清空也要用户确认丢弃这些改动才执行。容器停止后这些未保存改动已不在，记录随之清除。

**只保留原生快照**：快照保存完整可写根文件系统，包括系统安装和浏览器配置，不包含内存、运行中的进程及单独挂载的文件系统。Cloudflare 的有效期为创建或恢复后 30 天；每次保存创建新快照，冷启动恢复当前快照时续期，设置页显示各快照的实际到期时间。历史快照不会因为使用了其他保存点而续期，`pinned` 也不免于到期。没有 R2 长期工作区副本。来源：[Containers snapshots](https://developers.cloudflare.com/containers/guides/snapshots/)。

**恢复**：每次使用电脑前先 `ready()`。冷启动使用当前保存点的有效原生快照，恢复成功后将续期写回 DO，再允许用户命令执行。恢复沿用快照的来源镜像，不将已有环境转换到新部署镜像；新电脑使用当前部署镜像。当前快照已到期时从基础镜像启动空电脑，不回退到其他历史状态；没有到期的快照恢复失败时直接报错，保留句柄供重试，绝不把失败当作过期而清空。新启动明确清除旧工作区标记、桌面和浏览器进程锁，再写本次恢复标记。DO 接上仍运行的容器时保留数据，不重复恢复。新容器在后台启动屏幕，多个对话同时使用时依次完成恢复。

DO 在内存中记住哪一代容器已经恢复（`Workspace.#restoredIn`）。`NativeMachine` 启动新容器或在 DO 重启后接上仍运行的容器时调用 `Workspace.started()`，只清除这个缓存，下一次核对磁盘上的恢复标记；接上原容器不会重复恢复。容器停止通过原生 `monitor()` 或显式 `destroy()` 处理，前一实例延迟到达的停止通知不能影响替代实例。

代次在容器停止、或 `ready()` 找不到恢复标记时变化。恢复过程中代次变了，标记可能写在没有恢复的新容器上：删掉它，本次报错，下次再恢复。命令直接使用 `ctx.container.exec(["bash", "-c", command])`，每次显式传 cwd 和电脑环境，不保留隐式 shell 状态；人使用的 tmux 终端另有会话。

电脑自己记录 30 分钟空闲期限，并在 alarm 中先保存再停止。原生超时在启动及 DO 重启后重新设为 6 小时作为后备，运行中的 `monitor()` 由空闲 alarm 管理结束。活动 Run 租约、正在处理的调用与打开的屏幕／终端阻止休眠；保存失败或保存期间有新调用时一分钟后再检查。

**防止用空目录覆盖好数据**：

- 保存前核对标记：只有恢复过的工作区才允许保存，一个新启动、还没恢复的空工作区永远不会被当成最新状态存下来。
- 容器在保存进行中停止了（电脑的停止计数），这次快照不进入保留列表，报告“lost”；废弃的原生快照由平台到期回收。调用方告诉模型改动没保住，工作区回到上次有效保存点。
- 改动属于哪个容器：`ready()` 返回容器的代次（容器停止、或发现了没恢复过的新容器时加一），调用之后的保存带上它。代次变了，说明做这次调用的容器已经不在，改动随它丢了；即使另一处已经把新容器恢复好、看起来“没有变化”，也报告“lost”，不会当成保存成功。
- 保存时仍然核对容器里的恢复标记，不只信 DO 记住的代次：这一条是“空目录不覆盖好数据”的最后一道检查，和查改动合在同一次请求里，不多花一次往返。

**快照不覆盖，按顺序前进**：

- 每个保存点都是新的原生根快照，不覆盖旧状态。保存排队执行，列表按创建时间排序；不再扫描 `/workspace` 判断归档能否复用，因为系统安装和浏览器状态也必须保存。
- “当前快照”单独记录（`workspace-current`）：每次保存后是新存的那份，恢复快照时改成选中的那份，新容器恢复的就是它。恢复只改这条记录，不挪动列表：以前靠把选中的快照挪到列表最前表示“当前”，保留规则又按列表位置判断，恢复前的状态和下一次保存落在同一小时，就被当成重复删掉了。
- 保留最多 10 份未过期保存点：当前、最新两份、恢复或清空前保留的 `pinned` 状态，再往前每小时最后一份。修剪只移除 DO 中的句柄；原生快照没有 Worker 删除 API，由平台 TTL 回收。列表和恢复接口都排除过期保存点。

**主动清空**：清空工作区只删除 `/workspace` 内容，保留操作前的原生快照，可在它到期前恢复。恢复快照会回滚整个电脑文件系统，包括工作区、系统安装和浏览器数据。

**保存开销**：每次保存只核对当前容器已完成恢复的标记，再调用原生快照 API 并提交 DO 元数据。没有目录遍历、tar/zstd 打包、R2 上传、归档复用或引用计数。原生快照的线上耗时与容量仍需实际测量。

**固定的往返**：工具层仍使用 `ready`、`startProcess`、`waitForExit`、收结果和 `save` 五次电脑 DO 调用。`ready` 在已知恢复过时不重复问容器；结果文件在一次 `exec` 中读取并删除。保存时另外调用原生快照 API。

**软件**：npm 全局安装与 pip 用户安装默认在 `/workspace/.local`；`apt install` 等系统安装也随有效的完整根快照恢复。所有电脑文件遵循相同的 30 天保留期限，常用软件放基础镜像。

- **pip 不带 `--user` 也装进 `/workspace/.local`**（2026-09-29）：以前不带 `--user` 的 `pip install` 装进 `/usr/local`，重启就没了，而 `npm install -g` 会保留，两者不一致。现在系统 Python 自己的 pip 配置（`/usr/pip.conf`，pip 读取所在解释器前缀下的 `pip.conf`；`sandbox/pip.conf`）设了 `user = true`，所以 `pip install` 默认就装进用户目录。没有用环境变量 `PIP_USER`：它对虚拟环境里的 pip 也生效，而 pip 在虚拟环境里拒绝 `--user`（“User site-packages are not visible in this virtualenv”），模型建的 venv 就装不了包。虚拟环境有自己的前缀，读不到 `/usr/pip.conf`，在里面 `pip install` 照常装进环境本身；venv 放在 `/workspace` 里就会保留。镜像原来没有装 `python3-venv`，`python -m venv` 直接失败（缺 ensurepip），工具说明却让模型把 venv 放进工作区，现在补上了。实测：`pip install six==1.16.0` 落在 `/workspace/.local/lib/python3.13/site-packages`，`/workspace/venv/bin/pip install cowsay` 落在 venv 里。
- **用户目录排在系统目录之后**：`/workspace/.local/bin` 以前在 PATH 最前，它跨重启保留，一条被网页诱导执行的命令在那里写一个 `ls`、`git`、`python`，从此每条命令都会先找到它。现在 PATH 和 NODE_PATH 都是镜像自己的目录在前、`/workspace/.local` 在后：装进用户目录的新命令照常能用，但盖不住系统已有的命令和模块（代价：想用 `pip install -U pip`、`npm install -g` 升级镜像里已有的工具时，系统那份仍然优先，要用完整路径或放进项目自己的 `node_modules`、venv）。**仍然存在的风险**：Python 的用户 site-packages（`/workspace/.local/lib/python3.13/site-packages`）排在系统的 site-packages 前面，写进那里的同名包（如 `numpy`）或 `.pth` 文件（每次启动 Python 都会执行）一样能长期留在电脑里；Python 没有像 PATH 那样调整这一顺序的办法，关掉用户目录又会让 `pip install` 装的东西失效。这属于“不可信内容获得指令权限”这一类问题（S1），根本的防线在 agent 一侧，不在镜像。

不采用的方案：把 R2 bucket 直接挂载成 `/workspace`（SDK 支持挂载 bucket）。每次写入直接落到对象存储，天然不丢；但面对 git、`node_modules` 这类大量小文件时很慢，文件系统语义也不完整。以后需要存大文件时，可以另挂一个 `/data`。

### 镜像

自己搭的 Debian 13 trixie slim 镜像（`apps/server/sandbox/Dockerfile`），不继承 SDK 官方运行镜像。SDK 1.0 只复制固定版本的 `sandbox-shim` 文件助手，原生命令直接由 `ctx.container` 执行；入口由 tini 管理常驻进程，不需要旧控制服务器或 FUSE 挂载。预装 Python 3.13、venv、固定版本的数据处理包、Node.js 24、git、curl、jq、ripgrep，以及 TigerVNC、openbox、plank、D-Bus、websockify、中文与 emoji 字体、Google Chrome、Playwright MCP 0.0.82 与 playwright-core 1.63.0；编译工具和 ffmpeg 按需安装。

**入口**：`tini` 作为 PID 1，它启动 `heveta-start`（`sandbox/start.sh`），后者建好 `/dev/shm`（Cloudflare 的容器没有它，Python 的 multiprocessing 等要用；以前由屏幕脚本建，屏幕改成在后台启动后，第一条命令可能早于它）后 `exec` 成 SDK 的服务程序。SDK 的文档只要求服务程序在运行，没有要求它是 PID 1；它只回收自己启动的子进程，而后台启动的程序（桌面的、命令留下的）退出后被过继给 PID 1，以前就一直是僵尸进程，按名字检查仍然“在运行”（C1）。实测：修复前的容器开过屏幕和浏览器后就挂着 `cat`、`bash` 等僵尸，被杀掉的 plank、dbus-daemon 也都成了僵尸；修复后同样的操作之后一个也没有。

**可复现**（2026-09-29）：三个基础镜像（`cloudflare/sandbox:0.12.10`、`node:24-bookworm-slim`，即 Node.js 24.21.0、`debian:trixie-slim`）都写成“标签@摘要”，标签会移动（`node:24` 跟着每个 24.x，trixie-slim 跟着每个 Debian 小版本），摘要不会；更新时用 `docker buildx imagetools inspect` 查标签当前的摘要。pip 装的数据包连同依赖都固定版本（`sandbox/requirements.txt`）。仍然会变的：Debian 的软件包在构建时取发行版当前的归档（带安全更新，大版本不变）；Google Chrome 只能下载当前稳定版（Google 的下载地址和软件源都只提供最新的一版），所以重新构建可能换一个 Chrome 版本。取舍：固定 Chrome 只能改用 Chrome for Testing（能按版本下载，但就是之前换掉的那个带 “Test” 角标的版本，见“浏览器”）或自己存一份安装包；目前接受这一点，构建时把装上的版本打印在构建日志里并存进镜像（`/usr/local/share/heveta/chrome-version`，这次是 154.0.8037.57），出问题时能查到是哪一版。

**为什么这样搭**（2026-09-29）：原来继承 SDK 的 `-python` 官方镜像（Ubuntu 22.04，标准支持 2027 年 4 月结束），同一口径实测解压后 3051 MB、压缩后 1436 MB；空闲时就有约 590 MB 内存被占：官方镜像为代码解释器预热 6 个 Node 和 3 个 Python 进程（约 520 MB），而我们只用 exec，从不用解释器。现在是 1724 MB / 707 MB，空闲时只有服务程序约 54 MB，屏幕开着时全部进程约 247 MB（实例规格 standard-1：0.5 vCPU、4 GiB、8 GB 磁盘，镜像也占这 8 GB）。去掉的：Bun、cloudflared（隧道）、代码解释器、编译工具链（约 170 MB）和 ffmpeg（约 145 MB，agent 需要时现装，随有效根快照恢复，过期或镜像变更时重装）、Playwright `--with-deps` 顺带装的重复字体和推荐包、Python 版 Playwright（140 MB，其中大半是它自带的一份 Node）、只为一个终端图标装的图标主题和 SVG 解码（换成我们自己的 `desktop/terminal.png`）、`dbus-user-session` 带进来的 systemd（显式装 `dbus-x11` 满足会话总线依赖）。剩下的大头是 Chrome（437 MB）和它经 libgbm 硬依赖的 mesa/LLVM（约 195 MB），openbox 的依赖链（imlib2 → ghostscript，约 60 MB）也保留：它是窗口管理器。Debian 把系统 Python 留给自己的包（PEP 668），电脑只归 agent 用，所以 pip 装在旁边：镜像里装进 `/usr/local`，agent 的 `pip install` 装进 `/workspace/.local`（`/usr/pip.conf` 的 `break-system-packages` 和 `user`，见“软件”）。websockify 装在自己的虚拟环境里（`/opt/websockify`，不带依赖）：和系统的包装在一起时它会 import numpy，只为给观看者发来的数据（鼠标键盘、画面请求，每次几个字节）去掩码，另外它的包还带进 redis、requests、jwcrypto（再带进 cryptography），都是我们不用的插件才需要的，不装时它照常运行、用纯 Python 去掩码。实测（Mac 上模拟 x86，空闲时的 RSS）：50.9 MB 降到 32.4 MB；系统 Python 里也不再有这五个包。

部署和本地开发都需要 Docker；在 Apple 芯片的 Mac 上要模拟 x86 构建，第一次约 6 分钟。

### 工具

文件和命令四个，文件进出两个；另有一组浏览器工具，见“浏览器工具”：

| 工具         | 作用                                                                                                                                   | 只读 | 并行 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---- |
| `shell`      | 在沙箱里执行命令：参数有命令、工作目录、超时；返回退出码和输出（过长截断，完整输出写到文件并告诉模型路径）                             | 否   | 否   |
| `read_file`  | 读取文本文件，从某一行开始分页；不是文本（有 NUL 字节）或不存在时说明原因                                                              | 是   | 是   |
| `write_file` | 写入或覆盖一个文件                                                                                                                     | 否   | 否   |
| `edit_file`  | 把文件里的一段原文精确替换成新文本（原文必须唯一），改大文件的一小处时不必整体重写；只改 10 MB 以内的文本文件，更大的用 `shell`        | 否   | 否   |
| `send_file`  | 把电脑里的一个文件发给用户：它是回复里单独的一部分，出现在调用的位置，图片直接显示、其他文件可下载；发出的图片模型也看到               | 是   | 是   |
| `view_image` | 模型看一张不必给用户看的图（如浏览途中的截图）：按文件头核实是图片才复制、交给模型；不是图片就报错，不复制。模型不支持图片输入时不提供 | 是   | 是   |

- “只读”决定中断恢复时的处理：只读的调用重跑，其余的报告“结果未知”（loop 现有规则）。“并行”决定同一步里相邻的调用能否同时执行（[工具执行](tool-execution.md)）；两者不同：带文件名保存的截图可以安全地重跑，却必须在发送它的调用之前完成。
- 文本工具不让 SDK 猜编码：`readFile` 默认按文件名猜 MIME 类型，认成二进制就返回 base64（`.ts` 文件在它看来是 MPEG 视频流），所以文本一律显式按 UTF-8 读。`read_file` 在电脑里先判断文件（`test -f`、`stat`、`grep -I` 看有没有 NUL 字节、`awk` 数行），再只把要看的那一段（按 UTF-8 字符上限的字节数截取）拿出电脑，几十 MB 的日志不进 Worker 的内存。SDK 的 `exec` 把命令直接放进它为会话保留的那个 shell 里执行（不是子 shell），所以我们自己的多行命令都包在 `( … )` 里：判断文件的那段以前遇到“不存在”“是二进制”时 `exit 0`，结束的是整个会话 shell，调用失败成 “shell exited”，变量也会留在会话里（2026-09-29：保存前的检查起初也这样写，本地复现为设置页重启时报 “shell exited”，两处一起改正）。
- 不做 apply_patch：它是 OpenAI 模型专门训练过的补丁格式，要自己解析，也绑定了模型家族；`edit_file` 的精确替换对各家模型都简单可靠。
- `shell` 的超时是单条命令的参数，由模型根据命令决定，有默认值；这和“Run 不设预算”不冲突，它只防止一条命令永远挂住。需要一直跑的程序（例如起一个服务），以后加后台进程的工具。
- 命令的输出在界面上作为工具调用的结果显示（现有的 `ChatToolCalls`），目标显示为命令本身。
- 命令以沙箱里的进程运行（`startProcess`），而不是 `exec`：中止信号不能经 Durable Object 的 RPC 传进沙箱（需要一个尚未公开的兼容开关），所以超时或运行被停止时，由执行器调用 `killProcess` 结束整个进程组。实测：点停止后约 0.3 秒运行结束，容器里的进程已被结束。
- 命令实际跑在 `timeout` 之下（到点连子进程一起杀掉），输出和退出码写进 `/tmp/heveta-calls/<按调用生成的名字>` 下的文件（`sandbox/tools.ts` 的 `runShell`）。Run 的执行一直等到命令结束（命令受自己的超时限制）；执行被实例重启打断时命令继续在电脑里跑，检查点把这次调用留作待答，下一次执行用 `resumeShell` 按调用名去 `/tmp/heveta-calls` 找它：还在跑就接着等，跑完了就收结果；容器在这期间重启过、对应进程已经不在了，就报告结果未知。用户主动停止则直接杀掉这个进程。等待命令结束靠 SDK 的事件流（`waitForExit`）；这条流中途断开（SDK 报“stream ended unexpectedly without exit event”）时命令还在跑，执行器隔一秒重新订阅（每次 `waitForExit` 都开一条新流），命令还在跑就一直等下去，不按断开的次数放弃：以前断三次就报告未知，模型可能把仍在运行的命令再启动一遍；进程不在了又没有退出码，或者连检查都失败，才报告结果未知，从不报告为失败（模型会以为没执行而再跑一遍）。是否超时按容器里记下的开始和结束时间判断，不看收集结果的时刻：命令可能结束很久之后才被收集。启动命令的请求失败时也先这样找一次：电脑可能已经启动了它，只是回包丢了。
- 输出和错误输出各自在电脑里裁到 1 万字节，保留开头和结尾，中间换成“… N bytes omitted …”（`shellProcess`，`modules/sandbox/tools.ts`）：命令可能打印远超 Worker 内存的内容，所以裁剪在容器里做，Worker 只读回裁好的文件（和退出码、起止时间一起，一次 `exec` 读出并删除调用的文件夹；读不出来时这次调用的结果是未知，不报告为失败）；两者合起来不超过结果上限，不再二次裁剪，省略说明原样到达模型。工具说明让模型把大量输出写进文件再读。

### 文件进出：附件放进电脑，产物发给用户

用户打不开电脑里的文件，模型以前只能写 `sandbox:/workspace/…` 这种链接（ChatGPT 代码解释器的习惯），网页显示不了；用户的附件也进不了电脑。现在：

**所有文件都走 R2 的一份不变的副本。** 上传的附件、agent 发出的文件、agent 看过的图，都存进 R2 的附件区：`files` 表一行、对象 `files/<uuid>`、浏览器地址 `/files/<uuid>`。写一次再不改：电脑里的原文件以后被覆盖（截图常用同一个名字）、删除，或电脑休眠、原生快照无法恢复，聊天记录里的文件都还在；模型看过的图以后每次请求原样再发，前缀不变。按文件头识别类型：PNG、JPEG、WebP、GIF、PDF 以文件头为准（声明成这些类型却不是的文件被拒绝），其余按声明的类型存。只有图片在页面里直接显示，其余一律以下载（`attachment; filename*=…`）返回。单个文件上限 100 MB（Worker 请求体的上限）。

**上传。** `POST /upload?name=<文件名>`，请求体就是文件，和 RPC 一样带着会话，流式写进 R2，不经内存（文件太大，不适合放进 RPC 消息；RPC 只收发文字和 ID）。网页用 XMLHttpRequest 发送以显示进度。一条消息最多 10 个附件。

**附件放进电脑。** 发送时，每个附件在同一事务里被认领，分到电脑里这条消息自己的文件夹 `/workspace/uploads/<消息 ID>/<文件名>`：同一条消息里重名时加编号（`data (2).csv`）；名字去掉目录分隔符和控制字符、按字节截到 255。别的消息的文件不会在这个文件夹里，所以路径一定空着，不用去电脑上探测。路径记在文件上，也随消息保存，所以之后每次发给模型的说明都一样。运行一开始就在后台把附件从 R2 流式写进电脑（`placeUploads`，`sandbox/uploads.ts`），同时模型在读消息；它第一次调用电脑工具前会等复制完成，复制失败则这次调用报错、下次再试，运行本身不受影响。复制完即保存工作区。放的是这个对话里所有还没放进电脑的附件，而不只是这条消息的：以前只放本条消息的，某条附件放置失败、或那次运行根本没用电脑，之后就再也不会放，模型却一直被告知文件在电脑上。先查数据库，没有要放的附件就不碰电脑。

每个附件只真正放一次：保存了放好附件的工作区之后才记时间戳（`files.placed_at`），这次运行被恢复、或者同一个 Turn 重新生成时不会再放一遍——agent 很可能已经动过这个文件，再放一遍会把它的改动冲掉。电脑在保存之前重启了，附件没有记时间戳，下次再放。

**模型看到什么。** 用户消息里，每个附件后面跟一句说明：`[Attached: data.csv (900 bytes), copied to your computer at /workspace/uploads/<消息 ID>/data.csv]`（说的是复制到过哪里：之后 agent 可能改过它，用户也可能恢复快照或清空工作区）。图片（`input_image`）和 PDF（`input_file`，OpenAI 直接读文字和页面）另外把内容给模型，一条消息里合计不超过 20 MB（发送时校验）；其他文件只有说明，模型在电脑上用代码去读。

**两个工具。**

- 发给用户（`send_file`）：任意文件，出现在回复里调用的位置：图片直接显示（`MessageImage`，点开看大图），其他文件是文件卡片（类型、名称、大小，点击下载）。它是回复里单独的 `file` 部分（`ToolOutcome.shown`），紧跟在调用之后，不是正文 Markdown 语法。模型只能输出文字和工具调用，所以“发一个文件”要经工具调用（Claude 的 `present_files` 也是如此）；这只是模型一侧的机制：界面上这次调用没有工具行，只有文件，复制副本的一两秒里显示回复的加载状态；失败时模型读到原因后自己说明。发出的图片模型也看到（`ToolOutcome.images`，同一份副本）：模型交付的多是截图和图表，交付前它并没有看过，看到了才能发现白屏、报错页、标签重叠、中文成方块并重做，用户追问图里的内容也能直接回答。工具说明和系统指令都告诉它：文件自己会出现在回复里，不要再写链接或路径（实测不这样说，它会发完文件再附一串 `sandbox:` 链接）。
- 模型自己看图（`view_image`，同 Codex 的 `view_image`、Claude Code 用 Read 看图）：浏览途中的截图、下载的图片不进上下文，需要时再看。网页在这次调用展开后的详情里显示这张图。模型不支持图片输入时不提供。

两个工具都以 SDK 的原始字节流（`readFile(path, { encoding: "none" })`）读出文件，经 `FixedLengthStream` 写进 R2，不经内存、不做 base64，也不会把 GBK 编码的 CSV 这类文件当文本转码。这要求 SDK 的 RPC 传输（见“执行器”）。

**发给模型的格式。** 工具结果的 `ToolResult.images` 记下模型读过的图；发给模型的 `function_call_output.output` 是一个列表：先是结果文字（`input_text`），再是每张图（`input_image`，`detail: "auto"`）。上下文和 checkpoint 里只存引用 `heveta-file:<fileId>`，发请求前才按 ID 从 R2 读出，换成 `data:…;base64,…`（图片放进 `image_url`，PDF 放进 `file_data`）。

- **缓存**：本次运行里拼出的结果，和以后从对话记录重建的，由同一个函数（`toolResultOutput`、`attachmentContent`）生成，引用的又是不变的副本，所以每次请求的前缀逐字节相同。图片和 PDF 按字节预算（20 MB）从旧到新计入：超出预算时去掉的是最新那张（换成一句说明），前面的前缀不变；副本读不到时同样换成一句说明。旧图不主动移出：Anthropic 的 computer-use 示例在开启提示缓存后也关掉了“只留最近几张截图”，因为缓存读取只要一成价格，为删图打破缓存不划算。
- **归属与清理**：工具存下的文件在保存运行输出的同一个事务里被回复引用（`claimFiles` 加 `message_files`，与发送消息引用附件相同）；运行中途崩溃、没被引用的，一天后由清理删掉。删除对话时，只被它引用的文件（附件、回复发出的文件、模型看过的图）立即标记删除，一小时内清理掉。

### 执行器

- `SandboxExecutor` 实现 `ToolExecutor`，通过 `cloudflare:workers` 的 `exports.Computer.getByName("user-<userId>")` 获取用户电脑，使用 Workers RPC 调用项目的原生电脑类。命令、文件流、屏幕与浏览器端口由 `NativeMachine` 适配，没有旧 SDK 会话或 HTTP／RPC 传输模式切换。
- 现在的 `ToolSet` 只有一个执行器。改为一个 Run 的工具来自多个执行器，按工具名分发：本地工具走本地执行器，沙箱工具走沙箱执行器。这是 `tools.ts` 里的一个小改动，loop 不变。

### 电脑的画面与浏览器（已实现）

- **屏幕**：镜像里有虚拟显示器（TigerVNC 的 Xtigervnc，1280×800，它本身就是 VNC 服务器，只在容器内 127.0.0.1:5900 监听、不设密码，关掉了它默认开启的黑名单：同一来源 5 次未完成认证的连接就会被暂时拒绝，而所有观看者都经 websockify 从 127.0.0.1 进来，启动脚本检查端口的连接也算一次，屏幕很快就会拒绝所有人；只有 websockify 连它，websockify 只接受带屏幕令牌的连接，入口由 Worker 按会话把守）、一个简单的桌面，以及把 VNC 转成 WebSocket 的 websockify（容器内 6080 端口）。`sandbox/screen.sh`（镜像里的 `heveta-screen`）按需启动它们，可以重复执行，等端口可用后才返回。电脑就绪（新容器恢复工作区之后）时在后台启动一次，打开画面、启动浏览器时会再确认一次（见下）。屏幕起不来只记日志，不影响命令。
- **桌面**：openbox 管窗口，用我们自己的配置（`sandbox/desktop/rc.xml`，Ubuntu 默认配置改了主题、标题字体和工作区数）和主题（`themerc`，扁平深色，与 Dock 同色），只有一个工作区（滚轮切不走窗口）；底部居中一个 Dock（plank，2026-09-29 参照 Manus 等产品的电脑画面，替换了原来的 tint2 通栏任务栏）：只有图标，浏览器和终端（lxterminal，打开在 /workspace），正在运行的程序下面有一个点，窗口停在它上方；背景是壁纸（`sandbox/desktop/wallpaper.jpg`，1280×800，深色渐变加淡淡的 H 标志），空桌面不会被误认成黑屏。桌面上的浏览器就是 Google Chrome（设为系统默认浏览器 `x-www-browser`），也就是 agent 用的那一个（见下面“浏览器”），以 root 运行所以带 `--no-sandbox`，隔离靠容器。配置在 `sandbox/desktop/`。
- **Dock 是怎么搭起来的**（`sandbox/desktop/dock/`，`screen.sh`）：
  - plank 要知道哪些程序在运行，靠 bamf 经 D-Bus 会话总线告诉它；容器里原本没有会话总线，`screen.sh` 启动一个固定地址的（`DBUS_SESSION_BUS_ADDRESS`，镜像里设好），bamf 由总线按需启动。
  - bamf 按启动项的 `StartupWMClass` 把窗口对到启动项：Chrome 的窗口类名本来带着配置目录，所以 `heveta-browser` 用 `--class=heveta-browser` 固定它；终端是 `Lxterminal`。bamf 查的是它自己的启动项索引（`bamf-2.index`），由它的软件包在 `/usr/share/applications` 变化时经 dpkg 触发器重建，所以镜像复制完启动项后触发一次；没有这一步时，窗口被对到 Chrome 和 lxterminal 自带的启动项上，每个程序显示两个图标。
  - 设置（总是显示、图标 40、主题、两个启动项）写成 dconf 的系统默认值并锁定：构建时没有会话写不进去，而有了会话总线以后 plank 会把自己的默认主题写回用户库、盖掉系统默认值。
  - 圆角半透明的底板（`dock.theme`，与窗口边框同样的深灰）需要窗口合成器，用 xcompmgr（不带任何效果）。实测（2026-09-29，Mac 上模拟 x86，同一个滚动页面，一个按 noVNC 方式连续请求画面的 VNC 客户端）：开和不开合成器，每秒都是约 44 次更新、19 屏画面，没有差别。
  - 终端的图标是我们自己的（`desktop/terminal.png`，深色圆角加 `>_`）：lxterminal 自带的是一个显示器，而按名字找终端图标要装约 25 MB 的图标主题和 SVG 解码。
- **屏幕令牌**（2026-09-29，S5）：容器里的 Chrome 打开的网页可以连 `ws://localhost:6080`，以前 websockify 接谁都转给无密码的 VNC，网页就能看到并操作桌面（实测：授予本地网络权限后，网页收到了 `RFB 003.008`）。现在 websockify 只接受带令牌的连接（它的 `TokenFile` 插件：URL 里的 `token` 在令牌文件里才转给 5900 端口，文件每次连接都重读，换令牌不用重启它）。令牌是电脑 DO 生成的 32 字节随机数，每个容器一个（容器启动、停止时丢弃，DO 重启后下一次启动屏幕时换新的），启动屏幕时以环境变量传给 `heveta-screen`（不出现在命令行里），写进只有 root 能读的 `/tmp/heveta-screen/tokens`；DO 转发观看者的连接时把它加在连向容器的 URL 上。网页拿不到它：它不在网页能读到的任何地方。实测：不带令牌或令牌不对时 websockify 拒绝（“Token not present”“Token … not found”），带对的令牌握手成功；换令牌后旧的立即失效，已有的连接不断。
- **看画面**：浏览器连 `/screen?user=…` 的 WebSocket，带着会话 cookie。Worker 确认是本站页面打开、Session 有效且属于该账号（准入同事件通道，见[多端同步](sync.md)），把升级请求交给用户的电脑（`Computer` Durable Object，`sandbox/connections.ts`、`computer-object.ts`），只带握手头和它自己设的两个头（连接类型、Session），设备发来的其他头一律不转，所以设备伪造不了。连接当场接受并按 Session 登记，然后才唤醒电脑、确认屏幕在运行、连到容器的 6080 端口，期间设备发来的消息先存着，连上后先发出去；之后把两端的消息原样转发，直到一端关闭。连向容器的屏幕连接带上屏幕令牌（见上）。电脑冷启动可能要几分钟，设备这期间放弃（页面隐藏、面板关闭、退出登录）就关掉自己这端，这里随之结束；以前先等电脑就绪再接受，没人接收的连接会一直留着，电脑无法休眠。设备请求的子协议在这里按第一个商定，只把这一个转给容器。Session 结束（退出登录、过期）时它的连接关闭，还在等电脑的也一样；关闭失败时会话记录保留，由每小时的清理再关一次（同事件通道）。转发放在电脑自己的 Durable Object 里：SDK 本来就在这里代理容器的 WebSocket，再经用户的 `UserHub` 转一次既多绕一段路，又让 hub 在连接期间不能休眠。VNC 只在容器内监听，这条路由是唯一入口。网页端用 noVNC 显示，默认只看，可切换为”操作”接管鼠标键盘。
- **为什么是 Xtigervnc 而不是 Xvfb + x11vnc**：起初用的是 agent 沙箱里最常见的组合 Xvfb + x11vnc（Anthropic computer use 示例、E2B 桌面都是），没有比较过。x11vnc 是连到显示器上的另一个程序，只能反复拷贝屏幕、和上一份比对来找变化；Xtigervnc 自己画画面，画在哪里就记下哪里变了，直接发出去。同一镜像、同一滚动页面、同样的客户端请求方式（ZRLE，收到一次更新就请求下一次）实测（2026-09-25，Mac 上模拟 x86，只看相对值）：x11vnc 每秒 30–32 次更新、合 13–14 屏画面，最长停顿 410–500 毫秒，显示加 VNC 的 CPU 45–52%；Xtigervnc 每秒 56–57 次、19 屏，最长停顿 52–54 毫秒，CPU 64–65%（多传了四成画面，折算到每屏略省），静止时 0%（x11vnc 2–4%）。其余不变：websockify、noVNC、Worker 转发看到的还是同一个 VNC 端口。
- **为什么是 WebSocket 而不是 WebRTC**：看 agent 操作网页，画面大部分时间是静止的，VNC 只传变化的区域就够用；WebRTC 需要 UDP，而容器不接受外部直接连入的 UDP，还得另接 TURN/SFU 并在容器里做视频编码，复杂得多。以后需要流畅视频时，再单独换画面通道。
- **浏览器**：Google Chrome（正式版，构建镜像时的稳定版）预装在镜像里（Debian 13 的 Chromium 不是 snap，但用户要的是正式版），`DISPLAY=:99`。起初用的是 Playwright 自带的 Chrome for Testing，图标带 “Test” 角标、会提示登录 Chromium，2026-09-29 换成正式版；两者都支持 H.264 等视频解码（实测），区别主要在于这是用户熟悉的那个 Chrome。电脑上只有一个常驻的浏览器（`heveta-browser`，Dock 上的浏览器也是它）：启动一次，固定的配置目录，只在本机开放 DevTools 端口 9222；再次运行只是在它里面打开链接。agent 在 Node 里用 Playwright 的 `connectOverCDP` 连上去（镜像里没有 Python 版 Playwright，见上），在已有的页面或新标签里工作，脚本结束只是断开，浏览器、标签、登录状态都留着，用户在屏幕上一直看到同一个窗口。起初让 agent 每次自己 `launch` 一个有界面的浏览器，结果每条命令结束浏览器就关了，下一步又重新打开：先让它打开浏览器、再让它访问网页，它会先关掉再开一个。启动参数沿用 Playwright 驱动浏览器时的那几项：`--no-first-run` 等关掉首次运行的页面，`--disable-infobars` 关掉“仅供自动化测试”的提示条；正式版 Chrome 还会在每个页面上方提示不支持 `--no-sandbox`，用 ChromeDriver 也会带的 `--test-type` 关掉。浏览器配置在 `/root` 下，电脑重启后清空，登录状态不跨重启保留。
- **本地开发**：wrangler 只转发镜像里 `EXPOSE` 声明过的端口，所以 Dockerfile 声明了 6080 和 8931（浏览器工具）。
- **屏幕进程死了能恢复**（2026-09-29，C1）：以前 `screen.sh` 按名字（`pgrep -x`）和文件（D-Bus 的套接字）判断各部分是否在运行，而死掉的进程在 PID 1 下成了僵尸、名字还在，被杀掉的 dbus-daemon 留下套接字，所以再运行 `heveta-screen` 什么也不做，屏幕一直坏着。现在一是有 init 回收进程（见“入口”），二是按“是否应答”判断：显示器看 `xdpyinfo` 能否连上，会话总线看 D-Bus 的 `Ping` 有没有回答（2 秒超时），WebSocket 看 6080 端口能否连上；窗口管理器、合成器、Dock 只能看进程，用 `pgrep -r R,S,D` 排除僵尸。显示器不应答时，连同它的客户端（openbox、xcompmgr、plank）一起换掉；总线不应答时删掉残留的套接字重开，Dock 和 bamf 随之重启（它们连着旧总线）。几个调用方（DO、观看者的连接、浏览器）可能同时运行它，所以脚本用 `flock` 一次只跑一个，启动的程序不继承这把锁。实测（本地容器，逐个 `kill -9` Xtigervnc、openbox、plank、xcompmgr、websockify、dbus-daemon 后重新运行 `heveta-screen`）：每次都恢复，显示器和总线应答、五个程序在运行、带令牌的 WebSocket 握手成功、没有僵尸，每次约 0.4–0.5 秒；截图里 Dock 两个图标和运行中的点都在。什么都在运行时再运行一次约 0.25 秒。
- **屏幕在后台启动**（2026-09-29，P5）：以前新容器恢复工作区后，`ready()` 要等整个屏幕启动完才返回，只用 shell 的运行也在第一次调用前多等这一段。现在 `ready()` 恢复完就返回，屏幕在 DO 里后台启动（同一时刻只跑一个，其他调用方等它）；真正需要屏幕的地方各自确认：观看者的连接在转发前等它，浏览器由 `heveta-browser` 在启动 Chrome 前运行 `heveta-screen`（浏览器工具的 `heveta-browser-mcp`、agent 脚本里的 `heveta-browser` 都经过它）。仍然可能碰到的：新电脑刚醒的一两秒里，agent 直接运行别的图形程序（不经 `heveta-browser`）会找不到显示器；本地测得屏幕冷启动约 1.4 秒。

### 浏览器工具：Playwright MCP（已实现）

模型可以切换，所以浏览器也做成普通的函数工具，而不是某家模型专有的 computer use（按像素坐标点屏幕）。页面以无障碍树快照给模型，元素带 ref，操作按 ref 指定元素，和 Playwright MCP、Claude for Chrome、Manus 的做法同类。工具由微软的 Playwright MCP 提供，它驱动的就是屏幕上那个浏览器，用户看着 agent 操作。

- **结构**：镜像里装 `@playwright/mcp`（`npm install -g`，不下载自己的浏览器）。`heveta-browser-mcp`（`sandbox/browser-mcp.sh`）先确保浏览器在运行，再启动 Playwright MCP：`--cdp-endpoint` 连到浏览器的 9222 端口，以 Streamable HTTP 监听容器的 8931 端口（所有网卡，和屏幕的 websockify 一样：Worker 的 `containerFetch` 从容器外面连进来，只监听 127.0.0.1 时线上连不上，本地开发里电脑容器和代理容器共用网络才碰巧能通；它仍然只接受发往 `localhost:8931` 的请求，`--allowed-hosts` 比较的 Host 带端口）；可以重复执行。Worker 里用官方 MCP SDK 的 `Client` 和 `StreamableHTTPClientTransport`，把它的 `fetch` 换成沙箱的 `containerFetch`（`modules/sandbox/browser.ts`）。请求以普通数据（URL、headers、JSON 文本）经 RPC 传入，由沙箱自己构造请求：直接传 `Request` 对象时，它的 body 以流跨过 RPC，沙箱每次都报“ReadableStream received over RPC disconnected prematurely”。响应（包括服务端的事件流）流式传回。
- **会话**：一次执行一个 MCP 会话，第一次调用浏览器工具时建立（先让电脑就绪、启动服务）。新会话的当前标签页是浏览器的第一个，不一定是 agent 刚才用的那个：建立时先列出标签页，有不止一个时在这个会话的第一个结果前告诉模型，并列出它们，让它需要时用 `browser_tabs` 切回去。浏览器工具一律不并行（`concurrent: false`）：同一个页面按模型给出的顺序操作，等待之后的快照看到等到的内容，带文件名保存的截图在发送它之前完成。服务端每 3 秒经事件流 ping 一次，客户端应答；这期间电脑一直有请求，不会休眠。Run 结束时执行器的 `close()` 结束会话：发 `DELETE`，服务端随之关闭事件流（请求不带 signal，客户端自己关不掉这条流）；之后不再有 ping。调用抛错（页面自身的错误是结果，不是抛错）时丢弃会话，下一次调用重新建立；只有服务端不认识这个会话（404，电脑重启过）时当场再调一次，其它失败（连接断开、等待超时）可能已经生效，不重复：只读的调用报告失败并说明原因，会改变什么的调用（点击、输入、导航等）报告结果未知，让模型先看页面再决定。连不上浏览器时报告“浏览器无法访问，什么也没做”。客户端等一次调用最多 120 秒（SDK 默认 60 秒），长于 Playwright MCP 自己最长的等待（导航，默认 60 秒），慢页面由服务端以结果回答，而不是在这边被切断。运行中的标签页跨工具会话与 Run 保留；电脑实际重启后重新启动浏览器，有效根快照可保留配置和登录文件，不恢复进程或保证所有登录仍有效。
- **提供的工具**（15 个）：`browser_navigate`、`browser_navigate_back`、`browser_tabs`、`browser_snapshot`、`browser_find`、`browser_take_screenshot`、`browser_wait_for`、`browser_click`、`browser_hover`、`browser_type`、`browser_fill_form`、`browser_select_option`、`browser_press_key`、`browser_handle_dialog`、`browser_file_upload`。不提供：关闭浏览器（它是屏幕上常驻的那一个）、执行任意代码、网络/控制台/窗口尺寸等开发者工具。说明和参数格式用 Playwright MCP 自己的：`pnpm gen:browser-tools` 启动 devDependency 里同版本的 CLI 列出工具，生成 `browser-tools.json`；它的参数有可选项，所以不用 strict 模式。升级时改 `package.json` 和 Dockerfile 里的版本再重新生成，测试检查三者一致。
- **结果**：文字原样给模型，超过 2 万字符截断，并提示用 `browser_find` 找其余部分。不带文件名的截图是给模型看的图，存成副本（`ToolOutcome.images`，同 `view_image`）；模型不支持图片输入时不提供截图工具。带文件名保存的文件落在工作区：相对路径以服务进程的工作目录 `/workspace` 为准（客户端不声明 MCP roots），保存后保存工作区；保存没成功时，结果照常给模型，并加上和其它电脑工具一样的说明（`savedOutcome`）。点击、输入这类操作不返回页面快照，而是写进 `/tmp/playwright-mcp` 的文件并给出路径；要看操作后的页面，模型调用 `browser_snapshot`（系统指令这样告诉它）。结果里的路径是绝对路径（`--file-paths absolute`，`read_file` 可以直接读），不附带每一步的 Playwright 代码（`--codegen none`，省 token）。
- **和 shell 的分工**：打开、点击、填写用浏览器工具；很多页面的脚本化工作仍可以在 `shell` 里用 Node 版 Playwright 的 `connectOverCDP` 连同一个浏览器。只读一个页面时 `web_fetch` 更快。
- **界面**：工具行显示中文名和目标（元素、网址、查找的文字、按键、文件名）；其余参数是设置（截图的 scale、标签页的 action）或 ref，不显示。调用不自动切换到电脑页面：由用户选择当前页面。
- **实测**（本地，2026-09-25）：打开 example.com → `browser_snapshot` 拿到 ref → 点击链接 → 返回上一页 → 在页面中查找文字 → 截图保存并用 `send_file` 发给用户，都正常；每次运行建一个会话，结束时 `DELETE`。改用普通数据传请求之前，有一次运行里“返回上一页”和“查看页面”都超时（30 秒），之后没有再出现。

### 侧边栏页面：电脑、终端、文件

侧边栏分别提供“电脑”（`/computer`）、“终端”（`/computer/terminal`）和“文件”（`/computer/files`），三者共用同一台电脑。和对话、邮箱共用同一个应用布局，各自占据完整主区域；手机上进入相同页面，顶部提供导航抽屉入口。

电脑、终端、文件和邮箱共用 `AppPageHeader`：标题在左，连接状态、观看／控制、重连、上传、刷新或邮箱信息位于同一行的最右侧；目录路径和邮箱文件夹也在顶栏。下面直接是完整内容区域，电脑与终端没有第二行工具栏，也没有内容内边距。

文件页用现有 Astryx 组件预览：图片通过可缩放的 `Lightbox`，UTF-8 文本通过全屏 `Dialog` 原样展示。支持常见图片、文本和源代码扩展名，以及 README、LICENSE、Makefile、Dockerfile；HTML 与 SVG 按文本展示。文本最多 1 MiB、图片最多 20 MiB，读取时也按实际字节限量；不支持或过大的文件只保留下载，二进制内容与无法解码的图片提示下载查看。预览按需加载，关闭或离开时释放图片 URL，取消读取，过期登录的响应不展示。

- **电脑**：上面的 noVNC 桌面画面。
- **终端**：xterm.js 通过 `/terminal?user=…&cols=…&rows=…` 的 WebSocket 连接原生 PTY，PTY 附着到独立 tmux 会话 `terminal`（从 `/workspace` 开始）。输入和输出是二进制字节，窗口大小是 `{cols, rows}` JSON，后端接好 PTY 后发送 `ready`。离开页面只中止附着客户端，tmux shell 和历史继续存在，回来重绘当前屏幕；shell 退出后下一次连接创建新的 shell。没有 `SandboxAddon` 或 SDK 终端协议，页面沿用自己的重连与可见性管理。
- **文件**：浏览 `/workspace`（它是长期持久目录；其余目录用终端）。`ComputerService.ListComputerFiles` 列一层目录（文件夹在前、按名字排，隐藏文件不列）；下载由页面 `fetch` `/computer-file?path=…`（带会话 cookie 和指明账号的 `X-Heveta-User` 请求头，普通链接带不了这个头，这也挡住了跨站请求），从电脑流式读出、以下载返回；上传是 `POST /computer-file?path=<文件夹>&name=…`，同样的 cookie 和请求头，请求体就是文件（和附件上传一样用 XMLHttpRequest 显示进度）。必须带数字的 `Content-Length`（0 字节的文件可以没有请求体），写入时用 `FixedLengthStream` 卡住请求体正好这么长，先流式写成那个文件夹里一个隐藏的临时文件，完整了才改成它的名字（重名加编号不覆盖），中途断开或失败就删掉临时文件，不留半截文件；写完保存工作区，保存不成功但文件还在（等下一次保存）时上传照常成功，容器重启丢了文件时上传失败。三个路由都只接受 `/workspace` 里的路径；路径不存在时回答不存在（先问电脑，SDK 自己的错误码经过 RPC 会丢），文件页面据此回到 `/workspace`。

打开着的屏幕或终端连接会让电脑一直不休眠（电脑的空闲 alarm 检查其连接集合），所以页面不在屏幕上（切到别的标签、最小化、手机切到别的应用）时网页断开它们，回来再连；终端的 shell 和输出在电脑里一直在。

三个页面的选择只由 URL 决定，不再保存本机标签偏好；agent 用电脑时不替用户切换页面。屏幕由 noVNC 在剩余宽度和高度内等比缩放，终端填满剩余区域，文件列表独立滚动。只挂载当前页面，离开电脑或终端页面就释放其连接；这只结束查看，不停止后台 Run。浏览目录和上传由登录布局中的 `WorkspaceFilesProvider` 持有，切换页面时保留，退出登录或换账号时取消上传并重置目录；文件查询只在文件视图挂载时执行。对话控制器同样位于登录布局，草稿与执行状态不随页面切换丢失。工具调用的 `surface` 由服务端按工具定义记录，网页据此展示工具行，不另抄一份工具名单。文件、占用和快照在电脑说工作区变了时重读（事件 `computer`，每次存下快照或恢复快照后由电脑的 Durable Object 发出；休眠前那次保存不发，否则开着文件列表的设备会立刻重读、把刚要休眠的电脑叫醒）。读文件和占用会唤醒电脑，所以页面不在屏幕上时（事件或事件通道重连后）它们只标为过期，页面回到屏幕上再读（`meta.wakesComputer`，`lib/refresh-queries.ts`）；快照只读 Durable Object 的存储，照常重读。

### 设置里的电脑管理

设置里“电脑”一节（`ComputerService` 的管理接口，`modules/sandbox/manage.ts`）：

- **占用空间**：`du -sb /workspace`，打开这一节会唤醒电脑。
- **重启电脑**：先保存最新的改动（终端里做的、后台程序写的，只在连接断开或休眠前才保存），再原生 `ctx.container.destroy()`，正在运行的程序结束；下次使用时从当前快照恢复。
- **快照**：列出保留的快照（最多 10 份，见上面的保留规则），标出当前那份。恢复一份快照：先保存当前状态并标为保留，把“当前”指向选中的那份，然后重启电脑；电脑重新启动后，使用尚未到期的原生根快照，恢复的就是刚选的这份。不是恢复进正在跑的那个容器：终端、浏览器这些正用着工作区的程序会继续指着旧文件（它们不知道文件换了），而且向正在跑的容器恢复会和现有内容合并，而不是整个换掉。恢复前的状态作为保留的快照留在列表里，可在到期前再恢复回去。选中的快照在列表读出后被清理了，回答不存在，页面提示并重读列表。
- **清空工作区**：先保存当前状态并标为保留，再删除 `/workspace` 下的全部内容并保存。

这三项都先保存：以前假定“工作区每次改动后都已保存”，这只对工具调用成立，终端里的改动、后台程序写的文件会被直接丢掉。保存不成功时（见“保存失败”）默认拒绝（`ERROR_REASON_WORKSPACE_UNSAVED`），页面再问一次，用户确认丢弃这些改动才执行（请求带 `discard_unsaved`）。

有回复正在使用电脑时这三项也拒绝执行（`ERROR_REASON_COMPUTER_BUSY`），免得从 agent 手下把文件抽走。“正在使用”是租约：运行第一次用电脑时在 `ready(runId)` 里登记，运行结束（完成、失败、停止）时执行器的 `close(runEnded)` 释放；因暂时故障退避、等下一次执行继续的运行仍然持有。执行丢了、没来得及释放的租约，检查时按数据库里 Run 是否还在进行过滤掉。

### 选择电脑

- 每个用户一台电脑，`ComputerService` 的方法都指这台，不带电脑 ID。以后要接入用户自己的电脑时，再和对应的执行器一起设计选择方式。
- 网页端：侧边栏的“电脑”“终端”“文件”分别进入三个页面；没有电脑选择器。

### 安全

- 每个沙箱是独立的虚拟机，文件系统、进程、网络互相隔离，CPU、内存、磁盘有配额。（[Security](https://developers.cloudflare.com/sandbox/concepts/security/)）
- 沙箱里不放任何密钥。以后要让沙箱访问需要凭据的服务，用官方建议的出站代理：由 Worker 拦截沙箱的出站请求并注入凭据，沙箱本身看不到凭据。
- 沙箱可以访问互联网；没有入站连接（除非显式暴露端口，第一期不做）。
- **容器里的网页连不到容器本身**（2026-09-29）：Chrome 里的网页能向 `localhost` 发请求，而容器在本机开着几个不设防的端口，最危险的是 SDK 的服务程序（3000 端口）：它对任何本机来源执行命令，一个 `Content-Type: text/plain` 的 POST（浏览器不做预检的“简单请求”）就够，响应还带 `Access-Control-Allow-Origin: *`。实测（修复前的镜像）：Chrome 154 默认对公网页面访问本机先弹出“本地网络访问”提示，请求挂起；一旦允许（用户点了，或 agent 被页面引导去点），`https://example.com` 页面里的一次 `fetch` 就在容器里以 root 创建了文件，也连上了屏幕的 VNC。SDK 的服务程序我们改不了，所以在浏览器这一侧挡：镜像给 Chrome 装了一条管理策略（`sandbox/desktop/browser-policy.json` → `/etc/opt/chrome/policies/managed/`）`LocalNetworkAccessBlockedForUrls: ["*"]`，任何网站都不能向本机和本地网络发请求，也就不再有可以被点“允许”的提示。容器自己提供的页面（agent 起的开发服务器，`http://localhost:…`）访问本机不受影响：那不是从更公开的网络进更私有的网络。实测（修复后）：公网页面对 3000、8931、6080 的请求和 WebSocket 立即失败，站点的本地网络权限是 `denied`；`localhost:8000` 的页面照常访问 `127.0.0.1:8000`。只有经 DevTools 协议显式授权才绕得过（那需要已经控制了浏览器）。屏幕令牌（见上）是 6080 上的第二道门。
- **浏览器工具的端口（8931）**：网页调不动它。MCP 的请求必须是 `Content-Type: application/json`（`text/plain` 的简单请求被拒，415），JSON 请求要先过 CORS 预检，而它对预检回 400、不带任何 CORS 头；旧的 `/sse` 端点虽然接受简单的 GET，但响应没有 CORS 头，网页读不到里面的会话 ID；`--allowed-hosts` 还挡住了 DNS 重绑定。所以这个端口不改。

### 可观测性

（2026-09-29，O1）线上电脑 DO 的调用以前分不出是哪个方法（p99 160 秒，被取消的中位数 76 秒）。现在两侧都记结构化日志，每个调用一行：

- **电脑 DO**（`[Computer] Call`）：排队操作记录 `method`、`outcome`、`totalMs`、`queueMs` 和 `startMs`、`checkMs`、`restoreMs`、`restoredSnapshot`、`snapshotMs`、`snapshotId`、`stopMs`。`[Computer] Filesystem snapshot` 记录原生根快照 ID 和大小。屏幕启动及屏幕／终端连接记录耗时、结果、关闭码和原因；不再产生 R2 备份日志。
- **Worker 一侧**（`[Sandbox] Call`）：工具对电脑的每次电脑调用（`ready`、`startProcess`、`waitForExit`、`exec`、`readFile`、`writeFile`、`save` 等，以及浏览器的 `startBrowser`、`connectBrowser` 和每次浏览器工具调用）记 `method`、`outcome`、`ms`、`runId`、`callId`。返回流的调用只计到流开始。`waitForExit` 的时长就是命令跑了多久。

一次 `shell` 调用约 5 行 Worker 日志加 2 行 DO 日志，不记内容和字节。

### 费用

按实际运行时间计费（CPU、内存、磁盘分别计，以 10ms 为单位），空闲休眠后不计。实例规格从 `lite`（1/16 vCPU、256 MiB）到 `standard-4`（4 vCPU、12 GiB）；从 `standard-1`（1/2 vCPU、4 GiB、8 GB 磁盘）开始：安装 Python、Node 依赖时 1 GiB 内存容易不够。按实际使用调整。（[Containers 定价](https://developers.cloudflare.com/containers/pricing/)）

## 已定

- 一个用户一台电脑（ID `user-<userId>`）。
- 电脑文件系统只通过原生快照保存，连续 30 天未使用后清空；每次可能改动文件的调用后、提交前保存，休眠前再保存。未恢复或保存中重启的容器不算保存成功；重要成果通过 `send_file` 发到对话里。
- 工具：`shell`、`read_file`、`write_file`、`edit_file`、`send_file`、`view_image`，由 `SandboxExecutor` 执行；一个 Run 的工具由 `composeToolSets` 按工具名分给本地执行器和沙箱执行器。
- 规格 `standard-1`，休眠时间 30 分钟。沙箱在模型第一次调用这些工具时才会被唤醒。
- 浏览器与画面：Google Chrome 预装，画面经 VNC over WebSocket 显示（见“电脑的画面与浏览器”）。
- 浏览器工具：Playwright MCP 在电脑里驱动屏幕上的浏览器，Worker 经 `containerFetch` 以 MCP 客户端调用，一个 Run 一个会话（见“浏览器工具”）。

## 部署

- `cloudflare.config.ts` 定义 `heveta-computer-native`，使用 `schedulingPolicy: "durable-object"` 和 `images.computer`（`sandbox/Dockerfile`）；`worker.exports.Computer` 关联它，启动选择 `standard-1`。沿用 Computer 类名、DO 命名空间与实例 ID。SDK 与镜像 shim 固定为 1.0.0，Worker 保留 `nodejs_compat`。应用不再导出 `DirectoryBackupGateway`，也不再绑定 `BACKUP_BUCKET`。
- 根快照通过 `snapshotContainer()` 创建，冷启动用 `containerSnapshot` 恢复；句柄存在 Computer DO，不需要 R2。附件仍使用独立的 `BUCKET`（`heveta-files`）。
- 本地开发和部署需要 Docker 构建镜像。`cf dev` 启动开发服务，`cf workers types` 生成 `.cloudflare/types/index.d.ts`，`cf deploy --dry-run` 只构建和检查，`cf deploy` 才发布。`wrangler.config.ts` 仅管理应用 Worker 的构建器、资源目录和类型生成。

### 从 R2 双层备份迁移

旧 DO 列表只保存 R2 保存点 ID，原生快照句柄仍在旧桶的 JSON 中。不能跳过迁移直接删除旧桶，否则已有电脑无法恢复。临时迁移 Worker 为 `apps/server/scripts/computer-snapshot-migration.ts`，配置为同目录的 `computer-snapshot-migration.jsonc`；它只读取旧桶，向原 Computer DO 写入句柄，不删除归档，也不对外提供电脑管理接口。

1. 部署临时 Worker，设置随机 `MIGRATION_TOKEN`。操作请求必须携带 `Authorization: Bearer <token>`，路径只接受 POST。
2. 暂停新回复，在旧应用仍运行时请求 `/prepare`：确认没有活动 Run，保存各电脑当前数据并停止容器，保证当前保存点具有原生句柄。此步可重试；有活动 Run、保存失败或电脑忙时中止。
3. 部署新的应用，再请求 `/migrate`：按原 DO 的保存点 ID 读取 `backups/<id>.json`，保留当前 ID、时间及 pinned 状态，把原生句柄和到期时间写入 DO。没有原生句柄的历史 R2-only 保存点不再提供恢复；当前保存点缺失原生句柄时中止，绝不清空。重复调用可安全重试。
4. 核对所有账号迁移完成，再检查电脑文件、终端及屏幕恢复。完成前保留旧桶；核对后可删除 `heveta-workspaces` 和临时 Worker。附件桶 `heveta-files` 不参与此次清理。

迁移前的 DO 会拒绝使用电脑而不是启动空环境。已有运行容器不会因缺少迁移信息被销毁，迁移 RPC 仍能执行。迁移 Worker 的构建命令为 `pnpm --filter @heveta/server exec wrangler deploy --config scripts/computer-snapshot-migration.jsonc --dry-run`；去掉 `--dry-run` 才发布它。设置密钥与请求由部署操作者完成，Token 不写入仓库或日志。

## 以后

- 画面里的操作权交接：agent 运行时用户接管、交还。
- 后台进程与端口：起服务、长时间任务。
- 工具按需加载：工具多了以后按工具包延迟加载（OpenAI 的 namespace + `defer_loading` + 客户端 `tool_search`，其他模型用一个通用的加载工具）。已设计，未实现。
- 更多执行环境（另一个 Durable Object、用户自己的电脑），见 [工具执行](tool-execution.md)。

### 0.x 到 1.0 的独立升级

官方迁移说明：[替换 Sandbox 类](https://developers.cloudflare.com/sandbox/sdk/migrate/replace-the-sandbox-class/)、[规划切换](https://developers.cloudflare.com/sandbox/sdk/migrate/plan-the-move/)。调度策略切换是单向的，不能通过回滚 0.x Worker 恢复旧容器启动能力；发布使用先上传镜像和 Worker 版本、确认无活动 Run、保存并停止旧电脑、转换目录归档、最后激活版本的顺序。

一次性 `scripts/sandbox-upgrade-worker.ts` 在独立 Worker 中访问旧电脑 RPC、转换已有 SquashFS 归档、写入新格式备份记录，保留快照 ID、时间顺序与当前选择。生产代码只读取新记录，没有旧 SDK、旧归档解码或旧聊天正文兼容分支。测试 Worker 与其容器应用、测试快照及临时认证 token 在发布后清理。
