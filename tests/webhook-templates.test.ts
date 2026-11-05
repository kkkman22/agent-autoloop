// Failure modes: a vendor receives the wrong JSON shape; an HTTP 200 API error is acknowledged as delivered; Discord
// content exceeds its documented limit; externally supplied text triggers mentions; an unknown template is silently used;
// a DingTalk @ goes to someone the owner never allowlisted, or the robot's sign is wrong so every message is refused.
// DingTalk matches a mention by userid or mobile that the text names, so the ids the owner allows are the only ones
// that can be pinged, and a name alone never becomes a mention.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import webhook from "../plugins/webhook/channel.ts";
import { payload, signedUrl } from "../plugins/webhook/templates.ts";
test("templates reject text beyond vendor limits instead of losing the answer link", () => {
  assert.throws(() => payload("discord", "x".repeat(2001)));
  assert.throws(() => payload("wecom", "字".repeat(683)));
  assert.throws(() => payload("missing", "text"));
});

test("DingTalk only mentions ids the owner allowlisted, and never everyone", () => {
  const text = "正文 @zhang.san @13900002222";
  const sent: any = payload("dingtalk", text, ["zhang.san", "13800001111"]);
  assert.deepEqual(sent.at, { atUserIds: ["zhang.san"], atMobiles: [], isAtAll: false });
  assert.deepEqual(
    (payload("dingtalk", text) as any).at,
    { atUserIds: [], atMobiles: [], isAtAll: false },
    "no allowlist means no mention",
  );
  assert.deepEqual(
    (payload("dingtalk", "正文 @张三", ["zhang.san"]) as any).at,
    { atUserIds: [], atMobiles: [], isAtAll: false },
    "a name in outside text is not a mention request",
  );
  assert.deepEqual(
    (payload("dingtalk", "正文 @13800001111", ["13800001111"]) as any).at,
    { atUserIds: [], atMobiles: ["13800001111"], isAtAll: false },
    "a mobile still works for people without a userid",
  );
});

test("signedUrl appends the documented DingTalk signature for a fixed moment", () => {
  const url = "https://oapi.dingtalk.com/robot/send?access_token=abc";
  const signed = signedUrl(url, "SEC", 1_730_000_000_000);
  const sign = encodeURIComponent(createHmac("sha256", "SEC").update(`1730000000000\nSEC`).digest("base64"));
  assert.equal(signed, `${url}&timestamp=1730000000000&sign=${sign}`);
  assert.ok(signedUrl("https://x/hook", "SEC", 5).startsWith("https://x/hook?timestamp=5&sign="));
});
const card: any = {
  id: 1,
  version: 1,
  ref: null,
  state: "open",
  title: "要处理",
  text: "正文 @everyone <@U1>",
  options: [],
  link: "https://example.com/c/a",
};
for (const platform of ["dingtalk", "wecom", "slack", "discord"])
  test(`${platform}: official payload and API failure on a local receiver`, async () => {
    const received: any[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (b) => (body += b));
      req.on("end", () => {
        received.push(JSON.parse(body));
        res.end(
          platform === "slack"
            ? "ok"
            : platform === "discord"
              ? ""
              : JSON.stringify({ errcode: received.length === 1 ? 0 : 310000, errmsg: "拒绝" }),
        );
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const stop = new AbortController();
    const calls: string[] = [];
    let i = 0;
    const hub: any = {
      nextCard: async () => {
        if (++i <= 2) return { card: { ...card, id: i } };
        stop.abort();
        return { card: null };
      },
      delivered: async () => calls.push("delivered"),
      failed: async () => calls.push("failed"),
    };
    try {
      await webhook({
        hub,
        options: { platform, url: `http://127.0.0.1:${(server.address() as any).port}` },
        log: () => {},
        signal: stop.signal,
      });
    } finally {
      server.close();
    }
    assert.equal(received.length, 2);
    if (["dingtalk", "wecom"].includes(platform)) {
      assert.equal(received[0].msgtype, "text");
      assert.match(received[0].text.content, /正文/);
      assert.deepEqual(calls, ["delivered", "failed"]);
    }
    if (platform === "slack") {
      assert.match(received[0].text, /正文/);
      assert.equal(received[0].mrkdwn, false);
    }
    if (platform === "discord") {
      assert.match(received[0].content, /正文/);
      assert.deepEqual(received[0].allowed_mentions, { parse: [] });
    }
  });

test("dingtalk: the channel signs the request and only allowlisted mentions survive the trip", async () => {
  const seen: { url: string; body: any }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (b) => (body += b));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", body: JSON.parse(body) });
      res.end(JSON.stringify({ errcode: 0 }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const stop = new AbortController();
  let i = 0;
  const calls: string[] = [];
  const hub: any = {
    nextCard: async () => {
      if (++i <= 1) return { card: { ...card, id: 1, text: "正文 @zhang.san @13900002222" } };
      stop.abort();
      return { card: null };
    },
    delivered: async () => calls.push("delivered"),
    failed: async () => calls.push("failed"),
  };
  try {
    await webhook({
      hub,
      options: {
        platform: "dingtalk",
        url: `http://127.0.0.1:${(server.address() as any).port}/robot/send?access_token=abc`,
        secret: "SEC",
        at: ["zhang.san"],
      },
      log: () => {},
      signal: stop.signal,
    });
  } finally {
    server.close();
  }
  assert.deepEqual(calls, ["delivered"]);
  assert.match(seen[0].url, /\/robot\/send\?access_token=abc&timestamp=\d+&sign=/);
  assert.deepEqual(seen[0].body.at, { atUserIds: ["zhang.san"], atMobiles: [], isAtAll: false });
});
