// What a worker keeps of finished runs. Failure cases: old output stays for as long as the worker runs, because it's only
// cleared when it starts, or stays for a loop of its own that drives the worker round by round; the folder of a run still in
// hand, or one not old enough, goes; one made while the start tidy is still walking stays; one folder that can't be cleared
// stops the worker or the rest of the clearing.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("worker-tidy");
const { createWorker } = await import("../worker/worker.ts");

const runs = join(home, "worker", "runs");
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 3600_000);
const age = (path: string, days: number) => utimesSync(path, daysAgo(days), daysAgo(days));

/** The folder of a finished run, this many days after it finished. */
function finished(name: string, days: number) {
  const dir = join(runs, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "stdout-1.log"), "它说过的话");
  age(dir, days);
  return dir;
}

const quiet = () => ({
  asked: 0,
  async work() {
    this.asked += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { job: null, cancel: [] };
  },
  async started() {
    return { ok: true };
  },
  async result() {
    return { rejected: [] };
  },
});

async function until(done: () => boolean) {
  const end = Date.now() + 15_000;
  while (!done()) {
    if (Date.now() > end) assert.fail("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("old output goes while the worker keeps running, not only when it starts", async () => {
  const hub = quiet();
  let clock = Date.now();
  const worker = createWorker({ hub: hub as any, name: "w1", wait: 0, now: () => clock });
  const stop = new AbortController();
  const running = worker.run(stop.signal);
  try {
    await until(() => hub.asked > 0);
    // The start tidy fired on the first tick and walks the folder at its own pace: wait it out before making an
    // aged folder, or it sees the new one mid-flight and clears what this test is about to keep.
    await worker.tidy();
    const old = finished("1-1", 15);
    const asked = hub.asked;
    await until(() => hub.asked > asked + 2);
    assert.equal(existsSync(old), true, "cleared at the start, so not again at once");
    clock += 60 * 60_000 + 1;
    await until(() => !existsSync(old));
    await worker.tidy();
  } finally {
    stop.abort();
    await running;
  }
});

test("a loop of its own, going round by round, gets the clearing too", async () => {
  let clock = Date.now();
  const worker = createWorker({ hub: quiet() as any, name: "w1", wait: 0, now: () => clock });
  await worker.tick();
  await worker.tidy();
  const old = finished("7-1", 15);
  await worker.tick();
  assert.equal(existsSync(old), true, "cleared at the first round, so not again at once");
  clock += 60 * 60_000 + 1;
  await worker.tick();
  await until(() => !existsSync(old));
});

test("only finished runs' folders old enough go", async () => {
  const worker = createWorker({ hub: quiet() as any, name: "w1", wait: 0 });
  const old = finished("2-1", 15);
  const recent = finished("3-1", 13);
  const inHand = finished("4-1", 15);
  writeFileSync(join(inHand, "entry.json"), "{}");
  age(inHand, 15);
  await worker.tidy();
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(recent), true);
  assert.equal(existsSync(inHand), true);
  rmSync(inHand, { recursive: true });
});

test(
  "a folder that can't be cleared is said and leaves the rest to go",
  { skip: process.getuid!() === 0 },
  async () => {
    const lines: string[] = [];
    const worker = createWorker({ hub: quiet() as any, name: "w1", wait: 0, log: (line) => lines.push(line) });
    const stuck = finished("5-1", 15);
    const locked = join(stuck, "locked");
    mkdirSync(locked);
    // Something inside: an empty folder goes even locked, since only its parent has to allow that.
    writeFileSync(join(locked, "kept"), "");
    chmodSync(locked, 0o000);
    age(stuck, 15);
    const other = finished("6-1", 15);
    try {
      await worker.tidy();
      assert.equal(existsSync(other), false);
      assert.equal(existsSync(stuck), true);
      assert.ok(lines.some((line) => line.includes("5-1")));
    } finally {
      chmodSync(locked, 0o700);
      rmSync(stuck, { recursive: true });
    }
  },
);

test("session baselines nobody resumed go with the runs; one in use stays", async () => {
  const usage = join(home, "worker", "usage");
  mkdirSync(usage, { recursive: true });
  const baseline = (session: string) =>
    join(
      usage,
      `${createHash("sha256")
        .update(JSON.stringify(["scripted", session]))
        .digest("hex")}.json`,
    );
  const stale = baseline("gone");
  writeFileSync(stale, "{}");
  age(stale, 20);
  const fresh = baseline("going");
  writeFileSync(fresh, "{}");
  const worker = createWorker({ hub: quiet() as any, name: "w1", wait: 0 });
  await worker.tidy();
  assert.equal(existsSync(stale), false, "没人续接的基线跟着清理走了");
  assert.equal(existsSync(fresh), true, "还在用的基线留下");
});
