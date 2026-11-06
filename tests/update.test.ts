// `update` on a real clone of a throwaway repository, shallow like the one install.sh makes. Failure modes: checking for
// an update changes the install; it says "up to date" while there are newer commits, or doesn't name the newest
// version; updating to a version that isn't there leaves the install half changed or says it worked; a version name
// that starts like an option reaches git as one; going back after an update has nothing to go back to, goes somewhere
// else, or can't be undone in turn; a plain update after going back to a version stays stuck on it; a test reloads the
// real service.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const repo = join(import.meta.dirname, "..");
const dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-autoloop-update-")));
after(() => rmSync(dir, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "tag.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

const upstream = join(dir, "upstream");
for (const part of ["bin", "cli", "host", "kernel", "plugins", "protocol", "skills", "worker", "package.json"]) {
  cpSync(join(repo, part), join(upstream, part), { recursive: true });
}
git(upstream, "init", "-q", "-b", "main");
git(upstream, "add", "-A");
git(upstream, "commit", "-qm", "one");
git(upstream, "tag", "v1.0.0");
const one = git(upstream, "rev-parse", "HEAD");
const app = join(dir, "app");
git(dir, "clone", "--quiet", "--depth", "1", `file://${upstream}`, app);
writeFileSync(join(upstream, "MARK"), "two\n");
git(upstream, "add", "-A");
git(upstream, "commit", "-qm", "two");
git(upstream, "tag", "v1.1.0");
const two = git(upstream, "rev-parse", "HEAD");
writeFileSync(join(upstream, "MARK"), "three\n");
git(upstream, "commit", "-qam", "three");
const three = git(upstream, "rev-parse", "HEAD");

// Stand-ins that say no service is loaded, so nothing here can restart a real one.
const fakes = join(dir, "fakes");
mkdirSync(fakes);
for (const name of ["launchctl", "systemctl"]) {
  writeFileSync(join(fakes, name), "#!/bin/sh\nexit 1\n");
  chmodSync(join(fakes, name), 0o755);
}
const person = join(dir, "person");
mkdirSync(person);
const environment = (home: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: person,
    AGENT_AUTOLOOP_HOME: home,
    PATH: `${fakes}:${process.env.PATH}`,
  };
  delete env.AGENT_AUTOLOOP_COMMIT;
  delete env.AGENT_AUTOLOOP_RULES;
  return env;
};
const cli = (home: string, ...args: string[]) =>
  spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join(app, "bin", "agent-autoloop.ts"), ...args],
    {
      env: environment(home),
      encoding: "utf8",
      timeout: 60_000,
    },
  );
const home = join(dir, "home");
const head = () => git(app, "rev-parse", "HEAD");
const mark = () => (existsSync(join(app, "MARK")) ? readFileSync(join(app, "MARK"), "utf8") : null);

test("checking says how far behind it is and what the newest version is, and changes nothing", () => {
  const checked = cli(home, "update", "--check");
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /落后 2 个提交/);
  assert.match(checked.stdout, /v1\.1\.0/);
  assert.equal(head(), one, "只看不改");
  assert.equal(mark(), null);
});

test("an update to a version goes to exactly that version, and says how to go back", () => {
  const pinned = cli(home, "update", "v1.1.0");
  assert.equal(pinned.status, 0, pinned.stderr);
  assert.equal(head(), two);
  assert.equal(mark(), "two\n");
  assert.match(pinned.stdout, /update --rollback/);
  const checked = cli(home, "update", "--check");
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /落后 1 个提交/, "停在某个版本上也能看出后面还有");
});

test("going back returns to the version before the last update, and going back again undoes that", () => {
  const back = cli(home, "update", "--rollback");
  assert.equal(back.status, 0, back.stderr);
  assert.equal(head(), one);
  assert.equal(mark(), null);
  const again = cli(home, "update", "--rollback");
  assert.equal(again.status, 0, again.stderr);
  assert.equal(head(), two);
});

test("a plain update after going to a version goes on to the newest", () => {
  const latest = cli(home, "update");
  assert.equal(latest.status, 0, latest.stderr);
  assert.equal(head(), three);
  assert.equal(mark(), "three\n");
  const checked = cli(home, "update", "--check");
  assert.match(checked.stdout, /已经是最新的/);
});

test("a version that isn't there, or a name git would read as an option, changes nothing", () => {
  const missing = cli(home, "update", "v9.9.9");
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /v9\.9\.9/);
  assert.equal(head(), three);
  const sneaky = join(dir, "sneaked");
  const option = cli(home, "update", `-upload-pack=touch ${sneaky}`);
  assert.notEqual(option.status, 0);
  assert.ok(!existsSync(sneaky));
  assert.equal(head(), three);
});

test("with no update behind it there is nothing to go back to", () => {
  const fresh = cli(join(dir, "another-home"), "update", "--rollback");
  assert.notEqual(fresh.status, 0);
  assert.match(fresh.stderr, /没有/);
  assert.equal(head(), three);
});
