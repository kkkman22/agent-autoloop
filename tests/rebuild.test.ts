// Failure modes: a rebuild that is stopped partway (killed, or the machine loses power) starts over from the first fact
// every time, so a long log never finishes rebuilding; it carries on from a checkpoint that doesn't match what is in the
// projection, so a fact is applied twice or skipped; a half-built projection is taken for a finished one and used; a
// half-built projection of another format is carried on as if it were this one's; a commit made from a view opened
// before the rebuild started lands on top of the half-built projection; the result differs from a projection built in
// one go; nobody can tell how far a long rebuild has got.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { Conflict } from "../kernel/errors.ts";
import { snapshot, type Fact } from "../kernel/evolve.ts";
import { commit, openView, rebuild } from "../kernel/store.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-rebuild-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** Facts that add, change and remove rows, so applying one twice or skipping one shows in the result. */
const fact = (seq: number): Fact => ({
  version: 1,
  seq,
  at: seq,
  type: "fixture",
  changes: [
    { table: "events", key: String(seq), row: { id: seq, source: "app", key: `e${seq}`, seen: seq } },
    { table: "timers", key: String(seq - 1), row: seq % 3 ? { id: seq - 1, fired: seq } : null },
    { table: "seen", key: "worker:w1", row: { kind: "worker", name: "w1", count: seq } },
  ],
});
const FACTS = 1000;
function seeded(file = ":memory:") {
  const db = new DatabaseSync(file);
  const view = openView(db, "a");
  commit(db, view, () => Array.from({ length: FACTS }, (_, n) => fact(n + 1)));
  return db;
}
const format = (db: DatabaseSync) => String(db.prepare("SELECT format FROM projection_meta WHERE id=1").get()!.format);
/** What a projection built in one go from the same log looks like. */
const expected = (() => {
  const db = seeded();
  const view = openView(db, "b");
  return snapshot(view);
})();

test("a rebuild stopped partway carries on from where it stopped and ends where one built in one go does", () => {
  const db = seeded();
  const first: number[] = [];
  assert.throws(
    () =>
      rebuild(db, "b", {
        chunk: 100,
        progress(done) {
          first.push(done);
          if (done >= 300) throw new Error("断电了");
        },
      }),
    /断电了/,
  );
  assert.deepEqual(first, [100, 200, 300]);
  assert.notEqual(format(db), "b", "做了一半的投影不能当成做完的");

  const resumed: [number, number][] = [];
  const view = openView(db, "b", { chunk: 100, progress: (done, total) => resumed.push([done, total]) });
  assert.equal(resumed[0][0], 400, "接着上次的地方做，不从头来");
  assert.deepEqual(resumed.at(-1), [FACTS, FACTS]);
  assert.ok(
    resumed.every(([done], n) => n === 0 || done > resumed[n - 1][0]),
    "进度只往前走",
  );
  assert.equal(format(db), "b");
  assert.deepEqual(snapshot(view), expected);
  db.close();
});

test("a half-built projection of another format is started again, not carried on", () => {
  const db = seeded();
  assert.throws(() =>
    rebuild(db, "c", {
      chunk: 100,
      progress() {
        throw new Error("停");
      },
    }),
  );
  const steps: number[] = [];
  const view = openView(db, "b", { chunk: 100, progress: (done) => steps.push(done) });
  assert.equal(steps[0], 100, "别的格式做了一半的不接着用");
  assert.deepEqual(snapshot(view), expected);
  db.close();
});

test("a commit from a view opened before the projection was rebuilt is refused, half-built or done", () => {
  const db = new DatabaseSync(":memory:");
  let view = openView(db, "a");
  view = commit(db, view, () => [fact(1), fact(2), fact(3)]);
  const stale = view;
  assert.throws(() =>
    rebuild(db, "b", {
      chunk: 1,
      progress() {
        throw new Error("停");
      },
    }),
  );
  assert.throws(() => commit(db, stale, () => [fact(4)]), Conflict, "做到一半的投影上不能再提交");
  openView(db, "b");
  assert.throws(() => commit(db, stale, () => [fact(4)]), Conflict, "换了格式以后旧视图不能提交");
  assert.equal(Number(db.prepare("SELECT MAX(seq) AS seq FROM facts").get()!.seq), 3, "日志没多出东西");
  db.close();
});

test("a rebuild killed in the middle of a transaction carries on after it, from what it had committed", async () => {
  const file = join(dir, "killed.db");
  seeded(file).close();
  const store = new URL("../kernel/store.ts", import.meta.url).href;
  // Each step is slowed down so the kill lands while the rebuild is still going.
  const script = `
    import { DatabaseSync } from "node:sqlite";
    const { rebuild } = await import(${JSON.stringify(store)});
    const db = new DatabaseSync(${JSON.stringify(file)});
    rebuild(db, "b", { chunk: 50, progress(done) {
      console.log(done);
      const until = Date.now() + 30;
      while (Date.now() < until);
    } });
  `;
  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script],
    {
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let seen = 0;
  await new Promise<void>((resolve) => {
    child.stdout!.on("data", (chunk) => {
      seen = Math.max(seen, ...String(chunk).trim().split("\n").map(Number));
      if (seen >= 200) {
        child.kill("SIGKILL");
        resolve();
      }
    });
  });
  await exited;

  const db = new DatabaseSync(file);
  assert.notEqual(format(db), "b");
  const steps: number[] = [];
  const view = openView(db, "b", { chunk: 50, progress: (done) => steps.push(done) });
  assert.ok(steps[0] > 50, `接着做，不从头来：从 ${steps[0]} 开始`);
  assert.ok(steps[0] <= seen + 100, "接上的地方就是被杀之前提交过的地方");
  assert.deepEqual(snapshot(view), expected);
  db.close();
});
