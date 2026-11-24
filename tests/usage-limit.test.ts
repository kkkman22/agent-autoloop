// An Agent that has used up its subscription for now, such as Claude Code at its 5-hour limit. Seen on 2026-11-06: a batch
// of 296 events ran out the limit, and every queued round was then handed out, failed within two seconds and was tried
// again, until the owner stopped 93 of them. Failure cases: once one round says the agent is limited until a time, other
// rounds for it are still handed out before then, or rounds for other agents are held too; events that come meanwhile are
// dropped or skipped instead of waiting; nothing starts again by itself at that time, or the round that hit the limit is
// tried before it; the owner isn't told when it comes back, is told once per round or per agent that hit it, or the shared
// card points at an agent that's already back, closes while another is still held, or stays open after they're all back; the
// owner can't try the agent before then, or a round that got through then leaves the hold in place, or the rounds that hit
// the limit still wait for the reset; the ask is spent on the round it sent rather than living on in its retries, and an
// ask made while the thread's round was running waits out that round's backoff instead of going when it fails; a time
// that isn't one, or one on a round that didn't
// fail, is taken; a time days off, which no usage limit gives, holds the agent that long; a time already past, as from a
// result read late, is recorded and told to the owner as a hold; the hold is lost when the
// projection is rebuilt from the log; the state view still reports the agent as held after its reset has passed, until a
// tick lifts the row.
import assert from "node:assert/strict";
import { test } from "node:test";
import { at, setup } from "./helpers.ts";

setup("usage-limit");
const { execute, tick, ingest, claimNext, heartbeat, finish, stateOf, db, getView } = await import("./hub.ts");
const { rebuild } = await import("../kernel/store.ts");
const { all, run } = await import("./storage.ts");

const clean = () => {
  for (const table of ["run_events", "runs", "events", "seen", "cards", "deliveries", "timers", "schedules", "limits"])
    run(`DELETE FROM ${table}`);
};
const claim = (now: number) => claimNext("w1", `c${Math.random()}`, now);
const feedback = (subject: string, now: number) =>
  ingest("app", { id: `f${subject}`, type: "feedback.new", subject }, now);
const limited = (until: number) => ({
  outcome: "failed",
  error: "You've hit your 5-hour limit · resets 11:00am (Asia/Shanghai)",
  limitedUntil: new Date(until).toISOString(),
});
const notices = () =>
  all<{ title: string; text: string; state: string }>(
    "SELECT title, text, state FROM cards WHERE kind = 'notice' AND key LIKE 'limit:%' ORDER BY id",
  );

test("an agent out of quota is handed nothing until it resets, and what comes meanwhile waits for it", () => {
  clean();
  heartbeat("w1", [], at(0));
  for (const subject of ["#1", "#2", "#3"]) feedback(subject, at(0));
  const first = claim(at(1))!;
  const second = claim(at(1))!;
  finish(first.run, first.token, limited(at(60)), at(2));
  assert.equal(claim(at(3)), null, "#3 is queued for the same agent, and held");
  feedback("#4", at(4));
  assert.deepEqual(
    all<{ state: string }>("SELECT state FROM runs WHERE rule = '意见' AND id NOT IN (?, ?)", [
      first.run,
      second.run,
    ]).map((row) => row.state),
    ["queued", "queued"],
    "what came meanwhile is queued, not skipped",
  );
  finish(second.run, second.token, limited(at(60)), at(5));
  assert.equal(notices().length, 1, "two rounds hit the limit, the owner hears once");
  assert.match(notices()[0].text, /11:00/);
  assert.equal(
    stateOf(at(6)).agents.find((agent) => agent.id === "a1")!.limited!.until,
    new Date(at(60)).toISOString(),
  );
  execute("runRule", ["巡检", "owner", {}], at(7));
  assert.equal(claim(at(7))!.rule.name, "巡检", "another agent on the same worker goes on");
  tick(at(59));
  assert.equal(claim(at(59)), null);
  // The row is still there — no tick has lifted it — but the moment it named has passed, and it already holds nothing.
  assert.equal(
    stateOf(at(60) + 1).agents.find((agent) => agent.id === "a1")!.limited,
    null,
    "past its reset an agent is free, before the tick that lifts the row",
  );
  tick(at(60));
  const after = [claim(at(60)), claim(at(60)), claim(at(60))];
  assert.ok(
    after.every((job) => job?.rule.name === "意见"),
    "the rounds that hit the limit and the one held go again, as parallel allows",
  );
  assert.equal(stateOf(at(61)).agents.find((agent) => agent.id === "a1")!.limited, null);
  assert.equal(notices()[0].state, "closed", "back, so the card has nothing more to say");
});

