// A hub started from inside an Agent turn. Failure case: everything an Agent starts belongs to its turn, which Windows
// ends with the turn's job and Unix stops by process group. A hub an Agent restarted from inside its turn went with the
// turn without a word, and with no service to start it again the install stayed down until the next login. `up` reads
// the turn's own AGENT_AUTOLOOP_RUN and AGENT_AUTOLOOP_CONTEXT, refuses for the hub that runs the turn, and says why; a
// throwaway hub on another home, as a test or acceptance run inside a turn starts, isn't refused.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const bin = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
const home = mkdtempSync(join(tmpdir(), "agent-autoloop-up-in-turn-"));
// A suite that itself runs inside a turn starts from what a person's shell would have.
const outside = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/^AGENT_AUTOLOOP_(RUN|CONTEXT)$/.test(name)),
) as NodeJS.ProcessEnv;
after(() => rmSync(home, { recursive: true, force: true }));

test("up refuses to restart its own hub from inside a turn, says why, and starts nothing", () => {
  const run = (turn: NodeJS.ProcessEnv) =>
    spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", bin, "up"], {
      env: { ...outside, AGENT_AUTOLOOP_HOME: home, ...turn },
      encoding: "utf8",
      timeout: 30_000,
    });
  const inside = run({
    AGENT_AUTOLOOP_RUN: "412",
    AGENT_AUTOLOOP_CONTEXT: join(home, "worker", "runs", "412-1", "context.json"),
  });
  assert.notEqual(inside.status, 0);
  assert.match(inside.stderr, /这是在第 412 轮 Agent 里启动这个中台/);
  assert.equal(existsSync(join(home, "up.pid")), false);
  // The turn is what it reads: outside one, what stops the same command here is that nothing is installed.
  const beside = run({});
  assert.doesNotMatch(beside.stderr, /轮 Agent 里启动/);
  // A turn of the hub at another home starting this one is a test hub, which should go with the turn.
  const elsewhere = run({ AGENT_AUTOLOOP_RUN: "412", AGENT_AUTOLOOP_CONTEXT: join(tmpdir(), "412-1", "context.json") });
  assert.doesNotMatch(elsewhere.stderr, /轮 Agent 里启动/);
});
