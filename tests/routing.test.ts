// Failure modes: a rule bound to one channel leaks its cards to every other channel; system cards ignore the
// notices.channels the owner narrowed them to; changing a rule moves cards that already exist, or fails to route the
// new ones; why cannot say where a card was sent and why.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { at, setup } from "./helpers.ts";
setup("routing");
const hub = await import("../host/runtime.ts");
const { all, one, run } = await import("./storage.ts");
after(() => hub.db.close());

const clean = () => {
  for (const table of ["run_events", "runs", "events", "seen", "cards", "deliveries", "timers", "schedules"])
    run(`DELETE FROM ${table}`);
};
const origin = structuredClone(hub.getView().get("config", "rules")!.value);
const reset = () => {
  clean();
  hub.execute("rules", [structuredClone(origin)], at(0));
};
const withChannels = (name: string, channels: string[] | undefined) => {
  const next = structuredClone(origin);
  const rule = next.rules.find((rule: { name: string }) => rule.name === name);
  if (channels === undefined) delete rule.channels;
  else rule.channels = channels;
  return next;
};
const withNotices = (channels: string[] | undefined) => {
  const next = structuredClone(origin);
  if (channels === undefined) delete next.notices;
  else next.notices = { channels };
  return next;
};
const askCard = (n: number, now: number) => {
  hub.ingest("app", { id: `routing:${n}`, type: "feedback.new", subject: `#${n}` }, now);
  const job = hub.claimNext("w1", `c${n}`, now)!;
  hub.finish(
    job.run,
    job.token,
    { outcome: "done", ask: [{ title: `问 ${n}`, text: "选", options: ["甲", "乙"], key: `k${n}` }] },
    now + 1,
  );
  return one<{ id: number }>("SELECT id FROM cards WHERE run_id = ?", [job.run])!.id;
};

test("a rule bound to one channel keeps its cards away from the others", () => {
  reset();
  hub.execute("rules", [withChannels("意见", ["chat"])], at(1));
  const card = askCard(1, at(2));
  assert.equal(hub.nextCard("plain", at(3)), null, "the other channel gets nothing");
  assert.equal(hub.nextCard("chat", at(3))!.id, card);
});

test("without channels a card is handed to every channel, as before", () => {
  reset();
  const card = askCard(1, at(1));
  assert.equal(hub.nextCard("chat", at(2))!.id, card);
  assert.equal(hub.nextCard("plain", at(2))!.id, card, "the old behaviour: every registered channel");
});

test("system cards follow notices.channels, and default to every channel", () => {
  reset();
  hub.tell("routing-note-1", "记一笔", "默认发到所有通道", at(1));
  assert.equal(hub.nextCard("plain", at(2))!.title, "记一笔");
  assert.equal(hub.nextCard("chat", at(2))!.title, "记一笔");
  clean();
  hub.execute("rules", [withNotices(["plain"])], at(3));
  hub.tell("routing-note-2", "收窄了", "只发 plain", at(4));
  assert.equal(hub.nextCard("plain", at(5))!.title, "收窄了");
  assert.equal(hub.nextCard("chat", at(5)), null);
});

test("changing a rule moves no card that exists, and routes the new ones by the new rule", () => {
  reset();
  hub.execute("rules", [withChannels("意见", ["chat"])], at(1));
  const card1 = askCard(1, at(2));
  hub.execute("rules", [withChannels("意见", ["plain"])], at(3));
  const card2 = askCard(2, at(4));
  assert.equal(
    hub.nextCard("chat", at(5))!.id,
    card1,
    "the card made before the change still goes where it was made to",
  );
  assert.equal(hub.nextCard("chat", at(5)), null, "and nothing new follows it there");
  assert.equal(hub.nextCard("plain", at(5))!.id, card2);
});

test("why shows the channels a card was created with", () => {
  reset();
  hub.execute("rules", [withChannels("意见", ["chat"])], at(1));
  hub.ingest("app", { id: "routing:why", type: "feedback.new", subject: "#why" }, at(2));
  const job = hub.claimNext("w1", "why", at(2))!;
  hub.finish(
    job.run,
    job.token,
    { outcome: "done", ask: [{ title: "问 why", text: "选", options: ["甲", "乙"] }] },
    at(3),
  );
  const card = all<{ id: number }>("SELECT id FROM cards WHERE state = 'open'")[0].id;
  const change = hub
    .why(job.run)
    .flatMap((fact: { changes: { table: string; key: string; row: { channels?: string[] } | null }[] }) => fact.changes)
    .find((change: { table: string; key: string }) => change.table === "cards" && change.key === String(card));
  assert.deepEqual(change!.row!.channels, ["chat"]);
});
