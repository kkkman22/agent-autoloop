// 定时问一遍本地 jira MCP：JQL 命中的 case 有更新就交回事件，编号稳定所以重复读中台只记一次，不花 Token。
// 首次配置用 `node watch.ts jira.json --dry-run` 直接看 MCP 返回的原文。
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

type Config = {
  mcp: string[]; // 启动本地 jira MCP 的命令，如 ["uvx", "mcp-atlassian==0.23.0"]
  jql: string; // 自定义查询，窗口放宽一点没关系，靠事件编号去重
  envFile?: string; // KEY=VALUE 逐行；JIRA_URL、JIRA_PERSONAL_TOKEN 等密钥放这里，不进仓库
  maxResults?: number; // 默认 20
  timeoutSeconds?: number; // 默认 120，uvx 第一次要下载
};
type Reporter = { name?: string; email?: string; display_name?: string; key?: string };
type Issue = {
  key: string;
  summary: string;
  browse_url: string;
  url?: string;
  status?: { name?: string } | string;
  reporter?: Reporter;
  assignee?: Reporter;
  updated: string;
  fields?: Record<string, unknown>;
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
      reporter: (issue.reporter ?? fields.reporter) as Reporter | undefined,
      assignee: (issue.assignee ?? fields.assignee) as Reporter | undefined,
      updated: String(issue.updated ?? fields.updated ?? ""),
    };
  });
}
const statusName = (status: Issue["status"]) => (typeof status === "string" ? status : String(status?.name ?? ""));

// detail 是资料不是指令：字段都截好长度再拼，notify.ts 读得回来。
function eventFrom(issue: Issue) {
  const reporter = issue.reporter ?? {};
  const assignee = issue.assignee ?? {};
  const detail = JSON.stringify({
    summary: issue.summary.slice(0, 200),
    status: statusName(issue.status).slice(0, 50),
    reporter_name: String(reporter.display_name ?? "").slice(0, 100),
    // The Jira account name is the DingTalk userid in most companies, so the notifier can map the creator.
    reporter_account: String(reporter.name ?? "").slice(0, 100),
    reporter_email: String(reporter.email ?? "").slice(0, 200),
    // The assignee is the one working on the case, so they get the mention when the map knows them.
    assignee_name: String(assignee.display_name ?? "").slice(0, 100),
    assignee_account: String(assignee.name ?? "").slice(0, 100),
    assignee_email: String(assignee.email ?? "").slice(0, 200),
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

// 走一遍 stdio MCP：initialize → initialized → tools/call jira_search，拿回工具的文本结果。
async function search(config: Config, log: (line: string) => void): Promise<string> {
  const child = spawn(config.mcp[0], config.mcp.slice(1), {
    env: { ...process.env, ...readEnv(config.envFile) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const timer = setTimeout(() => child.kill(), (config.timeoutSeconds ?? 120) * 1000);
  let buffer = "";
  let complaint = "";
  child.stderr.on("data", (chunk: Buffer) => (complaint = (complaint + chunk.toString()).slice(-500)));
  const ask = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
  try {
    return await new Promise<string>((resolve, reject) => {
      child.on("error", reject);
      ask({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "agent-autoloop-jira-watch", version: "1.0.0" },
        },
      });
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        let cut: number;
        while ((cut = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 1);
          if (!line.trim()) continue;
          let message: { id?: number; error?: { message?: string }; result?: unknown };
          try {
            message = JSON.parse(line);
          } catch {
            continue; // Some servers greet or log plain lines before the JSON-RPC frames.
          }
          if (message.id === 1) {
            log("握手完成");
            ask({ jsonrpc: "2.0", method: "notifications/initialized" });
            ask({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: {
                name: "jira_search",
                arguments: {
                  jql: config.jql,
                  limit: config.maxResults ?? 20,
                  fields: "summary,status,reporter,assignee,updated",
                },
              },
            });
          } else if (message.id === 2) {
            if (message.error) return reject(new Error(`MCP 报错：${message.error.message ?? "未知"}`));
            const content = (message.result as { content?: { type?: string; text?: string }[] })?.content ?? [];
            const text = content.find((part) => part.type === "text")?.text;
            if (!text) return reject(new Error("MCP 没有交回文字结果"));
            resolve(text);
          }
        }
      });
      child.on("close", (code) =>
        reject(new Error(`MCP 提前退出（${code ?? "?"}）${complaint ? `：${complaint.trim()}` : ""}`)),
      );
    });
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dryRun = process.argv.includes("--dry-run");
  const config: Config = JSON.parse(readFileSync(process.argv[2], "utf8"));
  if (!Array.isArray(config.mcp) || config.mcp.length === 0 || !config.jql?.trim()) {
    throw new Error("检查 jira.json：mcp 是启动命令数组，jql 是查询条件，都不能空");
  }
  try {
    const said: string[] = [];
    const text = await search(config, (line) => said.push(line));
    let issues: Issue[];
    try {
      issues = issueList(JSON.parse(text));
    } catch {
      // Jira's own complaint (bad JQL, dead token) arrives where the issue list should be.
      throw new Error(`Jira 说：${text.slice(0, 300)}`);
    }
    if (dryRun) {
      console.log(`MCP 返回 ${issues.length} 条：\n\n${text.slice(0, 8000)}`);
    } else {
      const receipt: Receipt = { events: issues.map(eventFrom).filter((event) => event.subject) };
      console.log(
        `${said.join("、")}，JQL 命中 ${receipt.events!.length} 条\n\n\`\`\`agent-autoloop\n${JSON.stringify(receipt)}\n\`\`\``,
      );
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
