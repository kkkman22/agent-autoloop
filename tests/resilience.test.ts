// Failure modes: a hub that says "slow down" (429) is taken as refusing a finished run's result, so the worker throws the
// result away; it is taken as gone, so after ten minutes the owner is told the hub can't be reached; one run whose agent
// plugin throws while being looked at stops every other run from being looked at, handed in or taken on, and stays
// stuck after the plugin is fixed; a channel plugin that returns or crashes as soon as it starts is started again at once,
// for ever, or waits ever longer even after it has been running fine; stopping the machine waits out a channel's pause.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("resilience");
const folder = join(home, "project");
mkdirSync(folder);
const { createWorker } = await import("../worker/worker.ts");
const { HubError } = await import("../protocol/client.ts");
const { keepChannelRunning } = await import("../host/up.ts");

// An agent plugin that can't read what its agent printed while this file exists, as a third-party plugin with a bug can't.
const broken = join(home, "plugin-is-broken");
mkdirSync(join(home, "plugins", "flaky"), { recursive: true });
writeFileSync(
  join(home, "plugins", "flaky", "agent.ts"),
  `import { existsSync } from "node:fs";
export default {
  command: (t) => t.command,
  read(stdout, code) {
    if (existsSync(${JSON.stringify(broken)})) throw new Error("插件读不懂这段输出");
    if (code === null) return {};
    if (code !== 0) return { error: "boom" };
    return { text: stdout };
  },
};`,
);

let nextRun = 100;
const job = (use = "command") => ({
  run: nextRun++,
  token: `token-${nextRun}`,
  attempt: 1,
  session: null,
  askFirst: [],
  rule: { name: "意见", cwd: folder, prompt: "按手册做。" },
  agent: { id: "a", name: "甲", use, access: "edit", command: ["/bin/sh", "-c", "echo 好了"] },
  context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
});

function fakeHub() {
  const hub = {
    jobs: [] as object[],
    results: [] as any[],
    attempts: 0,
    limitResults: false,
    limitWork: false,
    async work(query: any) {
      if (hub.limitWork) throw new HubError(429, "请求太多了，30 秒后再试");
      return { job: query.capacity ? (hub.jobs.shift() ?? null) : null, cancel: [] };
    },
    async started() {
      return { ok: true };
    },
    async result(run: number, token: string, body: any) {
      hub.attempts += 1;
      if (hub.limitResults) throw new HubError(429, "请求太多了，30 秒后再试");
      hub.results.push({ run, token, ...body });
      return { rejected: [] };
    },
  };
  return hub;
}

