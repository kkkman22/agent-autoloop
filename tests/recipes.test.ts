// Failure modes: a recipe's rules don't pass `agent-autoloop check`, or check would pass anything; a rule names a Skill the
// recipe doesn't ship, or the README doesn't say where to put it; a README promises one access level while the rules give
// another, or a script-only recipe's README hides that it runs no model; the curl in ops-alerts no longer reaches its rule,
// or the outside system's key can set off the restart; the issue watcher prints something the worker can't read (a body's
// line break or backslash breaking its JSON), or an event the rules wouldn't let through, or asks GitHub for something else
// when called with one argument; the jira watcher asks the MCP something other than the configured JQL, or hands back an
// unstable id (so every poll notifies again), or loses the creator the notifier needs, or notifies someone the local map
// never carried.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readMessage, resultFrom } from "../worker/contract.ts";

const ROOT = join(import.meta.dirname, "..");
const RECIPES = join(ROOT, "examples", "recipes");
const NAMES = [
  "morning-brief",
  "github-issues",
  "ops-alerts",
  "feedback",
  "website-watch",
  "feishu-brief",
  "browser-handoff",
  "jira-watch",
];
const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-recipes-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const cleanEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("AGENT_AUTOLOOP_")),
  ) as NodeJS.ProcessEnv;
const agentAutoloop = (args: string[], env: NodeJS.ProcessEnv) =>
  spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join(ROOT, "bin", "agent-autoloop.ts"), ...args],
    {
      env: { ...cleanEnv(), ...env },
      encoding: "utf8",
    },
  );
const readRules = (name: string) => JSON.parse(readFileSync(join(RECIPES, name, "rules.json"), "utf8"));
const readDoc = (name: string) => readFileSync(join(RECIPES, name, "README.md"), "utf8");
const check = (rulesFile: string) =>
  agentAutoloop(["check"], {
    AGENT_AUTOLOOP_RULES: rulesFile,
    AGENT_AUTOLOOP_HOME: mkdtempSync(join(scratch, "home-")),
  });

for (const name of NAMES) {
  test(`${name}: agent-autoloop check passes its rules`, () => {
    const checked = check(join(RECIPES, name, "rules.json"));
    assert.equal(checked.status, 0, checked.stderr);
  });

  test(`${name}: every Skill a rule names is here, and the README says where it goes`, () => {
    const skills = readRules(name).rules.flatMap((rule: { skill?: string }) => rule.skill ?? []);
    if (skills.length === 0) {
      assert.match(readDoc(name), /不跑模型/, "a recipe that runs no model must say so where the reader looks");
      return;
    }
    assert.equal(skills.length, 1);
    const skill = readFileSync(join(RECIPES, name, "SKILL.md"), "utf8");
    assert.match(skill, new RegExp(`^name: ${skills[0]}$`, "m"));
    assert.match(readDoc(name), new RegExp(`~/\\.codex/skills/${skills[0]}/`));
    assert.match(readDoc(name), new RegExp(`~/\\.claude/skills/${skills[0]}/`));
  });

  test(`${name}: the README states the access level the rules actually give`, () => {
    const { agents } = readRules(name);
    const real = Object.values<{ use: string; access: string }>(agents).filter((agent) => agent.use !== "command");
    if (real.length === 0) {
      assert.match(readDoc(name), /不跑模型/);
      return;
    }
    assert.equal(real.length, 1);
    const stated = /权限：`(read|edit|full)`/.exec(readDoc(name));
    assert.ok(stated, "README 要写明权限");
    assert.equal(stated[1], real[0].access);
  });
}

