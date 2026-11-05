// 定时问一遍本地 jira MCP：状态变成 Testing 的 case 有哪些，就交回事件。
// 只在值班时间跑（工作日与法定节假日由日历决定），查的是上一轮到现在这一段，所以周末和合盖都不会漏。
// 首次配置用 `node watch.ts jira.json --dry-run` 直接看 MCP 返回的原文。
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { clockOf, isWorkingDay, loadYear, readCursor, windowStart, writeCursor } from "./schedule.ts";

type Config = {
  mcp: string[]; // 启动本地 jira MCP 的命令，如 ["uvx", "mcp-atlassian==0.23.0"]
  project?: string; // 项目代号，如 CH
  status?: string; // 盯着的状态名，默认 Testing
  maxResults?: number; // 默认 50
  timeoutSeconds?: number; // 默认 120，uvx 第一次要下载
  envFile?: string; // KEY=VALUE 逐行；JIRA_URL、JIRA_PERSONAL_TOKEN 等密钥放这里，不进仓库
  timezone?: string; // 与 rules.json 一致，默认 Asia/Shanghai
  holidaysFile?: string; // 节假日缓存，默认与 jira.json 同目录的 holidays.json
  holidaysUrl?: string; // 节假日接口，默认公开接口
  cursorFile?: string; // 上一轮查到哪，默认与 jira.json 同目录的 cursor.json
  firstRunAt?: string; // 第一次从哪查起，默认昨天 18:00
  now?: string; // 固定"现在"，测试用
  componentFrontend?: string; // 前端组件名，默认 H5
  componentBackend?: string; // 后端组件名，默认 API-H5
};
type Reporter = { name?: string; email?: string; display_name?: string; key?: string };
type Issue = {
  key: string;
  summary: string;
  browse_url: string;
  url?: string;
  status?: { name?: string } | string;
  components?: string[];
  reporter?: Reporter;
  assignee?: Reporter;
  updated: string;
  fields?: Record<string, unknown>;
  issuelinks?: {
    type?: { name?: string };
    outward_issue?: { key?: string; fields?: { components?: string[] } };
    inward_issue?: { key?: string; fields?: { components?: string[] } };
  }[];
};
type Receipt = {
  events?: { id: string; type: string; subject: string; summary: string; detail: string; link?: string }[];
};

// mcp-atlassian 的 jira_search 回 {"total","start_at","max_results","issues":[...]}，字段平铺；也认 Jira 原生的 fields 嵌套。
function issueList(payload: unknown): Issue[] {
  const root = payload as { issues?: Partial<Issue>[] } | Partial<Issue>[];
  const issues = Array.isArray(root) ? root : (root?.issues ?? []);
  return issues.map((issue) => {
    const fields = (issue.fields ?? {}) as Record<string, unknown>;
    return {
      key: String(issue.key ?? fields.key ?? ""),
      summary: String(issue.summary ?? fields.summary ?? ""),
      browse_url: String(issue.browse_url ?? issue.url ?? fields.url ?? ""),
      status: (issue.status ?? fields.status) as Issue["status"],
      components: issue.components ?? (fields.components as string[]) ?? [],
      reporter: (issue.reporter ?? fields.reporter) as Reporter | undefined,
      assignee: (issue.assignee ?? fields.assignee) as Reporter | undefined,
      updated: String(issue.updated ?? fields.updated ?? ""),
    };
  });
}
const statusName = (status: Issue["status"]) => (typeof status === "string" ? status : String(status?.name ?? ""));

// detail 是资料不是指令：字段都截好长度再拼，notify.ts 读得回来。
function eventFrom(issue: Issue, linked: Linked) {
  const reporter = issue.reporter ?? {};
  const detail = JSON.stringify({
    summary: issue.summary.slice(0, 200),
    status: statusName(issue.status).slice(0, 50),
    components: (issue.components ?? []).slice(0, 5),
    reporter_name: String(reporter.display_name ?? "").slice(0, 100),
    reporter_account: String(reporter.name ?? "").slice(0, 100),
    reporter_email: String(reporter.email ?? "").slice(0, 200),
    // The frontend case this one belongs to, and who works on it.
    linked_fe_key: linked.key.slice(0, 40),
    linked_fe_url: linked.url.slice(0, 500),
    linked_fe_status: linked.status.slice(0, 50),
    linked_fe_assignee_name: linked.assigneeName.slice(0, 100),
    linked_fe_assignee_email: linked.assigneeEmail.slice(0, 200),
    updated: issue.updated.slice(0, 40),
    url: issue.browse_url.slice(0, 500),
  });
  return {
    // updated 缺失时编号退化为只有 key：宁可少通知一次，也不每轮重发。
    id: `${issue.key}:${issue.updated}`.slice(0, 200),
    type: "jira.updated",
    subject: issue.key,
    summary: issue.summary.slice(0, 200),
    detail: detail.slice(0, 4000),
    ...(issue.browse_url && /^https?:\/\//.test(issue.browse_url) ? { link: issue.browse_url.slice(0, 500) } : {}),
  };
}

type Linked = { key: string; url: string; status: string; assigneeName: string; assigneeEmail: string };

function readEnv(file?: string): Record<string, string> {
  if (!file) return {};
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const cut = line.indexOf("=");
        return cut > 0 ? [line.slice(0, cut), line.slice(cut + 1)] : null;
      })
      .filter((pair): pair is [string, string] => pair !== null),
  );
}

