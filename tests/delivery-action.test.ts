// Failure modes from Ship: a later docs-only commit suppresses a queued code release; an unhealthy endpoint authorizes
// skipping release; the action imports a project's mutable copy of the engine or accepts a non-commit target; the merge
// itself loosens the settings that judge it; settings that can't be read release on trust.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { decideShip } from "../plugins/delivery/action.ts";

test("Ship compares live to target and only runtime changes can supersede", async () => {
  const calls: any[] = [];
  const required = (a: string, b: string) => {
    calls.push([a, b]);
    return a === "live" || b === "new-code";
  };
  assert.deepEqual(decideShip("target", "docs-after", { sha: "live", release: "live" }, required), {
    release: true,
    superseded: false,
  });
  assert.deepEqual(calls, [
    ["live", "target"],
    ["target", "docs-after"],
  ]);
  assert.deepEqual(decideShip("target", "new-code", { sha: "target", release: "target" }, required), {
    release: false,
    superseded: true,
  });
  assert.deepEqual(decideShip("target", "target", null, required), { release: true, superseded: false });
});

const program = join(import.meta.dirname, "../plugins/delivery/action.ts");
const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-ship-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A repository whose origin is itself with the standard refspec, the way the checkout looks in CI. */
function repo(name: string) {
  const root = join(scratch, name);
  mkdirSync(root, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (file: string, text: string) => {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  const commit = () => {
    git("add", "-A");
    git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "test");
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", root);
  git("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  return { root, write, commit };
}
const valid = JSON.stringify({ repo: "example/app", internal: ["**/*"], review: { points: "AGENTS.md" } });
function ship(root: string, target: string, before?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, INPUT_TARGET: target };
  delete env.GITHUB_OUTPUT;
  delete env.GITHUB_EVENT_PATH;
  if (before) env.INPUT_BEFORE = before;
  return spawnSync(process.execPath, [program], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
}
test("the settings that judge a release are main's, from before the merge that landed it", () => {
  const { root, write, commit } = repo("before-the-merge");
  write("app.ts", "original");
  write("ops/delivery.json", valid);
  commit();
  write("app.ts", "changed");
  write("ops/delivery.json", JSON.stringify({ repo: "example/app", review: {} }));
  const target = commit();
  const done = ship(root, target);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(done.stdout, "release=true\nsuperseded=false\n");
});
test("a push that carries the merge and later commits is judged by the main before the push", () => {
  const { root, write, commit } = repo("push-range");
  write("app.ts", "original");
  write("ops/delivery.json", JSON.stringify({ repo: "example/app", internal: ["docs/**"], review: {} }));
  const before = commit();
  // The merge widens what counts as skippable docs; the release it asks for is judged by the narrower main before it.
  write("app.ts", "changed");
  write("ops/delivery.json", valid); // internal: everything counts as docs
  commit();
  write("docs.md", "说明"); // a later commit in the same push
  const target = commit();
  write("readme.md", "说明"); // main moves on, docs only
  commit();
  // Judged by the pre-push main, the readme that followed still needs a release: superseded.
  const judged = ship(root, target, before);
  assert.equal(judged.status, 0, judged.stderr);
  assert.equal(judged.stdout, "release=true\nsuperseded=true\n");
  // Without the platform saying where the push began, the old guess (the commit before the tip) still applies.
  const guessed = ship(root, target);
  assert.equal(guessed.status, 0, guessed.stderr);
  assert.equal(guessed.stdout, "release=true\nsuperseded=false\n");
});
test("a target whose settings can't be read from before the merge waits for a person", () => {
  const first = repo("root-commit");
  first.write("app.ts", "original");
  first.write("ops/delivery.json", valid);
  const rootTarget = first.commit();
  const rooted = ship(first.root, rootTarget);
  assert.equal(rooted.status, 0, rooted.stderr);
  assert.equal(rooted.stdout, "release=true\nsuperseded=true\n");
  const missing = repo("no-settings");
  missing.write("app.ts", "original");
  missing.commit();
  missing.write("app.ts", "changed");
  missing.write("ops/delivery.json", valid);
  const target = missing.commit();
  const done = ship(missing.root, target);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(done.stdout, "release=true\nsuperseded=true\n");
});
