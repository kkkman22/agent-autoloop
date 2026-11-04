// Vendor message formats: links are listed in protocol.md so the fields can be checked against their owning APIs.
import { createHmac } from "node:crypto";

const MOBILE = /^1[3-9]\d{9}$/;

export function payload(platform: string, text: string, at: readonly string[] = []): object {
  if (platform === "discord" && [...text].length > 2000) throw new Error("Discord 消息超过 2000 个字，请缩短卡片");
  if (platform === "wecom" && Buffer.byteLength(text) > 2048) throw new Error("企微消息超过 2048 字节，请缩短卡片");
  switch (platform) {
    case "dingtalk": {
      // A mention needs both sides: an @mobile in the card text and the same mobile in the owner's allowlist,
      // so outside text alone can never choose who gets pinged.
      const wanted = new Set(text.match(/@1[3-9]\d{9}/g)?.map((hit) => hit.slice(1)) ?? []);
      const allowed = [...new Set(at)].filter((mobile) => MOBILE.test(mobile) && wanted.has(mobile));
      return { msgtype: "text", text: { content: text }, at: { atMobiles: allowed, isAtAll: false } };
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
