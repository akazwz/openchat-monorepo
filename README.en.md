# Heveta

[中文](README.md)

Heveta is a general AI agent: you can simply chat with it, or hand it a task. It searches and reads the web, looks up past conversations, and keeps long-term memory about the user as needed, calling tools as many times as a run requires before it answers. Runs execute on the server, so closing the browser does not interrupt them.

Heveta grew out of OpenChat, an AI chatbot from the previous era (React, Cloudflare Workers, and Connect RPC, on the web, mobile, and desktop). It has been rewritten as the general agent it is now; the old code is kept at the [`openchat-final`](../../tree/openchat-final) tag.

## What it does today

- **Models and thinking**: the server configures the model list (currently GPT-5.6 Luna, GPT-5.6 Terra, and DeepSeek Flash). Each model has its own reasoning efforts, selectable per message; the UI shows the reasoning summaries the model returns (DeepSeek gives its reasoning itself).
- **Input**: text and attachments of any type, up to 10 per message and 100 MB each. Images are read directly by the model, and PDFs by a model that reads PDFs (20 MB total per message); other files, and PDFs the model cannot read, land in `/workspace/uploads` on the cloud computer or `uploads/` in the Mac workspace, according to the selected execution environment.
- **Tools**:

  | Area          | Tools                                                                      | Notes                                                                                                                                                             |
  | ------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Web           | `web_search`, `web_fetch`                                                  | Search the web and read pages as text; TinyFish first, Jina when it fails or runs out of quota                                                                    |
  | Memory        | `memory_search`, `memory_add`, `memory_update`, `memory_delete`            | Long-term facts about the user, plain text in PostgreSQL; the newest 100 come with every request, the rest are found by search                                    |
  | Conversations | `conversation_search`, `conversation_read`                                 | Search and read past conversations, including parts of the current one that have left the context window                                                          |
  | Computer      | `shell`, `read_file`, `write_file`, `edit_file`, `send_file`, `view_image` | Run commands, read and write files, and send or view files on the selected cloud computer or Mac; cloud tools are preinstalled, while the Mac uses local software |
  | Browser       | `browser_navigate` and 14 more                                             | Operate the browser on the computer's screen (Playwright MCP), which the user can watch                                                                           |
  | Email         | `email_list`, `email_read`, `email_save_attachments`, `email_send`         | The agent's own mailbox: list and read received and sent mail, put attachments on the computer, send and reply (with files from the computer attached)            |

- **Runs**: the agent loop has no step, token, or time budget; it ends when the model replies without calling a tool. The context is a sliding window: at 80% of the working window, old tool results are cleared and the oldest content slides out in whole units down to 20%. Runs can be stopped and regenerated at any time.
- **Replies**: Markdown, with math typeset by KaTeX.
- **A computer**: each user has a Linux computer of their own (the "cloud computer"), shared by all their conversations; "Computer" in the side nav shows its screen live and lets the user take over, and the agent drives a headed browser on it with Playwright. Files in `/workspace` are saved after every change and come back as they were after the computer sleeps or restarts; software installed with `pip install --user` or `npm install -g` lives there too. After 30 days without using the computer, its files, installed software and browser data are cleared. Download important results or send them to a conversation; conversations, memories and conversation files have separate retention rules.
- **A local Mac**: bind the native client to an account, enable access, and select the Mac for commands and files. Agent desktop tools capture on demand; human remote desktop uses WebRTC. Local files are independent of cloud retention. See [macOS integration](docs/macos.md) for permissions, verification, and release status.
- **Electron desktop client**: a macOS client that hosts the complete web app, with a window band in the interface’s own color. The Mac can be handed to the agent as a device of the account (commands, files, screenshots, pointer and keyboard), and its screen watched or controlled from another device. See [Electron client](apps/electron/README.md).
- **A mailbox**: each user's agent has an email address of its own (on the `agent.heveta.com` subdomain, given by the app). Anyone can write to it; mail is kept but starts nothing, and the agent reads it with its email tools in a conversation. It can send to 5 recipients in any 24 hours. "Mail" in the side nav shows every email received and sent. See [mailbox](docs/email.md).
- **Multi-device sync**: with the same account open on several devices or tabs, new messages, streamed text, stops, renames, and deletions show up on each of them at once; after a lost connection they catch up on their own.
- **Accounts**: email sign-in codes, by invitation (`pnpm invite <email>` adds an address; existing accounts need none); the first sign-in creates the account; no passwords are stored. A profile photo can be set, visible to its owner alone.
- **Languages**: the interface is English by default, with Simplified Chinese; it follows the browser or a choice in Settings. The site has both too.

