// Vendor message formats: links are listed in protocol.md so the fields can be checked against their owning APIs.
import { createHmac } from "node:crypto";

const MOBILE = /^1[3-9]\d{9}$/;
// A phone may be written with a country code; DingTalk's own examples are eleven bare digits.
const bare = (id: string) => id.replace(/^\+?86[- ]?/, "");
const mobile = (id: string) => (MOBILE.test(bare(id)) ? bare(id) : null);

/**
 * The ids the text names right after an @ that the owner allows.
 *
 * DingTalk matches a mention on the id in the text against the same id in the request, so the allowlist is the
 * only thing that decides who can be pinged. Which ids work depends on the vendor and on the group: a user's
 * userid (the internal id like 014728255240768602), their mobile, or the name the group shows them under.
 * An id the vendor cannot resolve is dropped silently, so an allowlist entry that never highlights means that
 * spelling is not what the vendor matches on, not that the message failed.
 */
function mentioned(text: string, allowed: readonly string[]): string[] {
  // A mention is what follows an @ up to the next space. The client renders it as "@name(name)", and the
  // owner may allow either spelling, so both the whole form and the name inside it count.
  const said = new Set<string>();
  for (const hit of text.matchAll(/@([^\s@]+)/g)) {
    const whole = hit[1];
    said.add(bare(whole));
    const inner = whole.match(/^\(([^)]*)\)$/);
    if (inner) said.add(bare(inner[1]));
    const name = whole.match(/^([^()]+)\(([^)]*)\)$/);
    if (name) {
      said.add(bare(name[1]));
      said.add(bare(name[2]));
    }
  }
  return allowed.filter((id) => said.has(id) || said.has(bare(id)));
}

export function payload(platform: string, text: string, at: readonly string[] = []): object {
  if (platform === "discord" && [...text].length > 2000) throw new Error("Discord 消息超过 2000 个字，请缩短卡片");
  if (platform === "wecom" && Buffer.byteLength(text) > 2048) throw new Error("企微消息超过 2048 字节，请缩短卡片");
  switch (platform) {
    case "dingtalk": {
      // A mention needs both sides: the id in the card text and the same id in the owner's allowlist,
      // so outside text alone can never choose who gets pinged. The allowlist holds every id the owner allows,
      // in any spelling DingTalk matches: a userid, a mobile, or the name a person goes by in the group.
      const allowed = [...new Set(at)];
      const picked = mentioned(text, allowed);
      return {
        msgtype: "text",
        text: { content: text },
        at: {
          atUserIds: picked.filter((id) => !mobile(id)),
          atMobiles: picked.map(mobile).filter((id): id is string => id !== null),
          isAtAll: false,
        },
      };
    }
    case "wecom":
      return { msgtype: "text", text: { content: text } };
    case "slack":
      return { text, mrkdwn: false, unfurl_links: false, unfurl_media: false };
    case "discord":
      return { content: text, allowed_mentions: { parse: [] } };
    default:
      throw new Error(`没有这个 Webhook 模板：${platform}`);
  }
}

// The robot's documented sign: HMAC-SHA256 of "<timestamp>\n<secret>", base64, URL-encoded, appended to the webhook.
export function signedUrl(url: string, secret: string, millis = Date.now()): string {
  const sign = encodeURIComponent(createHmac("sha256", secret).update(`${millis}\n${secret}`).digest("base64"));
  return `${url}${url.includes("?") ? "&" : "?"}timestamp=${millis}&sign=${sign}`;
}

export async function accepted(platform: string, response: Response) {
  if (!response.ok) throw new Error(`返回 ${response.status}`);
  if (platform === "dingtalk" || platform === "wecom") {
    const result = await response.json();
    if (result.errcode !== 0) throw new Error(`发送失败：${result.errmsg ?? result.errcode}`);
  } else if (platform === "slack" && (await response.text()).trim() !== "ok") throw new Error("Slack 没有确认收到消息");
}
