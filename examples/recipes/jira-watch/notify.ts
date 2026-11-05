// 把事项资料拼成给钉钉群看的通知文字。@只认钉钉 userId 或手机号，纯名字没有提醒效果。
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

type User = { name?: string; userid?: string; mobile?: string };
type Context = {
  events: { id: string; type: string; subject: string; summary: string; detail: string; link?: string }[];
};
type Receipt = { notice?: { key: string; title: string; text: string }[] };

// The map's key is the Jira account (email, English name or Chinese name); the value carries the DingTalk id.
// Jira hands back emails and display names, and one person can appear under either domain, so every form is tried.
function findUser(detail: Record<string, string>, users: Record<string, User>) {
  const forms = [
    detail.reporter_email,
    detail.reporter_account,
    detail.reporter_name,
    detail.reporter_email?.split("@")[0],
    detail.reporter_account?.split("@")[0],
  ].filter(Boolean);
  for (const form of forms) {
    const hit = users[form] ?? users[form.toLowerCase()];
    if (hit) return hit;
  }
  return undefined;
}

function noticeFrom(event: Context["events"][number], users: Record<string, User>) {
  let detail: Record<string, string> = {};
  try {
    detail = JSON.parse(event.detail || "{}");
  } catch {
    // detail 被截断过就当没有：通知仍发，只是少几行资料。
  }
  const who = findUser(detail, users);
  // DingTalk pings by userid or mobile; a name in the text is just text. Text type is the one that highlights.
  const mention = who?.userid ? `@${who.userid}` : who?.mobile ? `@${who.mobile}` : "";
  const name = who?.name || detail.reporter_name || detail.reporter_account || "（没有映射）";
  const title = `[${event.subject}] ${event.summary}`.slice(0, 80);
  const text = [
    `创建人：${name}${mention ? ` ${mention}` : ""}`,
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
