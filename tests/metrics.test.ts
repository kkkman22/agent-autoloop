// Failure modes: the numbers are readable with someone else's key or none, so a channel or a source sees the owner's
// business; the body carries card text, event text or a key; an empty hub has nothing to say and errors instead; a count
// disagrees with `/v1/state`, so two views of one hub tell different stories; a delivery that failed again and one the
// hub gave up on are counted as the same thing or twice; asking for metrics appends a fact, so reading changes what is
// read; a rule name with a quote, a backslash or a newline runs the rest of the line into the value, and a scraper reads
// a different number than the one meant; the numbers stop working after the projection is rebuilt, or claim facts the
// log no longer has.
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { at, setup } from "./helpers.ts";

const home = setup("metrics");
/** A rule name nothing forbids, so the exporter has to escape it rather than trust it. */
const NASTY = '告警 "备份\\清理"\n第二行';
writeFileSync(
  join(home, "rules.json"),
  JSON.stringify(
    {
      timezone: "Asia/Shanghai",
      sources: { app: { name: "应用" } },
      agents: { a1: { name: "甲", worker: "w1", use: "claude" } },
      channels: { chat: { name: "聊天", answerers: ["me"] }, ops: { name: "运维群", answerers: ["me"] } },
      rules: [
        { name: "意见", when: { source: "app", types: ["feedback.*"] }, to: "a1", cwd: "~/x", prompt: "按手册做。" },
        { name: NASTY, when: { source: "app", types: ["alert.raised"] }, to: "a1", cwd: "~/x", prompt: "处理告警。" },
      ],
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
process.env.AGENT_AUTOLOOP_RULES = join(home, "rules.json");

const { serve } = await import("../host/http.ts");
const hub = await import("../host/runtime.ts");
const { rebuild } = await import("../kernel/store.ts");
const { metricsText } = await import("../host/metrics.ts");

const keys = {
  owner: hub.addKey("owner", "owner"),
  w1: hub.addKey("worker", "w1"),
  chat: hub.addKey("channel", "chat"),
  ops: hub.addKey("channel", "ops"),
  app: hub.addKey("source", "app"),
};
const masterKey = readFileSync(join(home, "master.key"), "utf8").trim();
const server = serve(0, "127.0.0.1", { commit: "abc123" });
let base = "";
before(async () => {
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const get = async (path: string, key?: string) => {
  const response = await fetch(base + path, { headers: key ? { authorization: `Bearer ${key}` } : {} });
  return { status: response.status, text: await response.text(), type: response.headers.get("content-type") ?? "" };
};

type Sample = { name: string; labels: Record<string, string>; value: number };
/** Read the body the way a scraper would: every line is one sample or a comment, and no line is unreadable. */
function samples(body: string): Sample[] {
  const found: Sample[] = [];
  for (const line of body.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const match = /^([a-z_][a-z0-9_]*)(?:\{([^}]*)\})? (-?[0-9.eE+-]+)$/.exec(line);
    assert.ok(match, `读不了这一行：${JSON.stringify(line)}`);
    const labels: Record<string, string> = {};
    for (const pair of match![2] ? match![2].split(/,(?=[a-z_]+=")/) : []) {
      const [name, quoted] = pair.split("=");
      labels[name!] = quoted!.slice(1, -1).replaceAll("\\\\", "\\").replaceAll('\\"', '"').replaceAll("\\n", "\n");
    }
    found.push({ name: match![1]!, labels, value: Number(match![3]) });
  }
  return found;
}
/** The one sample with this name and exactly these labels; missing or duplicated both fail. */
function metric(body: string, name: string, labels: Record<string, string> = {}) {
  const wanted = JSON.stringify(Object.entries(labels).sort());
  const found = samples(body).filter(
    (sample) => sample.name === name && JSON.stringify(Object.entries(sample.labels).sort()) === wanted,
  );
  assert.equal(found.length, 1, `${name}${wanted} 应该正好有一条，实际 ${found.length} 条`);
  return found[0]!.value;
}

test("only the owner reads the numbers, and the numbers carry nobody's words", async () => {
  for (const path of ["/v1/metrics", "/v1/metrics?wait=0"]) {
    assert.equal((await get(path)).status, 401, path);
    for (const who of [keys.w1, keys.chat, keys.app]) assert.equal((await get(path, who)).status, 401, path);
  }
  const told = hub.tell("source:app:first", "不能出现在指标里的标题", "也不能出现的正文", at(0));
  hub.ingest(
    "app",
    { id: "e-secret", type: "feedback.new", subject: "secret-subject", summary: "也不能出现的摘要" },
    at(0),
  );

  const answer = await get("/v1/metrics", keys.owner);
  assert.equal(answer.status, 200);
  assert.match(answer.type, /^text\/plain/);
  for (const secret of [
    "不能出现在指标里的标题",
    "也不能出现的正文",
    "也不能出现的摘要",
    "secret-subject",
    keys.owner,
    masterKey,
  ])
    assert.ok(!answer.text.includes(secret), `指标里不该有 ${secret.slice(0, 12)}`);

  // The rule with a quote, a backslash and a newline in its name comes back as one readable line.
  assert.equal(metric(answer.text, "hub_runs_by_rule", { rule: NASTY, state: "queued" }), 0);
  assert.ok(told.card > 0);
});

test("an empty hub answers with zeros, and reading is not a fact", async () => {
  const facts = () => Number(hub.one<{ n: number }>("SELECT COUNT(*) AS n FROM facts")!.n);
  const before = facts();
  const first = await get("/v1/metrics", keys.owner);
  assert.equal(first.status, 200);
  assert.equal(metric(first.text, "hub_facts_total"), before);
  assert.equal(metric(first.text, "hub_runs", { state: "done" }), 0);
  assert.equal(metric(first.text, "hub_deliveries_given_up_total"), 0);
  for (const sample of samples(first.text)) assert.ok(Number.isFinite(sample.value), JSON.stringify(sample));
  assert.equal((await get("/v1/metrics", keys.owner)).status, 200);
  assert.equal(facts(), before, "光是读指标不能写事实");
});

test("what the numbers say is what /v1/state says, and only work moves them", async () => {
  const line = async () => {
    const answer = await get("/v1/state", keys.owner);
    assert.equal(answer.status, 200);
    const state = JSON.parse(answer.text);
    return { state, body: (await get("/v1/metrics", keys.owner)).text };
  };

  const start = await line();
  assert.equal(metric(start.body, "hub_runs", { state: "done" }), 0);

  const done = hub.ingest("app", { id: "e-done", type: "feedback.new", subject: "one" }, at(1));
  const job = hub.claimNext("w1", "claim-1", at(1))!;
  assert.deepEqual(done.routed, ["意见"]);
  hub.finish(
    job.run,
    job.token,
    {
      outcome: "done",
      usage: { input: 1200, output: 200, cost: 0.01 },
      ask: [{ title: "选一个", text: "两种都行。", options: ["一", "二"] }],
    },
    at(2),
  );
  hub.ingest("app", { id: "e-open", type: "feedback.new", subject: "two" }, at(3));
  hub.claimNext("w1", "claim-2", at(3));

  const now = await line();
  const rule = now.state.lines.find((item: { name: string }) => item.name === "意见");
  assert.equal(metric(now.body, "hub_runs", { state: "done" }), now.state.totals.done);
  assert.equal(metric(now.body, "hub_runs", { state: "claimed" }), now.state.totals.running);
  assert.equal(metric(now.body, "hub_runs", { state: "queued" }), now.state.totals.queued);
  assert.equal(metric(now.body, "hub_runs", { state: "retrying" }), now.state.totals.retrying);
  assert.equal(metric(now.body, "hub_runs_done_today"), now.state.totals.doneToday);
  assert.equal(metric(now.body, "hub_cards_open"), now.state.cards.length);
  assert.equal(metric(now.body, "hub_run_cost_total", { rule: "意见" }), rule.totals.usage.cost);
  assert.equal(
    metric(now.body, "hub_run_tokens_total", { rule: "意见" }),
    rule.totals.usage.input + rule.totals.usage.output,
  );

  const facts = Number(hub.one<{ n: number }>("SELECT COUNT(*) AS n FROM facts")!.n);
  const seq = Number(hub.one<{ seq: number }>("SELECT MAX(seq) AS seq FROM facts")!.seq);
  assert.equal(metric(now.body, "hub_facts_total"), facts);
  assert.equal(metric(now.body, "hub_facts_seq"), seq);
  assert.equal(metric(now.body, "hub_projection_seq"), seq);
  assert.equal(metric(now.body, "hub_projection_lag"), 0);
  assert.equal(metric(now.body, "hub_projection_format_matches"), 1);
  assert.equal(metric(now.body, "hub_db_bytes", { file: "hub.db" }), statSync(join(home, "hub.db")).size);

  assert.equal(metric(now.body, "hub_workers_online"), 0, "没人报过到的接单程序不算在线");
  hub.heartbeat("w1", [], Date.now());
  const handed = JSON.parse((await get("/v1/cards/next?wait=0", keys.chat)).text).card as {
    id: number;
    version: number;
  } | null;
  assert.ok(handed, "通道来领卡片才算在线");
  hub.delivered("chat", handed.id, handed.version, "om_x", Date.now());
  const online = await get("/v1/metrics", keys.owner);
  assert.equal(metric(online.text, "hub_workers_online"), 1);
  assert.equal(metric(online.text, "hub_channels_online"), 1);
});

test("a failed delivery and a given-up one are told apart, and a rebuilt projection keeps saying so", async () => {
  // The sweep normally reaps the run the last test left in hand when its timer gets a turn; under a loaded test
  // runner that turn may come late and block this claim. Sweep here, once, so what follows is deterministic.
  hub.sweep(Date.now());
  // A card someone has to decide on is open, so the channel is handed it whenever it asks.
  hub.ingest("app", { id: "e-ask", type: "feedback.new", subject: "third" }, at(5));
  const job = hub.claimNext("w1", "claim-3", at(5))!;
  hub.finish(
    job.run,
    job.token,
    { outcome: "done", ask: [{ title: "问题", text: "内容", options: ["一", "二"] }] },
    at(5),
  );
  const card = Number(hub.one<{ id: number }>("SELECT id FROM cards WHERE run_id = ?", [job.run])!.id);

  // The channel is handed the cards that came before it, then the one it keeps failing to send.
  let sent = hub.nextCard("ops", at(6));
  for (let round = 0; round < 6 && sent && sent.id !== card; round += 1) {
    hub.delivered("ops", sent.id, sent.version, `om_${sent.id}`, at(6));
    sent = hub.nextCard("ops", at(6));
  }
  assert.equal(sent?.id, card, "这张卡片交给了运维群");
  hub.failed("ops", card, sent!.version, "平台 400", at(6));

  const failedOnce = await get("/v1/metrics", keys.owner);
  assert.equal(metric(failedOnce.text, "hub_deliveries_failed_total"), 1);
  assert.equal(metric(failedOnce.text, "hub_deliveries_given_up_total"), 0);

  // A channel that keeps asking and keeps failing walks the resend schedule until the hub gives the card up.
  let clock = 6;
  let tries = 0;
  while (tries < 12 && clock < 200) {
    clock += 1;
    const again = hub.nextCard("ops", at(clock));
    if (!again || again.id !== card) continue;
    tries += 1;
    hub.failed("ops", card, again.version, "平台 400", at(clock));
  }
  const givenUp = await get("/v1/metrics", keys.owner);
  assert.equal(metric(givenUp.text, "hub_deliveries_given_up_total"), 1);
  assert.equal(metric(givenUp.text, "hub_deliveries_failed_total"), 0, "放弃的不再算作还在失败");

  const facts = Number(hub.one<{ n: number }>("SELECT COUNT(*) AS n FROM facts")!.n);
  const seq = Number(hub.one<{ seq: number }>("SELECT MAX(seq) AS seq FROM facts")!.seq);
  // A projection left behind by another build is what this machine has on disk until something asks for a view: it is
  // said out loud here, and rebuilt from the log the moment the numbers are asked for through the door.
  rebuild(hub.db, "别的版本留下的投影");
  const stale = metricsText("abc123");
  assert.equal(metric(stale, "hub_projection_format_matches"), 0, "别的版本留下的投影认得出来");
  assert.equal(metric(stale, "hub_facts_total"), facts, "事实只看日志，不看投影");

  const afterRebuild = await get("/v1/metrics", keys.owner);
  assert.equal(afterRebuild.status, 200);
  assert.equal(metric(afterRebuild.text, "hub_projection_format_matches"), 1, "门一开就按本机的格式重建");
  assert.equal(metric(afterRebuild.text, "hub_projection_seq"), seq, "重建把日志读完了");
  assert.equal(metric(afterRebuild.text, "hub_projection_lag"), 0);
  assert.equal(metric(afterRebuild.text, "hub_facts_total"), facts);
  assert.equal(metric(afterRebuild.text, "hub_deliveries_given_up_total"), 1, "重建后说的还是日志里的事");
  assert.equal(
    metric(afterRebuild.text, "hub_cards_open"),
    Number(hub.one<{ n: number }>("SELECT COUNT(*) AS n FROM cards WHERE state='open'")!.n),
  );
});
