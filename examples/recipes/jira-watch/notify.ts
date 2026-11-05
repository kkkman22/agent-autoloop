// 把事项资料拼成给钉钉群看的通知文字。@认钉钉 userId、手机号和群里的名字；名字要用映射表里的写法。
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

type User = { name?: string; userid?: string; mobile?: string; mention?: string; role?: string };
type Context = {
  events: { id: string; type: string; subject: string; summary: string; detail: string; link?: string }[];
};
type Receipt = { notice?: { key: string; title: string; text: string }[] };

// The map's key is the Jira account (email, English name or Chinese name); the value carries the DingTalk id.
// Jira hands back emails and display names, and one person can appear under either domain, so every form is tried.
function findUser(forms: (string | undefined)[], users: Record<string, User>) {
  const candidates = forms.filter(Boolean) as string[];
  for (const form of candidates) {
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
  const local = candidates.map((form) => form.split("@")[0]).filter(Boolean);
  for (const name of local) {
    const hit = users[name] ?? users[name.toLowerCase()];
    if (hit) return hit;
  }
  for (const [key, value] of Object.entries(users)) {
    if (local.some((name) => key.split("@")[0].toLowerCase() === name.toLowerCase())) return value;
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
  let detail: Record<string, unknown> = {};
  try {
    detail = JSON.parse(event.detail || "{}");
  } catch {
    // detail 被截断过就当没有：通知仍发，只是少几行资料。
  }
  const text_ = (key: string) => (typeof detail[key] === "string" ? (detail[key] as string) : "");
  const components = Array.isArray(detail.components) ? (detail.components as string[]) : [];
  const isBackend = components.includes("API-H5");

  // The tester filed the case, so they are the one who has to pick it up.
  const reporter = findUser([text_("reporter_email"), text_("reporter_account"), text_("reporter_name")], users);
  // A backend case points at the frontend case that goes with it; its developer is the one to start.
  const frontend = findUser([text_("linked_fe_assignee_email"), text_("linked_fe_assignee_name")], users);

  // The same person twice is one mention.
  const mentions = [...new Set([mentionOf(reporter), isBackend ? mentionOf(frontend) : ""].filter(Boolean))];
  const name = reporter?.name || text_("reporter_name") || "（没有映射）";
  const title = `[${event.subject}] ${event.summary}`.slice(0, 80);
  // @ 写在最前面，紧贴那个人的标识；钉钉要靠正文里的这段文字认出被提醒的人。
  // case 的地址单独一行，钉钉把纯链接认成可点的跳转。
  const text = [
    mentions.join(" "),
    `${event.subject} ${event.summary}`,
    text_("url") || event.link || "",
    `状态：${text_("status") || "未知"}`,
    isBackend && text_("linked_fe_key")
      ? `关联前端 case：${text_("linked_fe_key")}${
          text_("linked_fe_assignee_name") ? `（经办人 ${text_("linked_fe_assignee_name")}）` : ""
        }`
      : "",
    isBackend && !text_("linked_fe_key") ? "关联前端 case：没有找到" : "",
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
