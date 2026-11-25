// A receipt's event whose id already holds a different event is not applied, and the receipt says so in `rejected`, next
// to the ones the rule's emits list turned away. An agent that sent one and got no number, no notice and no line anywhere
// could only assume it landed. Failure cases: the clash vanishes silently (what happened before this test); the same event
// sent again under its fixed id, as a poll does every round, is reported as not applied; the same execution handing in
// the same result again is counted as rejected a second time instead of as the replay it is; a new id is turned away.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { at, setup } from "./helpers.ts";

const home = setup("receipt-duplicate");
const fixture = JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_RULES!, "utf8"));
const rule = fixture.rules.find((r: { name: string }) => r.name === "意见");
rule.emits = { source: "app", types: ["feedback.*"] };
const rulesFile = join(home, "rules.json");
writeFileSync(rulesFile, JSON.stringify(fixture));
process.env.AGENT_AUTOLOOP_RULES = rulesFile;
const hub = await import("./hub.ts");
const { all, one } = await import("./storage.ts");

const note = (n: number) => ({
  id: `feedback:${n}:new`,
  type: "feedback.new",
  subject: `#${n}`,
  summary: `第 ${n} 条`,
});
const sent = (id: string) =>
  all<{ key: string; type: string; subject: string }>(
    "SELECT key, type, subject FROM events WHERE key = ? ORDER BY id",
    [id],
  );
const eventCount = () => one<{ n: number }>("SELECT count(*) AS n FROM events")!.n;

test("an event id that is already taken is not applied, and the receipt lists it with the reasons", () => {
  hub.ingest("app", note(1), at(0));
  const first = hub.claimNext("w1", "claim-1", at(0))!;
  const firstReceipt = hub.finish(
    first.run,
    first.token,
    {
      outcome: "done",
      summary: "好了",
      events: [{ id: "taken", type: "feedback.done", subject: "#1", summary: "第一条" }],
    },
    at(1),
  );
  assert.deepEqual(firstReceipt.rejected, []);
  assert.deepEqual(sent("taken"), [{ key: "taken", type: "feedback.done", subject: "#1" }]);
  assert.equal(eventCount(), 2, "the event that started the run, and the one it sent");

  // Another run, another subject, the same id under another type: the hub keeps the first one's meaning for that id.
  hub.ingest("app", note(2), at(5));
  const second = hub.claimNext("w1", "claim-2", at(5))!;
  const result = {
    outcome: "done",
    summary: "也好了",
    events: [{ id: "taken", type: "feedback.new", subject: "#2", summary: "第二条" }],
  };
  const secondReceipt = hub.finish(second.run, second.token, result, at(6));
  assert.deepEqual(secondReceipt.rejected, [
    { what: "events", reason: "事件「taken」这个编号已经记过另一件事，这次没有记" },
  ]);
  assert.deepEqual(
    sent("taken"),
    [{ key: "taken", type: "feedback.done", subject: "#1" }],
    "the table still has only the first",
  );
  assert.equal(eventCount(), 3, "only the event that started this run was added; the one it sent was not");

  // The same execution handing in the same result again is the replay it always was: same answer, marked as such.
  const again = hub.finish(second.run, second.token, result, at(7));
  assert.deepEqual(again, { rejected: secondReceipt.rejected, duplicate: true });
  assert.equal(sent("taken").length, 1);

  // The same event sent again under its number is how a source stays idempotent: nothing to report.
  hub.ingest("app", note(4), at(8));
  const fourth = hub.claimNext("w1", "claim-4", at(8))!;
  const resent = hub.finish(
    fourth.run,
    fourth.token,
    {
      outcome: "done",
      summary: "又发了一次",
      events: [{ id: "taken", type: "feedback.done", subject: "#1", summary: "第一条" }],
    },
    at(9),
  );
  assert.deepEqual(resent.rejected, []);
  assert.equal(sent("taken").length, 1);

  // An id nobody has used is taken as before.
  hub.ingest("app", note(3), at(10));
  const third = hub.claimNext("w1", "claim-3", at(10))!;
  const thirdReceipt = hub.finish(
    third.run,
    third.token,
    {
      outcome: "done",
      summary: "好了",
      events: [{ id: "fresh", type: "feedback.new", subject: "#3", summary: "第三条" }],
    },
    at(11),
  );
  assert.deepEqual(thirdReceipt.rejected, []);
  assert.deepEqual(sent("fresh"), [{ key: "fresh", type: "feedback.new", subject: "#3" }]);
  assert.equal(eventCount(), 6);
});
