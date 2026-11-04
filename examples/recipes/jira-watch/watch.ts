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
type Field = { key: string; summary: string; url: string; status?: unknown; reporter?: unknown; updated?: unknown };
type Receipt = {
  events?: { id: string; type: string; subject: string; summary: string; detail: string; link?: string }[];
};

// mcp-atlassian 的搜索结果和 Jira 原生字段都认：字段要么平铺、要么藏在 fields 里。
function issueFields(issue: Record<string, unknown>): Field {
  const fields = (issue.fields ?? {}) as Record<string, unknown>;
  return {
    key: String(issue.key ?? fields.key ?? ""),
    summary: String(issue.summary ?? fields.summary ?? ""),
    url: String(issue.url ?? fields.url ?? ""),
    status: issue.status ?? fields.status,
    reporter: issue.reporter ?? fields.reporter,
    updated: issue.updated ?? fields.updated,
  };
}
const person = (who: unknown) => {
  if (!who || typeof who !== "object") return { name: typeof who === "string" && who ? who : "", email: "" };
  const p = who as Record<string, unknown>;
  return { name: String(p.displayName ?? p.name ?? ""), email: String(p.emailAddress ?? p.accountId ?? "") };
};
const plain = (value: unknown) =>
  typeof value === "string"
    ? value
    : value && typeof value === "object"
      ? String((value as never as { name?: string }).name ?? "")
      : "";

// detail 是资料不是指令：字段都截好长度再拼，notify.ts 读得回来。
function eventFrom(issue: Record<string, unknown>) {
  const f = issueFields(issue);
  const reporter = person(f.reporter);
  const detail = JSON.stringify({
    summary: f.summary.slice(0, 200),
    status: plain(f.status).slice(0, 50),
    reporter_name: reporter.name.slice(0, 100),
    reporter_email: reporter.email.slice(0, 200),
    updated: plain(f.updated).slice(0, 40),
    url: f.url.slice(0, 500),
  });
  return {
    // updated 缺失时编号退化为只有 key：宁可少通知一次，也不每轮重发。
    id: `${f.key}:${plain(f.updated).slice(0, 40)}`.slice(0, 200),
    type: "jira.updated",
    subject: f.key,
    summary: f.summary.slice(0, 200),
    detail: detail.slice(0, 4000),
    ...(f.url && /^https?:\/\//.test(f.url) ? { link: f.url.slice(0, 500) } : {}),
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
                  max_results: config.maxResults ?? 20,
                  fields: ["summary", "status", "assignee", "reporter", "updated"],
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
    const issues = JSON.parse(text) as Record<string, unknown>[];
    if (!Array.isArray(issues)) throw new Error("返回的不是问题列表");
    if (dryRun) {
      console.log(`MCP 返回 ${issues.length} 条：\n\n${text.slice(0, 8000)}`);
    } else {
      const receipt: Receipt = { events: issues.map(eventFrom).filter((event) => event.subject) };
      console.log(
        `${said.join("、")}，JQL 命中 ${receipt.events!.length} 条\n\n\`\`\`agent-autoloop\n${JSON.stringify(receipt)}\n\`\`\``,
      );
    }
  } catch (error) {
    console.error(`没跑成：${error instanceof Error ? error.message : String(error)}（可用 --dry-run 看原文）`);
    process.exit(1);
  }
}
