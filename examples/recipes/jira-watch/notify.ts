// 把事项资料拼成给钉钉群看的通知文字。@认钉钉 userId、手机号和群里的名字；名字要用映射表里的写法。
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

type User = { name?: string; userid?: string; mobile?: string; mention?: string };
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
    // The map may be keyed by email, by English name, or by Chinese name; the first two are what Jira hands over.
    const hit =
      users[form] ??
      users[form.toLowerCase()] ??
      users[form.replace(/\s+/g, "")] ??
      users[form.replace(/\s+/g, "").toLowerCase()];
    if (hit) return hit;
  }
  // One person can show up under either email domain, so a name that differs only by domain still counts.
  const local = forms.map((form) => form.split("@")[0]).filter(Boolean);
  for (const name of local) {
    const hit = users[name] ?? users[name.toLowerCase()];
    if (hit) return hit;
  }
  return undefined;
}

// 钉钉按正文里的写法匹配：userId、手机号、群里显示的名字都认。
// 谁被 @ 只能由本地映射表决定，事件里的文字没有这个权力。
function mentionOf(who: User | undefined) {
  if (!who) return "";
  const id = who.mention ?? who.userid ?? who.mobile;
  return id ? `@${id}` : "";
}

function noticeFrom(event: Context["events"][number], users: Record<string, User>) {
  let detail: Record<string, string> = {};
  try {
    detail = JSON.parse(event.detail || "{}");
  } catch {
    // detail 被截断过就当没有：通知仍发，只是少几行资料。
  }
  const who = findUser(detail, users);
  const mention = mentionOf(who);
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
