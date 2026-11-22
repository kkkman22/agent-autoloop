// Historical output must not make the worker scan the disk every poll or wait for cleanup before talking to the hub, and
// whoever holds the worker must not see an empty hand before its first round.
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("worker-active");
const { createWorker } = await import("../worker/worker.ts");
const { HubError } = await import("../protocol/client.ts");
const runs = join(home, "worker", "runs");

test("polls with one recovered result and 4,488 historical directories", async (t) => {
  for (let id = 1; id < 4489; id++) fs.mkdirSync(join(runs, `${id}-1`), { recursive: true });
  const dir = join(runs, "4489-1");
  fs.mkdirSync(dir);
  const file = join(dir, "entry.json");
  const result = { outcome: "done", summary: "已完成" };
  fs.writeFileSync(file, JSON.stringify({ run: 4489, token: "result-token", dir, result }));
  const listing = t.mock.method(fs, "readdirSync");
  const asyncListing = t.mock.method(fs.promises, "readdir");
  syncBuiltinESMExports();
  const calls: number[][] = [];
  let receipts = 0;
  // The hub's refusals of a receipt put its retry on a clock: the worker's own pause, not the test's timing, decides.
  let clock = 1_700_000_000_000;
  const worker = createWorker({
    name: "test",
    now: () => clock,
    hub: {
      async work({ running }) {
        calls.push(running ?? []);
        return { job: null, cancel: [] };
      },
      async started() {
        return { ok: true };
      },
      async result(run, token, data) {
        assert.deepEqual([run, token, data], [4489, "result-token", result]);
        if (++receipts === 1) throw new HubError(503, "try again");
        return { rejected: [] };
      },
    },
  });
  try {
    assert.deepEqual(
      worker.entries().map((entry) => entry.run),
      [4489],
      "whoever holds the worker sees the run in hand before its first round",
    );
    await worker.tick();
    await worker.tidy();
    assert.deepEqual(calls[0], [4489]);
    assert.ok(fs.existsSync(file), "a failed receipt stays available for restart");
    listing.mock.resetCalls();
    asyncListing.mock.resetCalls();
    clock += 30_000;
    await worker.tick();
    await worker.tick();
    assert.deepEqual(calls, [[4489], [], []]);
    assert.equal(receipts, 2);
    assert.ok(!fs.existsSync(file), "an acknowledged receipt is released");
    assert.ok(fs.existsSync(join(runs, "1-1")), "recent output stays available");
    assert.ok(
      ![...listing.mock.calls, ...asyncListing.mock.calls].some(({ arguments: [dir] }) => dir === runs),
      "steady-state heartbeat and receipt never list the historical directory",
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("an outstanding historical deletion leaves the worker free to poll the hub", { timeout: 10_000 }, async (t) => {
  const old = join(runs, "4490-1");
  fs.mkdirSync(old, { recursive: true });
  const past = new Date(Date.now() - 15 * 24 * 3600_000);
  fs.utimesSync(old, past, past);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const remove = fs.promises.rm;
  t.mock.method(fs.promises, "rm", async (...args: Parameters<typeof remove>) => {
    if (args[0] === old) {
      started.resolve();
      await release.promise;
    }
    return remove(...args);
  });
  let polls = 0;
  const worker = createWorker({
    name: "test",
    hub: {
      async work() {
        polls++;
        return { job: null, cancel: [] };
      },
      async started() {
        return { ok: true };
      },
      async result() {
        return { rejected: [] };
      },
    },
  });
  try {
    await worker.tick();
    assert.ok(fs.existsSync(old), "the first poll does not wait for historical deletion");
    await started.promise;
    await worker.tick();
    assert.equal(polls, 2);
  } finally {
    release.resolve();
    await worker.tidy();
  }
  assert.ok(!fs.existsSync(old));
});

test("recovery retries a known run whose receipt file was temporarily unreadable", async (t) => {
  const dir = join(runs, "4491-1");
  fs.mkdirSync(dir, { recursive: true });
  const file = join(dir, "entry.json");
  fs.writeFileSync(file, JSON.stringify({ run: 4491, token: "receipt", dir, result: { outcome: "done" } }));
  const read = fs.readFileSync;
  let blocked = true;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof read>) => {
    if (args[0] === file && blocked) throw Object.assign(new Error("file busy"), { code: "EBUSY" });
    return read(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const receipts: number[] = [];
  const worker = createWorker({
    name: "test",
    hub: {
      async work() {
        return { job: null, cancel: [] };
      },
      async started() {
        return { ok: true };
      },
      async result(run) {
        receipts.push(run);
        return { rejected: [] };
      },
    },
  });
  await worker.tick();
  assert.deepEqual(receipts, []);
  blocked = false;
  await worker.tick();
  assert.deepEqual(receipts, [4491]);
  await worker.tidy();
});
