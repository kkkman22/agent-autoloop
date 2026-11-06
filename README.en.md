# Agent Autoloop

**Let your command-line agents pick up work and follow it through in the background — staying quiet when they can handle it, and sending you a card only when a decision is yours to make.**

[中文](README.md) | **English**

[Get started](#get-started) · [Recipes](#ready-to-use-recipes) · [Plugins](#plugin-ecosystem-swap-any-of-the-four-sides) · [Kernel](#four-kernel-mechanisms) · [Docs](#documentation)

![Architecture](docs/architecture.en.svg)

## What problem does it solve?

Most of us use command-line agents like Claude Code or Codex by babysitting a terminal: you type a prompt, watch it run, and answer its questions. Close the window or walk away, and the work stops.

**Agent Autoloop** turns your command-line agents into a background loop. At the center is a deterministic **kernel** with zero runtime dependencies. Around it, event sources, agents, notification channels, and even CI/CD delivery pipelines are all swappable **plugins**.

- **One machine, one install command.** Runs on your Mac or Linux machine. No cloud server or inbound ports required.
- **Connect a new agent in one line.** No SDK, no agent source code to fork. Any CLI tool that takes a prompt and prints a final reply can plug in.
- **No web dashboard.** Cards reach you on Feishu, DingTalk, WeCom, Slack, Discord, or desktop notifications when you are needed. Everything else is one command away.

## Get started

Works on macOS and Linux. You need Node 24, Git, curl, and at least one command-line agent already signed in; no GitHub account required. You can also hand the [installation guide](INSTALL.md) to your agent and let it install everything for you.

```bash
curl -fsSL https://raw.githubusercontent.com/KKKKhazix/agent-autoloop/main/install.sh | sh
```

Then run a real loop with your own agent — ask, exit while it waits, make the call, resume:

```bash
agent-autoloop try
```

> CLI output and default notification strings are currently in Chinese.

Here is the actual output from Codex in a non-interactive terminal:

```text
事件发出去了，Agent 开始干活……

Agent 结束了这一轮，问了你一个问题。它现在不占进程、不花 Token。

【等你决定】#1 试跑：选一个颜色
这是一次试跑，选哪个都行。
  1. 蓝色
  2. 绿色
回答：agent-autoloop answer 1 <序号>
答完运行 agent-autoloop status，能看到它接着把活干完。
```

In an interactive terminal, just type the option number. In a non-interactive terminal, run `agent-autoloop answer 1 2` to pick green. Then `agent-autoloop status` shows that the agent resumed its conversation and finished, along with rounds, tokens, and cost for today and the past seven days ([how they are counted](skills/agent-autoloop/SKILL.md#看情况回答)).

## How a piece of work flows

The numbers match the diagram above:

1. **An event comes in.** A 9:00 AM schedule, a new GitHub issue, or a production alert becomes a standard event sent to the kernel.
2. **Dispatched by your rules.** Your rules decide which agent handles it and in which folder. New events for the same subject while it is queued merge into one round.
3. **Work one round and exit.** The agent puts its result in its final message, and the process exits.
4. **Asks only when needed.** For sensitive actions like deleting data, restarting a service, spending money, or messaging people, the kernel sends you a card through Feishu or a desktop notification. While you take your time, no agent process runs and no tokens are spent.
5. **One tap resumes it.** Your answer picks up the original conversation and finishes the job.

Anything the agent can handle alone takes the auto-loop at the top of the diagram: finish outright, or schedule a follow-up check (say, in 30 minutes) without bothering you.

## Day-to-day usage

### Write your rules (`rules.json`)

No glue code needed. Open `~/.agent-autoloop/rules.json` and, under `rules`, declare **what happened, who handles it, and where they work**. Set `to` to a name already under `agents`. For example, write a brief every morning at 9:

```json
{
  "name": "Morning brief",
  "when": { "cron": "0 9 * * *" },
  "to": "codex",
  "cwd": "~/notes",
  "prompt": "Summarize yesterday's notes and commits into today's brief."
}
```

External events work the same way once the source is connected. To hand new GitHub issues to Codex, first register `github` under `sources` ([guide](skills/agent-autoloop/SKILL.md#接一个事件插件)):

```json
{
  "name": "Handle issues",
  "when": { "source": "github", "types": ["issues.opened"] },
  "to": "codex",
  "cwd": "~/code/app",
  "skill": "handle-issue",
  "parallel": 3
}
```

Changes take effect within seconds of saving. Run `agent-autoloop check` to validate. If you make a mistake, the hub keeps running the previous valid rules and sends you a card pointing out the error. Deleting or renaming a rule cancels queued runs that were not picked up yet and closes its unfinished cards, with one notice for each; a run already claimed finishes. Answering those old cards is refused until you resolve them.

### How agents talk back to the hub

The hub asks only one thing of an agent: **put your result in your final message**. When the job is done, a one-line conclusion is enough. To ask you something, the agent appends an `agent-autoloop` block:

````text
Order checked. We have enough stock in the warehouse.

```agent-autoloop
{
  "ask": [{
    "title": "How should we ship it?",
    "text": "Both options can go out today.",
    "options": ["Courier", "Pickup"],
    "key": "shipping"
  }]
}
```
````

Besides `ask`, receipts can send notifications (`notice`), resolve open cards (`resolve`), schedule follow-up checks (`later`), and emit new events (`events`). If the JSON is invalid, the hub has the agent rewrite just that final message in the same session, without repeating completed work. If rewriting also fails, it keeps the original conclusion and tells you the receipt was not applied.

## Ready-to-use recipes

Each recipe includes rules, a task Skill, and setup instructions (written in Chinese).

| Task | Included workflow |
|---|---|
| [Morning brief](examples/recipes/morning-brief/README.md) | Summarize local notes and Git commits at 8 AM by default; write `briefs/YYYY-MM-DD.md` |
| [GitHub issues](examples/recipes/github-issues/README.md) | Poll every five minutes, edit code locally, and notify you to review; no commits, pushes, or issue replies |
| [Production alerts](examples/recipes/ops-alerts/README.md) | Receive an error, investigate local code, ask before restarting, and continue after your answer |
| [User feedback](examples/recipes/feedback/README.md) | Re-read current feedback, fix, deliver and verify, then prepare a reply; ask you in Feishu and resume after your answer |
| [Website watch](examples/recipes/website-watch/README.md) | Check status and expected content every five minutes; wake the agent on a new incident, keep ongoing failures quiet, and update the card on recovery |
| [Feishu weekly and business brief](examples/recipes/feishu-brief/README.md) | Read selected reports and tables with your permissions at 6 PM Sunday; summarize locally and send only a short summary to Feishu |
| [Jira updates to DingTalk](examples/recipes/jira-watch/README.md) | Poll your local jira MCP on a cron with your own JQL, notify a DingTalk group and mention the creator; scripts only, no model runs |
| [PR delivery](skills/agent-autoloop/SKILL.md#交付流水线) | Add `deliver` to a PR to review it, wait for CI, merge, wait for deployment, and verify the live version |

**To enable one:** open its instructions, put the task Skill in your agent's skills directory, merge the sample rules into `~/.agent-autoloop/rules.json`, replace worker names and paths, then run `agent-autoloop check`.

Feedback, website watch, and Feishu briefs default to Asia/Shanghai and send only to the owner's private Feishu chat. Sample data is fictional; scripts and receipts have been verified only with local HTTP and a fake Feishu CLI, not run end to end on a live account.

More: [Claude-to-Codex browser handoff](examples/recipes/browser-handoff/README.md), [weekly code cleanup](examples/skills/weekly-sweep/SKILL.md), [ship a PR](examples/skills/ship-pr/SKILL.md).

## Plugin ecosystem: swap any of the four sides

Built-in plugins ship with the program and are enabled through configuration. Use `agent-autoloop add <git URL>` for third-party plugins.

| Side | Built in | Setup |
|---|---|---|
| **Events**: how work is found | [GitHub Webhook](plugins/github/source.ts), [HTTP API](docs/protocol.md#来源把世界变成事件), [cron rules](skills/agent-autoloop/SKILL.md#改规则), [issue polling script](examples/watch-github-issues.sh) | [Guide](skills/agent-autoloop/SKILL.md#接一个事件插件) |
| **Agents**: who does the work | [Claude Code](plugins/claude/agent.ts), [Codex](plugins/codex/agent.ts), [ACP](plugins/acp/agent.ts), [generic command](plugins/command/agent.ts) | [Guide](skills/agent-autoloop/SKILL.md#接一个-agent) |
| **Channels**: how cards reach you | [Desktop notifications](plugins/desktop/channel.ts) (on by default), [Feishu](plugins/feishu/channel.ts), [DingTalk / WeCom / Slack / Discord](plugins/webhook/templates.ts) | [Guide](skills/agent-autoloop/SKILL.md#接一个通道) |
| **Delivery**: CI/CD as a plugin | [`delivery`](plugins/delivery/delivery.ts) | [Guide](skills/agent-autoloop/SKILL.md#交付流水线) |

**What has been tested:** Claude Code, Codex, and ACP (with the official Codex ACP adapter) have run multi-turn Q&A and session resumption across processes. Feishu has run real delivery, button callbacks, and card updates. The four webhook templates have only been checked against local mock servers. These text channels answer through a link, so `hub.publicUrl` must be reachable from your phone or computer. A channel that takes button answers must be registered under `channels` in `rules.json` and list its answerers in `answerers`; a missing or empty list means it can deliver notifications but nobody can answer through it, and only an explicit `["*"]` lets anyone with a name answer. An unregistered channel gets no cards.

**Other CLI agents connect in one line.** Set `use: "command"` and pass a command array; `{prompt}` is a single argument, never evaluated as shell code. These commands come from each tool's official docs, and we have not run each of them yet:

| Agent | Command |
|---|---|
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cli-help.md#dsh-headless) | `dsh --profile headless {prompt}` |
| [pi](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md) | `pi --print {prompt}` |
| [OpenClaw](https://docs.openclaw.ai/cli/agent) | `openclaw agent exec {prompt}` |
| [Hermes](https://hermes-agent.nousresearch.com/docs/user-guide/cli) | `hermes chat -q {prompt}` |
| [Cursor](https://cursor.com/docs/cli/reference/parameters) | `agent -p --trust {prompt}` |
| [WorkBuddy / CodeBuddy](https://www.codebuddy.ai/docs/cli/headless) | `codebuddy -p {prompt}` |

**Delivery pipeline.** Add the `deliver` label to a GitHub PR and it follows through to release: **review → wait for CI → merge → wait for deploy → verify the live version**. Settings are read only from `main`, and PR code is never checked out or run on the worker machine. Queueing, concurrency, and retries come from the kernel. A PR that changes the CI workflows, `scripts/`, `tests/`, `package.json`, `package-lock.json`, or `ops/delivery.json` is not merged on its own: someone marks it `deliver-attended` to say they looked. Ship judges a release with main's settings from before the merge. Review is advice, not a security gate.

**Write your own.** Start from the runnable [agent](examples/plugins/hello-agent/agent.ts), [channel](examples/plugins/hello-channel/channel.ts), and [event](examples/plugins/hello-source/source.ts) templates and the [plugin guide](docs/plugins.md). For web tasks, read [browser access](docs/plugins.md#浏览器接入) first. The CLI and [MCP](skills/agent-autoloop/SKILL.md#mcp-与密钥撤销) (read-only by default) can also inspect and answer cards.

## Four kernel mechanisms

The kernel is about 1,650 lines with zero runtime dependencies. It reads no clock, uses no randomness, and makes no outbound requests; plugins connect in, and credentials stay with the plugins that use them. Identical inputs always give identical results. It brings four proven systems patterns to command-line agents:

- **Zero-cost wait**: The process exits while waiting for your call, and the waiting state lives in SQLite, so the agent does not stay alive. If you reply three days later, no agent process runs and no tokens are spent in the meantime — only the lightweight hub waits in the background; your answer resumes the original conversation.
- **Event sourcing**: All state is derived from an append-only fact log, committed in the same SQLite transaction as its indexes before the hub replies. Confirmed facts survive `SIGKILL` (whole-machine power loss is not separately tested), every run can be traced with a single command, and format changes rebuild from the log without migration scripts.
- **Code / data split**: Like parameterized SQL. Issue titles, bodies, and other external text are written only to a local data file, never into the prompt, which carries only character-checked types, IDs, and links; `rules.json` alone decides which agent runs, in which folder, and with what access. Events carrying `cwd`, `agent`, or `access` fields are rejected outright.
- **Hop circuit breaker**: Like packet TTL in networking. Events returned by an agent can dispatch more agents, and the hop count keeps growing — across human questions and scheduled follow-ups too — and an agent cannot reset it. Past 8 hops, the kernel records the event, stops dispatching, and sends you a notice card.

### Check it yourself

Run these from `~/.agent-autoloop/app`:

| What it checks | Command |
|---|---|
| The full story of any round | `agent-autoloop why 1` |
| 200,000 simulated steps of network loss, dropped packets, crashes, and duplicate requests, reproducible from one seed | `node sim/random.ts 24301 200000` |
| 1,000 process kills with no acknowledged record lost | `node sim/crash.ts 1000 12648430` |
| The benchmarks below | `npm run benchmark` |

```text
第 1 轮 · 演示
11-03 20:47:25  规则版本 #1
11-03 20:47:25  触发事件：来源 local · 类型 demo.start · 对象 example
11-03 20:47:25  local 领取（演示程序）
11-03 20:47:25  结束：演示完成
```

### Benchmarks

Apple M5 Pro, 24 GB, Node 24.21.0. Each write is a separate request, acknowledged only after its transaction is durable. The pass marks in `npm run benchmark` are set for this machine, so another machine may report a miss.

| Metric | Measured |
|---|---:|
| Cold start | 88.78 ms |
| Idle memory | 59.94 MB RSS |
| 1,000 concurrent waiting polls | 170.49 MB RSS |
| Durable writes | 2,394 events/s |
| Dispatch p99 | 1.82 ms |
| Startup at 1.1 million facts | 99.8 ms |
| Kernel lines (with comments and blanks) | 1,651 |
| Runtime dependencies | 0 |

As history grows, the status summary slows down and the log and indexes keep using disk. The first start after a format change rebuilds from the log, which took 43.1 seconds for 1.1 million facts. [Full numbers and method](docs/protocol.md#历史增长实测) (in Chinese).

## Usage and provider terms

The hub invokes command-line tools you have already installed and signed into on your machine; it never reads or exports their credentials. Model usage is billed to your own account under each provider's terms.

For automated workloads, providers generally recommend using API keys rather than personal subscription quotas (which are designed around interactive personal use — see [Anthropic](https://code.claude.com/docs/en/legal-and-compliance) and [OpenAI](https://learn.chatgpt.com/docs/auth)). Use API keys if you are running services for others. This project is independent and is not affiliated with or endorsed by those providers.

## What changed in this round

- **Rules can be inspected before they are changed, and paused.** `agent-autoloop rules validate [file]` checks the rules file and reports warnings that don't block it (a channel nobody can answer, a source with no key, a directory missing on this machine); `check` is an alias. `rules explain <source> <type>` lists the rules that take such an event, with agent, directory and concurrency; `rules explain <rule>` explains one rule, and a scheduled rule shows its next three runs. Adding `"disabled": true` to a rule pauses it: events are still recorded and queued, just not handed out, and everything arrives together when it resumes; a paused schedule never owes its missed slots and starts from the next one. After using `disabled`, rolling back to an older version makes that version reject the rules file — resume the rules or remove the field before rolling back.
- **Channels need an answerer list.** A channel in `rules.json` without `answerers` (or with an empty list) can only send notifications, and any answer is refused. Only an explicit `["*"]` lets anyone answer. A channel that isn't listed in `rules.json` gets no cards at all.
- **A remote hub needs https.** `agent-autoloop join` accepts `https://` addresses; `http://` is allowed only for loopback: `127.0.0.1`, `localhost`, `::1`.
- **Backup, restore and master-key rotation are commands now.** `agent-autoloop backup [dir]` copies the database, master key, config and rules together (0700/0600, safe while the hub runs); `restore <dir> [--yes]` needs the hub stopped, checks the manifest, the hashes and the fact count first, and keeps what it replaces in `replaced-…`; `key rotate [--yes]` changes the master key, which invalidates every old card link and every run token still in flight, while keys made by `key new` keep working.
- **`GET /v1/metrics` is new.** With the owner key it returns Prometheus-style text, one number per line: runs, cost, who is online, cards whose delivery failed or was given up on, where the log and the projection stand, and how large the database files are. It holds no card or event text and no keys, and reading it writes no facts.
- **The hub limits each caller.** Every key, every run and every webhook source is counted on its own; over the limit the answer is 429 with `Retry-After`. `hub.limits` in `config.json` changes the limits, and a mistyped one stops the hub from starting. A worker keeps a finished result through a 429 and hands it in later; an older worker takes a 429 as a refusal, so upgrade workers with the hub. A channel plugin that exits right after starting is restarted after 5 seconds, doubling up to 5 minutes. One run a worker can't read is logged and no longer holds up the others.
- **Rebuilding the view carries on where it stopped.** The first start after an upgrade rebuilds the view from the log; it now commits every 50,000 facts, so a kill or a power cut midway resumes from there instead of starting over, and a long log reports progress on standard error. A view opened before the rebuild began can no longer commit onto the half-built one.
- **`status` and `/v1/metrics` no longer slow down with history.** Runs, tokens and cost per rule are added up at each commit instead of counted over every run each time. The view format changed with it, so the first start after upgrading rebuilds the view from the log once.
- **Updates can be checked, pinned and undone.** `agent-autoloop update --check` only looks; `update <version>` moves to a tag; `update --rollback` goes back to the version before the last update. `AGENT_AUTOLOOP_REF=<version>` in front of the install command installs that version.
- **MCP is read-only by default.** `agent-autoloop mcp` offers `status` and `why` only; add `--allow-writes` (or set `AGENT_AUTOLOOP_MCP_ALLOW_WRITES=1`) to answer a card, resolve one, stop a run or emit events.
- **`POST /v1/tell` takes at most 2000 characters** of `text`; more is a 400.
- **Card links expire after a week.** Opening or submitting a `/c/...` link then returns 410; the card stays open and `agent-autoloop answer <card> <option>` still answers it. `agent-autoloop why` and `status` strip control characters out of text written elsewhere; add `--raw` to see it as it was.
- **Deleting or renaming a rule** cancels runs it hadn't handed out yet, closes its open cards with a notice each, and answering those old cards returns 409; resolve them first.
- **Delivery.** A PR that changes a protected path (`.github/**`, `scripts/**`, `tests/**`, `package.json`, `package-lock.json`, `ops/delivery.json`, replaceable in settings under `protected`) or makes the checked workflow file differ from main's never auto-merges; a person adds `deliver-attended` or merges it by hand. Ship decides a release with main's settings from before the merge, and hands it to a person when it can't read them.

## Documentation

- [Installation guide](INSTALL.md)
- [Configuration & delivery pipeline manual](skills/agent-autoloop/SKILL.md)
- [Writing plugins](docs/plugins.md)
- [Full HTTP protocol specification](docs/protocol.md)
- [Security boundaries](SECURITY.md)
- [Contributing and community](CONTRIBUTING.md)
- [Development guidelines](AGENTS.md)

<details>
<summary><strong>Repository layout</strong></summary>

| Location | Contents |
|---|---|
| `kernel/` | Decisions, fact log, projections, deadlines, rule matching, endpoint behavior, and card forms |
| `host/` | Node HTTP, files and SQLite connections, clock, configuration, background services, and plugin loading |
| `protocol/` | Wire formats, JSON Schema, input validation, HTTP client, and conformance checks |
| `worker/` | Claim work, run agents, handle heartbeats and cancellation, read and submit receipts |
| `cli/`, `bin/` | User commands and entry point: status, answers, `why`, MCP, updates, and uninstall |
| `plugins/` | Built-in agent, event, channel, and delivery plugins |
| `examples/recipes/` | Complete recipes with rules, a task Skill, and setup instructions |
| `examples/plugins/`, `examples/skills/`, `examples/*.sh` | Minimal plugin templates, standalone task guides, and Shell examples |
| `skills/agent-autoloop/` | The hub's configuration and operation manual, also made available to agents during installation |
| `docs/` | Protocol, plugin guide, and Chinese / English architecture diagrams |
| `tests/`, `sim/` | Everyday behavior tests, simulation, enumeration, crash tests, and mutation checks |
| `scripts/`, `.github/workflows/` | Performance and real-agent checks, installation smoke scripts, and Linux / macOS CI |
| Root documents and `install.sh` | Chinese / English READMEs, installation, security, development guidelines, license, and installer |

Start reading at `bin/agent-autoloop.ts` → `cli/main.ts`, then follow the feature into `host/`, `worker/`, or `plugins/`. Read the [protocol](docs/protocol.md) for kernel design. Similarly named files serve different layers: `host/http.ts` adapts Node requests while `kernel/http.ts` defines endpoint behavior; `protocol/rules.ts` validates input while `kernel/rules.ts` defines rule types and matching.

</details>

[MIT License](LICENSE)
