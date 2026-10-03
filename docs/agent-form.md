# 产品形态调研：常驻 agent（2026-10-02）

用户提出：Grok Bot、OpenAI dots 这一批新产品是一种新的形态，Heveta 应该也改成这种形态。本文记录调研结果、Heveta 与它的差距，以及改造方案。方案未实施，待用户确认方向。

## 调研对象

| 产品                       | 发布                 | 要点                                                                                                                                                                          |
| -------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI dots                | 2026-09-29（DevDay） | ChatGPT 里的常驻 agent。每个 dot 有自己的云电脑和浏览器，在两次对话之间继续工作；有名字、handle（`@你-名字`）和可定制的形象；可在 ChatGPT、Slack、Teams、电话里找到同一个 dot |
| Grok Bot（xAI）            | 2026-08-11 beta      | “AI 队友”，有自己的云电脑，登录你已有的应用并通过真实界面操作；像给同事发消息一样用它；看你做一遍就把步骤存成 routine 以后自己跑；多个 Bot 可以并行、互相发消息、在群聊里分工 |
| ChatGPT Work               | 2026-07-09           | 给结果而不是给提示词：交回做好的表格、幻灯片、文档或一个可分享的网站；可按周期或条件触发；桌面应用把 Chat、Work、Codex 合成一个                                               |
| Claude（Cowork 并入 Chat） | 2026-09-16           | 去掉模式切换：同一个 Claude 既回答一句话的问题，也接手几小时的任务，由系统决定需要多大自主度；任务在关掉应用后继续，在手机上审批                                              |
| Grok Build                 | 2026 上半年          | 终端里的编码 agent（CLI），和上面几个不是一类，Heveta 不对标它                                                                                                                |

dots 的界面是实际渲染官方文档页面看到的（截图在调研时的临时目录，未入库）；Grok Bot 的页面需要登录，只有文字资料。

## 这类产品的共同形态

1. **agent 是一个“谁”，不是一个输入框。** 有名字、形象，一条一直延续的对话。dots 的主界面像即时通讯：顶部是形象和名字，时间居中（“Today 9:41 AM”），双方都是气泡，输入框只有一行（“Send message”，加号、麦克风、发送）。
2. **一直在线。** 对话之间它继续干活；可以定时、按条件触发，也可以自己决定什么时候暂停、什么时候醒来继续；有进展、有问题、需要你决定时主动来找你。
3. **有自己的电脑，看得见、接得过来。** dots：“Alfred's computer”卡片里是浏览器画面，底部一条“Alfred has control · Take over”，接管后“Return control”。
4. **活动视图代替对话列表。** dots 的资料页里 Activity 分 In progress / Scheduled / Completed，点开一项看进度、文件、结果和等你输入的请求。后台任务是独立的线程，主对话照常聊。
5. **权限与审批是产品的一部分。** dots 的每类操作四选一：直接做 / 你在指令里明说过才做 / 做之前问 / 交给你做；敏感操作（改密码）永远留给人；网站登录是对话里的一张请求卡，凭据在私密表单里填，不进对话，也可以“接管去登录”。
6. **记忆可见、可延续**，跨对话、跨渠道。
7. **连接**：应用和插件、消息渠道、你自己的电脑（dots：“Its computer and yours”，一次只能连一台）。
8. **交付的是成品**（文档、表格、网站），不是一段回复。

## Heveta 已有的和缺的

| 能力                       | Heveta 现状                                      | 差距                                                       |
| -------------------------- | ------------------------------------------------ | ---------------------------------------------------------- |
| 自己的云电脑，可看、可接管 | 有（电脑 / 终端 / 文件三个页面，观看与操作切换） | 入口是并列的页面，不是“它的电脑”；没有“谁在操作”的明确表达 |
| 你自己的电脑               | 有（Electron / Swift 客户端，把 Mac 接成设备）   | 基本对齐                                                   |
| 后台运行，多端同步         | 有（Run 在服务端，关掉页面不中断）               | 对齐                                                       |
| 记忆                       | 有（设置里可看可删）                             | 对齐                                                       |
| 自己的邮箱                 | 有（dots 发布时反而没有）                        | 领先                                                       |
| agent 的身份               | 没有。界面是“产品 + 对话列表”                    | 没有名字、形象；每次从“新对话”开始                         |
| 一条延续的对话             | 没有。多个互不相干的对话                         | 形态上最大的差别                                           |
| 定时 / 常驻 / 主动         | 没有。只在用户发消息时运行                       | 需要调度、自我唤醒、主动发消息                             |
| 活动视图                   | 只有侧栏里对话行上的转圈                         | 没有“进行中 / 已安排 / 已完成”                             |
| 审批与规则                 | 没有（审查遗留项 S1：高风险工具无确认）          | 常驻之前必须先有                                           |
| 主动找到用户               | 没有（Telegram 渠道只有规划）                    | 至少要有一个站外渠道                                       |
| 连接第三方应用             | 没有                                             | 这类产品靠它扩展；Heveta 目前靠浏览器和电脑                |

