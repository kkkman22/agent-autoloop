// Failure modes: a preview that lies about what deleting a rule would cancel and close, so the owner confirms a
// deletion believing nothing is lost; a preview that writes facts, so reading changes the hub; a source key reading
// the impact of a change; an oversized body accepted; a candidate that reads like a rules file but isn't one.
// Candidates come from file text, like the commands send them: the hub's own config value carries the injected
// schedule source and would be refused, as any hand-made body without the required fields should be.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";
setup("rules-preview");
const hub = await import("../host/runtime.ts");
const { makeHandler } = await import("../host/server.ts");
const runtime = makeHandler();
const owner = hub.addKey("owner", "me");
const source = hub.addKey("source", "app");
after(() => {
  runtime.close();
  hub.db.close();
});
const facts = () => hub.one<{ n: number }>("SELECT COUNT(*) AS n FROM facts")!.n;
const post = (body: string, key = owner) =>
  runtime.handle(
    new Request("http://local/v1/rules/preview", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body,
    }),
  );
const file = readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8");
const candidate = (change: (raw: { rules: Record<string, unknown>[] }) => void) => {
  const raw = JSON.parse(file);
  change(raw);
  return JSON.stringify(raw);
};
const without = (name: string) => candidate((raw) => void (raw.rules = raw.rules.filter((rule) => rule.name !== name)));
const note = (n: number) => ({ id: `preview:${n}`, type: "feedback.new", subject: `#${n}` });
const origin = structuredClone(hub.getView().get("config", "rules")!.value);

function askedCard(n: number, now: number) {
  hub.ingest("app", note(n), now);
  const job = hub.claimNext("w1", `c${n}`, now)!;
  hub.finish(
    job.run,
    job.token,
    { outcome: "done", ask: [{ title: `问 ${n}`, text: "选一个", options: ["甲", "乙"], key: `k${n}` }] },
    now + 1,
  );
  return job.run;
}

test("preview says exactly what removing a rule would do, and writes nothing", async () => {
  hub.execute("rules", [structuredClone(origin)], 0);
  hub.ingest("app", note(1), 1000);
  askedCard(2, 2000);
  const queuedId = hub.one<{ id: number }>("SELECT id FROM runs WHERE state = 'queued'")!.id;
  const before = facts();
  const response = await post(without("意见"));
  assert.equal(response.status, 200);
  const summary = await response.json();
  assert.deepEqual(summary.removed, ["意见"]);
  assert.deepEqual(summary.added, []);
  assert.deepEqual(summary.renamed, []);
  assert.deepEqual(summary.changed, []);
  assert.deepEqual(summary.cancels, [{ rule: "意见", count: 1, runs: [queuedId] }]);
  assert.equal(summary.closes.length, 1);
  assert.equal(summary.closes[0].rule, "意见");
  assert.equal(summary.closes[0].count, 1);
  assert.equal(summary.closes[0].cards[0].title, "问 2");
  assert.deepEqual(summary.claimed, [], "nothing is claimed here");
  assert.equal(facts(), before, "a preview leaves the log alone");
});

test("preview recognizes a rename, a change, and an identical file", async () => {
  const summary = await (
    await post(
      candidate((raw) => {
        raw.rules[0].name = "意见2";
      }),
    )
  ).json();
  assert.deepEqual(summary.renamed, [{ from: "意见", to: "意见2" }]);
  assert.deepEqual(summary.removed, []);
  assert.deepEqual(summary.added, []);
  const changedSummary = await (
    await post(
      candidate((raw) => {
        raw.rules[0].cwd = "~/elsewhere";
      }),
    )
  ).json();
  assert.deepEqual(changedSummary.changed, ["意见"]);
  assert.deepEqual(await (await post(file)).json(), {
    added: [],
    removed: [],
    renamed: [],
    changed: [],
    cancels: [],
    closes: [],
    claimed: [],
  });
});

test("a claimed run is listed as left alone, not as cancelled", async () => {
  hub.ingest("app", note(3), 3000);
  const job = hub.claimNext("w1", "held", 3000)!;
  const summary = await (await post(without("意见"))).json();
  assert.deepEqual(summary.claimed, [{ run: job.run, rule: "意见" }]);
  hub.finish(job.run, job.token, { outcome: "done", summary: "已经领走的照常跑完" }, 3100);
});

test("only the owner previews, and a body over the size limit or without the fields is refused", async () => {
  assert.equal((await post("{}", source)).status, 401);
  const padded = JSON.parse(file);
  padded.rules[0].prompt = "长".repeat(1024 * 1024);
  assert.equal((await post(JSON.stringify(padded))).status, 413);
  assert.equal((await post("{ 不是 JSON")).status, 400);
  const bad = await post(candidate((raw) => void raw.rules.push({ name: "没有 when", to: "a1" })));
  assert.equal(bad.status, 400);
  assert.match(await bad.json().then((body) => body.error), /rules.json 有问题/);
});
