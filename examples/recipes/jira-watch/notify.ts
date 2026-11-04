// 把事项资料拼成给钉钉群看的通知文字。@手机号只来自本地 users.json 的映射，事件里的字只是资料。
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

type User = { name?: string; mobile?: string };
type Context = {
  events: { id: string; type: string; subject: string; summary: string; detail: string; link?: string }[];
};
type Receipt = { notice?: { key: string; title: string; text: string }[] };

function noticeFrom(event: Context["events"][number], users: Record<string, User>) {
  let detail: Record<string, string> = {};
  try {
    detail = JSON.parse(event.detail || "{}");
  } catch {
    // detail 被截断过就当没有：通知仍发，只是少几行资料。
  }
  const who = users[detail.reporter_email?.toLowerCase() ?? ""] ?? users[detail.reporter_name ?? ""];
  const at = who?.mobile ? ` @${who.mobile}` : "";
  const name = who?.name || detail.reporter_name || "（没有映射）";
  const title = `[${event.subject}] ${event.summary}`.slice(0, 80);
  const text = [
    `创建人：${name}${at}`,
    `状态：${detail.status || "未知"}`,
    `更新时间：${detail.updated || "未知"}`,
    detail.url || event.link || "",
  ]
    .filter(Boolean)
    .join("\n");
  return { key: `jira-${event.id}`.slice(0, 200), title, text };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const users: Record<string, User> = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const context: Context = JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT!, "utf8"));
  const notice = context.events.map((event) => noticeFrom(event, users));
  const receipt: Receipt = { notice };
  console.log(`发了 ${notice.length} 条通知\n\n\`\`\`agent-autoloop\n${JSON.stringify(receipt)}\n\`\`\``);
}