## 改造方案

原则：先改形态，再加能力；每一步都能单独上线，不做兼容层。

### 第一步：形态（以前端为主）

- **主页就是和 agent 的对话。** 打开就是那条延续的对话，不再是“新对话”空白页。agent 有名字（默认 Heveta，可改）和形象（现有的 H 标志；不做 dots 那种可换装的卡通形象）。
- **任务是它派生出来的事，不是并列的对话。** 侧栏从“最近对话”改成“活动”：进行中 / 已完成（第二步后加“已安排”）。一件事跑起来就出现在“进行中”，点开看它的步骤、文件和结果。现有的 Thread → Turn → Run 模型不变：主对话是一个特殊的 Thread，其余 Thread 是任务。
- **电脑改成“它的电脑”。** 标题带上名字，底部明确“Heveta 正在操作 · 接管”与“交还”，替换现在的“只看 / 操作”分段开关。
- **输入框收成一行。** 模型、运行位置这些设置收进“+”菜单或 agent 的资料页，输入框只留加号和发送，和这类产品一致。

### 第二步：审批（服务端 + 前端）

对应遗留项 S1。按 dots 的做法：操作分级，对外有后果的（发邮件、在已登录的网站上提交、在用户的 Mac 上执行）默认先问；审批是对话里的一张卡片，Run 挂起等答复。没有这一步，不做第三步。

### 第三步：常驻

- 定时与周期任务（“已安排”），Durable Object alarm 驱动，到点创建 Run。
- agent 可以给自己安排下一次唤醒。
- 主动消息：完成、遇到问题、需要决定时发到主对话，并通过邮箱（已有）通知用户；Telegram 渠道按原规划接入。

### 之后

连接第三方应用、成品交付（文档 / 表格 / 网页）、多个 agent。都是独立的大项，等前三步站稳再排。

## 需要用户定的事

1. **是否把主页改成一条延续的对话。** 这是形态的核心，也改变现有用户的使用习惯（现在的多个对话会变成“任务”）。
2. **agent 叫什么、要不要让用户改名。** 建议默认叫 Heveta，可改。
3. **顺序。** 建议按上面的一、二、三做；也可以先做三（常驻）里的定时任务，但没有审批就让它自己跑，风险在 S1 里已经写明。

## 资料来源

- OpenAI dots：<https://learn.chatgpt.com/docs/dots>、<https://www.datacamp.com/blog/openai-dots>、<https://www.vellum.ai/blog/official-openai-dots-breakdown>、<https://betanews.com/article/openai-dots-agents-chatgpt/>、<https://www.engadget.com/2272230/dots-are-openais-new-personal-agents-and-soon-youll-be-able-to-control-several-of-them/>、<https://flaviocopes.com/openai-dots/>
- Grok Bot：<https://www.unite.ai/xai-launches-grok-bot-always-on-ai-teammates-with-their-own-cloud-computers/>、<https://www.reworked.co/collaboration-productivity/xai-launches-grok-bot-ai-agents-in-beta/>、<https://felloai.com/grok-bot-vs-claude-cowork/>
- Grok Build：<https://en.wikipedia.org/wiki/Grok_Build>
- ChatGPT Work：<https://www.leadwithai.co/article/chatgpt-work-is-here-openais-answer-to-claude-cowork>、<https://bigaiagent.tech/ai-agent-work-platforms-2026/>
- Claude 合并：<https://www.explainx.ai/blog/claude-cowork-chat-merge-docs-slides-design-september-2026>
