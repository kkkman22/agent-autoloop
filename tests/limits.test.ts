// Failure modes: one key, or anyone without one, sends or holds so much that the hub stops answering everybody else; a
// limit on one key slows down a different key; a request turned away is still half-read, so the connection it came on
// resets and takes the caller's next request down with it; a refusal doesn't say why or when to come back, or every
// refusal is logged and the log fills up; the limits leave a trace in the fact log, so replaying it depends on how busy
// the hub once was; a long poll or a slow upload that ends doesn't give its place back; guessing keys gets its own
// allowance with every new guess; a run's token is counted with the guesses, so a finished run can't hand in its result
// while someone is guessing; a mistyped limit in config.json is quietly taken as no limit.
import assert from "node:assert/strict";
import { copyFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { at, setup } from "./helpers.ts";

const home = setup("limits");
copyFileSync(join(import.meta.dirname, "rules.fixture.json"), join(home, "rules.json"));
process.env.AGENT_AUTOLOOP_RULES = join(home, "rules.json");
const { serve } = await import("../host/http.ts");
const hub = await import("../host/runtime.ts");
const { DEFAULT_LIMITS, limitsFrom } = await import("../host/limits.ts");

const keys = {
  owner: hub.addKey("owner", "owner"),
  other: hub.addKey("owner", "other"),
  w1: hub.addKey("worker", "w1"),
  w2: hub.addKey("worker", "w2"),
  app: hub.addKey("source", "app"),
};
const said: string[] = [];
const server = serve(0, "127.0.0.1", {
  limits: { perMinute: 60, burst: 3, inFlight: 2, waiting: 1 },
  log: (line) => said.push(line),
});
let base = "";
before(async () => {
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const call = (path: string, key?: string, init: RequestInit = {}) =>
  fetch(base + path, {
    ...init,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(init.headers as object) },
  });
const facts = () => Number(hub.one<{ n: number }>("SELECT COUNT(*) AS n FROM facts")!.n);
/** The allowance refills at one request a second here; this waits until a key has its whole burst back. */
const rested = () => new Promise((resolve) => setTimeout(resolve, 3_100));

test("a key that asks too often is told to wait, says when, and nobody else is slowed down", async () => {
  const before = facts();
  for (let n = 0; n < 3; n += 1) assert.equal((await call("/v1/state", keys.owner)).status, 200, `第 ${n + 1} 次`);
  const refused = await call("/v1/state", keys.owner);
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get("retry-after")) >= 1, "说了多久以后再来");
  assert.match((await refused.json()).error, /太多/);
  assert.equal((await call("/v1/state", keys.other)).status, 200, "另一把本人密钥不受影响");
  assert.equal((await call("/v1/state", keys.owner)).status, 429);
  // Reading the state writes nothing, so anything new in the log would have come from the limits.
  assert.equal(facts(), before, "限流本身不进日志");
  assert.equal((await call("/v1/work?wait=0&capacity=0&claim=x", keys.w1)).status, 200, "接单程序不受影响");

  assert.equal(said.filter((line) => line.includes("owner:owner")).length, 1, "同一个人一分钟里只记一行");
  assert.ok(!said.some((line) => line.includes(keys.owner)), "日志里没有密钥");
  await rested();
  assert.equal((await call("/v1/state", keys.owner)).status, 200, "等够了就恢复");
});

test("a key holds one long poll at a time here, and an ended one gives its place back", async () => {
  await rested();
  const first = new AbortController();
  const holding = call("/v1/work?wait=30&capacity=0&claim=a", keys.w1, { signal: first.signal }).catch(() => null);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const second = await call("/v1/work?wait=30&capacity=0&claim=b", keys.w1);
  assert.equal(second.status, 429, "同一把密钥的第二个长轮询被拒");
  assert.match((await second.json()).error, /长轮询/);
  const elsewhere = await call("/v1/work?wait=0&capacity=0&claim=c", keys.w2);
  assert.equal(elsewhere.status, 200, "别的接单程序照常");

  first.abort();
  await holding;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await call("/v1/work?wait=0&capacity=0&claim=d", keys.w1)).status, 200, "断开以后位置让出来了");
});

test("slow uploads can't pile up under one key, and a turned-away request leaves its connection usable", async () => {
  await rested();
  const stalls: AbortController[] = [];
  const hanging: Promise<unknown>[] = [];
  for (let n = 0; n < 2; n += 1) {
    const stop = new AbortController();
    stalls.push(stop);
    // A body that never finishes: the hub is still reading it, so this request stays in flight.
    const body = new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode("{")) });
    hanging.push(
      call("/v1/events", keys.app, { method: "POST", body, signal: stop.signal, duplex: "half" } as RequestInit).catch(
        () => null,
      ),
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  const third = await call("/v1/events", keys.app, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "e-third", type: "feedback.new", detail: "资料".repeat(30_000) }),
  });
  assert.equal(third.status, 429, "同时进行的请求超过上限");
  assert.match((await third.json()).error, /同时/);
  // The same connection pool carries the next request; a reset from the refused upload would fail it.
  assert.equal((await call("/v1/state", keys.other)).status, 200, "拒掉的请求没把连接弄坏");

  for (const stop of stalls) stop.abort();
  await Promise.all(hanging);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const later = await call("/v1/events", keys.app, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "e-later", type: "feedback.new" }),
  });
  assert.equal(later.status, 200, "上传结束以后又能发了");
});

test("guesses share one allowance, while a run's token and the owner's key keep theirs", async () => {
  await rested();
  hub.ingest("app", { id: "e-run", type: "feedback.new", subject: "run" }, at(0));
  const job = hub.claimNext("w1", "claim-run", at(0))!;
  assert.ok(job);

  for (let n = 0; n < 3; n += 1) assert.equal((await call("/v1/state", `guess-${n}`)).status, 401);
  assert.equal((await call("/v1/state", "guess-new")).status, 429, "换一个猜的密钥也没有新的额度");
  assert.equal((await call("/v1/state")).status, 401, "不带密钥是另一回事");

  const handed = await call(`/v1/runs/${job.run}/result`, job.token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ outcome: "done" }),
  });
  assert.equal(handed.status, 200, "这一轮的结果照样能交");
  assert.equal((await call("/v1/state", keys.other)).status, 200);
});

test("a card link that is asked for too often gets a page, not JSON", async () => {
  await rested();
  for (let n = 0; n < 3; n += 1) await call("/c/not-a-card");
  const refused = await call("/c/not-a-card");
  assert.equal(refused.status, 429);
  assert.match(refused.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(await refused.text(), /太多/);
});

test("config.json limits are numbers that mean something, and leaving them out keeps the defaults", () => {
  assert.deepEqual(limitsFrom(undefined), DEFAULT_LIMITS);
  assert.deepEqual(limitsFrom({ waiting: 2 }), { ...DEFAULT_LIMITS, waiting: 2 });
  for (const wrong of [{ waiting: 0 }, { perMinute: -1 }, { burst: 1.5 }, { inFlight: "8" }, { perSecond: 3 }, []])
    assert.throws(() => limitsFrom(wrong), /hub\.limits/, JSON.stringify(wrong));
  for (const value of Object.values(DEFAULT_LIMITS)) assert.ok(Number.isInteger(value) && value > 0);
  assert.ok(DEFAULT_LIMITS.waiting >= 2, "一个通道领卡片的同时还要能收回答");
});
