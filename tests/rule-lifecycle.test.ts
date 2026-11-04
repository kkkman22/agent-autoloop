// What happens to work when its rule is deleted or renamed. Failure cases: a queued run stays queued for ever and no
// worker can claim it; an open card stays open although its rule is gone; an answer lands on a card whose thread can no
// longer run, and is recorded as if it would; the owner is told once per change instead of once per lost item; a failed
// run with no rule goes back to the queue and waits for ever; restoring a rule leaves new work stuck behind old state.
import assert from "node:assert/strict";
import { test } from "node:test";
import { at, setup } from "./helpers.ts";

setup("rule-lifecycle");
const hub = await import("../host/runtime.ts");
const { Conflict } = await import("../kernel/errors.ts");
const { all, one, run } = await import("./storage.ts");

const clean = () => {
  for (const table of ["run_events", "runs", "events", "seen", "cards", "deliveries", "timers"])
    run(`DELETE FROM ${table}`);
};
const note = (n: number) => ({ id: `feedback:${n}:new`, type: "feedback.new", subject: `#${n}` });
const origin = structuredClone(hub.getView().get("config", "rules")!.value);
const without = (...names: string[]) => {
  const next = structuredClone(origin);
  next.rules = next.rules.filter((rule: { name: string }) => !names.includes(rule.name));
  return next;
};
const reset = () => {
  clean();
  hub.execute("rules", [structuredClone(origin)], at(0));
};

/** A run on subject #n that ends by asking, and the card it made. */
function askedCard(n: number, now = at(0)) {
  hub.ingest("app", note(n), now);
  const job = hub.claimNext("w1", `c${n}`, now)!;
  hub.finish(
    job.run,
    job.token,
    { outcome: "done", ask: [{ title: `问 ${n}`, text: "选一个", options: ["甲", "乙"], key: `k${n}` }] },
    now + 1,
  );
  const card = one<{ id: number; state: string }>("SELECT id, state FROM cards WHERE run_id = ?", [job.run])!;
  return { id: card.id, run: job.run };
}

test("deleting a rule cancels its queued runs and says so once per run", () => {
  reset();
  hub.ingest("app", note(1), at(0));
  const queued = one<{ id: number }>("SELECT id FROM runs WHERE state = 'queued'")!;
  hub.execute("rules", [without("意见")], at(1));
  const run = one<{ state: string; finished_at: string | null; summary: string }>(
    "SELECT state, finished_at, summary FROM runs WHERE id = ?",
    [queued.id],
  )!;
  assert.deepEqual([run.state, run.finished_at !== null], ["cancelled", true]);
  assert.match(run.summary, /规则已删除/);
  assert.equal(hub.claimNext("w1", "after-delete", at(2)), null, "nothing can claim it any more");
  const notices = () => all("SELECT id FROM cards WHERE key = ?", [`run:${queued.id}:rule-gone`]);
  assert.equal(notices().length, 1);
  hub.execute("rules", [without("意见")], at(3));
  assert.equal(notices().length, 1, "applying the same rules again doesn't tell the owner twice");
});

test("deleting a rule closes its open cards and says so once per card", () => {
  reset();
  const { id } = askedCard(1);
  hub.execute("rules", [without("意见")], at(2));
  const card = one<{ state: string; result: string }>("SELECT state, result FROM cards WHERE id = ?", [id])!;
  assert.deepEqual([card.state, card.result], ["closed", "对应规则已删除"]);
  const notices = () => all("SELECT id FROM cards WHERE key = ?", [`card:${id}:rule-gone`]);
  assert.equal(notices().length, 1);
  hub.execute("rules", [without("意见")], at(3));
  assert.equal(notices().length, 1);
});

test("renaming a rule is deleting the old one: its decided answer is closed instead of waiting", () => {
  reset();
  const { id } = askedCard(1);
  hub.answer(id, { choice: 0, by: "me" }, at(2));
  const answerRun = one<{ id: number }>("SELECT id FROM runs WHERE rule = '意见' AND state = 'queued'")!;
  const renamed = structuredClone(origin);
  renamed.rules[0].name = "意见2";
  hub.execute("rules", [renamed], at(3));
  assert.equal(one<{ state: string }>("SELECT state FROM runs WHERE id = ?", [answerRun.id])!.state, "cancelled");
  const card = one<{ state: string; result: string }>("SELECT state, result FROM cards WHERE id = ?", [id])!;
  assert.deepEqual([card.state, card.result], ["closed", "对应规则已删除"]);
  assert.equal(all("SELECT id FROM cards WHERE key = ?", [`card:${id}:rule-gone`]).length, 1);
  hub.ingest("app", note(2), at(4));
  const job = hub.claimNext("w1", "new-rule", at(4))!;
  assert.equal(job.rule.name, "意见2", "new work goes to the rule that replaced it");
});

test("answering a card whose rule is gone is refused, and the card stays for the owner to resolve", () => {
  reset();
  hub.ingest("app", note(1), at(0));
  const job = hub.claimNext("w1", "held", at(0))!;
  hub.execute("rules", [without("意见")], at(1));
  // A run claimed before the change still finishes; the question it makes has no rule behind it.
  hub.finish(job.run, job.token, { outcome: "done", ask: [{ title: "问", text: "选", options: ["甲", "乙"] }] }, at(2));
  const card = one<{ id: number; state: string }>("SELECT id, state FROM cards WHERE run_id = ?", [job.run])!;
  assert.throws(() => hub.answer(card.id, { choice: 0, by: "me" }, at(3)), Conflict);
  assert.equal(one<{ state: string }>("SELECT state FROM cards WHERE id = ?", [card.id])!.state, "open");
  assert.equal(all("SELECT id FROM events WHERE type = 'card.answered'").length, 0, "no answer was recorded");
  assert.equal(hub.resolve(card.id, "规则删了，不用回答", "owner", at(4)), true);
});

test("a failed run whose rule was deleted stops instead of waiting for ever in the queue", () => {
  reset();
  hub.ingest("app", note(1), at(0));
  const job = hub.claimNext("w1", "held", at(0))!;
  hub.execute("rules", [without("意见")], at(1));
  hub.finish(job.run, job.token, { outcome: "failed", error: "断了" }, at(2));
  const run = one<{ state: string; summary: string }>("SELECT state, summary FROM runs WHERE id = ?", [job.run])!;
  assert.equal(run.state, "cancelled");
  assert.match(run.summary, /规则已删除/);
  assert.equal(hub.claimNext("w1", "later", at(3)), null);
  assert.equal(all("SELECT id FROM cards WHERE key = ?", [`run:${job.run}:rule-gone`]).length, 1);
});

test("restoring a deleted rule lets new work run again", () => {
  reset();
  hub.execute("rules", [without("意见")], at(0));
  hub.execute("rules", [structuredClone(origin)], at(1));
  hub.ingest("app", note(1), at(2));
  const job = hub.claimNext("w1", "restored", at(2))!;
  assert.equal(job.rule.name, "意见");
});
