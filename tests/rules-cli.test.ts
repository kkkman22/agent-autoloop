// Failure modes: validate passes a rule that would silently do nothing (a channel nobody can answer, a source with no
// key so events never arrive, a cwd missing on this machine); explain misses wildcard types or misstates the parallel
// group; a cron rule's next runs come out in the wrong zone; validate is asked about a broken file and mangles it
// instead of just reporting; a name no rule has is silently answered with nothing.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { nextRun, parseCron } from "../kernel/cron.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";
const home = setup("rules-cli");
const hub = await import("../host/runtime.ts");
after(() => hub.db.close());
hub.addKey("source", "app");
const cli = promisify(execFile);
const run = (...args: string[]) =>
  cli(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "../bin/agent-autoloop.ts"), "rules", ...args],
    { encoding: "utf8" },
  );

const fixture = readFileSync(join(import.meta.dirname, "rules.fixture.json"), "utf8");

test("validate reports each way a rule would silently do nothing, without touching the file", async () => {
  const { stdout } = await run("validate");
  for (const words of [
    "规则没问题",
    "文字", // the channel without answerers
    "只能发通知",
    "还没有密钥", // ops has no key here
    "在这台电脑上不存在", // ~/x and ~/y don't exist on this machine
  ])
    assert.ok(stdout.includes(words), words + "\n" + stdout);
});

test("validate names the problems in a broken file and leaves it alone", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "rules-cli-broken-")), "rules.json");
  const broken = JSON.stringify({ ...JSON.parse(fixture), rules: [{ ...JSON.parse(fixture).rules[0], nope: 1 }] });
  writeFileSync(file, broken);
  await assert.rejects(run("validate", file), (error: { code: number; stderr: string }) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /不认识的字段 nope/);
    return true;
  });
  assert.equal(readFileSync(file, "utf8"), broken);
});

test("explain lists every rule a source and type lands on, with agent, worker, cwd and concurrency", async () => {
  const { stdout } = await run("explain", "ops", "alert.raised");
  assert.match(stdout, /2 条规则/);
  assert.match(stdout, /告警」[\s\S]*乙（a2）[\s\S]*w2[\s\S]*~/);
  assert.match(stdout, /告警也记一笔」[\s\S]*甲（a1）/);
  assert.ok(!stdout.includes("意见"), stdout);
  const wildcard = await run("explain", "app", "feedback.created");
  assert.match(wildcard.stdout, /意见」/);
  assert.match(wildcard.stdout, /最多 3 轮并行/);
  const none = await run("explain", "ops", "alert.gone");
  assert.match(none.stdout, /没有规则接/);
});

test("explain of a named rule tells the schedule and the next three times in the rules' zone", async () => {
  const { stdout } = await run("explain", "早报");
  assert.match(stdout, /每天 09:00/);
  assert.match(stdout, /Asia\/Shanghai/);
  const cron = parseCron("0 9 * * *")!;
  let at = Date.now();
  for (let n = 0; n < 3; n++) {
    at = nextRun(cron, at, "Asia/Shanghai")!;
    const clock = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(at);
    assert.ok(stdout.includes(clock), clock + "\n" + stdout);
  }
});

test("explain of a cron rule also shows the agent, and an unknown name is an error", async () => {
  const { stdout } = await run("explain", "巡检");
  assert.match(stdout, /丙（a3）/);
  assert.match(stdout, /每 5 分钟|巡检/);
  await assert.rejects(run("explain", "没有这条"), (error: { code: number; stderr: string }) => {
    assert.match(error.stderr, /没有叫/);
    return true;
  });
});