/** One MCP session: the handshake, then any number of tool calls over the same child process. */
class Mcp {
  private child;
  private buffer = "";
  private pending = new Map<number, { resolve: (text: string | undefined) => void; reject: (why: Error) => void }>();
  private next = 1;
  private complaint = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timeout: number;

  constructor(command: string[], env: Record<string, string>, timeoutSeconds: number) {
    this.child = spawn(command[0], command.slice(1), {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      // Its own group, so the whole tree goes down with it: uvx runs the server as a child of its own.
      detached: true,
    });
    // The first run may download the MCP's own dependencies, so the clock starts when the handshake answers.
    this.timeout = timeoutSeconds * 1000;
    this.child.stderr.on("data", (chunk: Buffer) => (this.complaint = (this.complaint + chunk.toString()).slice(-500)));
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("close", (code) =>
      this.failAll(new Error(`MCP 提前退出（${code ?? "?"}）${this.complaint ? `：${this.complaint.trim()}` : ""}`)),
    );
    this.child.stdout.on("data", (chunk: Buffer) => this.read(chunk.toString()));
  }

  private failAll(error: Error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  private read(text: string) {
    this.buffer += text;
    let cut: number;
    while ((cut = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, cut);
      this.buffer = this.buffer.slice(cut + 1);
      if (!line.trim()) continue;
      let message: { id?: number; error?: { message?: string }; result?: unknown };
      try {
        message = JSON.parse(line);
      } catch {
        continue; // Some servers greet or log plain lines before the JSON-RPC frames.
      }
      const waiting = message.id === undefined ? undefined : this.pending.get(message.id);
      if (!waiting) continue;
      this.pending.delete(message.id!);
      if (message.error) waiting.reject(new Error(`MCP 报错：${message.error.message ?? "未知"}`));
      else {
        const content = (message.result as { content?: { type?: string; text?: string }[] })?.content ?? [];
        waiting.resolve(content.find((part) => part.type === "text")?.text);
      }
    }
  }

  private ask(method: string, params: object): Promise<string | undefined> {
    const id = this.next++;
    return new Promise<string | undefined>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.arm();
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async start() {
    // The handshake answers with the server's abilities, not with content, so it does not read like a tool call.
    await this.ask("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "agent-autoloop-jira-watch", version: "1.0.0" },
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  }

  /** Every answer has to come in time, or the MCP is not answering at all. */
  private arm() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.child.kill(), this.timeout);
  }

  async call(tool: string, args: object): Promise<string> {
    const text = await this.ask("tools/call", { name: tool, arguments: args });
    if (text === undefined) throw new Error("MCP 没有交回文字结果");
    // A tool that failed says so in the text it returns, not in the protocol.
    if (text.startsWith("Error calling tool")) throw new Error(`Jira 说：${text.slice(0, 300)}`);
    return text;
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    // The whole group, not just the one process: the server under uvx would otherwise stay behind.
    try {
      process.kill(-this.child.pid!, "SIGTERM");
    } catch {
      this.child.kill();
    }
  }
}

/**
 * The frontend case this backend one belongs to, and who works on it.
 *
 * Jira's own query finds the linked cases and their people in one go, which is both quicker
 * and steadier than reading the links off the issue: the issue's own link field is not always readable.
 */
async function findLinkedFrontend(mcp: Mcp, issue: Issue, frontendComponent: string, reporterEmail: string) {
  const linked: Linked = { key: "", url: "", status: "", assigneeName: "", assigneeEmail: "" };
  const text = await mcp.call("jira_search", {
    jql: `issue in linkedIssues("${issue.key}")`,
    limit: 10,
    fields: "summary,status,components,reporter,assignee,updated",
  });
  for (const other of issueList(JSON.parse(text))) {
    if (!(other.components ?? []).includes(frontendComponent)) continue;
    // The tester files one case for the frontend and one for the backend, so the pair shares its reporter.
    if (reporterEmail && other.reporter?.email && other.reporter.email !== reporterEmail) continue;
    linked.key = other.key;
    linked.url = other.browse_url;
    linked.status = statusName(other.status);
    linked.assigneeName = String(other.assignee?.display_name ?? "");
    linked.assigneeEmail = String(other.assignee?.email ?? "");
    return linked;
  }
  return linked;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dryRun = process.argv.includes("--dry-run");
  const configPath = process.argv[2];
  const config: Config = JSON.parse(readFileSync(configPath, "utf8"));
  if (!Array.isArray(config.mcp) || config.mcp.length === 0) {
    throw new Error("检查 jira.json：mcp 是启动命令数组，不能空");
  }
  const beside = (name: string) => `${configPath.slice(0, configPath.lastIndexOf("/") + 1)}${name}`;
  const timezone = config.timezone ?? "Asia/Shanghai";
  const now = config.now ? new Date(config.now) : new Date();
  const clock = clockOf(now, timezone);
  const status = config.status ?? "Testing";
  const frontend = config.componentFrontend ?? "H5";
  const backend = config.componentBackend ?? "API-H5";

  try {
    // 值班时间：日历说今天放假就不问 Jira 了，周末和法定节假日都在这里安静退出。
    const holidaysFile = config.holidaysFile ?? beside("holidays.json");
    let working = true;
    try {
      const calendar = await loadYear(clock.year, holidaysFile, config.holidaysUrl);
      working = isWorkingDay(calendar, clock.date);
    } catch (error) {
      // The calendar is a convenience: when it cannot be reached, every weekday counts.
      console.error(`节假日日历拿不到（${error instanceof Error ? error.message : String(error)}），按周一到周五算`);
    }
    if (!working) {
      console.log(`没事可做：${clock.date} 不是工作日`);
      process.exit(0);
    }

    // 窗口：上一轮查到哪，这次就从哪查起。
    const cursorFile = config.cursorFile ?? beside("cursor.json");
    const lastCheckedAt = readCursor(cursorFile);
    const firstRunAt = config.firstRunAt ?? `${clockOf(new Date(now.getTime() - 24 * 3600_000), timezone).date} 18:00`;
    const since = windowStart(lastCheckedAt, now, timezone, firstRunAt);

    const mcp = new Mcp(config.mcp, readEnv(config.envFile), config.timeoutSeconds ?? 120);
    // A stop signal has to take the MCP down with it, or its server is left running on this machine.
    const stop = () => {
      mcp.stop();
      process.exit(0);
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    try {
      await mcp.start();
      const project = config.project ?? "";
      const jql = [
        project && `project = ${project}`,
        "sprint in openSprints()",
        `status CHANGED TO "${status}" AFTER "${since}"`,
        // The change is in the window, and the case is still sitting there waiting for the tester.
        `status = "${status}"`,
      ]
        .filter(Boolean)
        .join(" AND ");
      const text = await mcp.call("jira_search", {
        jql,
        limit: config.maxResults ?? 50,
        fields: "summary,status,components,reporter,assignee,updated",
      });
      let issues: Issue[];
      try {
        issues = issueList(JSON.parse(text));
      } catch {
        // Jira's own complaint (bad JQL, dead token) arrives where the issue list should be.
        throw new Error(`Jira 说：${text.slice(0, 300)}`);
      }

      const events = [];
      for (const issue of issues) {
        if (!issue.key) continue;
        let linked: Linked = { key: "", url: "", status: "", assigneeName: "", assigneeEmail: "" };
        // A backend case points at the frontend case that goes with it.
        if ((issue.components ?? []).includes(backend)) {
          try {
            linked = await findLinkedFrontend(mcp, issue, frontend, String(issue.reporter?.email ?? ""));
          } catch (error) {
            // One case whose links cannot be read is not a reason to drop the others; it goes out without a frontend case.
            console.error(`查 ${issue.key} 的关联 case 失败：${error instanceof Error ? error.message : error}`);
          }
        }
        events.push(eventFrom(issue, linked));
      }

      if (dryRun) {
        console.log(`窗口 ${since} → ${clock.date} ${clock.hour}:${clock.minute}`);
        console.log(`MCP 返回 ${issues.length} 条：\n\n${text.slice(0, 8000)}`);
      } else {
        const receipt: Receipt = { events };
        writeCursor(cursorFile, now.toISOString());
        console.log(
          `窗口 ${since} → ${clock.date} ${clock.hour}:${clock.minute}，命中 ${events.length} 条\n\n\`\`\`agent-autoloop\n${JSON.stringify(receipt)}\n\`\`\``,
        );
      }
    } finally {
      mcp.stop();
    }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    // The MCP answered but Jira complained (bad JQL, dead token): the owner has to fix it, so the run fails and shows.
    // The MCP never answered (it didn't start, crashed, timed out): transient, so the run ends quietly and the next
    // cron tick tries again — failing here would send the hub into a retry storm over what the cron re-checks anyway.
    if (why.startsWith("Jira 说：")) {
      console.log(`没跑成：${why}`);
      console.error(why);
      process.exit(1);
    }
    console.log(`没事可做：查 Jira 失败（${why}），下一轮再试`);
    if (dryRun) console.error(why);
    process.exit(0);
  }
}
