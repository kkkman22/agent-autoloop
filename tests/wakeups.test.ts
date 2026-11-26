// A coalesced answer or a source event named timer.due must not look like a dispensable model check.
// Missing usage, failed attempts and repeated polls of one run must not inflate the estimated savings.
import assert from "node:assert/strict";
import { test } from "node:test";
import { wakeupReport, wakeupText, type HistoryRun } from "../cli/wakeups.ts";
import { World } from "../sim/world.ts";

test("two pure rechecks point to their run numbers, without guessing unreported or inconsistent usage", async () => {
  const world = new World();
  try {
    world.call("ingest", "app", { id: "export", type: "one", subject: "export" });
    const records: HistoryRun[] = [];
    for (let n = 0; n < 3; n++) {
      const job = world.call("claimNext", "w1", "claim-" + n);
      world.finish(job.run, {
        outcome: "done",
        later: [{ key: "export", at: new Date(world.now + 60000).toISOString(), about: "检查导出" }],
      });
      records.unshift({
        id: job.run,
        rule: "one",
        events: job.context.events,
        claimedAt: "t",
        finishedAt: "t",
        attempts: 0,
        usage: n === 2 ? { input: 2, cached: 5 } : null,
      });
      world.advance(60000);
    }
    const report = await wakeupReport(
      {
        state: async () => {
          throw Error("unexpected");
        },
        ruleRuns: async () => ({ runs: records, nextBefore: null }),
        why: async () => world.log,
      },
      "one",
      100,
    );
    const checks = report.groups.find((group) => group.cause === "recheck")!;
    assert.deepEqual(checks.examples, [3, 2]);
    assert.deepEqual(checks.uncachedInput, { sum: 0, reported: 0 });
    assert.match(wakeupText(report), /多次到期复查/);
  } finally {
    world.view.close();
  }
});

test("a real timer and an answer in the same round remain mixed; earlier rounds keep their own cause", async () => {
  const world = new World();
  try {
    world.call("ingest", "app", { id: "job", type: "one", subject: "export" });
    const first = world.call("claimNext", "w1", "claim");
    world.finish(first.run, {
      outcome: "done",
      session: "s",
      ask: [{ key: "confirm", title: "选一个", text: "确认", options: ["甲", "乙"] }],
      later: [{ key: "check", at: "1970-01-01T00:01:00Z", about: "检查" }],
    });
    world.call("answer", 1, { choice: 1 });
    world.advance(60_000);
    const next = world.call("claimNext", "w1", "next");
    assert.deepEqual(next.context.events.map((e: { type: string }) => e.type).sort(), ["card.answered", "timer.due"]);
    const records = [
      { id: next.run, events: next.context.events },
      { id: first.run, events: [{ type: "one" }] },
    ].map((item) => ({ ...item, rule: "one", attempts: 0, claimedAt: "t", finishedAt: "t", usage: null }));
    const report = await wakeupReport(
      {
        state: async () => {
          throw Error("unexpected state read");
        },
        ruleRuns: async () => ({ runs: records, nextBefore: null }),
        why: async () => world.log,
      },
      "one",
      20,
    );
    assert.deepEqual(report.groups.map((g) => g.cause).sort(), ["mixed", "other"]);
  } finally {
    world.view.close();
  }
});

test("paging attributes failures once per run and distinguishes reported zero from missing usage", async () => {
  const run = (id: number, usage: unknown) => ({
    id,
    rule: "weekly",
    events: [{ type: "export" }],
    attempts: id === 4 ? 2 : 0,
    claimedAt: "t",
    finishedAt: "t",
    usage,
  });
  const cursors: (number | undefined)[] = [];
  const pages = {
    ruleRuns: async (_rule: string, before?: number) => {
      cursors.push(before);
      return before
        ? { runs: [run(2, { input: 0, output: 0, cached: 0 }), run(1, null)], nextBefore: null }
        : {
            runs: [run(4, { input: 100, cached: 80, output: 5 }), { ...run(3, null), claimedAt: null }],
            nextBefore: 3,
          };
    },
    state: async () => {
      throw Error("unexpected state read");
    },
    why: async () => {
      throw Error("unnecessary timeline read");
    },
  };
  const report = await wakeupReport(pages, "weekly", 3);
  assert.deepEqual(cursors, [undefined, 3]);
  assert.equal(report.hasMore, true);
  assert.equal(report.excluded, 1);
  const [group] = report.groups;
  assert.equal(group.rounds, 2);
  assert.equal(group.withFailures, 1);
  assert.deepEqual(group.uncachedInput, { sum: 20, reported: 2 });
  assert.deepEqual(group.cost, { sum: 0, reported: 0 });
  assert.deepEqual(group.examples, [4, 2]);
});

test("a stopped retry with its claim cleared still counts as an executed round", async () => {
  const run = {
    id: 1,
    rule: "weekly",
    events: [{ type: "export" }],
    attempts: 1,
    claimedAt: null,
    finishedAt: "t",
    usage: null,
  };
  const owner = {
    ruleRuns: async () => ({ runs: [run], nextBefore: null }),
    state: async () => {
      throw Error("unexpected");
    },
    why: async () => {
      throw Error("unexpected");
    },
  };
  const report = await wakeupReport(owner, "weekly", 1);
  assert.equal(report.excluded, 0);
  assert.equal(report.groups[0].withFailures, 1);
});

test("an external timer.due stays external even when the same fact window contains a different timer", async () => {
  const world = new World();
  try {
    const { rules } = await import("../sim/world.ts");
    const r = structuredClone(rules);
    r.rules[0].when = { source: "app", types: ["timer.due"] };
    world.call("rules", r);
    world.call("ingest", "app", { id: "named-by-source", type: "timer.due", subject: "export" });
    const job = world.call("claimNext", "w1", "claim");
    const record = {
      id: job.run,
      rule: "one",
      events: job.context.events,
      attempts: 0,
      claimedAt: "t",
      finishedAt: "t",
      usage: { input: 10 },
    };
    const result = await wakeupReport(
      {
        state: async () => {
          throw Error("unexpected");
        },
        ruleRuns: async () => ({ runs: [record], nextBefore: null }),
        why: async () => world.log,
      },
      "one",
      1,
    );
    assert.equal(result.groups[0].cause, "other");
    assert.deepEqual(result.groups[0].uncachedInput, { sum: 0, reported: 0 });
  } finally {
    world.view.close();
  }
});