## Architecture

```text
Browser (React SPA)
  ├─ Connect RPC (heveta.v1, request/response: reads and commands) ──► Cloudflare Worker
  └─ WebSocket /events ◄── every change (protobuf UserEvent) ── UserHub

Cloudflare Worker
  ├─ PostgreSQL (Hyperdrive): threads, runs, progress, checkpoints, memory
  ├─ R2: attachments
  └─► RunActor (Durable Object, one per run)
        ├─ agent loop ──► model: OpenAI SDK through the AI binding and AI Gateway
        │            └──► tool executor (ToolExecutor): local; sandbox ──► the user's computer (Sandbox container, native filesystem snapshots retained for 30 days)
        └─ after each commit ──► UserHub (Durable Object, one per user)
```

- **Domain**: `Thread → Turn → Run → Step`. Each user input is a Turn; a Turn can have several Run attempts (regeneration); every model call and tool call is a Step. See the [domain model](docs/agent-model.md).
- **Sync**: RPCs are request/response only (reads and commands); every change, once committed, is pushed by a per-user Durable Object (`UserHub`) over a WebSocket to all the user's devices, each frame a protobuf-encoded `UserEvent`. See [multi-device sync](docs/sync.md) (Chinese).
- **Execution**: a Durable Object drives each run in the background and commits every step and checkpoint to PostgreSQL. After an interruption the run resumes from its checkpoint; a model request with an unknown outcome is never replayed automatically. See the [runtime](docs/agent-runtime.md).
- **Tool execution is separate from the loop**: the loop only knows the `ToolExecutor` interface, not where or how a tool runs. The Worker local executor, cloud sandbox executor, and native Mac executor share this interface, with no change to the loop. See [tool execution](docs/tool-execution.md).
- **Design decisions** (context, memory, web search) are in [agent design](docs/agent-design.md).

## Roadmap

1. **More execution environments**: more places behind the same interface, such as another Durable Object or more native platforms; with suspending and resuming long-running calls, and human approval for actions with side effects.
2. **Also**: editing a sent message; semantic search (embeddings) over memory and conversations; GitHub and Google sign-in; handing control of the screen back and forth between the user and the agent; background processes and ports.

## Stack

| Area              | Implementation                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| Frontend          | React, React Router, Astryx (official Neutral theme), Lucide, KaTeX                                               |
| Frontend state    | TanStack Query, Zustand, React Hook Form, Zod                                                                     |
| API               | Connect RPC, Protocol Buffers (`heveta.v1`)                                                                       |
| Backend           | Cloudflare Workers, Durable Objects (SQLite)                                                                      |
| Models            | OpenAI SDK (Responses API), Cloudflare AI binding and AI Gateway                                                  |
| Data              | PostgreSQL, Drizzle ORM, Hyperdrive; attachments in R2; native computer snapshots, cleared after 30 inactive days |
| Computer          | Cloudflare Sandbox SDK (Containers)                                                                               |
| Sign-in and email | Invitation-only email codes, HttpOnly cookie sessions, Cloudflare Email Service (send and receive)                |
| Tooling           | pnpm workspace, mise, Buf, Oxlint, Oxfmt, Vite, Wrangler                                                          |

## Development

