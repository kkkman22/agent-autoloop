// Failure modes: the running totals behind `status` and `/v1/metrics` drift from the runs they count when a run changes
// state, is retried with its usage added up, is merged into another and removed, or is cancelled; a rebuilt projection
// counts differently from one kept up commit by commit; adding and taking away costs leaves a float crumb, so a rule
// that spent nothing shows a cost; "done today" is frozen at whatever day the total was kept on.
import assert from "node:assert/strict";
import { test } from "node:test";
import { at, setup } from "./helpers.ts";

setup("tallies");
const hub = await import("../host/runtime.ts");
const { countsOf } = await import("../kernel/state.ts");
const { dayStart } = await import("../kernel/cron.ts");
const { rebuild } = await import("../kernel/store.ts");

/** What the totals must equal: every run read one by one, the way `status` used to count them. */
function scanned(since: string) {
  return hub.all<Record<string, string | number>>(
    `SELECT rule, agent, state, COUNT(*) AS count,
      SUM(CASE WHEN state = 'queued' AND attempts > 0 THEN 1 ELSE 0 END) AS retrying,
      SUM(CASE WHEN state = 'done' AND finished_at >= ? THEN 1 ELSE 0 END) AS today,
      COALESCE(SUM(json_extract(usage, '$.input')), 0) AS input,
      COALESCE(SUM(json_extract(usage, '$.output')), 0) AS output,
      COALESCE(SUM(json_extract(usage, '$.cost')), 0) AS cost
     FROM runs GROUP BY rule, agent, state`,
    [since],
  );
}
/** Totals folded to one line per rule, agent and state, and "done today" to one per rule and agent, whatever rows they came in. */
function folded(rows: Record<string, string | number>[]) {
  const lines = new Map<string, Record<string, number>>();
  const add = (key: string, field: string, value: number) => {
    const line = lines.get(key) ?? {};
    line[field] = (line[field] ?? 0) + value;
    lines.set(key, line);
  };
  for (const row of rows) {
    const key = `${row.rule}|${row.agent}|${row.state}`;
    for (const field of ["count", "retrying", "input", "output", "cost"]) add(key, field, Number(row[field] ?? 0));
    add(`${row.rule}|${row.agent}|today`, "today", Number(row.today ?? 0));
  }
  for (const [key, line] of lines) {
    if (Object.values(line).every((value) => value === 0)) lines.delete(key);
    else if (line.cost !== undefined) line.cost = Math.round(line.cost * 1e9) / 1e9;
  }
  return Object.fromEntries([...lines].sort(([a], [b]) => a.localeCompare(b)));
}
const same = (now: number, message: string) => {
  const since = new Date(dayStart(now, hub.rules.timezone)).toISOString();
  assert.deepEqual(folded(countsOf(hub.all, since)), folded(scanned(since)), message);
};

const note = (n: number, step = "new") => ({ id: `t:${n}:${step}`, type: `feedback.${step}`, subject: `#${n}` });
const claim = (minute: number) => hub.claimNext("w1", `c-${minute}-${Math.random()}`, at(minute))!;

test("the totals match the runs one by one through every way a run can go, and again after a rebuild", () => {
  same(at(0), "空的时候也对得上");

  hub.ingest("app", note(1), at(0));
  const first = claim(0);
  hub.finish(first.run, first.token, { outcome: "done", usage: { input: 100, output: 10, cost: 0.1 } }, at(1));
  same(at(1), "做完一轮");

  // A failure with usage goes back to the queue as a retry, and an event for the same thing that came meanwhile is merged
  // into it: that other run is removed.
  hub.ingest("app", note(2), at(2));
  const failing = claim(2);
  hub.ingest("app", note(2, "update"), at(3));
  hub.finish(failing.run, failing.token, { outcome: "failed", error: "超时", usage: { input: 7, cost: 0.2 } }, at(4));
  same(at(4), "失败重排、合并掉另一轮");

  const retry = claim(10);
  hub.finish(retry.run, retry.token, { outcome: "done", usage: { input: 3, output: 1, cost: 0.1 } }, at(11));
  same(at(11), "重试做完，用量加在一起");

  hub.ingest("app", note(3), at(12));
  const stopped = claim(12);
  hub.cancel(stopped.run, at(13));
  hub.finish(stopped.run, stopped.token, { outcome: "cancelled" }, at(14));
  hub.ingest("app", note(4), at(15));
  same(at(15), "停掉一轮，另有一轮在排队");

  // The next day: what was done today is now done before today, and the totals that don't depend on the day stay.
  const tomorrow = at(15) + 86400_000;
  same(tomorrow, "第二天再看");

  const before = folded(countsOf(hub.all, new Date(dayStart(at(15), hub.rules.timezone)).toISOString()));
  rebuild(hub.db, "另一种格式");
  same(at(15), "重建以后也对得上");
  assert.deepEqual(
    folded(countsOf(hub.all, new Date(dayStart(at(15), hub.rules.timezone)).toISOString())),
    before,
    "重建前后说的是同一件事",
  );
  hub.getView();
});

test("costs added and taken away come back to exactly nothing", () => {
  hub.fixtureClear("runs");
  const totals = countsOf(hub.all, new Date(at(0)).toISOString());
  assert.deepEqual(totals, [], "清空以后一行也不剩，没有残留的零头");
});