test("agents on one account, told the same reset, make one card, closed when they are back", () => {
  clean();
  heartbeat("w1", [], at(0));
  heartbeat("w2", [], at(0));
  ingest("ops", { id: "a1", type: "alert.raised", subject: "db" }, at(0));
  const first = claimNext("w2", "c-w2", at(1))!;
  const second = claim(at(1))!;
  finish(first.run, first.token, limited(at(60)), at(2));
  finish(second.run, second.token, limited(at(60)), at(2));
  assert.deepEqual(
    notices().map(({ title, state }) => ({ title, state })),
    [{ title: "Agent 用量到上限", state: "open" }],
  );
  assert.match(notices()[0].text, /agent-autoloop status/);
  assert.doesNotMatch(notices()[0].text, /甲|乙|意见|告警/);
  execute("runRule", ["告警", "owner", {}], at(3));
  const probe = claimNext("w2", "probe-w2", at(3))!;
  finish(probe.run, probe.token, { outcome: "nothing", summary: "没事" }, at(4));
  assert.ok(stateOf(at(4)).agents.find((agent) => agent.id === "a1")!.limited, "the other agent is still held");
  assert.deepEqual(
    notices().map((card) => card.state),
    ["open"],
    "one agent recovering early does not close their shared notice",
  );
  tick(at(60));
  assert.deepEqual(
    notices().map((card) => card.state),
    ["closed"],
  );
});

test("the owner can try the agent before then, and a round that gets through lifts the hold", () => {
  clean();
  heartbeat("w1", [], at(0));
  feedback("#1", at(0));
  feedback("#2", at(0));
  const first = claim(at(1))!;
  finish(first.run, first.token, limited(at(300)), at(2));
  execute("runRule", ["意见", "owner", { subject: "#9" }], at(3));
  const probe = claim(at(3))!;
  assert.equal(probe.context.events[0].type, "run.manual", "only the owner's round goes");
  assert.equal(claim(at(3)), null);
  finish(probe.run, probe.token, { outcome: "nothing", summary: "没事" }, at(4));
  assert.deepEqual(
    [claim(at(4)), claim(at(4))].map((job) => job?.context.events[0].subject).sort(),
    ["#1", "#2"],
    "it works again, so the rest go, and the round that hit the limit with them, not at the reset it was told",
  );
});

test("a reset already past, or more than eight days off, is no usage limit: the round fails as any other", () => {
  clean();
  heartbeat("w1", [], at(0));
  feedback("#1", at(0));
  feedback("#2", at(0));
  feedback("#3", at(0));
  const job = claim(at(1))!;
  finish(job.run, job.token, limited(at(9 * 24 * 60)), at(2));
  const next = claim(at(3))!;
  assert.equal(next.context.events[0].subject, "#2", "nothing is held");
  finish(next.run, next.token, limited(at(2)), at(4));
  assert.equal(claim(at(5))!.context.events[0].subject, "#3", "nothing is held by a reset that has passed");
  assert.deepEqual(notices(), []);
  assert.equal(stateOf(at(5)).agents.find((agent) => agent.id === "a1")!.limited, null);
  assert.equal(claim(at(7))!.context.events[0].subject, "#1", "tried again after the usual wait");
});

test("an ask made while the thread's round was running goes when that round fails, not at the reset", () => {
  clean();
  heartbeat("w1", [], at(0));
  feedback("#1", at(0));
  const running = claim(at(1))!;
  execute("runRule", ["意见", "owner", { subject: "#1" }], at(2));
  finish(running.run, running.token, limited(at(60)), at(3));
  const probe = claim(at(4))!;
  assert.equal(probe.run, running.run, "the kept round carries the ask, and goes now");
  assert.ok(
    probe.context.events.some((event: any) => event.type === "run.manual"),
    "with the ask's own event merged in",
  );
});

test("the ask is spent on the round it sent, not on that round's retries", () => {
  clean();
  heartbeat("w1", [], at(0));
  feedback("#1", at(0));
  const first = claim(at(1))!;
  finish(first.run, first.token, limited(at(300)), at(2));
  execute("runRule", ["意见", "owner", {}], at(3));
  const probe = claim(at(3))!;
  assert.equal(probe.context.events[0].type, "run.manual");
  finish(probe.run, probe.token, limited(at(300)), at(4));
  assert.equal(claim(at(5)), null, "the probe failed, so what's left waits for the reset like any other round");
  assert.equal(
    stateOf(at(5)).runs.find((r: any) => r.id === probe.run)!.manual,
    false,
    "the ask was for that one dispatch; its retries aren't shown as the owner's",
  );
  tick(at(300));
  assert.ok(claim(at(300)), "and goes again at the reset");
});

// Last: a rebuild replays the whole log, including what the fixture resets above only cleared from the projection.
test("a hold is a fact in the log, and only a failed round can say until when", () => {
  clean();
  heartbeat("w1", [], at(0));
  feedback("#1", at(0));
  const job = claim(at(1))!;
  assert.throws(
    () => finish(job.run, job.token, { outcome: "done", limitedUntil: new Date(at(60)).toISOString() }, at(2)),
    /limitedUntil/,
  );
  assert.throws(() => finish(job.run, job.token, { outcome: "failed", limitedUntil: "11点" }, at(2)), /limitedUntil/);
  finish(job.run, job.token, limited(at(60)), at(2));
  rebuild(db, "throwaway");
  getView();
  feedback("#2", at(3));
  assert.equal(claim(at(3)), null, "still held after the projection is rebuilt");
});