test("agent-autoloop check refuses a recipe that was changed for the worse", () => {
  const broken = readRules("morning-brief");
  broken.rules[0].to = "nobody";
  const file = join(scratch, "broken.json");
  writeFileSync(file, JSON.stringify(broken));
  const checked = check(file);
  assert.notEqual(checked.status, 0);
  assert.match(checked.stderr, /不是已登记的 Agent/);
});

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("ops-alerts: the curl in the README reaches the rule, and that key can't set off the restart", async () => {
  const home = mkdtempSync(join(scratch, "ops-"));
  const port = await freePort();
  const env = { AGENT_AUTOLOOP_HOME: home };
  writeFileSync(join(home, "rules.json"), readFileSync(join(RECIPES, "ops-alerts", "rules.json")));
  const key = agentAutoloop(["key", "new", "source", "shop"], env).stdout.trim().split("\n").at(-1)!;
  const url = `http://127.0.0.1:${port}`;
  writeFileSync(join(home, "config.json"), JSON.stringify({ url, hub: { listen: `127.0.0.1:${port}` } }));
  const hub = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join(ROOT, "bin", "agent-autoloop.ts"), "up"],
    { env: { ...cleanEnv(), ...env }, stdio: "ignore" },
  );
  try {
    for (let tries = 0; tries < 100; tries++) {
      const up = await fetch(`${url}/healthz`).catch(() => null);
      if (up?.ok) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const curl = /```bash\n(curl [\s\S]*?)```/.exec(readDoc("ops-alerts"))?.[1];
    assert.ok(curl, "README 里要有一条 curl");
    const sent = spawnSync("sh", ["-c", curl.replaceAll("http://127.0.0.1:3350", url)], {
      env: { ...cleanEnv(), SHOP_KEY: key },
      encoding: "utf8",
    });
    assert.equal(sent.status, 0, sent.stderr);
    assert.deepEqual(JSON.parse(sent.stdout).routed, ["查线上报错"]);
    const restart = await fetch(`${url}/v1/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "from-outside", type: "restart", subject: "checkout" }),
    });
    assert.deepEqual((await restart.json()).routed, []);
  } finally {
    hub.kill("SIGTERM");
    await new Promise((resolve) => hub.once("exit", resolve));
  }
});

// Stands in for gh and does what gh does with --jq, so the watcher's own filter really runs.
const FAKE_GH = `#!/bin/sh
printf '%s\\n' "$*" > "$GH_LOG"
while [ $# -gt 0 ]; do
  [ "$1" = "--jq" ] && filter=$2
  shift
done
exec jq -c "$filter" "$GH_ISSUES"
`;

function watch(args: string[]) {
  const dir = mkdtempSync(join(scratch, "gh-"));
  writeFileSync(join(dir, "gh"), FAKE_GH);
  chmodSync(join(dir, "gh"), 0o755);
  const issues = [
    {
      number: 12,
      title: 'Crash on "C:\\new"',
      url: "https://example.com/issues/12",
      body: 'line one\nline two with a "quote" and a back\\slash\n\ttabbed',
    },
    { number: 13, title: "No body", url: "https://example.com/issues/13", body: "" },
    { number: 14, title: "Long", url: "https://example.com/issues/14", body: "字".repeat(5000) },
  ];
  writeFileSync(join(dir, "issues.json"), JSON.stringify(issues));
  const done = spawnSync("sh", [join(ROOT, "examples", "watch-github-issues.sh"), ...args], {
    env: {
      ...cleanEnv(),
      PATH: `${dir}:${process.env.PATH}`,
      GH_LOG: join(dir, "log"),
      GH_ISSUES: join(dir, "issues.json"),
    },
    encoding: "utf8",
  });
  assert.equal(done.status, 0, done.stderr);
  return { said: done.stdout, asked: readFileSync(join(dir, "log"), "utf8"), issues };
}

test("github-issues: what the watcher prints goes through the worker whole, and the rules let it in", () => {
  const { said, issues } = watch(["owner/repo"]);
  const { result, problem } = resultFrom(readMessage(said), {});
  assert.equal(problem, undefined);
  assert.equal(result.outcome, "done");
  const events = result.events!;
  assert.equal(events[0].id, "issue-12");
  assert.equal(events[0].subject, "#12");
  assert.equal(events[0].summary, issues[0].title);
  assert.equal(events[0].detail, issues[0].body, "the body has to reach an Agent that can't go and read it");
  assert.equal(events[0].link, issues[0].url);
  assert.equal(events[1].detail, "");
  assert.equal([...events[2].detail].length, 4000);
  const rules = readRules("github-issues").rules;
  const watcher = rules.find((rule: { emits?: unknown }) => rule.emits);
  const handler = rules.find((rule: { skill?: string }) => rule.skill);
  for (const { type } of events) {
    assert.ok(watcher.emits.types.includes(type));
    assert.ok(handler.when.types.includes(type));
  }
  assert.equal(handler.when.source, watcher.emits.source);
});

test("github-issues: the watcher's search is optional, and the rules use it to leave old issues alone", () => {
  assert.doesNotMatch(watch(["owner/repo"]).asked, /--search/);
  assert.match(watch(["owner/repo", "created:>=2026-11-04"]).asked, /--search created:>=2026-11-04/);
  const { agents } = readRules("github-issues");
  assert.ok(agents.watcher.command.some((part: string) => part.startsWith("created:>=")));
});

// Stands in for the local jira MCP: answers the stdio handshake and one jira_search, so the watcher's own client runs.
const FAKE_MCP = `const fs = require("node:fs");
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  const say = (object) => process.stdout.write(JSON.stringify(object) + "\\n");
  if (message.id === 1) say({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {} } });
  if (message.method === "notifications/initialized") fs.appendFileSync(process.env.MCP_LOG, "initialized\\n");
  if (message.id === 2) {
    fs.appendFileSync(process.env.MCP_LOG, JSON.stringify(message.params.arguments) + "\\n");
    if (process.env.MCP_DIES) process.exit(1);
    say({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: fs.readFileSync(process.env.MCP_ISSUES, "utf8") }] } });
  }
});
`;

function jiraWatch(issues: unknown, expectFailure = false, dies = false) {
  const dir = mkdtempSync(join(scratch, "jira-"));
  writeFileSync(join(dir, "mcp.cjs"), FAKE_MCP);
  writeFileSync(join(dir, "issues.json"), typeof issues === "string" ? issues : JSON.stringify(issues));
  writeFileSync(
    join(dir, "jira.json"),
    JSON.stringify({
      mcp: [process.execPath, join(dir, "mcp.cjs")],
      jql: "project = OPS AND updated >= '-20m'",
      maxResults: 5,
      timeoutSeconds: 30,
    }),
  );
  const done = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join(RECIPES, "jira-watch", "watch.ts"), join(dir, "jira.json")],
    {
      env: {
        ...cleanEnv(),
        MCP_LOG: join(dir, "log"),
        MCP_ISSUES: join(dir, "issues.json"),
        ...(dies ? { MCP_DIES: "1" } : {}),
      },
      encoding: "utf8",
    },
  );
  assert.equal(done.status, expectFailure ? 1 : 0, done.stderr);
  return { said: done.stdout, asked: readFileSync(join(dir, "log"), "utf8") };
}

test("jira-watch: Jira's own complaint fails the run, but an unreachable Jira ends quietly", () => {
  // A wrong JQL or a dead token is the owner's to fix: it must not look like "nothing to report".
  const wrong = jiraWatch("Error calling tool 'search': The value 'OPS' does not exist for the field 'project'.", true);
  assert.match(wrong.said, /没跑成/);
  assert.equal(resultFrom(readMessage(wrong.said), {}).result.outcome, "failed");

  // The MCP never answers: the cron ticks again, so the run ends as "nothing" rather than failing.
  const quiet = jiraWatch("", false, true);
  assert.equal(resultFrom(readMessage(quiet.said), {}).result.outcome, "nothing");
});

test("jira-watch: the watcher asks the configured JQL and hands back stable events the rules let in", () => {
  // The shape mcp-atlassian really returns: a wrapper with total/start_at/max_results/issues, fields flattened.
  const { said, asked } = jiraWatch({
    total: 2,
    start_at: 0,
    max_results: 5,
    issues: [
      {
        key: "OPS-12",
        summary: "数据库慢查询",
        browse_url: "https://jira.example.com/browse/OPS-12",
        status: { name: "In Progress", category: "进行中" },
        reporter: {
          account_id: null,
          display_name: "Zhang San",
          name: "zhang.san@cn.example.com",
          email: "zhang.san@example.com",
          key: "JIRAUSER21153",
        },
        updated: "2026-11-04 09:30:16 CST",
      },
      {
        key: "OPS-13",
        summary: "Release",
        browse_url: "https://jira.example.com/browse/OPS-13",
        status: { name: "Done" },
        reporter: { display_name: "李四", name: "li.si@cn.example.com", email: "li.si@example.com" },
        updated: "2026-11-04 10:00:00 CST",
      },
    ],
  });
  const lines = asked.trim().split("\n");
  assert.match(lines[0], /initialized/);
  const askedMcp = JSON.parse(lines[1]);
  assert.equal(askedMcp.jql, "project = OPS AND updated >= '-20m'");
  assert.equal(askedMcp.limit, 5);
  const { result, problem } = resultFrom(readMessage(said), {});
  assert.equal(problem, undefined);
  const events = result.events!;
  assert.equal(events.length, 2);
  assert.equal(events[0].id, "OPS-12:2026-11-04 09:30:16 CST", "stable id: rereading the window notifies once");
  assert.equal(events[0].subject, "OPS-12");
  assert.equal(events[0].summary, "数据库慢查询");
  assert.equal(events[0].link, "https://jira.example.com/browse/OPS-12");
  const detail = JSON.parse(events[0].detail);
  assert.equal(detail.reporter_email, "zhang.san@example.com", "the notifier maps the creator from this");
  assert.equal(detail.reporter_account, "zhang.san@cn.example.com");
  assert.equal(detail.status, "In Progress");
  assert.equal(events[1].summary, "Release");
  assert.equal(JSON.parse(events[1].detail).reporter_name, "李四");
  const rules = readRules("jira-watch").rules;
  const watcher = rules.find((rule: { emits?: unknown }) => rule.emits);
  const handler = rules.find((rule: { when: { source?: string } }) => rule.when.source);
  for (const { type } of events) {
    assert.ok(watcher.emits.types.includes(type));
    assert.ok(handler.when.types.includes(type));
  }
  assert.equal(handler.when.source, watcher.emits.source);
});

test("jira-watch: the notifier mentions only creators the local map carries", () => {
  const dir = mkdtempSync(join(scratch, "notify-"));
  writeFileSync(
    join(dir, "users.json"),
    JSON.stringify({ "zhang.san@example.com": { name: "张三", mention: "张三" } }),
  );
  const events = [
    {
      id: "OPS-12:t1",
      type: "jira.updated",
      subject: "OPS-12",
      summary: "数据库慢查询",
      detail: JSON.stringify({
        reporter_email: "zhang.san@example.com",
        reporter_account: "zhang.san@cn.example.com",
        reporter_name: "Zhang San",
        status: "In Progress",
        updated: "2026-11-04 09:30",
        url: "https://jira.example.com/browse/OPS-12",
      }),
      link: "https://jira.example.com/browse/OPS-12",
    },
    {
      id: "OPS-13:t1",
      type: "jira.updated",
      subject: "OPS-13",
      summary: "Release",
      detail: JSON.stringify({ reporter_name: "李四", status: "Done" }),
      link: "",
    },
  ];
  const done = (() => {
    const contextFile = join(dir, "context.json");
    writeFileSync(contextFile, JSON.stringify({ events }));
    return spawnSync(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", join(RECIPES, "jira-watch", "notify.ts"), join(dir, "users.json")],
      { env: { ...cleanEnv(), AGENT_AUTOLOOP_CONTEXT: contextFile }, encoding: "utf8" },
    );
  })();
  assert.equal(done.status, 0, done.stderr);
  const { result, problem } = resultFrom(readMessage(done.stdout), {});
  assert.equal(problem, undefined);
  const notice = result.notice!;
  assert.equal(notice.length, 2);
  assert.match(notice[0].text, /@张三/, "the mention is written the way the group knows the person");
  assert.match(notice[0].text, /张三/);
  assert.doesNotMatch(notice[1].text, /@/, "an unmapped creator is named, not pinged");
  assert.notEqual(notice[0].key, notice[1].key);
});

test("jira-watch: the mention comes first, so the person is pinged before the details", () => {
  const dir = mkdtempSync(join(scratch, "notify-first-"));
  writeFileSync(
    join(dir, "users.json"),
    JSON.stringify({ "zhang.san@example.com": { name: "张三", mention: "13800001111" } }),
  );
  const events = [
    {
      id: "OPS-12:t1",
      type: "jira.updated",
      subject: "OPS-12",
      summary: "数据库慢查询",
      detail: JSON.stringify({
        reporter_email: "zhang.san@example.com",
        reporter_name: "Zhang San",
        status: "In Progress",
        updated: "2026-11-04 09:30",
        url: "https://jira.example.com/browse/OPS-12",
      }),
      link: "https://jira.example.com/browse/OPS-12",
    },
  ];
  const contextFile = join(dir, "context.json");
  writeFileSync(contextFile, JSON.stringify({ events }));
  const done = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join(RECIPES, "jira-watch", "notify.ts"), join(dir, "users.json")],
    { env: { ...cleanEnv(), AGENT_AUTOLOOP_CONTEXT: contextFile }, encoding: "utf8" },
  );
  assert.equal(done.status, 0, done.stderr);
  const notice = resultFrom(readMessage(done.stdout), {}).result.notice!;
  assert.match(notice[0].text, /^@13800001111/, "the mention leads the message");
  assert.doesNotMatch(notice[0].text, /@13800001111 /, "no space right after the mention, or it does not match");
  assert.equal(
    notice[0].text,
    "@13800001111\nOPS-12 数据库慢查询 https://jira.example.com/browse/OPS-12\n状态：In Progress",
    "the message reads as the mention, the case with a link to it, and its status",
  );
});