`mise.toml` pins Node 26.9.0, pnpm 12.5.1, and Buf 1.73.0; dependency versions come from `pnpm-lock.yaml`. Start Docker (the local database and the computer's container need it), then run from the repository root:

```sh
mise install
mise run install
mise run gen
mise run dev
```

`mise run dev` is the same as `pnpm dev`: it builds the Worker's static assets, starts local PostgreSQL and applies migrations, then starts Vite and the Worker. The browser runs at `http://localhost:5173`, the Worker at `http://localhost:8787`, and PostgreSQL at `127.0.0.1:55437`, with data kept in a Docker volume.

The frontend needs no `.env`. The AI binding uses remote resources; the web tools need `TINYFISH_API_KEY` and `JINA_API_KEY` in `apps/server/.env`. Other settings are in the [server docs](apps/server/README.md).

| Command                     | Purpose                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev:web`              | Start Vite only                                                                                                                                               |
| `mise run dev:electron`     | Run the Electron macOS desktop client against the production service                                                                                          |
| `mise run install:electron` | Build and install the Electron development app in `~/Applications`                                                                                            |
| `pnpm dev:server`           | Prepare assets and the database, then start the Worker                                                                                                        |
| `pnpm db:setup`             | Start the local database and apply migrations                                                                                                                 |
| `pnpm db:down`              | Stop the local database, keeping its data                                                                                                                     |
| `pnpm gen`                  | Generate frontend and backend TypeScript from the protocol                                                                                                    |
| `mise run gen:env`          | Generate Worker binding types                                                                                                                                 |
| `pnpm format`               | Format code, config, and docs with Oxfmt (run it when `pnpm check` reports unformatted files)                                                                 |
| `mise run check`            | Lint, protocol checks, the migration check (fails when the schema changed without a migration), type checks, unit tests, and the PostgreSQL integration tests |
| `mise run test:integration` | Integration tests alone: starts a disposable PostgreSQL container (needs Docker)                                                                              |
| `pnpm build`                | Build the frontend and a Worker dry-run bundle                                                                                                                |

## Deployment

Configure the Hyperdrive, R2, Email Sending, rate-limit, container, and Durable Object bindings in `apps/server/cloudflare.config.ts`, and set `TINYFISH_API_KEY`, `JINA_API_KEY` for production; native filesystem snapshots resume the computer's environment, and computer data is cleared after 30 inactive days with no permanent R2 workspace backup; migrate existing checkpoints as documented before completing the rollout (see [agent sandbox](docs/sandbox.md)). The AI Gateway ID, model list, and prompts are in `apps/server/src/config.ts`. Hyperdrive must have query caching disabled (`wrangler hyperdrive update <id> --caching-disabled`), because run state depends on reading the latest data. One Worker serves both the static frontend and the API. The application Worker uses `cf` for development, dry-run builds, and deployment; `wrangler.config.ts` configures only the bundler and type generation. `pnpm build` runs a dry-run without publishing.

Set `DATABASE_URL` for the target PostgreSQL, migrate, then deploy:

```sh
mise run db:migrate
pnpm run deploy
```

The public site deploys on its own: `pnpm deploy:site` (`apps/site/cloudflare.config.ts`, Worker `heveta-site`, static files, nothing to configure). React Router generates the static pages, the Wrangler builder emits standard Build Output, and `cf deploy --prebuilt` publishes it. Development and prerendering retain their existing commands.

Deploying does not migrate the database. Migrations live in `apps/server/drizzle/migrations/`: a baseline plus incremental migrations generated by drizzle-kit. The baseline appends three deferrable circular foreign keys that Drizzle cannot declare; they must be maintained by hand when the related columns change (see the [server docs](apps/server/README.md)).

## Layout

```text
apps/web/          Web app, app.heveta.com (UI conventions in apps/web/AGENTS.md)
apps/macos/        Native macOS client: Swift, system WebView, and local execution capabilities
apps/electron/     Electron macOS desktop client: hosts the web app and connects this Mac as a device
apps/server/       Worker, run execution, tools, and database
apps/site/         Public site, heveta.com: static pages prerendered at build time, every entry leads to the app
packages/brand/    Name, mark, and the Heveta theme, shared by the app and the site
proto/heveta/v1/   Ten services: Auth, Model, Thread, Turn, Run, File, Memory, Computer, Mail, Device
docs/              Domain model, runtime, agent design, tool execution
scripts/           Repository task entry points
```

The [web docs](apps/web/README.md) cover components and state ownership; the [server docs](apps/server/README.md) cover modules, configuration, and the API.

The macOS client requires full Xcode 27 and Swift 6.4, and runs on macOS 14 or later. From the repository root, use `mise run dev:macos`, `mise run build:macos`, or `mise run release:macos`. See the [client docs](apps/macos/README.md) and [device architecture and implementation status](docs/macos.md).
