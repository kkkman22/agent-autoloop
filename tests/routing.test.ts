// Failure modes: a rule bound to one channel leaks its cards to every other channel; system cards ignore the
// notices.channels the owner narrowed them to; changing a rule moves cards that already exist, or fails to route the
// new ones; why cannot say where a card was sent and why. Quiet hours swallow urgent cards or burn delivery attempts
// on cards nobody may see; a window read in the machine's zone silences the wrong hours; a low card pops up anyway.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { at, setup } from "./helpers.ts";
setup("routing");
const hub = await import("../host/runtime.ts");
const { all, one, run } = await import("./storage.ts");
const { parseRules, RulesError } = await import("../protocol/rules.ts");
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
const withQuiet = (chat: Record<string, unknown>, severity?: string) => {
  const next = structuredClone(origin);
  Object.assign(next.channels.chat, chat);
  if (severity) next.rules.find((rule: { name: string }) => rule.name === "意见").severity = severity;
  return next;
};

test("in quiet hours an ordinary card waits and an urgent one goes out", () => {
  reset();
  hub.execute("rules", [withQuiet({ quiet: { from: "09:00", to: "12:00" } })], at(1)); // 10:00 Shanghai
  const card = askCard(1, at(6)); // 10:06: inside the quiet hours
  assert.equal(hub.nextCard("chat", at(6)), null, "an ordinary card waits");
  hub.execute("rules", [withQuiet({ quiet: { from: "09:00", to: "12:00" } }, "urgent")], at(7));
  const now = askCard(2, at(8));
  assert.equal(hub.nextCard("chat", at(9))!.id, now, "an urgent card ignores the quiet hours");
  assert.equal(hub.nextCard("chat", at(9)), null, "the ordinary one still waits, even after the urgent went");
});

test("quiet hours follow the rules' zone, not the machine's", () => {
  reset();
  const utc = structuredClone(origin);
  utc.timezone = "UTC";
  utc.channels.chat.quiet = { from: "09:00", to: "12:00" };
  hub.execute("rules", [utc], at(1));
  const card = askCard(1, at(6)); // at(6) is 02:06 UTC: outside 09:00-12:00 there, though it is 10:06 in Shanghai
  assert.equal(hub.nextCard("chat", at(6))!.id, card, "02:06 UTC is not quiet in UTC");
  const crossing = structuredClone(utc); // the hub freezes the config it was given; edit a fresh copy instead
  crossing.channels.chat.quiet = { from: "22:00", to: "08:00" }; // crossing midnight
  hub.execute("rules", [crossing], at(10));
  const night = askCard(2, at(30)); // 02:30 UTC: inside 22:00-08:00
  assert.equal(hub.nextCard("chat", at(30)), null, "a window across midnight is quiet at 02:30");
  assert.equal(hub.nextCard("chat", at(365))!.id, night, "08:05 UTC is past 08:00: the card goes out then");
});

test("quiet hours end: the card goes out then, timed from its first real hand-out", () => {
  reset();
  hub.execute("rules", [withQuiet({ quiet: { from: "09:00", to: "12:00" } })], at(1));
  const card = askCard(1, at(6)); // 10:06, quiet
  assert.equal(hub.nextCard("chat", at(13)), null, "still quiet at 10:13");
  assert.equal(hub.nextCard("chat", at(121))!.id, card, "12:01 Shanghai is past the quiet hours");
  const delivery = one<{ tries: number; first_try_at: string }>(
    "SELECT tries, first_try_at FROM deliveries WHERE card_id = ?",
    [card],
  )!;
  assert.deepEqual([delivery.tries, Date.parse(delivery.first_try_at)], [1, at(121)], "放弃计时从第一次真正交出算起");
});

test("a quiet window that never makes sense is a rules mistake", () => {
  const base = JSON.parse(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"));
  for (const quiet of [
    { from: "09:00", to: "09:00" },
    { from: "9am", to: "10:00" },
    { from: "24:00", to: "08:00" },
    { from: "09:00", to: "12:60" },
  ]) {
    const broken = structuredClone(base);
    broken.channels.chat.quiet = quiet;
    assert.throws(() => parseRules(JSON.stringify(broken), 0, "UTC"), RulesError, JSON.stringify(quiet));
  }
  const severity = structuredClone(base);
  severity.rules[0].severity = "high";
  assert.throws(() => parseRules(JSON.stringify(severity), 0, "UTC"), /severity/);
});

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
