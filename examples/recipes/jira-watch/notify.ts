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
function findUser(detail: Record<string, string>, users: Record<string, User>, prefix: "reporter" | "assignee") {
  const forms = [
    detail[`${prefix}_email`],
    detail[`${prefix}_account`],
    detail[`${prefix}_name`],
    detail[`${prefix}_email`]?.split("@")[0],
    detail[`${prefix}_account`]?.split("@")[0],
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
  // One person can show up under either email domain, so a name that differs only by domain still counts:
  // the map may be keyed by the other domain's full address, so look it up by the part before the @.
  const local = forms.map((form) => form.split("@")[0]).filter(Boolean);
  for (const name of local) {
    const hit = users[name] ?? users[name.toLowerCase()];
    if (hit) return hit;
  }
  for (const [key, value] of Object.entries(users)) {
    if (local.some((name) => key.split("@")[0].toLowerCase() === name.toLowerCase())) return value;
  }
  return undefined;
}

// 谁被 @ 只能由本地映射表决定，事件里的文字没有这个权力。
function mentionOf(who: User | undefined) {
  if (!who) return "";
  const id = who.mention ?? who.userid ?? who.mobile;
  return id ? `@${id}` : "";
}

// 经办人是正在做这件事的人，优先提醒他；映射表里没有他（或没有可 @ 的标识），才退回提醒创建人。
function noticeFrom(event: Context["events"][number], users: Record<string, User>) {
  let detail: Record<string, string> = {};
  try {
    detail = JSON.parse(event.detail || "{}");
  } catch {
    // detail 被截断过就当没有：通知仍发，只是少几行资料。
  }
  const assignee = findUser(detail, users, "assignee");
  const creator = findUser(detail, users, "reporter");
  const who = mentionOf(assignee) ? assignee : creator;
  const mention = mentionOf(who);
  const title = `[${event.subject}] ${event.summary}`.slice(0, 80);
  const link = detail.url || event.link || "";
  // @ 写在最前面，紧贴那个人的标识；钉钉要靠正文里的这段文字认出被提醒的人。
  // case 的地址单独一行，钉钉把纯链接认成可点的跳转。
  const text = [mention, `${event.subject} ${event.summary}`, link, `状态：${detail.status || "未知"}`]
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