async function until(worker: { tick(): Promise<boolean> }, done: () => boolean) {
  const end = Date.now() + 15_000;
  while (!done()) {
    if (Date.now() > end) assert.fail("timed out waiting");
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const clean = () => rmSync(join(home, "worker"), { recursive: true, force: true });

test("a result the hub is too busy to take is kept, and handed in once it has waited", async () => {
  clean();
  const hub = fakeHub();
  let clock = Date.now();
  const lines: string[] = [];
  const worker = createWorker({ hub, name: "w1", wait: 0, now: () => clock, log: (line) => lines.push(line) });
  const given = job();
  hub.jobs.push(given);
  hub.limitResults = true;
  await until(worker, () => hub.attempts >= 1);
  assert.equal(worker.entries().length, 1, "结果留着，没有扔掉");
  assert.ok(worker.entries()[0].result, "跑完的结果还在");
  assert.ok(
    lines.some((line) => line.includes(`run ${given.run}`) && /slow down|busy/.test(line)),
    lines.join("\n"),
  );

  hub.limitResults = false;
  for (let n = 0; n < 3; n += 1) await worker.tick();
  assert.equal(hub.results.length, 0, "等的时间没到，不马上重交");
  clock += 31_000;
  await until(worker, () => hub.results.length === 1);
  assert.equal(hub.results[0].run, given.run);
  assert.equal(hub.results[0].outcome, "done");
  assert.equal(worker.entries().length, 0);
});

test("a hub that asks the worker to slow down is not a hub that can't be reached", async () => {
  clean();
  const hub = fakeHub();
  hub.limitWork = true;
  const told = join(home, "told.txt");
  rmSync(told, { force: true });
  let clock = Date.now();
  const worker = createWorker({
    hub,
    name: "w1",
    wait: 0,
    now: () => clock,
    unreachable: ["/bin/sh", "-c", `echo "$0" > ${JSON.stringify(told)}`, "{text}"],
  });
  for (let minute = 0; minute <= 12; minute += 1) {
    assert.equal(await worker.tick(), false, "这一轮先歇一歇");
    clock += 60_000;
  }
  assert.ok(!existsSync(told), "中台还在回话，不该告诉本人连不上");
});

test("one run its plugin can't read doesn't hold up the others, and goes on once the plugin is fixed", async () => {
  clean();
  const hub = fakeHub();
  const lines: string[] = [];
  const worker = createWorker({ hub, name: "w1", wait: 0, capacity: 3, log: (line) => lines.push(line) });
  writeFileSync(broken, "");
  const stuck = job("flaky");
  const fine = job("command");
  hub.jobs.push(stuck);
  await worker.tick();
  hub.jobs.push(fine);
  await until(worker, () => hub.results.some((result) => result.run === fine.run));
  assert.ok(!hub.results.some((result) => result.run === stuck.run), "读不懂的那一轮没被当成跑完");
  assert.ok(
    worker.entries().some((entry) => entry.run === stuck.run),
    "它还在手上",
  );
  assert.ok(
    lines.some((line) => line.includes(`run ${stuck.run}`) && line.includes("插件读不懂")),
    lines.join("\n"),
  );

  rmSync(broken);
  await until(worker, () => hub.results.some((result) => result.run === stuck.run));
  const result = hub.results.find((item) => item.run === stuck.run);
  assert.equal(result.outcome, "done");
});

test("a channel that keeps stopping is started again later each time, and sooner again once it has run a while", async () => {
  const delays: number[] = [];
  const lines: string[] = [];
  let clock = 0;
  let starts = 0;
  const stop = new AbortController();
  await keepChannelRunning("chat", { key: "k" }, "http://127.0.0.1:9", stop.signal, {
    load: async () => async () => {
      starts += 1;
      if (starts === 3) throw new Error("插件崩了");
      // The fourth start runs for a good while before it stops.
      if (starts === 4) clock += 11 * 60_000;
    },
    now: () => clock,
    sleep: async (ms) => {
      delays.push(ms);
      clock += ms;
      if (delays.length === 7) stop.abort();
    },
    say: (line) => lines.push(line),
  });
  assert.deepEqual(delays, [5_000, 10_000, 20_000, 5_000, 5_000, 10_000, 20_000]);
  assert.ok(
    lines.some((line) => line.includes("插件崩了")),
    lines.join("\n"),
  );
  assert.ok(
    lines.some((line) => line.includes("in 20 seconds")),
    lines.join("\n"),
  );
});

test("however often a channel stops, it waits at most five minutes, and stopping the machine doesn't wait at all", async () => {
  const delays: number[] = [];
  const stop = new AbortController();
  await keepChannelRunning("chat", { key: "k" }, "http://127.0.0.1:9", stop.signal, {
    load: async () => async () => {},
    now: () => 0,
    sleep: async (ms) => {
      delays.push(ms);
      if (delays.length === 12) stop.abort();
    },
    say: () => {},
  });
  assert.equal(Math.max(...delays), 300_000);
  assert.deepEqual(delays.slice(-3), [300_000, 300_000, 300_000]);

  const quit = new AbortController();
  const started = Date.now();
  const running = keepChannelRunning("chat", { key: "k" }, "http://127.0.0.1:9", quit.signal, {
    load: async () => async () => {},
    say: () => {},
  });
  setTimeout(() => quit.abort(), 50);
  await running;
  assert.ok(Date.now() - started < 2_000, "停下来不用等完那 5 秒");
});
