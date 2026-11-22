// Failure modes: --json changes the state instead of printing it; the human output stops being the plain one; an
// unknown flag is ignored and the command quietly does something else; a client can't tell where in the log the state
// was read, so it replays the whole log or misses what came between; an owner's card can't be tied to the matter it's
// about; a rule's tags don't reach its line, its runs and cards or the round's context, so a client grouping by them or an
// Agent wanting to know which group it works for has to guess; a rule without tags hands an Agent a context unlike before.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { at, setup } from "./helpers.ts";

const home = setup("status-json");
const hub = await import("./hub.ts");
const { serve } = await import("../host/http.ts");
const server = serve(0);
await once(server, "listening");
after(() => {
  server.closeAllConnections();
  server.close();
  if (hub.db.isOpen) hub.db.close();
});
writeFileSync(
  join(home, "config.json"),
  JSON.stringify({ url: `http://127.0.0.1:${(server.address() as any).port}`, owner: hub.addKey("owner", "reader") }),
);
const cli = async (...args: string[]) =>
  (
    await promisify(execFile)(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "../bin/agent-autoloop.ts"), ...args],
      { env: { ...process.env } },
    )
  ).stdout;

test("state exposes only pending timers on the first page", () => {
  hub.ingest("app", { id: "timer-state", type: "feedback.new", subject: "#timer" }, at(0));
  const job = hub.claimNext("w1", "timer-state", at(0))!;
  hub.finish(
    job.run,
    job.token,
    { outcome: "done", later: [{ key: "verify", at: new Date(at(100)).toISOString(), about: "核对结果" }] },
    at(1),
  );
  assert.deepEqual(hub.stateOf(at(2)).timers, [
    { rule: "意见", lane: "#timer", key: "verify", about: "核对结果", at: new Date(at(100)).toISOString() },
  ]);
  assert.deepEqual(hub.stateOf(at(2), job.run + 1).timers, []);
  hub.execute("tick", [], at(101));
  assert.deepEqual(hub.stateOf(at(101)).timers, []);
});

test("the state says where in the log it was read, so a client goes on from there in the stream", () => {
  const read = hub.stateOf(at(3));
  assert.equal(read.seq, hub.logAfter(0).at(-1)!.seq);
  hub.ingest("app", { id: "after-the-state", type: "nobody.takes", subject: "#later" }, at(4));
  const since = hub.logAfter(read.seq);
  assert.ok(since.length > 0, "what came after it is in the stream from there");
  assert.equal(hub.stateOf(at(5)).seq, since.at(-1)!.seq);
});

test("the owner's cards say which matter they're about and what the asker left for itself", () => {
  hub.ingest("app", { id: "card-lane", type: "feedback.new", subject: "#77" }, at(6));
  const job = hub.claimNext("w1", "card-lane", at(6))!;
  const ask = { title: "要不要退款", text: "他说坏了", options: ["退", "不退"], about: "退款走后台第三页" };
  hub.finish(job.run, job.token, { outcome: "done", ask: [ask] }, at(7));
  const card = hub.stateOf(at(8)).cards.find((open: { title: string }) => open.title === ask.title)!;
  assert.equal(card.lane, "#77");
  assert.equal(card.about, ask.about);
});

test("a rule's tags go with its line, its runs and cards, and the context of its rounds", () => {
  hub.ingest("app", { id: "tagged", type: "feedback.new", subject: "#tags" }, at(9));
  const job = hub.claimNext("w1", "tagged", at(9))!;
  assert.deepEqual(job.context.tags, ["shop", "反馈"]);
  hub.finish(
    job.run,
    job.token,
    { outcome: "done", ask: [{ title: "打标签了吗", text: "看看", options: ["是", "否"] }] },
    at(10),
  );
  const state = hub.stateOf(at(11));
  const tagged = ["shop", "反馈"];
  assert.deepEqual(state.lines.find((line: any) => line.name === "意见")!.tags, tagged);
  assert.deepEqual(state.lines.find((line: any) => line.name === "告警")!.tags, [], "a rule without tags has none");
  assert.deepEqual(state.runs.find((run: any) => run.id === job.run)!.tags, tagged);
  assert.deepEqual(state.cards.find((card: any) => card.title === "打标签了吗")!.tags, tagged);
  assert.deepEqual(hub.runsOfRule("意见").runs[0].tags, tagged);
  hub.ingest("ops", { id: "untagged", type: "alert.raised", subject: "#cpu" }, at(12));
  const plain = hub.claimNext("w2", "untagged", at(12))!;
  assert.equal(plain.rule.name, "告警");
  assert.ok(!("tags" in plain.context), "a rule without tags hands over the same context as before");
});

test("status --json prints the same state the hub serves, and the plain output stays human", async () => {
  hub.execute(
    "rules",
    [
      hub.parseRules(
        JSON.stringify({
          sources: { local: { name: "本机" } },
          agents: { helper: { name: "助手", worker: "this-machine", use: "command", command: ["true"] } },
          channels: {},
          rules: [],
        }),
        Date.now(),
      ),
    ],
    Date.now(),
  );
  const state = JSON.parse(await cli("status", "--json"));
  assert.deepEqual(Object.keys(state).sort(), Object.keys(hub.stateOf()).sort());
  assert.equal(state.timezone, hub.stateOf().timezone);
  assert.ok(Array.isArray(state.runs));
  assert.ok(Array.isArray(state.cards));
  const human = await cli("status");
  assert.ok(!human.trim().startsWith("{"));
  assert.match(human, /在跑|排队|等你/);
  assert.doesNotMatch(human, /\x1b/, "no colour codes when it isn't a terminal");
});

test("an unknown flag is refused instead of ignored", async () => {
  await assert.rejects(cli("status", "--wat"), /不认识的参数/);
});
